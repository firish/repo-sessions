/**
 * Path-spelling substitution shared by adapters.
 *
 * One concrete path shows up in synced content under several spellings. On
 * POSIX there is exactly one; on Windows the same path appears with
 * backslashes ("c:\Users\x"), forward slashes ("c:/Users/x"), and either
 * drive-letter case — Claude Code itself mixes these across fields. On top
 * of that, inside JSONL every backslash is JSON-escaped ("c:\\Users\\x").
 *
 * Substituting a raw Windows path into serialized JSON produces invalid
 * escapes (\U, \D, ...) and corrupts the transcript — the bug behind
 * "session renders only its last turns" (parse failures break the
 * parentUuid chain). So all transcript substitution goes through here with
 * json=true: tokenize matches every spelling including the escaped one, and
 * rehydrate emits the JSON-escaped spelling.
 */

const DRIVE = /^[a-zA-Z]:/;

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** All spellings of `path` to search for when tokenizing, longest first so
 *  escaped forms are consumed before their shorter raw cousins. */
export function pathSpellings(path: string, json: boolean): string[] {
  const seeds = new Set<string>([path]);
  if (path.includes('\\')) seeds.add(path.replaceAll('\\', '/'));
  if (DRIVE.test(path) && path.includes('/')) seeds.add(path.replaceAll('/', '\\'));
  for (const s of [...seeds]) {
    if (DRIVE.test(s)) {
      seeds.add(s.charAt(0).toLowerCase() + s.slice(1));
      seeds.add(s.charAt(0).toUpperCase() + s.slice(1));
    }
  }
  const out = new Set<string>();
  for (const s of seeds) {
    if (json) {
      const esc = jsonEscape(s);
      if (esc !== s) out.add(esc);
    }
    out.add(s);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every spelling of `path` in `content` with `token`. */
export function tokenizePath(content: string, path: string, token: string, json: boolean): string {
  let out = content;
  for (const spelling of pathSpellings(path, json)) out = out.replaceAll(spelling, token);
  return out;
}

/** The spelling of `path` that is safe to emit into the target content. */
export function emitPath(path: string, json: boolean): string {
  return json ? jsonEscape(path) : path;
}

/** Spelling-insensitive comparison form: forward slashes, lowercase drive.
 *  A session's recorded cwd and the CLI's repo root routinely disagree on
 *  both (VS Code "c:\", git rev-parse "C:/") while naming the same dir. */
export function canonicalPath(path: string): string {
  let out = path.replaceAll('\\', '/');
  if (DRIVE.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
  return out;
}

/** Is `child` the same directory as `root`, or inside it? */
export function sameOrInside(child: string, root: string): boolean {
  const c = canonicalPath(child);
  const r = canonicalPath(root);
  return c === r || c.startsWith(`${r}/`);
}
