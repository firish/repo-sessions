import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CssError, sha256hex } from './common.js';
import { resolveRepoKey, type SyncCtx } from './sync.js';
import { Vault, type SessionEntry } from './vault.js';

/**
 * Delete one session everywhere this machine can reach: local transcript(s)
 * and the vault copy (dir + index entry). The vault is git, so rm is
 * recoverable from vault history; the guarded case is the local file — never
 * silently destroy the only copy of unsynced turns.
 */

export interface RmResult {
  removedLocal: number;
  removedVault: boolean;
  name?: string;
}

export function rmSession(ctx: SyncCtx, sessionId: string, opts: { force?: boolean } = {}): RmResult {
  const vault = new Vault(ctx.cfg);
  vault.ensureCloned();
  vault.refresh();
  const key = resolveRepoKey(ctx);
  const index = vault.loadIndex();
  const project = index.projects[key.dirName];

  let entry: SessionEntry | undefined;
  if (project) {
    for (const tool of Object.values(project.tools)) {
      if (tool.sessions[sessionId]) entry = tool.sessions[sessionId];
    }
  }

  const localRefs = ctx.adapters
    .map((a) => ({ a, ref: a.adapter.locate(ctx.repoRoot, a.env).find((r) => r.sessionId === sessionId) }))
    .filter((x) => x.ref !== undefined);

  if (!opts.force) {
    for (const { a, ref } of localRefs) {
      const tok = a.adapter.tokenize(readFileSync(ref!.filePath, 'utf8'), {
        projectRoot: ctx.repoRoot,
        home: ctx.home,
        toolDataDir: a.env.dataDir,
      });
      if (!entry || sha256hex(tok) !== entry.sha256) {
        throw new CssError(
          `local copy of ${sessionId.slice(0, 8)} has turns the vault does not (or was never synced)`,
          'chat push first, or chat rm --force to delete anyway',
        );
      }
    }
  }

  let removedLocal = 0;
  for (const { ref } of localRefs) {
    rmSync(ref!.filePath);
    removedLocal++;
  }

  let removedVault = false;
  if (project) {
    for (const [toolId, tool] of Object.entries(project.tools)) {
      if (tool.sessions[sessionId]) {
        delete tool.sessions[sessionId];
        const dir = join(vault.path, key.dirName, toolId, 'sessions', sessionId);
        if (existsSync(dir)) rmSync(dir, { recursive: true });
        removedVault = true;
      }
    }
    if (removedVault) {
      vault.saveIndex(index);
      // Full id in the message — chat restore's deleted-listing parses these.
      vault.commitAndPush(`rm(${key.slug}): ${sessionId}${entry?.name ? ` (${entry.name})` : ''}`);
    }
  }
  return { removedLocal, removedVault, name: entry?.name };
}
