import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AdapterEnv, InstallRef, PathCtx, SessionRef } from '../types.js';

/**
 * Codex adapter — mechanics validated by M0 Track B on codex 0.145:
 *
 * - Rollout JSONLs live in a machine-global date tree,
 *   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, keyed by date,
 *   NOT by project — locate() filters by the cwd inside session_meta.
 * - `codex exec resume <id>` needs only the rollout file; the state_5.sqlite
 *   `threads` index self-heals a correct row on first resume, so we never
 *   write the DB. Until that first resume, the session is absent from the
 *   interactive picker but fully resumable by id (documented asymmetry).
 * - Rollouts embed THREE path roots: the project cwd, $CODEX_HOME itself
 *   (rollout_path self-references), and $HOME.
 * - The date-tree relPath contains no machine paths, so install preserves it
 *   verbatim — resume-by-id and self-heal both find the file there.
 * - Triggers: git hooks only (codex has no session-lifecycle plugin hooks).
 */

const TOKEN_ROOT = '${CSS_PROJECT_ROOT}';
const TOKEN_CODEX_HOME = '${CSS_CODEX_HOME}';
const TOKEN_HOME = '${CSS_HOME}';

const HEAD_CHUNK = 128 * 1024;
const TAIL_CHUNK = 64 * 1024;

function readChunk(filePath: string, start: number, length: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

interface RolloutMeta {
  sessionId: string;
  cwd: string;
  toolVersion?: string;
  summary?: string;
  lastTs?: string;
}

/** First line is session_meta with payload.{id,cwd,cli_version}; a
 *  user_message event supplies the summary. */
function scanRollout(filePath: string, size: number): RolloutMeta | null {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let toolVersion: string | undefined;
  let summary: string | undefined;

  for (const line of readChunk(filePath, 0, Math.min(size, HEAD_CHUNK)).split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    if (obj.type === 'session_meta') {
      if (typeof payload.id === 'string') sessionId = payload.id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.cli_version === 'string') toolVersion = payload.cli_version;
    }
    if (!summary && payload.type === 'user_message' && typeof payload.message === 'string') {
      summary = payload.message.slice(0, 100);
    }
    if (sessionId && cwd && summary) break;
  }
  if (!sessionId || !cwd) return null;

  let lastTs: string | undefined;
  const tailStart = Math.max(0, size - TAIL_CHUNK);
  const tailLines = readChunk(filePath, tailStart, Math.min(size, TAIL_CHUNK)).split('\n');
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line || !line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.timestamp === 'string') {
        lastTs = obj.timestamp;
        break;
      }
    } catch {
      continue;
    }
  }
  return { sessionId, cwd, toolVersion, summary, lastTs };
}

function* walkRollouts(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkRollouts(p);
    else if (st.isFile() && entry.startsWith('rollout-') && entry.endsWith('.jsonl')) yield p;
  }
}

export const codexAdapter: Adapter = {
  id: 'codex',

  detect(env: AdapterEnv): boolean {
    return existsSync(env.dataDir);
  },

  locate(repoRoot: string, env: AdapterEnv): SessionRef[] {
    const sessionsDir = join(env.dataDir, 'sessions');
    const refs: SessionRef[] = [];
    for (const filePath of walkRollouts(sessionsDir)) {
      const st = statSync(filePath);
      const meta = scanRollout(filePath, st.size);
      if (!meta) continue;
      if (meta.cwd !== repoRoot && !meta.cwd.startsWith(`${repoRoot}/`)) continue;
      refs.push({
        sessionId: meta.sessionId,
        filePath,
        relPath: relative(env.dataDir, filePath),
        cwd: meta.cwd,
        byteLen: st.size,
        mtimeMs: st.mtimeMs,
        toolVersion: meta.toolVersion,
        summary: meta.summary,
        lastTs: meta.lastTs,
      });
    }
    return refs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },

  tokenize(content: string, ctx: PathCtx): string {
    let out = content.replaceAll(ctx.projectRoot, TOKEN_ROOT);
    if (ctx.toolDataDir) out = out.replaceAll(ctx.toolDataDir, TOKEN_CODEX_HOME);
    return out.replaceAll(ctx.home, TOKEN_HOME);
  },

  rehydrate(content: string, ctx: PathCtx): string {
    let out = content.replaceAll(TOKEN_ROOT, ctx.projectRoot);
    if (ctx.toolDataDir) out = out.replaceAll(TOKEN_CODEX_HOME, ctx.toolDataDir);
    return out.replaceAll(TOKEN_HOME, ctx.home);
  },

  // Date-tree paths are machine-neutral; preserving them keeps resume-by-id
  // and the DB self-heal working. Fall back to today's shape if absent.
  installPath(ref: InstallRef, env: AdapterEnv): string {
    if (ref.relPath) return join(env.dataDir, ref.relPath);
    return join(env.dataDir, 'sessions', 'synced', `rollout-synced-${ref.sessionId}.jsonl`);
  },

  verifyResume(sessionId: string, repoRoot: string, env: AdapterEnv): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'codex',
        ['exec', 'resume', sessionId, 'Reply with exactly: CSS-VERIFY-OK'],
        { cwd: repoRoot, env: { ...process.env, CODEX_HOME: env.dataDir }, timeout: 180_000 },
        (err, stdout) => resolve(!err && stdout.includes('CSS-VERIFY-OK')),
      );
    });
  },
};
