/** ADR-6: every tool-specific assumption lives behind this interface. */

/** How tokenize/rehydrate treat the content they substitute into. */
export interface SubstOpts {
  /** Content is serialized JSON (jsonl transcripts). */
  json?: boolean;
}

export interface PathCtx {
  projectRoot: string;
  home: string;
  /** The adapter's own data root (claude: ~/.claude/projects, codex: $CODEX_HOME).
   *  Codex rollouts embed it, so it must be tokenized too. */
  toolDataDir?: string;
}

/** A local session file discovered by an adapter. */
export interface SessionRef {
  sessionId: string;
  filePath: string;
  /** Path relative to the adapter's dataDir. Machine-neutral for codex
   *  (date tree); machine-specific for claude (munged cwd), where install
   *  recomputes it instead. */
  relPath: string;
  /** Absolute cwd recorded inside the transcript (may be a subdir of the repo root). */
  cwd: string;
  byteLen: number;
  mtimeMs: number;
  toolVersion?: string;
  summary?: string;
  lastTs?: string;
}

/** What pull knows about a session when deciding where to install it. */
export interface InstallRef {
  sessionId: string;
  /** cwd already rehydrated for THIS machine. */
  cwd: string;
  relPath?: string;
}

/** A project-scoped memory file (claude: ~/.claude/projects/<munged>/memory/*.md). */
export interface MemoryRef {
  fileName: string;
  filePath: string;
  byteLen: number;
  mtimeMs: number;
}

/** Where the adapter's session store lives; injectable for tests. */
export interface AdapterEnv {
  home: string;
  /** Root of the tool's session storage (claude: ~/.claude/projects). */
  dataDir: string;
}

/**
 * Comparison normal form: collapse EVERY known device's path spellings.
 *
 * Tokenization is machine-relative, and transcripts can quote path spellings
 * as data (a pasted dirname, a meta.json dump, terminal output — any session
 * about the tool itself). Device A pushes such content with B's spellings
 * intact (it cannot recognize them); B's own tokenize collapses them. No
 * single machine's tokenize can therefore reproduce vault bytes written by
 * another — shas disagree forever, every pull misreads the session as
 * diverged, and every rebase splices a false tail (duplicating turns).
 *
 * The fix: comparisons and trunk-finding never touch raw bytes. Both sides
 * are first stripped of the adapter's volatile records (metadata the tool
 * rewrites non-deterministically per machine — claude's per-turn ai-title
 * refreshes land at different positions in each device's copy of the same
 * conversation), then folded through tokenize under every device ctx
 * recorded in the vault (deterministic order: local first, then foreign
 * sorted by device name). Tokens are inert under further tokenize and
 * stripping is idempotent, so the fold is a projection — applying it twice
 * equals applying it once. The result is compare-only: vault writes always
 * store the writer's own tokenize output, installs always rehydrate the raw
 * vault bytes.
 */
export function canonForCompare(adapter: Adapter, content: string, ctxs: PathCtx[], opts?: SubstOpts): string {
  let out = adapter.stripVolatile ? adapter.stripVolatile(content) : content;
  for (const c of ctxs) out = adapter.tokenize(out, c, opts);
  return out;
}

/** The ctx fold order for canonForCompare: this machine, then every other
 *  device the vault has seen for this tool, sorted for determinism. */
export function compareCtxs(local: PathCtx, deviceCtxs: Record<string, PathCtx> | undefined, selfDevice: string): PathCtx[] {
  const foreign = Object.entries(deviceCtxs ?? {})
    .filter(([device]) => device !== selfDevice)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, c]) => c);
  return [local, ...foreign];
}

export interface Adapter {
  id: string;
  detect(env: AdapterEnv): boolean;
  /** All local sessions whose recorded cwd is the repo root or inside it. */
  locate(repoRoot: string, env: AdapterEnv): SessionRef[];
  /** Absolute paths -> ${CSS_*} tokens (vault-canonical form).
   *  Pass json for JSONL content: matches JSON-escaped path spellings too. */
  tokenize(content: string, ctx: PathCtx, opts?: SubstOpts): string;
  /** Drop records the tool rewrites non-deterministically per machine
   *  (claude: per-turn ai-title refreshes), so honest copies of the same
   *  conversation never disagree on them. Compare-only — vault and local
   *  files keep their volatile records; only canonForCompare applies this. */
  stripVolatile?(content: string): string;
  /** ${CSS_*} tokens -> concrete local paths.
   *  Pass json for JSONL content: emits JSON-escaped spellings so Windows
   *  backslashes never produce invalid escapes inside string literals. */
  rehydrate(content: string, ctx: PathCtx, opts?: SubstOpts): string;
  /** Absolute file path where a rehydrated session must be installed so the
   *  tool's resume finds it. */
  installPath(ref: InstallRef, env: AdapterEnv): string;
  /** Doctor/CI check: does the tool actually resume this session? */
  verifyResume(sessionId: string, repoRoot: string, env: AdapterEnv): Promise<boolean>;
  /** Project-scoped memory files, for tools that keep them as files (claude).
   *  Absent = the tool has no syncable per-project memory (codex: global
   *  SQLite — see support matrix). */
  locateMemory?(repoRoot: string, env: AdapterEnv): MemoryRef[];
  /** Where a pulled memory file must land on this machine. */
  memoryPath?(fileName: string, repoRoot: string, env: AdapterEnv): string;
}
