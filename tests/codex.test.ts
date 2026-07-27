import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex/index';
import type { AdapterEnv } from '../src/adapters/types';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { repoKeyFromOrigin } from '../src/engine/repoKey';
import { pullSessions, pushSessions, type SyncCtx } from '../src/engine/sync';
import { readTranscript } from '../src/engine/vault';
import { mkTmp } from './helpers';

const SID = '019faaaa-bbbb-cccc-dddd-000000000001';
const REL = join('sessions', '2026', '07', '20', `rollout-2026-07-20T09-00-00-${SID}.jsonl`);

function fixture(): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', 'rollout.tokenized.jsonl'), 'utf8');
}

/** A fake machine with its own home + CODEX_HOME. */
function mkCodexDevice(base: string, name: string): { home: string; env: AdapterEnv } {
  const home = join(base, `home-${name}`);
  const dataDir = join(home, '.codex');
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  return { home, env: { home, dataDir } };
}

function seedRollout(env: AdapterEnv, home: string, cwd: string): string {
  const hydrated = codexAdapter.rehydrate(fixture(), { projectRoot: cwd, home, toolDataDir: env.dataDir });
  const filePath = join(env.dataDir, REL);
  mkdirSync(join(env.dataDir, 'sessions', '2026', '07', '20'), { recursive: true });
  writeFileSync(filePath, hydrated);
  return filePath;
}

describe('codex adapter', () => {
  it('locates rollouts in the date tree by embedded cwd, extracts meta', () => {
    const base = mkTmp('codex-locate');
    const { home, env } = mkCodexDevice(base, 'a');
    const root = join(base, 'work', 'proj');
    seedRollout(env, home, root);

    // an unrelated project's rollout in the same tree must be excluded
    const otherDir = join(env.dataDir, 'sessions', '2026', '07', '21');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, 'rollout-2026-07-21T10-00-00-019fbbbb-0000-0000-0000-000000000002.jsonl'),
      `${JSON.stringify({ timestamp: '2026-07-21T10:00:00.000Z', type: 'session_meta', payload: { id: '019fbbbb-0000-0000-0000-000000000002', cwd: join(base, 'other'), cli_version: '0.145.0' } })}\n`,
    );

    const refs = codexAdapter.locate(root, env);
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.sessionId).toBe(SID);
    expect(ref.relPath).toBe(REL);
    expect(ref.cwd).toBe(root);
    expect(ref.toolVersion).toBe('0.145.0');
    expect(ref.summary).toContain('ROLLOUT-5');
    expect(ref.lastTs).toBe('2026-07-20T09:00:05.000Z');
  });

  it('tokenize/rehydrate round-trips all three tokens', () => {
    const ctx = { projectRoot: '/Users/alice/dev/proj', home: '/Users/alice', toolDataDir: '/Users/alice/.codex' };
    const hydrated = codexAdapter.rehydrate(fixture(), ctx);
    expect(hydrated).toContain('/Users/alice/dev/proj');
    expect(hydrated).toContain('/Users/alice/.codex/sessions/2026');
    expect(hydrated).not.toContain('${CSS_');
    expect(codexAdapter.tokenize(hydrated, ctx)).toBe(fixture());
  });

  it('two-device round-trip preserves the date-tree relPath', () => {
    const base = mkTmp('codex-sync');
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
    const devA = mkCodexDevice(base, 'a');
    const devB = mkCodexDevice(base, 'b');
    const ctx = (repoRoot: string, dev: typeof devA, device: string, clone: string): SyncCtx => ({
      repoRoot,
      cfg: { vaultUrl: `file://${bareVault}`, vaultPath: join(base, clone), device } satisfies CssConfig,
      home: dev.home,
      adapters: [{ adapter: codexAdapter, env: dev.env }],
    });
    const ctxA = ctx(siteA, devA, 'laptop-a', 'clone-a');
    const ctxB = ctx(siteB, devB, 'laptop-b', 'clone-b');

    seedRollout(devA.env, devA.home, siteA);
    const push1 = pushSessions(ctxA);
    expect(push1.pushed).toBe(1);

    const dirName = repoKeyFromOrigin(`file://${bareOrigin}`).dirName;
    const tok = readTranscript(join(ctxA.cfg.vaultPath, dirName, 'codex', 'sessions', SID))!;
    expect(tok).toContain('${CSS_CODEX_HOME}');
    expect(tok).not.toContain(siteA);

    const pull1 = pullSessions(ctxB);
    expect(pull1.installed).toBe(1);
    const fileB = join(devB.env.dataDir, REL); // same machine-neutral date-tree path
    expect(existsSync(fileB)).toBe(true);
    const contentB = readFileSync(fileB, 'utf8');
    expect(contentB).toContain(`"cwd":"${siteB}"`);
    expect(contentB).toContain(join(devB.env.dataDir, 'sessions'));
    expect(contentB).not.toContain(siteA);
    expect(contentB).not.toContain('${CSS_');

    // B resumes (appends), pushes back: fast-forward, then steady state
    appendFileSync(
      fileB,
      `${JSON.stringify({ timestamp: '2026-07-20T11:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: `continued at ${siteB}` } })}\n`,
    );
    expect(pushSessions(ctxB).fastForwarded).toBe(1);
    const pull2 = pullSessions(ctxA);
    expect(pull2.fastForwarded).toBe(1);
    expect(readFileSync(join(devA.env.dataDir, REL), 'utf8')).toContain(`continued at ${siteA}`);
    expect(pushSessions(ctxA).upToDate).toBe(1);
  });
});
