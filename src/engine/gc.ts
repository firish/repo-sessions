import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, Vault } from './vault.js';

/**
 * Vault retention (M3): keep the newest `keep` sessions per project/tool and
 * drop anything older than `days`. Deletes the session dir (transcript +
 * conflicts + meta) and the index entry; the caller commits.
 */

export interface GcOptions {
  keep?: number;
  days?: number;
  nowMs?: number;
}

export interface GcResult {
  pruned: number;
  kept: number;
}

function entryTs(e: SessionEntry): number {
  return Date.parse(e.lastTs ?? e.syncedAt) || 0;
}

export function pruneVault(vault: Vault, opts: GcOptions): GcResult {
  const index = vault.loadIndex();
  const nowMs = opts.nowMs ?? Date.now();
  const result: GcResult = { pruned: 0, kept: 0 };

  for (const [dirName, project] of Object.entries(index.projects)) {
    for (const [toolId, tool] of Object.entries(project.tools)) {
      const entries = Object.entries(tool.sessions).sort((a, b) => entryTs(b[1]) - entryTs(a[1]));
      entries.forEach(([sessionId, entry], rank) => {
        const overCount = opts.keep !== undefined && rank >= opts.keep;
        const tooOld = opts.days !== undefined && nowMs - entryTs(entry) > opts.days * 86_400_000;
        if (overCount || tooOld) {
          const dir = join(vault.path, dirName, toolId, 'sessions', sessionId);
          if (existsSync(dir)) rmSync(dir, { recursive: true });
          delete tool.sessions[sessionId];
          result.pruned++;
        } else {
          result.kept++;
        }
      });
    }
  }
  vault.saveIndex(index);
  return result;
}
