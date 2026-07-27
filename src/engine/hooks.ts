import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, gitCommonDir } from './git.js';

/**
 * Git hook installer (ADR-4). Three hooks ride the user's existing git
 * muscle memory:
 *   pre-push       css push -q   (foreground — sessions leave with the code)
 *   post-merge     css pull -q   (background — after git pull)
 *   post-checkout  css pull -q   (background — after clone/branch switch)
 *
 * Chain-loading: a pre-existing hook is moved to <name>.css-chained and runs
 * first, with argv and stdin preserved; its failure still aborts the git
 * operation. Our sync step can never fail the operation (G5).
 */

export const HOOK_NAMES = ['pre-push', 'post-merge', 'post-checkout'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

const MARKER = 'repo-sessions:hook v1';
const CHAIN_SUFFIX = '.css-chained';

export interface HookActionResult {
  name: HookName;
  action: 'installed' | 'chained' | 'updated' | 'removed' | 'restored' | 'skipped';
  note?: string;
}

export interface HookStateResult {
  name: HookName;
  state: 'ours' | 'ours+chained' | 'foreign' | 'none';
}

/** Repos using core.hooksPath (husky et al.) keep their hooks inside the
 *  project tree — writing there would leak tooling into tracked files, so we
 *  refuse and let the user add `css push -q` to their own pipeline. */
export function customHooksPath(repoRoot: string): string | null {
  const res = git(['config', '--get', 'core.hooksPath'], { cwd: repoRoot, allowFail: true });
  return res.ok && res.stdout ? res.stdout : null;
}

function hooksDir(repoRoot: string): string {
  return join(gitCommonDir(repoRoot), 'hooks');
}

function buildScript(name: HookName, cssCmd: string): string {
  const sync =
    name === 'pre-push'
      ? `${cssCmd} push -q || true`
      : `( ${cssCmd} pull -q >/dev/null 2>&1 & )`;
  return `#!/bin/sh
# ${MARKER} (${name})
# Managed by repo-sessions — \`css hooks uninstall\` removes this and restores
# any chained hook. Session sync never fails the git operation.
tmp=$(mktemp) || exit 0
cat >"$tmp" 2>/dev/null || true
if [ -x "$0${CHAIN_SUFFIX}" ]; then
  "$0${CHAIN_SUFFIX}" "$@" <"$tmp"
  chained=$?
  if [ $chained -ne 0 ]; then rm -f "$tmp"; exit $chained; fi
fi
rm -f "$tmp"
${sync}
exit 0
`;
}

function isOurs(path: string): boolean {
  return existsSync(path) && readFileSync(path, 'utf8').includes(MARKER);
}

export function installHooks(repoRoot: string, cssCmd: string): HookActionResult[] {
  const dir = hooksDir(repoRoot);
  const results: HookActionResult[] = [];

  for (const name of HOOK_NAMES) {
    const hookPath = join(dir, name);
    const chainPath = hookPath + CHAIN_SUFFIX;

    if (isOurs(hookPath)) {
      writeFileSync(hookPath, buildScript(name, cssCmd));
      chmodSync(hookPath, 0o755);
      results.push({ name, action: 'updated' });
      continue;
    }
    if (existsSync(hookPath)) {
      if (existsSync(chainPath)) {
        // A foreign hook AND an old chain: someone replaced our hook by hand.
        // Refuse rather than risk clobbering either of them.
        results.push({ name, action: 'skipped', note: `both ${name} and ${name}${CHAIN_SUFFIX} exist — resolve manually` });
        continue;
      }
      renameSync(hookPath, chainPath);
      writeFileSync(hookPath, buildScript(name, cssCmd));
      chmodSync(hookPath, 0o755);
      results.push({ name, action: 'chained', note: `existing hook preserved as ${name}${CHAIN_SUFFIX}` });
      continue;
    }
    writeFileSync(hookPath, buildScript(name, cssCmd));
    chmodSync(hookPath, 0o755);
    results.push({ name, action: 'installed' });
  }
  return results;
}

export function uninstallHooks(repoRoot: string): HookActionResult[] {
  const dir = hooksDir(repoRoot);
  const results: HookActionResult[] = [];

  for (const name of HOOK_NAMES) {
    const hookPath = join(dir, name);
    const chainPath = hookPath + CHAIN_SUFFIX;

    if (!isOurs(hookPath)) {
      results.push({ name, action: 'skipped', note: existsSync(hookPath) ? 'not ours — left in place' : 'not installed' });
      continue;
    }
    rmSync(hookPath);
    if (existsSync(chainPath)) {
      renameSync(chainPath, hookPath);
      results.push({ name, action: 'restored', note: 'original hook restored' });
    } else {
      results.push({ name, action: 'removed' });
    }
  }
  return results;
}

export function hookStatus(repoRoot: string): HookStateResult[] {
  const dir = hooksDir(repoRoot);
  return HOOK_NAMES.map((name) => {
    const hookPath = join(dir, name);
    if (isOurs(hookPath)) {
      return { name, state: existsSync(hookPath + CHAIN_SUFFIX) ? 'ours+chained' : 'ours' } as HookStateResult;
    }
    return { name, state: existsSync(hookPath) ? 'foreign' : 'none' } as HookStateResult;
  });
}

/** Absolute-path invocation used inside hook scripts when `css` is not on
 *  PATH (dev installs). Exported so `enable` can resolve it once. */
export function absoluteCssInvocation(): string {
  return `"${process.execPath}" "${resolve(process.argv[1] ?? '')}"`;
}
