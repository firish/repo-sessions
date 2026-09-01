# Changelog

## 1.0.0 — 2026-08-31

Everything below is the initial public release.

### The core

- **Sessions follow the repo**: Claude Code + Codex transcripts sync through
  a single private git vault, namespaced per-project by origin URL, with
  every embedded path tokenized on push and rewritten per-machine on pull —
  `claude --resume` / `codex resume` just work on the next laptop.
- **Zero ceremony**: chain-loading git hooks (`pre-push` out,
  `post-merge`/`post-checkout` in) plus a Claude Code plugin
  (SessionStart pull + stale-resume warning, SessionEnd/Stop background
  push with configurable debounce). `chat setup` once per machine,
  `chat init` once per repo.
- **Project memory travels too** (claude): `~/.claude/projects/*/memory`
  syncs with newest-wins-per-file semantics; vault git history is the undo.

### The verbs

`setup`, `init`, `disable`, `push`, `pull`, `list`, `status`, `memory`,
`resume` (name-aware, auto-pulls, picks the tool), `name` (vault-synced
session names), `rebase` (splice diverged tails), `split` (divergent branch
→ own session), `fork [--at <vault-hash>]` (safe rewind, works on deleted
sessions), `open`, `rm` (unsynced-turns guard; vault history keeps it),
`restore` (resurrect deleted sessions, no hash needed), `ignore`
(`.chatignore`), `hooks`, `gc`, `doctor` (env checks, secret scan,
resume canary). Aliases kept: `css` bin, `enable`, `duplicate`, `merge`.

### Safety rails

- Vault must be private (`chat setup` refuses public GitHub vaults).
- Gitleaks-style secret scan on push and doctor (warn-only).
- Append-only invariant: divergence is never destroyed — conflict copies +
  `rebase`/`split`; compaction-containing tails refuse unsafe splices.
- Byte-representation hardened: JSON-escaped Windows path spellings,
  drive-letter case, CRLF-immune memory compares, `* -text` vault attributes.

### Proven

61 hermetic tests green on macOS, Windows, and Linux (CI matrix); live
end-to-end demos for both tools (`scripts/e2e-*.sh`); dogfooded across
three real machines — including one cross-OS session resume that found and
fixed two Windows byte-drift bugs before you had to hit them.
