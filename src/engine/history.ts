import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PathCtx } from '../adapters/types.js';
import { CssError, nowIso, sha256hex } from './common.js';
import { git, gitBuffer } from './git.js';
import { duplicateContent } from './merge.js';
import { resolveRepoKey, type SyncCtx } from './sync.js';
import { Vault, writeTranscript, type SessionEntry } from './vault.js';

/**
 * Vault time travel. The vault is git, so every synced state of every session
 * is in history. The rule that keeps sync sane: we travel only by restoring
 * DELETED sessions or forking NEW ones from past states — never by rewriting
 * a live transcript (in-place rewind fights the append-only model: other
 * devices would immediately push the "missing" turns back).
 */

export interface HistoricalSession {
  hash: string;
  toolId: string;
  transcriptTok: string;
  meta: Partial<SessionEntry> | null;
}

/** Newest state of a session in vault history (or its state at `at`). */
export function findSessionInHistory(
  vault: Vault,
  dirName: string,
  sessionId: string,
  at?: string,
): HistoricalSession | null {
  const hashes = at
    ? [at]
    : git(['log', '--all', '--format=%H', '--', `*/sessions/${sessionId}/*`], {
        cwd: vault.path,
        allowFail: true,
      }).stdout.split('\n').filter(Boolean);

  for (const hash of hashes) {
    const ls = git(['ls-tree', '-r', '--name-only', hash, '--', dirName], { cwd: vault.path, allowFail: true });
    if (!ls.ok) continue;
    const files = ls.stdout.split('\n').filter((f) => f.includes(`/sessions/${sessionId}/`));
    if (files.length === 0) continue; // e.g. the rm commit itself
    const tPath = files.find((f) => f.endsWith('transcript.jsonl.gz')) ?? files.find((f) => f.endsWith('transcript.jsonl'));
    if (!tPath) continue;
    const buf = gitBuffer(['show', `${hash}:${tPath}`], vault.path);
    if (!buf) continue;
    const transcriptTok = tPath.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');

    let meta: Partial<SessionEntry> | null = null;
    const mPath = files.find((f) => f.endsWith('meta.json'));
    if (mPath) {
      const mBuf = gitBuffer(['show', `${hash}:${mPath}`], vault.path);
      if (mBuf) {
        try {
          meta = JSON.parse(mBuf.toString('utf8')) as Partial<SessionEntry>;
        } catch {
          meta = null;
        }
      }
    }
    const toolId = tPath.split('/')[1] ?? 'claude';
    return { hash, toolId, transcriptTok, meta };
  }
  return null;
}

export interface RemovedSession {
  id: string;
  name?: string;
  when: string;
}

/** Sessions mentioned by rm commits, newest first, deduped. */
export function listRemovedSessions(vault: Vault): RemovedSession[] {
  const log = git(['log', '--all', '--format=%cI|%s'], { cwd: vault.path, allowFail: true });
  if (!log.ok) return [];
  const seen = new Set<string>();
  const out: RemovedSession[] = [];
  for (const line of log.stdout.split('\n')) {
    const m = /^([^|]+)\|rm\([^)]*\): ([0-9a-f-]{36}|[0-9a-f]{8})(?: \((.+)\))?$/.exec(line.trim());
    if (!m || !m[2] || seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ id: m[2], name: m[3], when: m[1]!.slice(0, 16) });
  }
  return out;
}

export interface RestoreResult {
  hash: string;
  toolId: string;
  installedAt?: string;
}

export function restoreSession(ctx: SyncCtx, sessionId: string, opts: { at?: string } = {}): RestoreResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();
  const key = resolveRepoKey(ctx);
  const hist = findSessionInHistory(vault, key.dirName, sessionId, opts.at);
  if (!hist) {
    throw new CssError(`session ${sessionId.slice(0, 8)} not found in vault history`, 'chat restore (no args) lists deleted sessions');
  }
  const index = vault.loadIndex();
  const project = (index.projects[key.dirName] ??= { slug: key.slug, origin: key.normalized, tools: {} });
  const tool = (project.tools[hist.toolId] ??= { sessions: {} });
  if (tool.sessions[sessionId]) {
    throw new CssError('session already exists in the vault', 'to take a past version as a NEW session: chat fork <session> --at <hash>');
  }

  const entry: SessionEntry = {
    byteLen: Buffer.byteLength(hist.transcriptTok),
    sha256: sha256hex(hist.transcriptTok),
    device: ctx.cfg.device,
    cwdTok: hist.meta?.cwdTok ?? '${CSS_PROJECT_ROOT}',
    relPath: hist.meta?.relPath,
    lastTs: hist.meta?.lastTs,
    summary: hist.meta?.summary,
    toolVersion: hist.meta?.toolVersion,
    syncedAt: nowIso(),
    name: hist.meta?.name,
  };
  const sessionDir = join(vault.path, key.dirName, hist.toolId, 'sessions', sessionId);
  writeTranscript(sessionDir, hist.transcriptTok);
  writeFileSync(join(sessionDir, 'meta.json'), `${JSON.stringify({ sessionId, tool: hist.toolId, restoredFrom: hist.hash, ...entry }, null, 2)}\n`);
  tool.sessions[sessionId] = entry;
  vault.saveIndex(index);
  vault.commitAndPush(`restore(${key.slug}): ${sessionId}${entry.name ? ` (${entry.name})` : ''}`);

  const result: RestoreResult = { hash: hist.hash, toolId: hist.toolId };
  const active = ctx.adapters.find((a) => a.adapter.id === hist.toolId);
  if (active) {
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: active.env.dataDir };
    const cwd = active.adapter.rehydrate(entry.cwdTok, pathCtx);
    const target = active.adapter.installPath({ sessionId, cwd, relPath: entry.relPath }, active.env);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, active.adapter.rehydrate(hist.transcriptTok, pathCtx, { json: true }));
      result.installedAt = target;
    }
  }
  return result;
}

export interface ForkAtResult {
  newSessionId: string;
  targetPath: string;
  toolId: string;
  hash: string;
}

/** Fork a session from a past vault state — the safe "rewind": new id, no
 *  sync conflict, original untouched. Works even for deleted sessions. */
export function forkSessionAt(ctx: SyncCtx, sessionId: string, at?: string): ForkAtResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();
  const key = resolveRepoKey(ctx);
  const hist = findSessionInHistory(vault, key.dirName, sessionId, at);
  if (!hist) {
    throw new CssError(`session ${sessionId.slice(0, 8)} not found in vault history${at ? ` at ${at.slice(0, 8)}` : ''}`);
  }
  const active = ctx.adapters.find((a) => a.adapter.id === hist.toolId);
  if (!active) throw new CssError(`this machine has no ${hist.toolId} adapter active`);

  const { content, newSessionId } = duplicateContent(hist.transcriptTok, sessionId);
  const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: active.env.dataDir };
  const cwd = active.adapter.rehydrate(hist.meta?.cwdTok ?? '${CSS_PROJECT_ROOT}', pathCtx);
  const relPath = hist.meta?.relPath?.replaceAll(sessionId, newSessionId);
  const target = active.adapter.installPath({ sessionId: newSessionId, cwd, relPath }, active.env);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, active.adapter.rehydrate(content, pathCtx, { json: true }));
  return { newSessionId, targetPath: target, toolId: hist.toolId, hash: hist.hash };
}
