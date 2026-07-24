# M0 De-risking Spike — Findings

Machine: macOS (darwin 25.3.0), Claude Code CLI 2.1.215 (VS Code extension writes 2.1.218), Node present.
Method: two directory trees under distinct roots ("site-a", "site-b") simulate two machines — the same-OS/different-path cell of the ADR-3 test matrix.

## Track A — Claude Code: **PASS** ✅

`claude --resume` accepts a rehydrated session. The core architecture bet holds.

**Pipeline proven** (scripts in `spike/m0a-claude/`):

1. Baseline: `claude -p` in site-a established codeword `BANANA-42` and stated its cwd in the reply → session `593bb202` (10 lines), abs path present in metadata (`cwd` per line) *and* message content — 7 occurrences.
2. `tokenize.mjs`: all 7 → `${CSS_PROJECT_ROOT}`; **0 residual** absolute paths.
3. Negative control: from site-b, `claude -p --resume 593bb202` → "No conversation found" (the exact cross-device failure the product fixes).
4. `rehydrate.mjs --install`: tokens → site-b paths, installed at `~/.claude/projects/<munged(site-b)>/593bb202.jsonl`; **0 residual tokens**.
5. Resume from site-b: recalled `BANANA-42` **and reported site-b as its cwd** — no site-a leakage, context fully consistent.

**Facts pinned (CC 2.1.215):**

- **Munge rule:** project dir name = abs cwd with every char outside `[A-Za-z0-9-]` replaced by `-` (verified for `/`, `.`, `_`; literal `-` passes through, so segments starting with `-` produce `--`).
- **Rule drift is real:** this machine has both `-AI-AI-ML` and `-AI-AI_ML` for the same `AI_ML` dir — some older version/entrypoint preserved `_`. Adapter `locate()` must scan known variants, not just compute one name.
- **Resume semantics:** `-p --resume <id>` continues the **same session id**, appending to the same file (10 → 17 lines); forking is opt-in via `--fork-session`. This matches the append-only / fast-forward sync model in the plan (§3).
- Sessions are plain per-line JSON with `cwd`, `sessionId`, `version`, `gitBranch` on every line; plain string replacement on the raw file is sound on POSIX (JSON doesn't escape `/`).
- Project dir also contains a `memory/` subdir (session memory). Scope decision for M1: sync it or not (leaning: yes, it's project-scoped state).
- Nested `claude -p` works from within a Claude Code session (unset `CLAUDE*` env vars) — the spike is fully automatable; this becomes the canary CI pattern.

## Track B — Codex: (in progress)

**Storage backend verified on this machine** (VS Code ChatGPT extension `openai.chatgpt-26.5715.*`, cli 0.125.0-alpha.3):

- **Hybrid, confirming the AuthSec flag:** `~/.codex/state_5.sqlite` `threads` table is the session index — columns include `id`, `rollout_path` (absolute!), `cwd`, `git_origin_url`, `git_branch`, `git_sha`, `cli_version`, `source` — while transcripts remain JSONL rollouts at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`.
- Rollout line 1 is `session_meta` with `payload.{id, cwd, originator, cli_version, source}`.
- Per the 0.128 change (session picker reads SQLite): **rehydration must both rewrite the rollout JSONL and upsert a `threads` row** (`rollout_path` + `cwd` are the path-bearing columns) or the session is invisible to the picker.
- No standalone `codex` CLI on this machine — resume validation runs against a scratch-installed npm CLI with an isolated `CODEX_HOME` (never touching live `~/.codex`).

## Node cold-start (hook budget): (pending)

## Related work (recon)

- **CASR** ([cross_agent_session_resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer)) — Rust, canonical-IR converters for Codex/Claude/Gemini; reads the same JSONL surfaces; README doesn't document the SQLite layer. Sibling: [coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search) (11+ provider format docs).
- [codex-provider-sync](https://github.com/Dailin521/codex-provider-sync) — narrowly about keeping rollout files and SQLite state consistent; direct prior art for Track B's upsert step.
- [AuthSec writeup](https://authsec.ai/blogs/stop-re-explaining-bridge-claude-codex-gemini) — source of the SQLite flag; NB its Claude munge rule ("colon, backslash, slash, space") is **incomplete** vs our empirical result (`.` and `_` also munge on 2.1.215).
- [npow/session-sync](https://github.com/npow/session-sync) + `@npow/interchange-core` — cross-tool conversion (distill-adjacent, v2 territory).
