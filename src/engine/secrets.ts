/**
 * Gitleaks-style secret scan (M3). Transcripts contain whatever the session
 * saw — env vars echoed by tools, keys in command output — so push warns and
 * doctor reports before anything relies on vault privacy. Warning-only in v1
 * (JWT-shaped strings are common in agent transcripts); `css publish` (v2
 * team sharing) is where scanning becomes blocking.
 */

export interface SecretFinding {
  rule: string;
  count: number;
}

// Order matters: more specific rules run first and mask their matches so the
// generic ones don't double-count (sk-ant-… would also match the openai rule).
const RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{24,}\b/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
] as const;

export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let remaining = text;
  for (const [rule, pattern] of RULES) {
    const matches = remaining.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({ rule, count: matches.length });
      for (const m of new Set(matches)) remaining = remaining.replaceAll(m, '<masked>');
    }
  }
  return findings;
}

export function describeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `${f.rule}×${f.count}`).join(', ');
}
