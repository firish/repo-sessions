import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ActiveAdapter } from '../adapters/registry.js';
import type { PathCtx } from '../adapters/types.js';
import { CssError, isPrefixOf, log, nowIso, sha256hex } from './common.js';
import { readTranscript, writeTranscript, type SessionEntry } from './vault.js';

/**
 * Cross-device splice merge (the any-laptop workflow).
 *
 * Divergent copies of one session share a common line prefix; the merge keeps
 * the longest copy as trunk and appends each other copy's tail, re-parenting
 * the first tail record onto the trunk's leaf so the chain stays linear and
 * every turn replays. Reads as "meanwhile, on the other laptop" — which is
 * the truth.
 *
 * Refused when a TAIL contains compaction records: replaying a compact
 * boundary mid-transcript silently drops everything before it from context.
 * Those cases use --split instead: the divergent branch becomes its own new
 * session (full fidelity, zero risk).
 */

export interface Branch {
  name: string;
  lines: string[];
}

export interface MergePlan {
  trunk: Branch;
  tails: { name: string; lines: string[] }[];
  absorbed: string[];
}

const COMPACT_MARKER = /"type":"(summary|compact_boundary)"|"isCompactSummary":true|"compactMetadata"/;

export function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function commonPrefixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export function planMerge(branches: Branch[]): MergePlan {
  const sorted = [...branches].sort((a, b) => b.lines.length - a.lines.length);
  const trunk = sorted[0];
  if (!trunk) throw new CssError('nothing to merge');
  const plan: MergePlan = { trunk, tails: [], absorbed: [] };

  for (const branch of sorted.slice(1)) {
    const prefix = commonPrefixLen(trunk.lines, branch.lines);
    if (prefix === branch.lines.length) {
      plan.absorbed.push(branch.name); // pure prefix of trunk — nothing new
      continue;
    }
    const tail = branch.lines.slice(prefix);
    if (tail.some((l) => COMPACT_MARKER.test(l))) {
      throw new CssError(
        `branch "${branch.name}" diverges with a compaction record in its tail — splicing would drop earlier context on replay`,
        `use: css merge <id> --split  (keeps that branch as its own new session)`,
      );
    }
    plan.tails.push({ name: branch.name, lines: tail });
  }
  return plan;
}

function lastUuid(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as { uuid?: string };
      if (typeof obj.uuid === 'string') return obj.uuid;
    } catch {
      continue;
    }
  }
  return null;
}

/** Append tails to the trunk, re-parenting each tail's first chained record
 *  onto the current leaf (claude transcripts; codex has no parent chain and
 *  concatenates cleanly). */
export function spliceMerge(plan: MergePlan): string {
  const merged = [...plan.trunk.lines];
  for (const tail of plan.tails.sort((a, b) => a.name.localeCompare(b.name))) {
    const leaf = lastUuid(merged);
    let reparented = false;
    for (const line of tail.lines) {
      if (!reparented && leaf) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if ('parentUuid' in obj) {
            obj.parentUuid = leaf;
            merged.push(JSON.stringify(obj));
            reparented = true;
            continue;
          }
        } catch {
          /* fall through to verbatim */
        }
      }
      merged.push(line);
    }
  }
  return `${merged.join('\n')}\n`;
}

export interface MergeSources {
  sessionDir: string;
  canonicalTok: string;
  conflicts: { device: string; content: string }[];
  localTok: string | null;
}

