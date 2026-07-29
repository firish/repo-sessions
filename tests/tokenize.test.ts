import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude/index';
import { fixtureTokenized } from './helpers';

const ctx = { projectRoot: '/Users/alice/dev/proj', home: '/Users/alice' };

describe('claude tokenize/rehydrate', () => {
  it('rehydrate resolves every token to concrete paths', () => {
    const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), ctx);
    expect(hydrated).toContain('/Users/alice/dev/proj');
    expect(hydrated).toContain('/Users/alice/.claude/projects/-Users-alice-dev-proj');
    expect(hydrated).not.toContain('${CSS_');
  });

  it('tokenize(rehydrate(x)) round-trips to the identical vault form', () => {
    const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), ctx);
    expect(claudeAdapter.tokenize(hydrated, ctx)).toBe(fixtureTokenized());
  });

  it('tokenize leaves no absolute paths behind', () => {
    const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), ctx);
    const tok = claudeAdapter.tokenize(hydrated, ctx);
    expect(tok).not.toContain(ctx.projectRoot);
    expect(tok).not.toContain(ctx.home);
  });

  it('cross-device: rehydrating at a new root yields consistent paths', () => {
    const ctxB = { projectRoot: '/opt/work/proj', home: '/home/bob' };
    const hydratedB = claudeAdapter.rehydrate(fixtureTokenized(), ctxB);
    expect(hydratedB).toContain('"cwd":"/opt/work/proj"');
    expect(hydratedB).toContain('/home/bob/.claude/projects/-opt-work-proj');
    expect(hydratedB).not.toContain('alice');
  });
});

/** Regression: raw "C:\Users\x" substituted into a JSON string produces
 *  invalid escapes (\U) — Claude Code then fails to parse those lines, the
 *  parentUuid chain breaks, and the session renders only its last turns. */
describe('windows path forms in jsonl content', () => {
  const win = { projectRoot: 'c:\\Users\\rishi\\dev\\proj', home: 'C:\\Users\\rishi' };
  const json = { json: true };

  it('rehydrate emits JSON-escaped backslashes — every line stays parseable', () => {
    const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), win, json);
    for (const line of hydrated.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(hydrated).toContain('c:\\\\Users\\\\rishi\\\\dev\\\\proj');
    expect(hydrated).not.toContain('${CSS_');
  });

  it('windows round-trip: rehydrate then tokenize restores the exact vault form', () => {
    const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), win, json);
    expect(claudeAdapter.tokenize(hydrated, win, json)).toBe(fixtureTokenized());
  });

  it('tokenize catches escaped, forward-slash, and either drive-letter case', () => {
    const line = JSON.stringify({
      cwd: 'C:\\Users\\rishi\\dev\\proj',
      file: 'c:/Users/rishi/dev/proj/src/a.ts',
      home: 'C:\\Users\\rishi',
    });
    const tok = claudeAdapter.tokenize(line, win, json);
    expect(tok).not.toContain('rishi');
    const parsed = JSON.parse(tok) as Record<string, string>;
    expect(parsed.cwd).toBe('${CSS_PROJECT_ROOT}');
    expect(parsed.file).toBe('${CSS_PROJECT_ROOT}/src/a.ts');
    expect(parsed.home).toBe('${CSS_HOME}');
  });

  it('re-tokenizing previously corrupted raw-backslash content heals it', () => {
    // file bytes as the old bug wrote them: {"command":"ls C:\Users\rishi\dev\proj"}
    const corrupt = '{"command":"ls C:\\Users\\rishi\\dev\\proj"}';
    expect(() => JSON.parse(corrupt)).toThrow(); // proves the fixture is the broken shape
    const tok = claudeAdapter.tokenize(corrupt, win, json);
    expect(JSON.parse(tok)).toEqual({ command: 'ls ${CSS_PROJECT_ROOT}' });
    const repaired = claudeAdapter.rehydrate(tok, win, json);
    expect(JSON.parse(repaired)).toEqual({ command: 'ls c:\\Users\\rishi\\dev\\proj' });
  });
});
