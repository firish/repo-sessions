import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../src/engine/git';
import { hookStatus, installHooks, uninstallHooks } from '../src/engine/hooks';
import { mkTmp } from './helpers';

/** A repo plus a fake `css` that records how it was invoked. */
function rig(): { repo: string; cssLog: string; cssCmd: string } {
  const base = mkTmp('hooks');
  const repo = join(base, 'repo');
  git(['init', '--quiet', repo]);
  const cssLog = join(base, 'css-invocations.log');
  const shim = join(base, 'css-shim.sh');
  writeFileSync(shim, `#!/bin/sh\necho "css $@" >> "${cssLog}"\nexit 0\n`);
  chmodSync(shim, 0o755);
  return { repo, cssLog, cssCmd: `"${shim}"` };
}

function hookPath(repo: string, name: string): string {
  return join(repo, '.git', 'hooks', name);
}

describe('git hook installer', () => {
  it('installs all three hooks, executable, and pre-push invokes css push -q', () => {
    const { repo, cssLog, cssCmd } = rig();
    const results = installHooks(repo, cssCmd);
    expect(results.map((r) => r.action)).toEqual(['installed', 'installed', 'installed']);

    const run = spawnSync('sh', [hookPath(repo, 'pre-push')], { input: 'refs/heads/main abc refs/heads/main def\n' });
    expect(run.status).toBe(0);
    expect(readFileSync(cssLog, 'utf8')).toContain('css push -q');
  });

  it('chain-loads an existing hook: original runs first with stdin, its failure aborts', () => {
    const { repo, cssLog, cssCmd } = rig();
    const sentinel = join(repo, 'chained-ran.txt');
    writeFileSync(hookPath(repo, 'pre-push'), `#!/bin/sh\ncat > "${sentinel}"\nexit 0\n`);
    chmodSync(hookPath(repo, 'pre-push'), 0o755);

    const results = installHooks(repo, cssCmd);
    expect(results.find((r) => r.name === 'pre-push')?.action).toBe('chained');
    expect(existsSync(hookPath(repo, 'pre-push.css-chained'))).toBe(true);

    const run = spawnSync('sh', [hookPath(repo, 'pre-push')], { input: 'ref-data\n' });
    expect(run.status).toBe(0);
    expect(readFileSync(sentinel, 'utf8')).toContain('ref-data'); // stdin reached the chained hook
    expect(readFileSync(cssLog, 'utf8')).toContain('css push -q'); // and css still ran

    // a failing chained hook must abort the git operation before css runs
    writeFileSync(hookPath(repo, 'pre-push.css-chained'), '#!/bin/sh\nexit 7\n');
    chmodSync(hookPath(repo, 'pre-push.css-chained'), 0o755);
    writeFileSync(cssLog, '');
    const fail = spawnSync('sh', [hookPath(repo, 'pre-push')]);
    expect(fail.status).toBe(7);
    expect(readFileSync(cssLog, 'utf8')).not.toContain('push');
  });

  it('reinstall is idempotent (updates in place, keeps the chain)', () => {
    const { repo, cssCmd } = rig();
    writeFileSync(hookPath(repo, 'post-merge'), '#!/bin/sh\nexit 0\n');
    installHooks(repo, cssCmd);
    const second = installHooks(repo, cssCmd);
    expect(second.find((r) => r.name === 'post-merge')?.action).toBe('updated');
    expect(existsSync(hookPath(repo, 'post-merge.css-chained'))).toBe(true);
    expect(hookStatus(repo).find((s) => s.name === 'post-merge')?.state).toBe('ours+chained');
  });

  it('uninstall removes ours and restores the original', () => {
    const { repo, cssCmd } = rig();
    const original = '#!/bin/sh\necho original\n';
    writeFileSync(hookPath(repo, 'pre-push'), original);
    installHooks(repo, cssCmd);
    const results = uninstallHooks(repo);
    expect(results.find((r) => r.name === 'pre-push')?.action).toBe('restored');
    expect(readFileSync(hookPath(repo, 'pre-push'), 'utf8')).toBe(original);
    expect(existsSync(hookPath(repo, 'pre-push.css-chained'))).toBe(false);
    // hooks we never chained are simply removed
    expect(results.find((r) => r.name === 'post-merge')?.action).toBe('removed');
    expect(existsSync(hookPath(repo, 'post-merge'))).toBe(false);
  });

  it('never touches a foreign hook on uninstall', () => {
    const { repo } = rig();
    writeFileSync(hookPath(repo, 'pre-push'), '#!/bin/sh\necho theirs\n');
    const results = uninstallHooks(repo);
    expect(results.find((r) => r.name === 'pre-push')?.action).toBe('skipped');
    expect(readFileSync(hookPath(repo, 'pre-push'), 'utf8')).toContain('theirs');
  });
});
