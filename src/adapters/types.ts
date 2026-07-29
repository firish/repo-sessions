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

export interface Adapter {
  id: string;
  detect(env: AdapterEnv): boolean;
  /** All local sessions whose recorded cwd is the repo root or inside it. */
  locate(repoRoot: string, env: AdapterEnv): SessionRef[];
  /** Absolute paths -> ${CSS_*} tokens (vault-canonical form).
   *  Pass json for JSONL content: matches JSON-escaped path spellings too. */
  tokenize(content: string, ctx: PathCtx, opts?: SubstOpts): string;
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
