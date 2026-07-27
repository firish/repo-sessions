import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from './claude/index.js';
import type { Adapter, AdapterEnv } from './types.js';

export interface ActiveAdapter {
  adapter: Adapter;
  env: AdapterEnv;
}

/** All installed tools we can sync. The codex adapter (M2.5) registers here. */
export function detectAdapters(home: string = homedir()): ActiveAdapter[] {
  const active: ActiveAdapter[] = [];
  const claudeEnv: AdapterEnv = { home, dataDir: join(home, '.claude', 'projects') };
  if (claudeAdapter.detect(claudeEnv)) active.push({ adapter: claudeAdapter, env: claudeEnv });
  return active;
}
