#!/usr/bin/env node
// M0 Track B — generic ordered string rewrite for Codex artifacts.
// Codex needs three mappings (longest-first ordering matters — the project
// root and CODEX_HOME usually both live under $HOME):
//   project root (site-a -> site-b), CODEX_HOME (home-a -> home-b), $HOME.
// Used for both the rollout JSONL and (via sqlite REPLACE()) sanity-diffing.
//
// usage: node rewrite.mjs --in <file> --out <file> --map old=new [--map old=new ...]
import { readFileSync, writeFileSync } from 'node:fs';

const maps = [];
let inFile, outFile;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--in') inFile = argv[++i];
  else if (argv[i] === '--out') outFile = argv[++i];
  else if (argv[i] === '--map') {
    const a = argv[++i];
    const eq = a.indexOf('=');
    maps.push([a.slice(0, eq), a.slice(eq + 1)]);
  }
}
if (!inFile || !outFile || maps.length === 0) {
  console.error('usage: node rewrite.mjs --in <file> --out <file> --map old=new [--map old=new ...]');
  process.exit(1);
}

const count = (hay, needle) => hay.split(needle).length - 1;
let text = readFileSync(inFile, 'utf8');
const stats = {};
for (const [from, to] of maps) {
  stats[from] = count(text, from);
  text = text.replaceAll(from, to);
}
writeFileSync(outFile, text);
const residual = Object.fromEntries(maps.map(([from]) => [from, count(text, from)]).filter(([, n]) => n > 0));
console.log(JSON.stringify({ replaced: stats, residual }, null, 2));
if (Object.keys(residual).length) {
  console.error('FAIL: residual source strings remain');
  process.exit(2);
}
