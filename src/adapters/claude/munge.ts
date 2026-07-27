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

/** All known munge spellings for a path, current rule first, deduped. */
export function mungeVariants(absPath: string): string[] {
  return [...new Set([mungeCurrent(absPath), mungeLegacyUnderscore(absPath)])];
}
