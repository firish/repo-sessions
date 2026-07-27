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
