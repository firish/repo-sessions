import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../src/engine/secrets';

describe('secret scan', () => {
  it('flags common key shapes', () => {
    const text = [
      'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      'anthropic: sk-ant-api03-abcdefghijklmnopqrstuv',
      '-----BEGIN RSA PRIVATE KEY-----',
    ].join('\n');
    const rules = scanSecrets(text).map((f) => f.rule);
    expect(rules).toContain('aws-access-key');
    expect(rules).toContain('github-token');
    expect(rules).toContain('anthropic-key');
    expect(rules).toContain('private-key-block');
  });

  it('does not double-count anthropic keys under the openai rule', () => {
    const findings = scanSecrets('sk-ant-api03-abcdefghijklmnopqrstuv');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('anthropic-key');
  });

  it('stays quiet on ordinary transcript content', () => {
    expect(scanSecrets('{"cwd":"${CSS_PROJECT_ROOT}","text":"nothing secret here, just paths and prose"}')).toHaveLength(0);
  });
});
