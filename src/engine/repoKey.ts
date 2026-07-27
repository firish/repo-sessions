import { sha256hex } from './common.js';

/**
 * Normalize a git remote URL so every spelling of the same repo yields the
 * same vault key: strip protocol, credentials, trailing ".git" and "/";
 * case-fold the host (paths stay case-sensitive). Handles scp-like syntax
 * (git@host:path).
 */
export function normalizeOrigin(url: string): string {
  let rest = url.trim();

  const protoIdx = rest.indexOf('://');
  let host: string;
  let path: string;
  if (protoIdx !== -1) {
    rest = rest.slice(protoIdx + 3);
    const at = rest.lastIndexOf('@');
    if (at !== -1) rest = rest.slice(at + 1); // strip user[:pass]@
    const slash = rest.indexOf('/');
    host = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? '' : rest.slice(slash + 1);
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(rest);
    if (scp && scp[1] && scp[2] !== undefined) {
      host = scp[1];
      path = scp[2];
    } else {
      // Local path remote (file vault, bare repo on a NAS mount).
      host = '';
      path = rest;
    }
  }

  host = host.toLowerCase().replace(/:\d+$/, '');
  path = path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
  return host ? `${host}/${path}` : path;
}

export interface RepoKey {
  key: string;
  slug: string;
  /** Directory name inside the vault: <key>-<slug>. */
  dirName: string;
  normalized: string;
}

export function repoKeyFromOrigin(originUrl: string): RepoKey {
  const normalized = normalizeOrigin(originUrl);
  const key = sha256hex(normalized).slice(0, 8);
  const lastSegment = normalized.split('/').filter(Boolean).pop() ?? 'project';
  const slug =
    lastSegment
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  return { key, slug, dirName: `${key}-${slug}`, normalized };
}
