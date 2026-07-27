import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

/** Two simulated laptops sharing one project origin and one vault remote —
 *  everything local, no network. */
function rig(): {
  siteA: string;
  siteB: string;
  ctxA: SyncCtx;
  ctxB: SyncCtx;
  vaultUrl: string;
  dirName: string;
} {
  const base = mkTmp('sync');
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
  const cfg = (device: string, cloneDir: string): CssConfig => ({
    vaultUrl: `file://${bareVault}`,
    vaultPath: join(base, cloneDir),
    device,
  });

  const ctx = (repoRoot: string, dev: typeof devA, c: CssConfig): SyncCtx => ({
    repoRoot,
    cfg: c,
    home: dev.home,
    adapters: [{ adapter: claudeAdapter, env: dev.env }],
  });

  seedSession(devA.env, siteA, devA.home);
  return {
    siteA,
    siteB,
    ctxA: ctx(siteA, devA, cfg('laptop-a', 'vault-clone-a')),
    ctxB: ctx(siteB, devB, cfg('laptop-b', 'vault-clone-b')),
    vaultUrl: `file://${bareVault}`,
    dirName: repoKeyFromOrigin(`file://${bareOrigin}`).dirName,
  };
}

describe('two-device vault round-trip', () => {
  it('push A -> pull B -> resume B -> push B -> pull A, then divergence conflicts', () => {
    const { siteA, siteB, ctxA, ctxB, dirName } = rig();

    // --- A pushes its session
    const push1 = pushSessions(ctxA);
    expect(push1.pushed).toBe(1);
    expect(push1.committed).toBe(true);

    const vaultTranscript = join(ctxA.cfg.vaultPath, dirName, 'claude', 'sessions', FIXTURE_SID, 'transcript.jsonl');
    const tok = readFileSync(vaultTranscript, 'utf8');
    expect(tok).toContain('${CSS_PROJECT_ROOT}');
    expect(tok).not.toContain(siteA);

    // --- B pulls: session installed under B's paths
    const pull1 = pullSessions(ctxB);
    expect(pull1.installed).toBe(1);
    const fileB = join(ctxB.adapters[0]!.env.dataDir, mungeCurrent(siteB), `${FIXTURE_SID}.jsonl`);
    expect(existsSync(fileB)).toBe(true);
    const contentB = readFileSync(fileB, 'utf8');
    expect(contentB).toContain(`"cwd":"${siteB}"`);
    expect(contentB).not.toContain(siteA);
    expect(contentB).not.toContain('${CSS_');

    // --- B "resumes" (appends a turn), pushes: vault fast-forwards
    appendFileSync(fileB, turnLine(siteB, '33333333-3333-3333-3333-333333333333', 'continued on laptop B'));
    const push2 = pushSessions(ctxB);
    expect(push2.fastForwarded).toBe(1);
    expect(push2.committed).toBe(true);

    // --- A pulls: local file fast-forwards, appended turn rehydrated to A's paths
    const pull2 = pullSessions(ctxA);
    expect(pull2.fastForwarded).toBe(1);
    const fileA = join(ctxA.adapters[0]!.env.dataDir, mungeCurrent(siteA), `${FIXTURE_SID}.jsonl`);
    const contentA = readFileSync(fileA, 'utf8');
    expect(contentA).toContain('continued on laptop B');
    expect(contentA).toContain(`"cwd":"${siteA}"`);
    expect(contentA).not.toContain(siteB);

    // --- steady state: nothing to do
    const push3 = pushSessions(ctxA);
    expect(push3.upToDate).toBe(1);
    expect(push3.committed).toBe(false);

    // --- both devices grow the same session divergently
    appendFileSync(fileA, turnLine(siteA, '44444444-4444-4444-4444-444444444444', 'divergent turn on A'));
    appendFileSync(fileB, turnLine(siteB, '55555555-5555-5555-5555-555555555555', 'divergent turn on B'));
    expect(pushSessions(ctxA).fastForwarded).toBe(1); // A lands first
    const push4 = pushSessions(ctxB);
    expect(push4.conflicts).toBe(1);

    const conflictPath = join(
      ctxB.cfg.vaultPath,
      dirName,
      'claude',
      'sessions',
      FIXTURE_SID,
      'transcript.conflict-laptop-b.jsonl',
    );
    expect(existsSync(conflictPath)).toBe(true);
    expect(readFileSync(conflictPath, 'utf8')).toContain('divergent turn on B');

    // canonical transcript still carries A's line — no turns dropped anywhere
    expect(readFileSync(vaultTranscript, 'utf8')).toContain('divergent turn on A');

    // --- B pulling now reports divergence and keeps local intact
    const pull3 = pullSessions(ctxB);
    expect(pull3.conflicts).toBe(1);
    expect(readFileSync(fileB, 'utf8')).toContain('divergent turn on B');
  });

  it('pull installs subdir sessions into the subdir project dir', () => {
    const { siteA, siteB, ctxA, ctxB } = rig();

    // A also has a session that started in a subdir of the repo
    const subCwdA = join(siteA, 'blog');
    const subDirA = join(ctxA.adapters[0]!.env.dataDir, mungeCurrent(subCwdA));
    const subSid = 'eeeeeeee-0000-0000-0000-000000000005';
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'subdir session' }] }, cwd: subCwdA, sessionId: subSid, timestamp: '2026-07-20T12:00:00.000Z', version: '2.1.215' })}\n`;
    mkdirSync(subDirA, { recursive: true });
    writeFileSync(join(subDirA, `${subSid}.jsonl`), line);

    pushSessions(ctxA);
    pullSessions(ctxB);

    const subCwdB = join(siteB, 'blog');
    const installed = join(ctxB.adapters[0]!.env.dataDir, mungeCurrent(subCwdB), `${subSid}.jsonl`);
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf8')).toContain(`"cwd":"${subCwdB}"`);
  });
});
