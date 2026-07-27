import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent, mungeLegacyUnderscore } from '../src/adapters/claude/munge';
import { FIXTURE_SID, mkDevice, mkTmp, seedSession } from './helpers';

describe('claude locate()', () => {
  it('finds sessions across munge variants and subdirs, excludes sibling false-positives', () => {
    const base = mkTmp('locate');
    const { home, env } = mkDevice(base, 'a');
    const root = join(base, 'work', 'my-repo');

    // 1. session at the repo root (current munge rule)
    seedSession(env, root, home);

    // 2. session started in a subdir — its own project dir, prefix of root's
    const subCwd = join(root, 'blog');
    const subDir = join(env.dataDir, mungeCurrent(subCwd));
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'sub.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'sub session' }, cwd: subCwd, sessionId: 'bbbbbbbb-0000-0000-0000-000000000002', timestamp: '2026-07-20T10:10:00.000Z' })}\n`,
    );

    // 3. sibling path whose munged name collides with the subdir prefix pattern
    const siblingCwd = `${root}-extra`;
    const siblingDir = join(env.dataDir, mungeCurrent(siblingCwd));
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(
      join(siblingDir, 'sib.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'not ours' }, cwd: siblingCwd, sessionId: 'cccccccc-0000-0000-0000-000000000003', timestamp: '2026-07-20T10:20:00.000Z' })}\n`,
    );

    // 4. noise that must be ignored inside a project dir
    mkdirSync(join(env.dataDir, mungeCurrent(root), 'memory'), { recursive: true });
    writeFileSync(join(env.dataDir, mungeCurrent(root), 'notes.txt'), 'not a session');

    const refs = claudeAdapter.locate(root, env);
    const ids = refs.map((r) => r.sessionId);
    expect(ids).toContain(FIXTURE_SID);
    expect(ids).toContain('bbbbbbbb-0000-0000-0000-000000000002');
    expect(ids).not.toContain('cccccccc-0000-0000-0000-000000000003');
    expect(refs).toHaveLength(2);
  });

  it('finds sessions stored under the legacy underscore munge rule', () => {
    const base = mkTmp('legacy');
    const { env } = mkDevice(base, 'b');
    const root = join(base, 'work', 'ai_lab');

    const legacyDir = join(env.dataDir, mungeLegacyUnderscore(root));
    expect(legacyDir).toContain('ai_lab'); // sanity: legacy spelling really differs
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'old.jsonl'),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'legacy' }, cwd: root, sessionId: 'dddddddd-0000-0000-0000-000000000004', timestamp: '2026-07-20T10:30:00.000Z' })}\n`,
    );

    const refs = claudeAdapter.locate(root, env);
    expect(refs.map((r) => r.sessionId)).toContain('dddddddd-0000-0000-0000-000000000004');
  });

  it('reads sessionId/cwd past queue-operation lines and extracts summary + lastTs', () => {
    const base = mkTmp('scan');
    const { home, env } = mkDevice(base, 'c');
    const root = join(base, 'proj');
    seedSession(env, root, home);

    const [ref] = claudeAdapter.locate(root, env);
    expect(ref?.sessionId).toBe(FIXTURE_SID);
    expect(ref?.cwd).toBe(root);
    expect(ref?.summary).toContain('FIXTURE-7');
    expect(ref?.lastTs).toBe('2026-07-20T10:00:05.000Z');
    expect(ref?.toolVersion).toBe('2.1.215');
  });
});
