---
description: List or sync this repo's synced agent sessions (repo-sessions vault)
allowed-tools: Bash(css *)
---

Run the repo-sessions CLI for this repository and relay the result.

Subcommand requested: `$ARGUMENTS` (when empty, use `list`).

- `list` → run `css list`; show the sessions table verbatim, then remind the
  user they can continue any of them with `claude --resume <session-id>`.
- `push` / `pull` / `status` → run `css push` / `css pull` / `css status` and
  summarize the outcome in one line (what changed, any conflicts).
- Anything else → run `css help` and show usage.

If `css` reports the repo is not enabled or not initialized, show the exact
hint it prints (it says which command to run) rather than improvising.
