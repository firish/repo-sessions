import { describe, expect, it } from 'vitest';
import { mungeCurrent, mungeLegacyUnderscore, mungeVariants } from '../src/adapters/claude/munge';

describe('munge rules (pinned by M0 probe on CC 2.1.215)', () => {
  it('replaces everything outside [A-Za-z0-9-] with dashes', () => {
    expect(mungeCurrent('/a/weird_name.v1')).toBe('-a-weird-name-v1');
  });

  it('passes literal dashes through (leading-dash segments double up)', () => {
    expect(mungeCurrent('/tmp/claude-501/-Users-x')).toBe('-tmp-claude-501--Users-x');
  });

  it('legacy rule preserves underscores', () => {
    expect(mungeLegacyUnderscore('/a/AI_ML')).toBe('-a-AI_ML');
  });

  it('variants differ only when the path contains an underscore', () => {
    expect(mungeVariants('/a/AI_ML')).toHaveLength(2);
    expect(mungeVariants('/a/plain-path')).toHaveLength(1);
  });
});
