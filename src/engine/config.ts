import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface CssConfig {
  vaultUrl: string;
  vaultPath: string;
  device: string;
  /** Stop-hook push debounce in minutes. Default 2; 0 = push after every
   *  response. Small values make lid-close laptop-hopping near-lossless. */
  stopDebounceMinutes?: number;
}

/** CSS_CONFIG_DIR override exists for tests and the e2e harness, which
 *  simulate multiple devices on one machine. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CSS_CONFIG_DIR ?? join(homedir(), '.config', 'css');
}

export function configPath(dir: string = configDir()): string {
  return join(dir, 'config.json');
}

export function loadConfig(dir: string = configDir()): CssConfig | null {
  const p = configPath(dir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as CssConfig;
}

export function saveConfig(cfg: CssConfig, dir: string = configDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(dir), `${JSON.stringify(cfg, null, 2)}\n`);
}

export function defaultVaultPath(): string {
  return join(homedir(), '.local', 'share', 'css', 'vault');
}

export function deviceName(): string {
  return hostname().split('.')[0] ?? 'device';
}
