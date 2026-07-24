#!/usr/bin/env node
// M0 Track A — tokenize: session JSONL -> path-portable JSONL (ADR-3).
//
// Replaces, in this order (project root usually lives under $HOME, so it goes
// first; the munged dirname can appear in tool output that references
// ~/.claude/projects/...):
//   1. <projectRoot>         -> ${CSS_PROJECT_ROOT}
//   2. munged(<projectRoot>) -> ${CSS_PROJECT_DIRNAME}
//   3. <home>                -> ${CSS_HOME}
//
// Plain string replacement on the raw file is sound on POSIX: JSON does not
// escape "/" so paths appear verbatim inside the JSONL. (Windows "\\" escaping
// is a later M0 matrix cell.)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { mungeProjectDir } from './munge.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const { in: inFile, root, out } = args;
const home = args.home ?? homedir();
if (!inFile || !root || !out) {
  console.error('usage: node tokenize.mjs --in <session.jsonl> --root <projectRoot> --out <tokenized.jsonl> [--home <home>]');
  process.exit(1);
}

const count = (hay, needle) => hay.split(needle).length - 1;

const raw = readFileSync(inFile, 'utf8');
const munged = mungeProjectDir(root);
const stats = { root: count(raw, root), mungedRoot: count(raw, munged), home: 0 };

let tok = raw.replaceAll(root, '${CSS_PROJECT_ROOT}').replaceAll(munged, '${CSS_PROJECT_DIRNAME}');
stats.home = count(tok, home);
tok = tok.replaceAll(home, '${CSS_HOME}');

const residual = { root: count(tok, root), home: count(tok, home) };
writeFileSync(out, tok);

console.log(JSON.stringify({ lines: raw.split('\n').filter(Boolean).length, replaced: stats, residual }, null, 2));
if (residual.root > 0 || residual.home > 0) {
  console.error('FAIL: residual absolute paths remain after tokenization');
  process.exit(2);
}
