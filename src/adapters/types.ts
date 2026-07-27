/** ADR-6: every tool-specific assumption lives behind this interface. */

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
  /** Absolute paths -> ${CSS_*} tokens (vault-canonical form). */
  tokenize(content: string, ctx: PathCtx): string;
  /** ${CSS_*} tokens -> concrete local paths. */
  rehydrate(content: string, ctx: PathCtx): string;
  /** Absolute file path where a rehydrated session must be installed so the
   *  tool's resume finds it. */
  installPath(ref: InstallRef, env: AdapterEnv): string;
  /** Doctor/CI check: does the tool actually resume this session? */
  verifyResume(sessionId: string, repoRoot: string, env: AdapterEnv): Promise<boolean>;
}
