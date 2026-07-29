import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { CssConfig } from '../src/engine/config';
import { git } from '../src/engine/git';
import { findByName, resolveSessionInput, uniquifyName, validateName } from '../src/engine/naming';
import { pushSessions, type SyncCtx } from '../src/engine/sync';
import { Vault, type ProjectEntry } from '../src/engine/vault';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession, turnLine } from './helpers';

function project(names: Record<string, string | undefined>): ProjectEntry {
  const sessions = Object.fromEntries(
    Object.entries(names).map(([sid, name]) => [
      sid,
      { byteLen: 1, sha256: 'x', device: 'd', cwdTok: '${CSS_PROJECT_ROOT}', syncedAt: 't', name },
    ]),
  );
  return { slug: 's', origin: 'o', tools: { claude: { sessions } } };
}

describe('session naming', () => {
  it('validates names and rejects id-lookalikes and spaces', () => {
    expect(validateName('auth-refactor/laptop-b')).toBe('auth-refactor/laptop-b');
    expect(() => validateName('has spaces')).toThrow();
    expect(() => validateName('deadbeef-dead-beef')).toThrow(/session ids/);
  });

  it('resolves by name, full id, and unique id prefix; rejects ambiguity', () => {
    const p = project({
      'aaaa1111-0000-0000-0000-000000000001': 'alpha',
      'aaaa2222-0000-0000-0000-000000000002': undefined,
    });
    expect(resolveSessionInput(p, 'alpha')).toBe('aaaa1111-0000-0000-0000-000000000001');
    expect(resolveSessionInput(p, 'aaaa2222-0000-0000-0000-000000000002')).toBe('aaaa2222-0000-0000-0000-000000000002');
    expect(resolveSessionInput(p, 'aaaa2222')).toBe('aaaa2222-0000-0000-0000-000000000002');
    expect(() => resolveSessionInput(p, 'aaaa')).toThrow(/ambiguous|no session/);
    expect(() => resolveSessionInput(p, 'nope')).toThrow(/no session named/);
  });

  it('uniquify appends -2, -3 …', () => {
    const p = project({ a: 'work', b: 'work-2' } as never);
    expect(uniquifyName(p, 'work')).toBe('work-3');
    expect(uniquifyName(p, 'fresh')).toBe('fresh');
    expect(findByName(p, 'work')).not.toBeNull();
  });

  it('push preserves an assigned name across fast-forwards', () => {
    const base = mkTmp('naming');
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
    pushSessions(ctx);

    // name it directly in the index (what cmdName does)
    const vault = new Vault(cfg);
    const index = vault.loadIndex();
    const proj = Object.values(index.projects)[0]!;
    proj.tools.claude!.sessions[FIXTURE_SID]!.name = 'first-session';
    vault.saveIndex(index);

    // grow the session, push again — the rewritten entry must keep the name
    appendFileSync(
      join(dev.env.dataDir, mungeCurrent(site), `${FIXTURE_SID}.jsonl`),
      turnLine(site, '99999999-9999-9999-9999-999999999999', 'more work'),
    );
    const res = pushSessions(ctx);
    expect(res.fastForwarded).toBe(1);
    const after = new Vault(cfg).loadIndex();
    expect(Object.values(after.projects)[0]!.tools.claude!.sessions[FIXTURE_SID]!.name).toBe('first-session');
    expect(readFileSync(join(dev.env.dataDir, mungeCurrent(site), `${FIXTURE_SID}.jsonl`), 'utf8')).toContain('more work');
  });
});