export function collectSources(sessionDir: string, localTok: string | null): MergeSources {
  const canonicalTok = readTranscript(sessionDir);
  if (canonicalTok === null) throw new CssError('session has no vault transcript');
  const conflicts: { device: string; content: string }[] = [];
  for (const entry of existsSync(sessionDir) ? readdirSync(sessionDir) : []) {
    const m = /^transcript\.conflict-(.+)\.jsonl(\.gz)?$/.exec(entry);
    if (!m || !m[1]) continue;
    const raw = readFileSync(join(sessionDir, entry));
    conflicts.push({ device: m[1], content: entry.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8') });
  }
  return { sessionDir, canonicalTok, conflicts, localTok };
}

export function branchesFrom(sources: MergeSources, device: string): Branch[] {
  // Dedupe by content: a device's local copy is often byte-identical to the
  // conflict copy it already pushed — splicing it twice would double turns.
  const seen = new Set<string>([sources.canonicalTok]);
  const branches: Branch[] = [{ name: 'vault', lines: splitLines(sources.canonicalTok) }];
  for (const c of sources.conflicts) {
    if (seen.has(c.content)) continue;
    seen.add(c.content);
    branches.push({ name: `conflict:${c.device}`, lines: splitLines(c.content) });
  }
  if (
    sources.localTok !== null &&
    !seen.has(sources.localTok) &&
    !isPrefixOf(sources.localTok, sources.canonicalTok)
  ) {
    branches.push({ name: `local:${device}`, lines: splitLines(sources.localTok) });
  }
  return branches;
}

export interface MergeOutcome {
  mergedTok: string;
  branchNames: string[];
  removedConflicts: number;
}

/** Execute the merge inside the vault working tree; caller installs locally,
 *  updates the index entry, and commits. */
export function mergeInVault(sources: MergeSources, device: string): MergeOutcome {
  const branches = branchesFrom(sources, device);
  if (branches.length < 2) {
    throw new CssError('nothing to merge — no conflict copies and local matches the vault');
  }
  const plan = planMerge(branches);
  if (plan.tails.length === 0) {
    throw new CssError('nothing to merge — all branches are prefixes of the vault transcript');
  }
  const mergedTok = spliceMerge(plan);
  writeTranscript(sources.sessionDir, mergedTok);
  let removed = 0;
  for (const entry of readdirSync(sources.sessionDir)) {
    if (/^transcript\.conflict-.+\.jsonl(\.gz)?$/.test(entry)) {
      rmSync(join(sources.sessionDir, entry));
      removed++;
    }
  }
  return {
    mergedTok,
    branchNames: [plan.trunk.name, ...plan.tails.map((t) => t.name), ...plan.absorbed.map((n) => `${n} (absorbed)`)],
    removedConflicts: removed,
  };
}

// ---------------------------------------------------------------- duplicate

export interface DuplicateResult {
  newSessionId: string;
  targetPath: string;
}

/** Fork a transcript into a brand-new session id: every occurrence of the old
 *  id is rewritten (per-line sessionId fields, codex session_meta payload.id,
 *  rollout_path self-references) and the file lands beside the original with
 *  the id swapped in its name. */
export function duplicateContent(content: string, oldId: string): { content: string; newSessionId: string } {
  const newSessionId = randomUUID();
  return { content: content.replaceAll(oldId, newSessionId), newSessionId };
}

export function duplicateLocal(adapterRef: { filePath: string; sessionId: string }, _active: ActiveAdapter): DuplicateResult {
  const raw = readFileSync(adapterRef.filePath, 'utf8');
  const { content, newSessionId } = duplicateContent(raw, adapterRef.sessionId);
  const dir = dirname(adapterRef.filePath);
  const name = basename(adapterRef.filePath);
  const newName = name.includes(adapterRef.sessionId)
    ? name.replaceAll(adapterRef.sessionId, newSessionId)
    : `${newSessionId}.jsonl`;
  const targetPath = join(dir, newName);
  writeFileSync(targetPath, content);
  return { newSessionId, targetPath };
}

/** --split resolution: each divergent branch becomes its own new session,
 *  installed locally via the adapter. Returns the new ids. */
export function splitBranches(
  sources: MergeSources,
  active: ActiveAdapter,
  pathCtx: PathCtx,
  originalRef: { sessionId: string; cwd: string; relPath?: string },
): { device: string; newSessionId: string; targetPath: string }[] {
  const out: { device: string; newSessionId: string; targetPath: string }[] = [];
  const canonical = sources.canonicalTok;
  const seen = new Set<string>([canonical]);
  const candidates = [...sources.conflicts];
  if (sources.localTok !== null && !isPrefixOf(sources.localTok, canonical) && sources.localTok !== canonical) {
    candidates.push({ device: 'local', content: sources.localTok });
  }
  for (const c of candidates) {
    if (seen.has(c.content) || isPrefixOf(c.content, canonical)) continue; // dupe or nothing beyond the vault
    seen.add(c.content);
    const { content, newSessionId } = duplicateContent(c.content, originalRef.sessionId);
    const hydrated = active.adapter.rehydrate(content, pathCtx);
    const target = active.adapter.installPath(
      { sessionId: newSessionId, cwd: originalRef.cwd, relPath: originalRef.relPath?.replaceAll(originalRef.sessionId, newSessionId) },
      active.env,
    );
    writeFileSync(target, hydrated);
    out.push({ device: c.device, newSessionId, targetPath: target });
  }
  return out;
}

export function summarizeMerge(outcome: MergeOutcome, sessionId: string): void {
  log.info(`merged ${sessionId.slice(0, 8)} from: ${outcome.branchNames.join(', ')}`);
  log.info(`sha256 ${sha256hex(outcome.mergedTok).slice(0, 12)}, ${splitLines(outcome.mergedTok).length} lines, ${outcome.removedConflicts} conflict cop${outcome.removedConflicts === 1 ? 'y' : 'ies'} cleared @ ${nowIso()}`);
}

// ---------------------------------------------------------------- orchestrators

import { mkdirSync } from 'node:fs';
import { Vault } from './vault.js';
import { resolveRepoKey, type SyncCtx } from './sync.js';

export interface MergeSessionResult {
  mode: 'merge' | 'split';
  outcome?: MergeOutcome;
  installedAt?: string;
  splits?: { device: string; newSessionId: string; targetPath: string }[];
  localReset?: boolean;
}

export function mergeSession(ctx: SyncCtx, sessionId: string, opts: { split?: boolean } = {}): MergeSessionResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();
  const key = resolveRepoKey(ctx);
  const index = vault.loadIndex();
  const project = index.projects[key.dirName];
  if (!project) throw new CssError('this repo has nothing in the vault yet');

  const active = ctx.adapters.find((a) => project.tools[a.adapter.id]?.sessions[sessionId]);
  if (!active) throw new CssError(`session ${sessionId} not found in the vault for this repo`);
  const entry: SessionEntry = project.tools[active.adapter.id]!.sessions[sessionId]!;

  const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: active.env.dataDir };
  const sessionDir = join(vault.path, key.dirName, active.adapter.id, 'sessions', sessionId);
  const localRef = active.adapter.locate(ctx.repoRoot, active.env).find((r) => r.sessionId === sessionId);
  const localTok = localRef ? active.adapter.tokenize(readFileSync(localRef.filePath, 'utf8'), pathCtx) : null;
  const sources = collectSources(sessionDir, localTok);
  const cwdForInstall = localRef?.cwd ?? active.adapter.rehydrate(entry.cwdTok, pathCtx);

  if (opts.split) {
    const splits = splitBranches(sources, active, pathCtx, {
      sessionId,
      cwd: cwdForInstall,
      relPath: entry.relPath ?? localRef?.relPath,
    });
    if (splits.length === 0) throw new CssError('nothing to split — no divergent branches');
    for (const e of readdirSync(sessionDir)) {
      if (/^transcript\.conflict-.+\.jsonl(\.gz)?$/.test(e)) rmSync(join(sessionDir, e));
    }
    delete entry.conflicts;
    vault.saveIndex(index);
    vault.commitAndPush(`merge(${key.slug}): split ${splits.length} branch(es) of ${sessionId.slice(0, 8)} into new sessions`);
    // The old id converges on the vault transcript; the divergent local turns
    // now live under the new session id.
    let localReset = false;
    if (localRef && localTok !== null && localTok !== sources.canonicalTok && !isPrefixOf(localTok, sources.canonicalTok)) {
      writeFileSync(localRef.filePath, active.adapter.rehydrate(sources.canonicalTok, pathCtx));
      localReset = true;
    }
    return { mode: 'split', splits, localReset };
  }

  const outcome = mergeInVault(sources, ctx.cfg.device);
  entry.byteLen = Buffer.byteLength(outcome.mergedTok);
  entry.sha256 = sha256hex(outcome.mergedTok);
  entry.device = ctx.cfg.device;
  entry.syncedAt = nowIso();
  delete entry.conflicts;
  vault.saveIndex(index);
  vault.commitAndPush(`merge(${key.slug}): reconciled ${sessionId.slice(0, 8)} from ${outcome.branchNames.length} branch(es)`);

  const target =
    localRef?.filePath ??
    active.adapter.installPath({ sessionId, cwd: cwdForInstall, relPath: entry.relPath }, active.env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, active.adapter.rehydrate(outcome.mergedTok, pathCtx));
  return { mode: 'merge', outcome, installedAt: target };
}

export function duplicateSession(ctx: SyncCtx, sessionId: string): DuplicateResult & { tool: string } {
  const owner = ctx.adapters
    .map((a) => ({ a, ref: a.adapter.locate(ctx.repoRoot, a.env).find((r) => r.sessionId === sessionId) }))
    .find((x) => x.ref);
  if (!owner?.ref) throw new CssError(`session ${sessionId} not found locally in this repo`, 'css pull first?');
  return { ...duplicateLocal(owner.ref, owner.a), tool: owner.a.adapter.id };
}
