import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { findSessionInHistory, forkSessionAt, listRemovedSessions, restoreSession } from '../src/engine/history';
import { rmSession } from '../src/engine/rm';
import { pushSessions, type SyncCtx } from '../src/engine/sync';
import { Vault } from '../src/engine/vault';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

function rig(): { site: string; ctx: SyncCtx; vault: Vault; dirName: () => string; file: string } {
  const base = mkTmp('hist');
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
  const vault = new Vault(cfg);
  return {
    site,
    ctx,
    vault,
    dirName: () => Object.keys(vault.loadIndex().projects)[0]!,
    file: join(dev.env.dataDir, mungeCurrent(site), `${FIXTURE_SID}.jsonl`),
  };
}

describe('vault time travel', () => {
  it('rm -> restore round-trip: transcript, index entry, and local file come back', () => {
    const { ctx, vault, dirName, file } = rig();
    pushSessions(ctx);
    const originalLocal = readFileSync(file, 'utf8');
    rmSession(ctx, FIXTURE_SID);
    expect(existsSync(file)).toBe(false);

    const removed = listRemovedSessions(vault);
    expect(removed.map((r) => r.id)).toContain(FIXTURE_SID); // full id parseable from the rm commit

    const res = restoreSession(ctx, FIXTURE_SID);
    expect(res.toolId).toBe('claude');
    expect(res.installedAt).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(originalLocal);
    expect(vault.loadIndex().projects[dirName()]!.tools.claude!.sessions[FIXTURE_SID]).toBeDefined();

    // restoring an existing session is refused, pointing at fork --at
    expect(() => restoreSession(ctx, FIXTURE_SID)).toThrow(/already exists/);
  });

  it('fork --at recovers the state at a specific vault commit', () => {
    const { ctx, file } = rig();
    pushSessions(ctx);
    const v1Hash = git(['rev-parse', 'HEAD'], { cwd: ctx.cfg.vaultPath }).stdout;

    appendFileSync(file, turnLine(ctx.repoRoot, '77777777-7777-7777-7777-777777777777', 'turn after v1'));
    pushSessions(ctx);

    // fork from the older state: the fork must NOT contain the later turn
    const fork = forkSessionAt(ctx, FIXTURE_SID, v1Hash);
    expect(fork.newSessionId).not.toBe(FIXTURE_SID);
    const content = readFileSync(fork.targetPath, 'utf8');
    expect(content).toContain(fork.newSessionId);
    expect(content).not.toContain(FIXTURE_SID);
    expect(content).not.toContain('turn after v1');
    expect(content).toContain(`"cwd":${JSON.stringify(ctx.repoRoot)}`); // rehydrated for this machine

    // fork with no --at takes the newest state (including the later turn)
    const forkNow = forkSessionAt(ctx, FIXTURE_SID);
    expect(readFileSync(forkNow.targetPath, 'utf8')).toContain('turn after v1');
  });

  it('findSessionInHistory skips commits where the session is absent (the rm commit)', () => {
    const { ctx, vault, dirName } = rig();
    pushSessions(ctx);
    rmSession(ctx, FIXTURE_SID);
    const hist = findSessionInHistory(vault, dirName(), FIXTURE_SID);
    expect(hist).not.toBeNull();
    expect(hist!.transcriptTok).toContain('FIXTURE-7');
    expect(hist!.meta?.cwdTok).toBe('${CSS_PROJECT_ROOT}');
  });
});
