import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { CssError } from './common.js';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export function git(
  args: string[],
  opts: { cwd?: string; allowFail?: boolean; timeoutMs?: number } = {},
): GitResult {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: GitResult = {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status,
  };
  if (!out.ok && !opts.allowFail) {
    throw new CssError(`git ${args[0]} failed: ${out.stderr || out.stdout || `exit ${out.status}`}`);
  }
  return out;
}

/** Toplevel of the repo containing cwd, or null when outside any repo. */
export function repoToplevel(cwd: string): string | null {
  const res = git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  return res.ok ? res.stdout : null;
}

export function originUrl(repoRoot: string): string | null {
  const res = git(['remote', 'get-url', 'origin'], { cwd: repoRoot, allowFail: true });
  return res.ok ? res.stdout : null;
}

/** Shared .git dir — worktrees of one repo resolve to the same place, so the
 *  enable marker is common to all of them. */
export function gitCommonDir(repoRoot: string): string {
  const res = git(['rev-parse', '--git-common-dir'], { cwd: repoRoot });
  return resolve(repoRoot, res.stdout);
}
