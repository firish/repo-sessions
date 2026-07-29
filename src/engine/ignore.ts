import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * .chatignore — sessions that never sync (the "keep this chat on this
 * machine" control; plan §4's ignore mechanism). One entry per line:
 * a session id, a name, or a simple glob (*). Lines starting with # are
 * comments. The file lives at the repo root; whether to gitignore it is the
 * user's call (ids are opaque uuids, but the file itself is theirs).
 */

export const IGNORE_FILE = '.chatignore';

export function loadIgnorePatterns(repoRoot: string): string[] {
  const p = join(repoRoot, IGNORE_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export type IgnoreFn = (sessionId: string, name?: string) => boolean;

export function makeIgnoreFn(patterns: string[]): IgnoreFn {
  if (patterns.length === 0) return () => false;
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const p of patterns) {
    if (p.includes('*')) globs.push(globToRegExp(p));
    else exact.add(p.toLowerCase());
  }
  return (sessionId, name) => {
    if (exact.has(sessionId.toLowerCase())) return true;
    if (name && exact.has(name.toLowerCase())) return true;
    return globs.some((g) => g.test(sessionId) || (name !== undefined && g.test(name)));
  };
}

/** Append an entry unless an identical line already exists. Returns false when
 *  it was already present. */
export function appendIgnore(repoRoot: string, entry: string): boolean {
  if (loadIgnorePatterns(repoRoot).includes(entry)) return false;
  const p = join(repoRoot, IGNORE_FILE);
  const needsHeader = !existsSync(p);
  appendFileSync(p, `${needsHeader ? '# sessions excluded from repo-sessions sync (chat ignore)\n' : ''}${entry}\n`);
  return true;
}
