import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ActiveAdapter } from '../adapters/registry.js';
import type { PathCtx } from '../adapters/types.js';
import { isPrefixOf, log, normalizeEol, nowIso, sha256hex } from './common.js';
import type { CssConfig } from './config.js';
import { originUrl } from './git.js';
import { CssError } from './common.js';
import { repoKeyFromOrigin, type RepoKey } from './repoKey.js';
import { describeFindings, scanSecrets } from './secrets.js';
import {
  Vault,
  readTranscript,
  writeConflict,
  writeTranscript,
  type MemoryEntry,
  type ProjectEntry,
  type SessionEntry,
  type VaultIndex,
} from './vault.js';

export interface SyncCtx {
  repoRoot: string;
  cfg: CssConfig;
  home: string;
  adapters: ActiveAdapter[];
  /** .chatignore predicate — matching sessions never sync in either direction. */
  ignore?: (sessionId: string, name?: string) => boolean;
}

export interface PushResult {
  pushed: number;
  fastForwarded: number;
  upToDate: number;
  remoteAhead: number;
  conflicts: number;
  ignored: number;
  memoryPushed: number;
  committed: boolean;
}

export interface PullResult {
  installed: number;
  fastForwarded: number;
  upToDate: number;
  localAhead: number;
  conflicts: number;
  ignored: number;
  memoryInstalled: number;
  installedIds: string[];
  updatedIds: string[];
  detail: Record<string, { summary?: string; device: string }>;
}

export function resolveRepoKey(ctx: SyncCtx): RepoKey {
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

  const key = resolveRepoKey(ctx);
  const index = vault.loadIndex();
  const project = ensureProject(index, key);
  const result: PushResult = {
    pushed: 0,
    fastForwarded: 0,
    upToDate: 0,
    remoteAhead: 0,
    conflicts: 0,
    ignored: 0,
    memoryPushed: 0,
    committed: false,
  };

  const projectDir = join(vault.path, key.dirName);
  const projectJson = join(projectDir, 'project.json');

  for (const { adapter, env } of ctx.adapters) {
    const tool = (project.tools[adapter.id] ??= { sessions: {} });
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: env.dataDir };

    for (const ref of adapter.locate(ctx.repoRoot, env)) {
      if (ctx.ignore?.(ref.sessionId, tool.sessions[ref.sessionId]?.name)) {
        result.ignored++;
        continue;
      }
      const tokenized = adapter.tokenize(readFileSync(ref.filePath, 'utf8'), pathCtx, { json: true });
      const sha = sha256hex(tokenized);
      const sessionDir = join(projectDir, adapter.id, 'sessions', ref.sessionId);
      const existing = readTranscript(sessionDir);

      const entry: SessionEntry = {
        byteLen: Buffer.byteLength(tokenized),
        sha256: sha,
        device: ctx.cfg.device,
        cwdTok: adapter.tokenize(ref.cwd, pathCtx),
        relPath: ref.relPath,
        lastTs: ref.lastTs,
        summary: ref.summary,
        toolVersion: ref.toolVersion,
        syncedAt: nowIso(),
        conflicts: tool.sessions[ref.sessionId]?.conflicts,
        name: tool.sessions[ref.sessionId]?.name,
      };

      if (existing === null) {
        writeTranscript(sessionDir, tokenized);
        tool.sessions[ref.sessionId] = entry;
        result.pushed++;
      } else if (existing === tokenized) {
        tool.sessions[ref.sessionId] ??= entry;
        result.upToDate++;
        continue;
      } else if (isPrefixOf(existing, tokenized)) {
        writeTranscript(sessionDir, tokenized);
        tool.sessions[ref.sessionId] = entry;
        result.fastForwarded++;
      } else if (isPrefixOf(tokenized, existing)) {
        result.remoteAhead++; // another device is further along; pull will catch us up
        continue;
      } else {
        // Disjoint growth of the same session on two devices: never drop turns.
        writeConflict(sessionDir, ctx.cfg.device, tokenized);
        const canonical = tool.sessions[ref.sessionId];
        if (canonical) {
          canonical.conflicts = [...new Set([...(canonical.conflicts ?? []), ctx.cfg.device])];
        }
        result.conflicts++;
        log.warn(`session ${ref.sessionId.slice(0, 8)} diverged on ${ctx.cfg.device}; kept as conflict copy`);
      }

      // Only content we are actually writing gets scanned (M3): warn, never block.
      const secrets = scanSecrets(tokenized);
      if (secrets.length > 0) {
        log.warn(`session ${ref.sessionId.slice(0, 8)}: possible secrets in transcript (${describeFindings(secrets)}) — vault privacy is load-bearing`);
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

  // ---- memory (mutable markdown: newest-mtime-wins per file, vault history is the undo)
  for (const { adapter, env } of ctx.adapters) {
    if (!adapter.locateMemory) continue;
    const tool = (project.tools[adapter.id] ??= { sessions: {} });
    const memIndex = (tool.memory ??= {});
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: env.dataDir };
    const memDir = join(projectDir, adapter.id, 'memory');

    for (const ref of adapter.locateMemory(ctx.repoRoot, env)) {
      const tok = normalizeEol(adapter.tokenize(readFileSync(ref.filePath, 'utf8'), pathCtx));
      const sha = sha256hex(tok);
      const entry = memIndex[ref.fileName];
      if (entry && entry.sha256 === sha) continue; // unchanged
      // A stale index sha (pre-EOL-normalization pushes) must not read as a
      // content change: when the bytes already agree, heal the entry silently —
      // never warn about "overwriting" identical content.
      const vaultFile = join(memDir, ref.fileName);
      if (existsSync(vaultFile) && normalizeEol(readFileSync(vaultFile, 'utf8')) === tok) {
        memIndex[ref.fileName] = {
          ...(entry ?? { mtimeMs: ref.mtimeMs, device: ctx.cfg.device, syncedAt: nowIso() }),
          sha256: sha,
          byteLen: Buffer.byteLength(tok),
        };
        continue;
      }
      if (entry && entry.mtimeMs > ref.mtimeMs) continue; // vault is newer; pull resolves
      if (entry && entry.device !== ctx.cfg.device) {
        log.warn(`memory ${ref.fileName}: overwriting ${entry.device}'s version (previous state stays in vault history)`);
      }
      const secrets = scanSecrets(tok);
      if (secrets.length > 0) {
        log.warn(`memory ${ref.fileName}: possible secrets (${describeFindings(secrets)})`);
      }
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, ref.fileName), tok);
      memIndex[ref.fileName] = {
        sha256: sha,
        byteLen: Buffer.byteLength(tok),
        mtimeMs: ref.mtimeMs,
        device: ctx.cfg.device,
        syncedAt: nowIso(),
      } satisfies MemoryEntry;
      result.memoryPushed++;
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
    `sync(${key.slug}): ${changed} session(s)${result.memoryPushed ? ` + ${result.memoryPushed} memory file(s)` : ''} from ${ctx.cfg.device}`,
  );
  return result;
}

