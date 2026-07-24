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

## Track B — Codex: **PASS** ✅

Validated against a scratch-installed `@openai/codex` **0.145.0** with isolated `CODEX_HOME`s (live `~/.codex` never touched; auth.json copy works across versions). Machine B simulated by a second fresh home that ran its own warmup session first.

**Storage backend (the AuthSec flag, confirmed and refined):**

- **Hybrid:** `state_5.sqlite` `threads` table is the session *index*; transcripts remain JSONL rollouts at `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. A fresh 0.145 home still creates `state_5` — no schema migration since the extension's 0.125-alpha (one less drift axis today). DB runs in WAL mode.
- Path-bearing surfaces: rollout content (project root ×27, **`CODEX_HOME` ×10** — a third token Claude doesn't need), and in the DB row: `rollout_path`, `cwd`, **and `sandbox_policy`** (a JSON blob full of absolute project paths).
- Rollouts are machine-global (date tree), *not* project-keyed — `locate()` filters by the `cwd` recorded inside, exactly as the plan predicted.

**Resume mechanics (better than planned):**

1. **`codex exec resume <id>` needs only the rewritten rollout file** — no `threads` row. Codeword recalled, site-b cwd consistent.
2. **The index self-heals:** that resume auto-created a correct `threads` row in machine-B's DB, derived from the rollout (correct site-b cwd).
3. **External insert also works** (needed for picker visibility *before* first resume): ATTACH machine-A's DB, copy the row, `REPLACE()` paths in `rollout_path`/`cwd`/`sandbox_policy`, bump recency → `exec resume --last` picked the inserted row and recalled the codeword, coexisting with machine-B's own sessions.

Net: Track B risk collapses. The adapter's minimum viable rehydrate is "rewrite rollout, drop in date tree"; the DB upsert is a UX enhancement, not a correctness requirement. Scripts in `spike/m0b-codex/`.

## Node cold-start (hook budget): **PASS** ✅

Node v20.14.0: bare `node -e ''` 20ms warm / 80ms cold; `munge.mjs` 30–40ms. Well under the 150ms/hook budget (ADR-5). No Go fallback needed.

## M0 verdict

**Both tracks pass — no pivot, no kill criteria triggered. Proceed to M1 as planned** (CLI core + claude adapter), with M2.5 (codex) de-risked ahead of schedule. The spike scripts are the seeds of `tokenize()`/`rehydrate()`; the nested-CLI codeword test is the canary CI pattern. Remaining matrix cells (macOS↔Linux, →Windows) still owed but the mechanism is proven; Windows `\\`-escaped JSON paths are the main open question.

## Related work (recon)

- **CASR** ([cross_agent_session_resumer](https://github.com/Dicklesworthstone/cross_agent_session_resumer)) — Rust, canonical-IR converters for Codex/Claude/Gemini; reads the same JSONL surfaces; README doesn't document the SQLite layer. Sibling: [coding_agent_session_search](https://github.com/Dicklesworthstone/coding_agent_session_search) (11+ provider format docs).
- [codex-provider-sync](https://github.com/Dailin521/codex-provider-sync) — narrowly about keeping rollout files and SQLite state consistent; direct prior art for Track B's upsert step.
- [AuthSec writeup](https://authsec.ai/blogs/stop-re-explaining-bridge-claude-codex-gemini) — source of the SQLite flag; NB its Claude munge rule ("colon, backslash, slash, space") is **incomplete** vs our empirical result (`.` and `_` also munge on 2.1.215).
- [npow/session-sync](https://github.com/npow/session-sync) + `@npow/interchange-core` — cross-tool conversion (distill-adjacent, v2 territory).
