import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { makeIgnoreFn } from '../src/engine/ignore';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { rmSession } from '../src/engine/rm';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { Vault } from '../src/engine/vault';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

function rig(): { site: string; ctx: SyncCtx; dirName: string; file: string } {
  const base = mkTmp('rm');
  const bareOrigin = join(base, 'origin.git');
  const bareVault = join(base, 'vault.git');
  git(['init', '--bare', '--quiet', bareOrigin]);
  git(['init', '--bare', '--quiet', bareVault]);
  const site = join(base, 'proj');
  git(['init', '--quiet', site]);
  git(['remote', 'add', 'origin', `file://${bareOrigin}`], { cwd: site });
  const dev = mkDevice(base, 'a');
  const cfg: CssConfig = { vaultUrl: `file://${bareVault}`, vaultPath: join(base, 'clone'), device: 'laptop-a' };
  const ctx: SyncCtx = { repoRoot: site, cfg, home: dev.home, adapters: [{ adapter: claudeAdapter, env: dev.env }] };
  seedSession(dev.env, site, dev.home);
  return {
    site,
    ctx,
    dirName: repoKeyFromOrigin(`file://${bareOrigin}`).dirName,
    file: join(dev.env.dataDir, mungeCurrent(site), `${FIXTURE_SID}.jsonl`),
  };
}

describe('chat rm', () => {
  it('refuses to delete unsynced local turns without --force', () => {
    const { ctx } = rig(); // never pushed — vault has nothing
    expect(() => rmSession(ctx, FIXTURE_SID)).toThrow(/turns the vault does not/);
  });

  it('deletes local + vault + index when synced; vault history retains it', () => {
    const { ctx, dirName, file } = rig();
    pushSessions(ctx);
    const res = rmSession(ctx, FIXTURE_SID);
    expect(res).toMatchObject({ removedLocal: 1, removedVault: true });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(ctx.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID))).toBe(false);
    const index = new Vault(ctx.cfg).loadIndex();
    expect(index.projects[dirName]?.tools.claude?.sessions[FIXTURE_SID]).toBeUndefined();
    // recoverability: the vault's git history still has the transcript
    const show = git(['log', '--oneline', '--all'], { cwd: ctx.cfg.vaultPath });
    expect(show.stdout).toContain('rm(');
  });

  it('--force deletes divergent local copies', () => {
    const { ctx, file } = rig();
    pushSessions(ctx);
    appendFileSync(file, turnLine(ctx.repoRoot, '66666666-6666-6666-6666-666666666666', 'unsynced turn'));
    expect(() => rmSession(ctx, FIXTURE_SID)).toThrow();
    const res = rmSession(ctx, FIXTURE_SID, { force: true });
    expect(res.removedLocal).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

describe('.chatignore', () => {
  it('matches ids, names, and globs', () => {
    const fn = makeIgnoreFn([FIXTURE_SID, 'secret-work', 'scratch/*']);
    expect(fn(FIXTURE_SID)).toBe(true);
    expect(fn('other-id', 'secret-work')).toBe(true);
    expect(fn('other-id', 'scratch/experiment')).toBe(true);
    expect(fn('other-id', 'real-work')).toBe(false);
  });

  it('push and pull skip ignored sessions in both directions', () => {
    const { ctx, dirName } = rig();
    ctx.ignore = makeIgnoreFn([FIXTURE_SID]);
    const push = pushSessions(ctx);
    expect(push.ignored).toBe(1);
    expect(push.pushed).toBe(0);
    expect(existsSync(join(ctx.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID))).toBe(false);

    // sync it from another non-ignoring context, then confirm ignoring pull skips it
    const ctxOpen: SyncCtx = { ...ctx, ignore: undefined };
    expect(pushSessions(ctxOpen).pushed).toBe(1);
    const devB = mkDevice(mkTmp('rm-b'), 'b');
    const ctxB: SyncCtx = {
      repoRoot: ctx.repoRoot,
      cfg: { ...ctx.cfg, vaultPath: join(mkTmp('rm-clone'), 'clone-b') },
      home: devB.home,
      adapters: [{ adapter: claudeAdapter, env: devB.env }],
      ignore: makeIgnoreFn([FIXTURE_SID]),
    };
    const pull = pullSessions(ctxB);
    expect(pull.ignored).toBe(1);
    expect(pull.installed).toBe(0);
  });
});
