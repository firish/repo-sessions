import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { mkDevice, mkTmp, seedSession } from './helpers';

function rig(): {
  siteA: string;
  siteB: string;
  ctxA: SyncCtx;
  ctxB: SyncCtx;
  memA: string;
  memB: string;
  dirName: string;
} {
  const base = mkTmp('mem');
  const bareOrigin = join(base, 'origin.git');
  const bareVault = join(base, 'vault.git');
  git(['init', '--bare', '--quiet', bareOrigin]);
  git(['init', '--bare', '--quiet', bareVault]);
  const mkSite = (name: string): string => {
    const site = join(base, name, 'proj');
    git(['init', '--quiet', site]);
    git(['remote', 'add', 'origin', `file://${bareOrigin}`], { cwd: site });
    return site;
  };
  const siteA = mkSite('a');
  const siteB = mkSite('b');
  const devA = mkDevice(base, 'a');
  const devB = mkDevice(base, 'b');
  const ctx = (root: string, dev: typeof devA, device: string, clone: string): SyncCtx => ({
    repoRoot: root,
    cfg: { vaultUrl: `file://${bareVault}`, vaultPath: join(base, clone), device } satisfies CssConfig,
    home: dev.home,
    adapters: [{ adapter: claudeAdapter, env: dev.env }],
  });
  const ctxA = ctx(siteA, devA, 'laptop-a', 'clone-a');
  const ctxB = ctx(siteB, devB, 'laptop-b', 'clone-b');
  seedSession(devA.env, siteA, devA.home);
  const memA = join(devA.env.dataDir, mungeCurrent(siteA), 'memory');
  const memB = join(devB.env.dataDir, mungeCurrent(siteB), 'memory');
  mkdirSync(memA, { recursive: true });
  return { siteA, siteB, ctxA, ctxB, memA, memB, dirName: repoKeyFromOrigin(`file://${bareOrigin}`).dirName };
}

describe('project memory sync', () => {
  it('memory travels A -> vault -> B with paths rewritten; edits flow back newest-wins', () => {
    const { siteA, siteB, ctxA, ctxB, memA, memB } = rig();
    writeFileSync(join(memA, 'MEMORY.md'), `# Memory Index\n- project lives at ${siteA}\n`);
    writeFileSync(join(memA, 'facts.md'), 'the codeword is FIXTURE-7\n');

    const push = pushSessions(ctxA);
    expect(push.memoryPushed).toBe(2);

    const pull = pullSessions(ctxB);
    expect(pull.memoryInstalled).toBe(2);
    const onB = readFileSync(join(memB, 'MEMORY.md'), 'utf8');
    expect(onB).toContain(siteB); // rewritten for machine B
    expect(onB).not.toContain(siteA);

    // B edits (newer mtime), A pulls the update
    writeFileSync(join(memB, 'facts.md'), 'the codeword is FIXTURE-7\nnew fact from B\n');
    utimesSync(join(memB, 'facts.md'), new Date(), new Date(Date.now() + 5000));
    expect(pushSessions(ctxB).memoryPushed).toBe(1);
    expect(pullSessions(ctxA).memoryInstalled).toBe(1);
    expect(readFileSync(join(memA, 'facts.md'), 'utf8')).toContain('new fact from B');
  });

  it('stale local edits do not clobber a newer vault version (push skips; pull overwrites)', () => {
    const { ctxA, ctxB, memA, memB } = rig();
    writeFileSync(join(memA, 'facts.md'), 'v1\n');
    pushSessions(ctxA);
    pullSessions(ctxB);

    // B writes the newest version
    writeFileSync(join(memB, 'facts.md'), 'v2 from B\n');
    utimesSync(join(memB, 'facts.md'), new Date(), new Date(Date.now() + 60_000));
    pushSessions(ctxB);

    // A makes an OLDER divergent edit (clock says stale)
    writeFileSync(join(memA, 'facts.md'), 'stale divergent edit on A\n');
    utimesSync(join(memA, 'facts.md'), new Date(), new Date(Date.now() - 60_000));
    const pushA = pushSessions(ctxA);
    expect(pushA.memoryPushed).toBe(0); // vault is newer — push refuses to clobber

    const pullA = pullSessions(ctxA);
    expect(pullA.memoryInstalled).toBe(1); // newest-wins lands on A
    expect(readFileSync(join(memA, 'facts.md'), 'utf8')).toBe('v2 from B\n');
  });

  it('a CRLF copy of identical content is not an overwrite (autocrlf false positive)', () => {
    const { ctxA, ctxB, memA, memB } = rig();
    writeFileSync(join(memA, 'facts.md'), 'line one\nline two\n');
    pushSessions(ctxA);
    pullSessions(ctxB);

    // Simulate a Windows autocrlf checkout landing on B: same content, CRLF,
    // fresh mtime. Must sync as "unchanged", never as an overwrite of A.
    writeFileSync(join(memB, 'facts.md'), 'line one\r\nline two\r\n');
    utimesSync(join(memB, 'facts.md'), new Date(), new Date(Date.now() + 60_000));
    expect(pushSessions(ctxB).memoryPushed).toBe(0);
    expect(pullSessions(ctxA).memoryInstalled).toBe(0);
    expect(readFileSync(join(memA, 'facts.md'), 'utf8')).toBe('line one\nline two\n');
  });

  it('memory does not exist -> everything is a no-op', () => {
    const { ctxB } = rig();
    expect(existsSync(join(ctxB.repoRoot, 'nonexistent'))).toBe(false);
    const push = pushSessions(ctxB);
    expect(push.memoryPushed).toBe(0);
  });
});