export function pullSessions(ctx: SyncCtx, onlyId?: string): PullResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();

  const key = resolveRepoKey(ctx);
  const index = vault.loadIndex();
  const project = index.projects[key.dirName];
  const result: PullResult = {
    installed: 0,
    fastForwarded: 0,
    upToDate: 0,
    localAhead: 0,
    conflicts: 0,
    ignored: 0,
    memoryInstalled: 0,
    installedIds: [],
    updatedIds: [],
    detail: {},
  };
  if (!project) return result;

  for (const { adapter, env } of ctx.adapters) {
    const tool = project.tools[adapter.id];
    if (!tool) continue;
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: env.dataDir };
    // Local files may live under legacy munge variants — resolve by session id,
    // never by recomputing the directory name.
    const localById = new Map(adapter.locate(ctx.repoRoot, env).map((r) => [r.sessionId, r]));

    for (const [sessionId, entry] of Object.entries(tool.sessions)) {
      if (onlyId && sessionId !== onlyId) continue;
      if (ctx.ignore?.(sessionId, entry.name)) {
        result.ignored++;
        continue;
      }
      const tokenized = readTranscript(join(vault.path, key.dirName, adapter.id, 'sessions', sessionId));
      if (tokenized === null) continue;

      const local = localById.get(sessionId);
      if (!local) {
        const cwd = adapter.rehydrate(entry.cwdTok, pathCtx);
        const target = adapter.installPath({ sessionId, cwd, relPath: entry.relPath }, env);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, adapter.rehydrate(tokenized, pathCtx, { json: true }));
        result.installed++;
        result.installedIds.push(sessionId);
        result.detail[sessionId] = { summary: entry.summary, device: entry.device };
        continue;
      }

      const localTok = adapter.tokenize(readFileSync(local.filePath, 'utf8'), pathCtx, { json: true });
      if (localTok === tokenized) {
        result.upToDate++;
      } else if (isPrefixOf(localTok, tokenized)) {
        writeFileSync(local.filePath, adapter.rehydrate(tokenized, pathCtx, { json: true }));
        result.fastForwarded++;
        result.updatedIds.push(sessionId);
        result.detail[sessionId] = { summary: entry.summary, device: entry.device };
      } else if (isPrefixOf(tokenized, localTok)) {
        result.localAhead++; // we have unsynced turns; next push fast-forwards the vault
      } else {
        result.conflicts++;
        log.warn(
          `session ${sessionId.slice(0, 8)} diverged from vault; local kept, see chat status`,
        );
      }
    }
  }

  // ---- memory (newest-mtime-wins per file; overwrites are logged, history keeps everything)
  for (const { adapter, env } of ctx.adapters) {
    if (!adapter.locateMemory || !adapter.memoryPath) continue;
    const memIndex = project.tools[adapter.id]?.memory;
    if (!memIndex) continue;
    const pathCtx: PathCtx = { projectRoot: ctx.repoRoot, home: ctx.home, toolDataDir: env.dataDir };
    const localByName = new Map(adapter.locateMemory(ctx.repoRoot, env).map((r) => [r.fileName, r]));

    for (const [fileName, entry] of Object.entries(memIndex)) {
      const vaultFile = join(vault.path, key.dirName, adapter.id, 'memory', fileName);
      if (!existsSync(vaultFile)) continue;
      const tok = normalizeEol(readFileSync(vaultFile, 'utf8'));
      const local = localByName.get(fileName);

      if (!local) {
        const target = adapter.memoryPath(fileName, ctx.repoRoot, env);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, adapter.rehydrate(tok, pathCtx));
        result.memoryInstalled++;
        continue;
      }
      const localTok = normalizeEol(adapter.tokenize(readFileSync(local.filePath, 'utf8'), pathCtx));
      if (localTok === tok) continue;
      if (entry.mtimeMs > local.mtimeMs) {
        log.warn(`memory ${fileName}: replaced by newer version from ${entry.device} (previous state stays in vault history)`);
        writeFileSync(local.filePath, adapter.rehydrate(tok, pathCtx));
        result.memoryInstalled++;
      }
      // local newer: push resolves it
    }
  }
  return result;
}
