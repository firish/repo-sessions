/**
 * Claude Code project-dir munge rules.
 *
 * Current rule, verified empirically on CC 2.1.215 (M0 probe): every char
 * outside [A-Za-z0-9-] becomes "-". Literal dashes pass through, so a path
 * segment starting with "-" yields a double dash.
 *
 * The rule has drifted across CC versions/entrypoints — the same on-disk
 * AI_ML dir produced both -AI-AI-ML and -AI-AI_ML on one machine — so
 * locate() must scan all known variants, while installs use the current rule.
 */

export function mungeCurrent(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

/** Older builds preserved "_" (evidence: -AI-AI_ML). */
export function mungeLegacyUnderscore(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** All known munge spellings for a path, current rule first, deduped.
 *  Windows drive-letter case varies by entrypoint (PowerShell "C:\", VS Code
 *  "c:\") and survives into the munge, so both cases are candidates. */
export function mungeVariants(absPath: string): string[] {
  const seeds = new Set<string>([absPath]);
  if (/^[a-zA-Z]:/.test(absPath)) {
    seeds.add(absPath.charAt(0).toLowerCase() + absPath.slice(1));
    seeds.add(absPath.charAt(0).toUpperCase() + absPath.slice(1));
  }
  const out = new Set<string>();
  for (const seed of seeds) {
    out.add(mungeCurrent(seed));
    out.add(mungeLegacyUnderscore(seed));
  }
  return [...out];
}
