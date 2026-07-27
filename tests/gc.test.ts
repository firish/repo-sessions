import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneVault } from '../src/engine/gc';
import { Vault, writeTranscript, type SessionEntry, type VaultIndex } from '../src/engine/vault';
import { mkTmp } from './helpers';

const NOW = Date.parse('2026-07-26T00:00:00.000Z');

function entry(lastTs: string): SessionEntry {
  return { byteLen: 10, sha256: 'x', device: 'd', cwdTok: '${CSS_PROJECT_ROOT}', syncedAt: lastTs, lastTs };
}

function rig(): { vault: Vault; dir: (sid: string) => string } {
  const vaultPath = mkTmp('gc');
  const index: VaultIndex = {
    version: 1,
    projects: {
      'k1-proj': {
        slug: 'proj',
        origin: 'x/proj',
        tools: {
          claude: {
            sessions: {
              old: entry('2026-01-01T00:00:00.000Z'),
              mid: entry('2026-07-01T00:00:00.000Z'),
              new: entry('2026-07-25T00:00:00.000Z'),
            },
          },
        },
      },
    },
  };
  const vault = new Vault({ vaultUrl: 'file:///dev/null', vaultPath, device: 'test' });
  mkdirSync(vaultPath, { recursive: true });
  vault.saveIndex(index);
  const dir = (sid: string): string => join(vaultPath, 'k1-proj', 'claude', 'sessions', sid);
  for (const sid of ['old', 'mid', 'new']) writeTranscript(dir(sid), `content-${sid}\n`);
  return { vault, dir };
}

describe('vault gc', () => {
  it('--keep retains the newest N and deletes the rest', () => {
    const { vault, dir } = rig();
    const res = pruneVault(vault, { keep: 2, nowMs: NOW });
    expect(res).toEqual({ pruned: 1, kept: 2 });
    expect(existsSync(dir('old'))).toBe(false);
    expect(existsSync(dir('new'))).toBe(true);
    expect(Object.keys(vault.loadIndex().projects['k1-proj']!.tools.claude!.sessions)).toEqual(['mid', 'new']);
  });

  it('--days drops sessions older than the window', () => {
    const { vault, dir } = rig();
    const res = pruneVault(vault, { days: 60, nowMs: NOW });
    expect(res.pruned).toBe(1); // only "old" is outside 60 days
    expect(existsSync(dir('old'))).toBe(false);
    expect(existsSync(dir('mid'))).toBe(true);
  });
});
