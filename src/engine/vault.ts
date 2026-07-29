import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CssError, log } from './common.js';
import type { CssConfig } from './config.js';
import { git } from './git.js';

export interface SessionEntry {
  /** Byte length and sha256 of the TOKENIZED transcript (vault-canonical form). */
  byteLen: number;
  sha256: string;
  device: string;
  /** Tokenized cwd, e.g. "${CSS_PROJECT_ROOT}/blog" — decides install dir on pull. */
  cwdTok: string;
  /** Origin-machine path relative to the tool's dataDir (machine-neutral for
   *  codex date trees; claude recomputes at install instead). */
  relPath?: string;
  lastTs?: string;
  summary?: string;
  toolVersion?: string;
  syncedAt: string;
  /** Devices that have written a .conflict transcript for this session. */
  conflicts?: string[];
  /** User-assigned name (chat name) — lives here so it syncs across machines. */
  name?: string;
}

/** Memory files are mutable markdown — no append-only structure, so sync is
 *  newest-mtime-wins per file, with vault git history as the undo. */
export interface MemoryEntry {
  sha256: string;
  byteLen: number;
  mtimeMs: number;
  device: string;
  syncedAt: string;
}

export interface ProjectEntry {
  slug: string;
  origin: string;
  tools: Record<string, { sessions: Record<string, SessionEntry>; memory?: Record<string, MemoryEntry> }>;
}

export interface VaultIndex {
  version: 1;
  projects: Record<string, ProjectEntry>;
}

/** The private sessions vault: one git repo, plain directories on its default
 *  branch (ADR-1/ADR-2). All writes go through commitAndPush. */
export class Vault {
  constructor(public cfg: CssConfig) {}

  get path(): string {
    return this.cfg.vaultPath;
  }

  ensureCloned(): void {
    if (existsSync(join(this.path, '.git'))) {
      this.ensureAttributes();
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const res = git(['clone', '--quiet', this.cfg.vaultUrl, this.path], { allowFail: true, timeoutMs: 60_000 });
    if (!res.ok) {
      throw new CssError(`could not clone vault from ${this.cfg.vaultUrl}`, res.stderr);
    }
    this.ensureAttributes();
  }

  /** The vault is a data store, not source code: `* -text` disables git's
   *  EOL conversion so Windows core.autocrlf can never rewrite LF content to
   *  CRLF on checkout (which read as phantom memory-file changes). Committed
   *  with the next sync. */
  private ensureAttributes(): void {
    const attrs = join(this.path, '.gitattributes');
    if (existsSync(attrs)) return;
    writeFileSync(attrs, '* -text\n');
  }

  /** Bring the local clone up to date. Throws CssError when the remote is
   *  unreachable — callers decide whether that is fatal (G5). */
  refresh(): 'ok' | 'empty' {
    const heads = git(['ls-remote', '--heads', 'origin'], {
      cwd: this.path,
      allowFail: true,
      timeoutMs: 15_000,
    });
    if (!heads.ok) throw new CssError('vault remote unreachable', heads.stderr);
    if (heads.stdout === '') return 'empty'; // fresh vault, nothing to pull yet
    git(['pull', '--rebase', '--autostash', '--quiet'], { cwd: this.path, timeoutMs: 60_000 });
    return 'ok';
  }

  /** Stage everything, commit, push (retry once through a rebase — two devices
   *  racing are serialized by git itself). Returns false when nothing changed. */
  commitAndPush(message: string): boolean {
    git(['add', '-A'], { cwd: this.path });
    const staged = git(['diff', '--cached', '--quiet'], { cwd: this.path, allowFail: true });
    if (staged.ok) return false;
    git(
      ['-c', 'user.name=css-sync', '-c', 'user.email=css@localhost', 'commit', '--quiet', '-m', message],
      { cwd: this.path },
    );
    const push = git(['push', '--quiet', '-u', 'origin', 'HEAD'], {
      cwd: this.path,
      allowFail: true,
      timeoutMs: 60_000,
    });
    if (!push.ok) {
      log.warn('vault push rejected, rebasing and retrying');
      git(['pull', '--rebase', '--autostash', '--quiet'], { cwd: this.path, timeoutMs: 60_000 });
      const retry = git(['push', '--quiet', '-u', 'origin', 'HEAD'], {
        cwd: this.path,
        allowFail: true,
        timeoutMs: 60_000,
      });
      if (!retry.ok) throw new CssError('vault push failed after retry', retry.stderr);
    }
    return true;
  }

  private get indexPath(): string {
    return join(this.path, 'index.json');
  }

  loadIndex(): VaultIndex {
    if (!existsSync(this.indexPath)) return { version: 1, projects: {} };
    return JSON.parse(readFileSync(this.indexPath, 'utf8')) as VaultIndex;
  }

  saveIndex(index: VaultIndex): void {
    writeFileSync(this.indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
}

// ---- transcript storage (gzipped in the vault; long sessions compress ~10x)

const TRANSCRIPT_GZ = 'transcript.jsonl.gz';
const TRANSCRIPT_PLAIN = 'transcript.jsonl'; // pre-M3 vaults

export function writeTranscript(sessionDir: string, content: string): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, TRANSCRIPT_GZ), gzipSync(Buffer.from(content)));
  const legacy = join(sessionDir, TRANSCRIPT_PLAIN);
  if (existsSync(legacy)) rmSync(legacy); // migrate on rewrite
}

export function readTranscript(sessionDir: string): string | null {
  const gz = join(sessionDir, TRANSCRIPT_GZ);
  if (existsSync(gz)) return gunzipSync(readFileSync(gz)).toString('utf8');
  const plain = join(sessionDir, TRANSCRIPT_PLAIN);
  if (existsSync(plain)) return readFileSync(plain, 'utf8');
  return null;
}

export function writeConflict(sessionDir: string, device: string, content: string): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `transcript.conflict-${device}.jsonl.gz`), gzipSync(Buffer.from(content)));
}

export function readConflict(sessionDir: string, device: string): string | null {
  const p = join(sessionDir, `transcript.conflict-${device}.jsonl.gz`);
  return existsSync(p) ? gunzipSync(readFileSync(p)).toString('utf8') : null;
}
