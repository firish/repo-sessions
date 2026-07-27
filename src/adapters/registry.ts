import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from './claude/index.js';
import { codexAdapter } from './codex/index.js';
import type { Adapter, AdapterEnv } from './types.js';

export interface ActiveAdapter {
  adapter: Adapter;
  env: AdapterEnv;
}

/** All installed tools we can sync. CSS_CODEX_HOME overrides the codex data
 *  root (mirrors codex's own CODEX_HOME; used by the e2e harness too). */
export function detectAdapters(home: string = homedir()): ActiveAdapter[] {
  const active: ActiveAdapter[] = [];
  const claudeEnv: AdapterEnv = { home, dataDir: join(home, '.claude', 'projects') };
  if (claudeAdapter.detect(claudeEnv)) active.push({ adapter: claudeAdapter, env: claudeEnv });
  const codexEnv: AdapterEnv = { home, dataDir: process.env.CSS_CODEX_HOME ?? join(home, '.codex') };
  if (codexAdapter.detect(codexEnv)) active.push({ adapter: codexAdapter, env: codexEnv });
  return active;
}
