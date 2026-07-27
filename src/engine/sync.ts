import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveAdapter } from '../adapters/registry.js';
import type { PathCtx } from '../adapters/types.js';
import { isPrefixOf, log, nowIso, sha256hex } from './common.js';
import type { CssConfig } from './config.js';
import { originUrl } from './git.js';
import { CssError } from './common.js';
import { repoKeyFromOrigin, type RepoKey } from './repoKey.js';
import { Vault, type ProjectEntry, type SessionEntry, type VaultIndex } from './vault.js';

export interface SyncCtx {
  repoRoot: string;
  cfg: CssConfig;
  home: string;
  adapters: ActiveAdapter[];
}

export interface PushResult {
  pushed: number;
  fastForwarded: number;
  upToDate: number;
  remoteAhead: number;
  conflicts: number;
  committed: boolean;
}

export interface PullResult {
  installed: number;
  fastForwarded: number;
  upToDate: number;
  localAhead: number;
  conflicts: number;
}

function repoKey(ctx: SyncCtx): RepoKey {
  const origin = originUrl(ctx.repoRoot);
  if (!origin) {
    throw new CssError(
      'this repo has no "origin" remote — the vault namespaces projects by origin URL',
      'add a remote (git remote add origin …) and re-run css enable',
    );
  }
  return repoKeyFromOrigin(origin);
}

function ensureProject(index: VaultIndex, key: RepoKey): ProjectEntry {
  const existing = index.projects[key.dirName];
  if (existing) return existing;
  const fresh: ProjectEntry = { slug: key.slug, origin: key.normalized, tools: {} };
  index.projects[key.dirName] = fresh;
  return fresh;
}

export function pushSessions(ctx: SyncCtx): PushResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();

  const key = repoKey(ctx);
  const index = vault.loadIndex();
  const project = ensureProject(index, key);
  const result: PushResult = {
    pushed: 0,
    fastForwarded: 0,
    upToDate: 0,
    remoteAhead: 0,
    conflicts: 0,
    committed: false,
  };

  const projectDir = join(vault.path, key.dirName);
  const projectJson = join(projectDir, 'project.json');

  for (const { adapter, env } of ctx.adapters) {
    const tool = (project.tools[adapter.id] ??= { sessions: {} });
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home };

    for (const ref of adapter.locate(ctx.repoRoot, env)) {
      const tokenized = adapter.tokenize(readFileSync(ref.filePath, 'utf8'), pathCtx);
      const sha = sha256hex(tokenized);
      const sessionDir = join(projectDir, adapter.id, 'sessions', ref.sessionId);
      const transcriptPath = join(sessionDir, 'transcript.jsonl');
      const existing = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : null;

      const entry: SessionEntry = {
        byteLen: Buffer.byteLength(tokenized),
        sha256: sha,
        device: ctx.cfg.device,
        cwdTok: adapter.tokenize(ref.cwd, pathCtx),
        lastTs: ref.lastTs,
        summary: ref.summary,
        toolVersion: ref.toolVersion,
        syncedAt: nowIso(),
        conflicts: tool.sessions[ref.sessionId]?.conflicts,
      };

      if (existing === null) {
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(transcriptPath, tokenized);
        tool.sessions[ref.sessionId] = entry;
        result.pushed++;
      } else if (existing === tokenized) {
        tool.sessions[ref.sessionId] ??= entry;
        result.upToDate++;
        continue;
      } else if (isPrefixOf(existing, tokenized)) {
        writeFileSync(transcriptPath, tokenized);
        tool.sessions[ref.sessionId] = entry;
        result.fastForwarded++;
      } else if (isPrefixOf(tokenized, existing)) {
        result.remoteAhead++; // another device is further along; pull will catch us up
        continue;
      } else {
        // Disjoint growth of the same session on two devices: never drop turns.
        const conflictPath = join(sessionDir, `transcript.conflict-${ctx.cfg.device}.jsonl`);
        writeFileSync(conflictPath, tokenized);
        const canonical = tool.sessions[ref.sessionId];
        if (canonical) {
          canonical.conflicts = [...new Set([...(canonical.conflicts ?? []), ctx.cfg.device])];
        }
        result.conflicts++;
        log.warn(`session ${ref.sessionId.slice(0, 8)} diverged on ${ctx.cfg.device}; kept as conflict copy`);
      }

      writeFileSync(
        join(sessionDir, 'meta.json'),
        `${JSON.stringify(
          {
            sessionId: ref.sessionId,
            tool: adapter.id,
            originalPath: ref.filePath,
            originalCwd: ref.cwd,
            ...entry,
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  if (!existsSync(projectJson)) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      projectJson,
      `${JSON.stringify({ origin: key.normalized, slug: key.slug, createdAt: nowIso() }, null, 2)}\n`,
    );
  }
  vault.saveIndex(index);

  const changed = result.pushed + result.fastForwarded + result.conflicts;
  result.committed = vault.commitAndPush(
    `sync(${key.slug}): ${changed} session(s) from ${ctx.cfg.device}`,
  );
  return result;
}

export function pullSessions(ctx: SyncCtx, onlyId?: string): PullResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();

  const key = repoKey(ctx);
  const index = vault.loadIndex();
  const project = index.projects[key.dirName];
  const result: PullResult = { installed: 0, fastForwarded: 0, upToDate: 0, localAhead: 0, conflicts: 0 };
  if (!project) return result;

  for (const { adapter, env } of ctx.adapters) {
    const tool = project.tools[adapter.id];
    if (!tool) continue;
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home };
    // Local files may live under legacy munge variants — resolve by session id,
    // never by recomputing the directory name.
    const localById = new Map(adapter.locate(ctx.repoRoot, env).map((r) => [r.sessionId, r]));

    for (const [sessionId, entry] of Object.entries(tool.sessions)) {
      if (onlyId && sessionId !== onlyId) continue;
      const transcriptPath = join(vault.path, key.dirName, adapter.id, 'sessions', sessionId, 'transcript.jsonl');
      if (!existsSync(transcriptPath)) continue;
      const tokenized = readFileSync(transcriptPath, 'utf8');

      const local = localById.get(sessionId);
      if (!local) {
        const cwd = adapter.rehydrate(entry.cwdTok, pathCtx);
        const dir = adapter.installDir(cwd, env);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sessionId}.jsonl`), adapter.rehydrate(tokenized, pathCtx));
        result.installed++;
        continue;
      }

      const localTok = adapter.tokenize(readFileSync(local.filePath, 'utf8'), pathCtx);
      if (localTok === tokenized) {
        result.upToDate++;
      } else if (isPrefixOf(localTok, tokenized)) {
        writeFileSync(local.filePath, adapter.rehydrate(tokenized, pathCtx));
        result.fastForwarded++;
      } else if (isPrefixOf(tokenized, localTok)) {
        result.localAhead++; // we have unsynced turns; next push fast-forwards the vault
      } else {
        result.conflicts++;
        log.warn(
          `session ${sessionId.slice(0, 8)} diverged from vault; local kept, see css status`,
        );
      }
    }
  }
  return result;
}
