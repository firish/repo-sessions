import { describe, expect, it } from 'vitest';
import { normalizeOrigin, repoKeyFromOrigin } from '../src/engine/repoKey';

describe('origin normalization', () => {
  it('collapses every spelling of the same repo', () => {
    const spellings = [
      'git@github.com:Firish/Repo.git',
      'https://GitHub.com/Firish/Repo.git',
      'https://user:token@github.com/Firish/Repo',
      'ssh://git@github.com/Firish/Repo.git/',
    ];
    const keys = new Set(spellings.map((s) => repoKeyFromOrigin(s).key));
    expect(keys.size).toBe(1);
    expect(normalizeOrigin(spellings[0]!)).toBe('github.com/Firish/Repo');
  });

  it('file:// and plain-path remotes normalize identically', () => {
    expect(normalizeOrigin('file:///srv/git/vault.git')).toBe(normalizeOrigin('/srv/git/vault.git'));
  });

  it('different repos get different keys; slug comes from the last segment', () => {
    const a = repoKeyFromOrigin('git@github.com:me/alpha.git');
    const b = repoKeyFromOrigin('git@github.com:me/beta.git');
    expect(a.key).not.toBe(b.key);
    expect(a.slug).toBe('alpha');
    expect(a.dirName).toBe(`${a.key}-alpha`);
  });

  it('path case matters, host case does not', () => {
    expect(repoKeyFromOrigin('git@GITHUB.com:me/x').key).toBe(repoKeyFromOrigin('git@github.com:me/x').key);
    expect(repoKeyFromOrigin('git@github.com:ME/x').key).not.toBe(repoKeyFromOrigin('git@github.com:me/x').key);
  });
});
