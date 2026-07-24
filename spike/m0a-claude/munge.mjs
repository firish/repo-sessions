// Claude Code project-dir munge rule.
//
// Empirically verified on CC 2.1.215 (M0 probe, 2026-07-23):
//   /private/tmp/.../weird_name.v1  ->  -private-tmp-...-weird-name-v1
// i.e. every char outside [A-Za-z0-9-] becomes "-"; literal dashes pass
// through (a path segment starting with "-" yields a double dash).
//
// CAUTION: the rule has drifted across CC versions/entrypoints — this machine
// has both -AI-AI-ML and -AI-AI_ML for the same on-disk AI_ML dir. A real
// adapter's locate() must scan known variants; the spike targets the current
// rule only.
export function mungeProjectDir(absPath) {
  return absPath.replace(/[^A-Za-z0-9-]/g, '-');
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = process.argv[2];
  if (!p) {
    console.error('usage: node munge.mjs <abs-path>');
    process.exit(1);
  }
  console.log(mungeProjectDir(p));
}
