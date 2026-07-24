#!/usr/bin/env node
// M0 Track A — rehydrate: path-tokenized JSONL -> concrete local paths, and
// (with --install) place it where `claude --resume` looks:
//   ~/.claude/projects/<munged(newRoot)>/<sessionId>.jsonl
//
// The session UUID is preserved — that is the id the user resumes by.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mungeProjectDir } from './munge.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !['--in', '--root', '--home', '--out', '--projects'].includes(a)));
const args = Object.fromEntries(
  argv.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const { in: inFile, root, out } = args;
const home = args.home ?? homedir();
const projectsDir = args.projects ?? join(homedir(), '.claude', 'projects');
const install = flags.has('--install');
if (!inFile || !root || (!out && !install)) {
  console.error('usage: node rehydrate.mjs --in <tokenized.jsonl> --root <newProjectRoot> (--out <file> | --install) [--home <home>] [--projects <dir>]');
  process.exit(1);
}

const count = (hay, needle) => hay.split(needle).length - 1;

const tok = readFileSync(inFile, 'utf8');
const hydrated = tok
  .replaceAll('${CSS_PROJECT_ROOT}', root)
  .replaceAll('${CSS_PROJECT_DIRNAME}', mungeProjectDir(root))
  .replaceAll('${CSS_HOME}', home);

const residualTokens = count(hydrated, '${CSS_');
let sessionId = null;
for (const line of hydrated.split('\n')) {
  if (!line.trim()) continue;
  try {
    const obj = JSON.parse(line);
    if (obj.sessionId) { sessionId = obj.sessionId; break; }
  } catch { /* tolerate non-JSON lines */ }
}

let target = out;
if (install) {
  if (!sessionId) {
    console.error('FAIL: no sessionId found in transcript; cannot install');
    process.exit(2);
  }
  const dir = join(projectsDir, mungeProjectDir(root));
  mkdirSync(dir, { recursive: true });
  target = join(dir, `${sessionId}.jsonl`);
}
writeFileSync(target, hydrated);

console.log(JSON.stringify({ sessionId, target, residualTokens }, null, 2));
if (residualTokens > 0) {
  console.error('FAIL: unresolved ${CSS_*} tokens remain after rehydration');
  process.exit(2);
}
