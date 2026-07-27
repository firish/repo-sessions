import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '../src/adapters/claude/index';
import { mungeCurrent } from '../src/adapters/claude/munge';
import type { AdapterEnv } from '../src/adapters/types';

export const FIXTURE_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001';

export function fixtureTokenized(): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', 'session.tokenized.jsonl'), 'utf8');
}

export function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `css-test-${prefix}-`));
}

/** A fake device: its own home, claude data dir, and adapter env. */
export function mkDevice(base: string, name: string): { home: string; env: AdapterEnv } {
  const home = join(base, `home-${name}`);
  const dataDir = join(home, '.claude', 'projects');
  mkdirSync(dataDir, { recursive: true });
  return { home, env: { home, dataDir } };
}

/** Install the fixture session as a hydrated local transcript for `cwd`. */
export function seedSession(env: AdapterEnv, cwd: string, home: string): string {
  const hydrated = claudeAdapter.rehydrate(fixtureTokenized(), { projectRoot: cwd, home });
  const dir = join(env.dataDir, mungeCurrent(cwd));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${FIXTURE_SID}.jsonl`);
  writeFileSync(filePath, hydrated);
  return filePath;
}

/** A JSONL turn appended by a "resumed" session at `cwd`. */
export function turnLine(cwd: string, uuid: string, text: string): string {
  return `${JSON.stringify({
    parentUuid: '22222222-2222-2222-2222-222222222222',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    uuid,
    timestamp: '2026-07-20T11:00:00.000Z',
    cwd,
    sessionId: FIXTURE_SID,
    version: '2.1.215',
    gitBranch: 'main',
  })}\n`;
}
