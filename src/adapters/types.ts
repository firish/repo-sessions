/** ADR-6: every tool-specific assumption lives behind this interface. */

export interface PathCtx {
  projectRoot: string;
  home: string;
}

/** A local session file discovered by an adapter. */
export interface SessionRef {
  sessionId: string;
  filePath: string;
  /** Absolute cwd recorded inside the transcript (may be a subdir of the repo root). */
  cwd: string;
  byteLen: number;
  mtimeMs: number;
  toolVersion?: string;
  summary?: string;
  lastTs?: string;
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
  /** Directory where a rehydrated session for `cwd` must be installed. */
  installDir(cwd: string, env: AdapterEnv): string;
  /** Doctor/CI check: does the tool actually resume this session? */
  verifyResume(sessionId: string, repoRoot: string): Promise<boolean>;
}
