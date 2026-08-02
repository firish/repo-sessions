import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import { canonForCompare } from '../src/adapters/types';
import { sha256hex } from '../src/engine/common';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { mergeSession } from '../src/engine/merge';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { readTranscript } from '../src/engine/vault';
import { FIXTURE_SID, aiTitleLine, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

/**
 * Tokenization is machine-relative: device A cannot recognize device B's
 * path spellings, so a transcript that QUOTES them as data (a session about
 * the tool itself: pasted meta.json, dirnames, terminal output) reaches the
 * vault with B's spellings intact — and B's own tokenize then collapses
 * them, so B can never reproduce the vault bytes. Real incident: session
 * 003ab73d read as diverged forever, and every `chat rebase` spliced a
 * false tail — 471 → 881 → 1701 lines, turns duplicated up to 8×.
 */

const QUOTE_UUID = '66666666-6666-6666-6666-666666666666';

function rig(): { siteA: string; siteB: string; ctxA: SyncCtx; ctxB: SyncCtx; dirName: string; fileA: string; fileB: string } {
  const base = mkTmp('normalform');
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

  const fileA = seedSession(devA.env, siteA, devA.home);
  // The self-referential turn: A's transcript quotes B's dirname and B's
  // project path as data. A's tokenizer does not know these spellings;
  // B's does.
  appendFileSync(fileA, turnLine(siteA, QUOTE_UUID, `debugging sync: vault dir is ${mungeCurrent(siteB)} and the repo lives at ${siteB}`));
  const fileB = join(devB.env.dataDir, mungeCurrent(siteB), `${FIXTURE_SID}.jsonl`);
  return { siteA, siteB, ctxA, ctxB, dirName: repoKeyFromOrigin(`file://${bareOrigin}`).dirName, fileA, fileB };
}

describe('canonForCompare', () => {
  it('is a projection: applying it twice equals applying it once', () => {
    const { siteB, ctxB, ctxA, siteA } = rig();
    const pathCtxA = { projectRoot: siteA, home: ctxA.home, toolDataDir: ctxA.adapters[0]!.env.dataDir };
    const pathCtxB = { projectRoot: siteB, home: ctxB.home, toolDataDir: ctxB.adapters[0]!.env.dataDir };
    // Content as it would arrive from A: A's tokenization, B's spellings quoted raw.
    const fromA = claudeAdapter.tokenize(
      readFileSync(join(ctxA.adapters[0]!.env.dataDir, mungeCurrent(siteA), `${FIXTURE_SID}.jsonl`), 'utf8'),
      pathCtxA,
      { json: true },
    );
    const ctxs = [pathCtxB, pathCtxA];
    const once = canonForCompare(claudeAdapter, fromA, ctxs, { json: true });
    const twice = canonForCompare(claudeAdapter, once, ctxs, { json: true });
    expect(once).not.toBe(fromA); // the fold genuinely collapses quoted foreign spellings
    expect(twice).toBe(once);
  });
});

describe('volatile ai-title records', () => {
  it('stripVolatile drops ai-title lines in any key order but keeps turns that quote them as data', () => {
    const title = aiTitleLine('Debug chat list divergence across machines');
    const reordered = `${JSON.stringify({ sessionId: FIXTURE_SID, type: 'ai-title', aiTitle: 'retitled' })}\n`;
    const quoting = turnLine('/tmp/x', QUOTE_UUID, 'look: {"type":"ai-title","aiTitle":"quoted as data"}');
    expect(claudeAdapter.stripVolatile!(title + reordered + quoting)).toBe(quoting);
    expect(claudeAdapter.stripVolatile!(quoting)).toBe(quoting);
  });

  it('interleaved title refreshes never read as divergence (incident: 003ab73d stuck diverged when truly behind)', () => {
    const { ctxA, ctxB, fileA, fileB } = rig();
    // A runs live: a title refresh lands mid-transcript before the push.
    appendFileSync(fileA, aiTitleLine('Debug chat list divergence across machines'));
    expect(pushSessions(ctxA).pushed).toBe(1);
    expect(pullSessions(ctxB).installed).toBe(1);

    // B's Claude Code generates its own title record locally.
    appendFileSync(fileB, aiTitleLine('a title only B has'));
    const pushB = pushSessions(ctxB);
    expect(pushB.upToDate).toBe(1);
    expect(pushB.conflicts).toBe(0);

    // A continues the session (new turn + fresh title) — B's copy now has a
    // title line the vault lacks AND the vault is longer: the 003ab73d shape.
    appendFileSync(fileA, turnLine(ctxA.repoRoot, '88888888-8888-8888-8888-888888888888', 'continued on A'));
    appendFileSync(fileA, aiTitleLine('Debug chat list divergence across machines'));
    expect(pushSessions(ctxA).fastForwarded).toBe(1);

    const pullB = pullSessions(ctxB);
    expect(pullB.conflicts).toBe(0);
    expect(pullB.fastForwarded).toBe(1); // behind, not diverged — pull heals it
    expect(readFileSync(fileB, 'utf8')).toContain('continued on A');
    expect(pushSessions(ctxB).upToDate).toBe(1);
  });
});

describe('self-referential session (quotes the other device\'s spellings)', () => {
  it('stays synced through push/pull on both devices — never reads as diverged', () => {
    const { ctxA, ctxB, fileB } = rig();

    expect(pushSessions(ctxA).pushed).toBe(1);
    expect(pullSessions(ctxB).installed).toBe(1);

    // B re-pushing its just-installed copy: canon-equal, not a conflict.
    const pushB = pushSessions(ctxB);
    expect(pushB.upToDate).toBe(1);
    expect(pushB.conflicts).toBe(0);

    // B pulling again: up to date, not diverged.
    const pullB = pullSessions(ctxB);
    expect(pullB.upToDate).toBe(1);
    expect(pullB.conflicts).toBe(0);

    // B resumes (appends): vault fast-forwards — the shared trunk is recognized.
    appendFileSync(fileB, turnLine(ctxB.repoRoot, '77777777-7777-7777-7777-777777777777', 'continued on B'));
    const pushB2 = pushSessions(ctxB);
    expect(pushB2.fastForwarded).toBe(1);
    expect(pushB2.conflicts).toBe(0);

    // A pulls B's turn and is clean again.
    const pullA = pullSessions(ctxA);
    expect(pullA.fastForwarded).toBe(1);
    expect(pushSessions(ctxA).upToDate).toBe(1);
  });

  it('rebase of a genuine divergence splices each turn exactly once, updates meta.json, and a re-run finds nothing to merge', () => {
    const { ctxA, ctxB, dirName, fileA, fileB } = rig();
    pushSessions(ctxA);
    pullSessions(ctxB);
    appendFileSync(fileA, turnLine(ctxA.repoRoot, '44444444-4444-4444-4444-444444444444', 'divergent turn on A'));
    appendFileSync(fileB, turnLine(ctxB.repoRoot, '55555555-5555-5555-5555-555555555555', 'divergent turn on B'));
    pushSessions(ctxA); // A lands first
    expect(pushSessions(ctxB).conflicts).toBe(1);

    const res = mergeSession(ctxB, FIXTURE_SID);
    expect(res.mode).toBe('merge');
    const merged = res.outcome!.mergedTok;

    // The regression: the quoted-spellings trunk must appear exactly once.
    expect(merged.split(QUOTE_UUID).length - 1).toBe(1);
    expect(merged.split('divergent turn on A').length - 1).toBe(1);
    expect(merged.split('divergent turn on B').length - 1).toBe(1);

    // meta.json mirrors the reconciled entry (was stale before).
    const sessionDir = join(ctxB.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID);
    const meta = JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf8')) as { sha256: string; device: string; conflicts?: string[] };
    expect(meta.device).toBe('laptop-b');
    expect(meta.conflicts).toBeUndefined();
    const vaultNow = readTranscript(sessionDir)!;
    expect(meta.sha256).toBe(sha256hex(vaultNow));

    // Immediately rebasing again must be a no-op error, not another splice.
    expect(() => mergeSession(ctxB, FIXTURE_SID)).toThrowError(/nothing to merge/);

    // And B is genuinely synced now.
    expect(pushSessions(ctxB).upToDate).toBe(1);
    expect(pullSessions(ctxB).upToDate).toBe(1);
  });
});
