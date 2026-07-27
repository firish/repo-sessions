import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter, AdapterEnv, PathCtx, SessionRef } from '../types.js';
import { mungeCurrent, mungeVariants } from './munge.js';

const TOKEN_ROOT = '${CSS_PROJECT_ROOT}';
const TOKEN_DIRNAME = '${CSS_PROJECT_DIRNAME}';
const TOKEN_HOME = '${CSS_HOME}';

const HEAD_CHUNK = 256 * 1024;
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

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        return (block as { text?: string }).text;
      }
    }
  }
  return undefined;
}

interface ScanMeta {
  sessionId: string;
  cwd: string;
  toolVersion?: string;
  summary?: string;
  lastTs?: string;
}

/** Pull identifying metadata out of a transcript without loading huge files
 *  whole. Early lines can lack cwd (queue-operation records), so scan until
 *  both cwd and sessionId are seen. */
function scanSession(filePath: string, size: number): ScanMeta | null {
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
      continue; // tolerate a line truncated by the chunk boundary
    }
    if (!sessionId && typeof obj.sessionId === 'string') sessionId = obj.sessionId;
    if (!cwd && typeof obj.cwd === 'string') {
      cwd = obj.cwd;
      if (typeof obj.version === 'string') toolVersion = obj.version;
    }
    if (!summary && obj.type === 'user' && obj.message && typeof obj.message === 'object') {
      const text = extractText((obj.message as { content?: unknown }).content);
      if (text) summary = text.slice(0, 100);
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

export const claudeAdapter: Adapter = {
  id: 'claude',

  detect(env: AdapterEnv): boolean {
    return existsSync(join(env.home, '.claude'));
  },

  locate(repoRoot: string, env: AdapterEnv): SessionRef[] {
    if (!existsSync(env.dataDir)) return [];
    const variants = mungeVariants(repoRoot);
    const refs: SessionRef[] = [];

    for (const dirName of readdirSync(env.dataDir)) {
      // Exact match = sessions started at the repo root; prefix match = sessions
      // started in subdirs (munge(root + "/sub") === munge(root) + "-sub..."). The
      // prefix can false-positive on sibling paths (/repo-extra), so membership is
      // always confirmed against the cwd recorded inside the transcript.
      if (!variants.some((v) => dirName === v || dirName.startsWith(`${v}-`))) continue;
      const dirPath = join(env.dataDir, dirName);
      if (!statSync(dirPath).isDirectory()) continue;

      for (const entry of readdirSync(dirPath)) {
        if (!entry.endsWith('.jsonl')) continue;
        const filePath = join(dirPath, entry);
        const st = statSync(filePath);
        if (!st.isFile()) continue;
        const meta = scanSession(filePath, st.size);
        if (!meta) continue;
        if (meta.cwd !== repoRoot && !meta.cwd.startsWith(`${repoRoot}/`)) continue;
        refs.push({
          sessionId: meta.sessionId,
          filePath,
          cwd: meta.cwd,
          byteLen: st.size,
          mtimeMs: st.mtimeMs,
          toolVersion: meta.toolVersion,
          summary: meta.summary,
          lastTs: meta.lastTs,
        });
      }
    }
    return refs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },

  tokenize(content: string, ctx: PathCtx): string {
    let out = content.replaceAll(ctx.projectRoot, TOKEN_ROOT);
    // Munged dirnames appear when tool output references ~/.claude/projects/...;
    // prefix substitution also covers subdir dirnames (munge(root) + "-sub").
    for (const variant of mungeVariants(ctx.projectRoot)) {
      out = out.replaceAll(variant, TOKEN_DIRNAME);
    }
    return out.replaceAll(ctx.home, TOKEN_HOME);
  },

  rehydrate(content: string, ctx: PathCtx): string {
    return content
      .replaceAll(TOKEN_ROOT, ctx.projectRoot)
      .replaceAll(TOKEN_DIRNAME, mungeCurrent(ctx.projectRoot))
      .replaceAll(TOKEN_HOME, ctx.home);
  },

  installDir(cwd: string, env: AdapterEnv): string {
    return join(env.dataDir, mungeCurrent(cwd));
  },

  verifyResume(sessionId: string, repoRoot: string): Promise<boolean> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('CLAUDE')) env[k] = v;
    }
    return new Promise((resolve) => {
      execFile(
        'claude',
        ['-p', '--model', 'haiku', '--resume', sessionId, 'Reply with exactly: CSS-VERIFY-OK'],
        { cwd: repoRoot, env, timeout: 180_000 },
        (err, stdout) => resolve(!err && stdout.includes('CSS-VERIFY-OK')),
      );
    });
  },
};

/** Raw transcript bytes for a located session (exposed for the sync engine). */
export function readTranscript(ref: SessionRef): string {
  return readFileSync(ref.filePath, 'utf8');
}
