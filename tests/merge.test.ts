import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { duplicateContent, mergeSession, planMerge, spliceMerge, type Branch } from '../src/engine/merge';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { readTranscript } from '../src/engine/vault';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

const line = (uuid: string, parent: string | null, text: string): string =>
  JSON.stringify({ parentUuid: parent, type: 'user', message: { role: 'user', content: text }, uuid, sessionId: 's', timestamp: '2026-07-28T00:00:00.000Z' });

describe('merge planning + splice (pure)', () => {
  it('splices a divergent tail and re-parents it onto the trunk leaf', () => {
    const prefix = [line('u1', null, 'shared one'), line('u2', 'u1', 'shared two')];
    const trunk: Branch = { name: 'vault', lines: [...prefix, line('a3', 'u2', 'laptop A turn'), line('a4', 'a3', 'more A')] };
    const other: Branch = { name: 'conflict:b', lines: [...prefix, line('b3', 'u2', 'laptop B turn')] };

    const plan = planMerge([trunk, other]);
    expect(plan.trunk.name).toBe('vault');
    expect(plan.tails).toHaveLength(1);

    const merged = spliceMerge(plan);
    expect(merged).toContain('laptop A turn');
    expect(merged, 'B tail preserved').toContain('laptop B turn');
    const bLine = JSON.parse(merged.split('\n').find((l) => l.includes('laptop B turn'))!) as { parentUuid: string };
    expect(bLine.parentUuid, 'seam re-parented onto trunk leaf').toBe('a4');
  });

  it('absorbs branches that are pure prefixes', () => {
    const prefix = [line('u1', null, 'one'), line('u2', 'u1', 'two')];
    const plan = planMerge([
      { name: 'vault', lines: [...prefix, line('a3', 'u2', 'three')] },
      { name: 'conflict:old', lines: prefix },
    ]);
    expect(plan.tails).toHaveLength(0);
    expect(plan.absorbed).toEqual(['conflict:old']);
  });

  it('refuses tails containing compaction records, pointing at --split', () => {
    const prefix = [line('u1', null, 'one')];
    const compactTail = { name: 'conflict:b', lines: [...prefix, '{"type":"summary","summary":"compacted","leafUuid":"x"}', line('b2', 'u1', 'after compact')] };
    expect(() => planMerge([{ name: 'vault', lines: [...prefix, line('a2', 'u1', 'A'), line('a3', 'a2', 'AA')] }, compactTail])).toThrowError(/compaction record/);
    try {
      planMerge([{ name: 'vault', lines: [...prefix, line('a2', 'u1', 'A'), line('a3', 'a2', 'AA')] }, compactTail]);
    } catch (e) {
      expect((e as { hint?: string }).hint).toContain('chat split');
    }
  });

  it('duplicateContent rewrites every occurrence of the old id', () => {
    const old = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001';
    const { content, newSessionId } = duplicateContent(`{"sessionId":"${old}","path":"rollout-${old}.jsonl"}`, old);
    expect(content).not.toContain(old);
    expect(content).toContain(newSessionId);
    expect(newSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

/** Same two-laptop rig as sync.test, driven into divergence. */
function divergedRig(): { siteA: string; siteB: string; ctxA: SyncCtx; ctxB: SyncCtx; dirName: string; fileA: string; fileB: string } {
  const base = mkTmp('merge');
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
  pushSessions(ctxA);
  pullSessions(ctxB);
  const fileA = join(devA.env.dataDir, mungeCurrent(siteA), `${FIXTURE_SID}.jsonl`);
  const fileB = join(devB.env.dataDir, mungeCurrent(siteB), `${FIXTURE_SID}.jsonl`);
  appendFileSync(fileA, turnLine(siteA, '44444444-4444-4444-4444-444444444444', 'divergent turn on A'));
  appendFileSync(fileB, turnLine(siteB, '55555555-5555-5555-5555-555555555555', 'divergent turn on B'));
  pushSessions(ctxA); // A fast-forwards the vault
  pushSessions(ctxB); // B lands as a conflict copy
  return { siteA, siteB, ctxA, ctxB, dirName: repoKeyFromOrigin(`file://${bareOrigin}`).dirName, fileA, fileB };
}

describe('mergeSession (integration)', () => {
  it('reconciles a real divergence: both tails kept, conflicts cleared, all devices converge', () => {
    const { siteA, siteB, ctxA, ctxB, dirName, fileA, fileB } = divergedRig();

    const res = mergeSession(ctxB, FIXTURE_SID);
    expect(res.mode).toBe('merge');

    // vault canonical now holds both tails; conflict copies are gone
    const sessionDir = join(ctxB.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID);
    const merged = readTranscript(sessionDir)!;
    expect(merged).toContain('divergent turn on A');
    expect(merged).toContain('divergent turn on B');
    expect(readdirSync(sessionDir).some((f) => f.includes('conflict'))).toBe(false);

    // B's local file got the merged transcript, rehydrated for B
    const localB = readFileSync(fileB, 'utf8');
    expect(localB).toContain('divergent turn on A');
    expect(localB).toContain(`"cwd":${JSON.stringify(siteB)}`);

    // A simply fast-forwards on next pull — its copy was the merge trunk
    const pullA = pullSessions(ctxA);
    expect(pullA.fastForwarded).toBe(1);
    const localA = readFileSync(fileA, 'utf8');
    expect(localA).toContain('divergent turn on B');
    expect(localA).toContain(`"cwd":${JSON.stringify(siteA)}`);
    expect(localA).not.toContain(siteB);
  });

  it('--split turns the divergent branch into its own session and resets the old id', () => {
    const { siteB, ctxB, dirName } = divergedRig();

    const res = mergeSession(ctxB, FIXTURE_SID, { split: true });
    expect(res.mode).toBe('split');
    expect(res.splits).toHaveLength(1); // local dupe of the conflict copy deduped away
    const split = res.splits![0]!;
    expect(split.newSessionId).not.toBe(FIXTURE_SID);

    // the new session exists locally, fully rewritten to the new id
    const content = readFileSync(split.targetPath, 'utf8');
    expect(content).toContain('divergent turn on B');
    expect(content).toContain(split.newSessionId);
    expect(content).not.toContain(FIXTURE_SID);

    // old id converged on the vault transcript (A's line, not B's)
    expect(res.localReset).toBe(true);
    const fileB = join(ctxB.adapters[0]!.env.dataDir, mungeCurrent(siteB), `${FIXTURE_SID}.jsonl`);
    const oldId = readFileSync(fileB, 'utf8');
    expect(oldId).toContain('divergent turn on A');
    expect(oldId).not.toContain('divergent turn on B');

    // conflict copies cleared in the vault
    const sessionDir = join(ctxB.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID);
    expect(existsSync(sessionDir)).toBe(true);
    expect(readdirSync(sessionDir).some((f) => f.includes('conflict'))).toBe(false);
  });
});
