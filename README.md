# repo-sessions (`css`)

> Your Claude Code conversations follow your repo, not your laptop.

Git-native sync of coding-agent sessions across devices through a single
**private vault repo**. Start a session on laptop A, `git push`; on laptop B,
`git pull` and `claude --resume` — the conversation is there, with every
embedded path rewritten for that machine. Claude Code ships first; Codex is
next (its mechanics are already validated — see `M0-FINDINGS.md`).

**Status: M2.** Sync now rides your git muscle memory: `css enable` installs
chain-loading git hooks (`pre-push` syncs out, `post-merge`/`post-checkout`
sync in, in the background), and the bundled Claude Code plugin adds
SessionStart/SessionEnd/Stop lifecycle sync plus `/sessions` commands.
22 unit tests; `scripts/e2e-local.sh` proves the whole flow with zero manual
sync commands. The codex adapter (M2.5) is next; not yet published.

## Quickstart

```sh
css init                # one-time per machine: creates/clones your private vault
                        #   (or: css init --url <any-private-git-url>)
css enable              # once per repo — after this, git push/pull sync sessions
css list                # sessions for this repo: id, state, device, summary
css status              # sync state, conflicts, vault reachability
css hooks status        # what's installed; install|uninstall to manage
css push / css pull     # manual sync (hooks make this mostly unnecessary)
css doctor [--verify <session-id>]   # env checks; --verify resumes for real
```

Existing hooks (including husky-style `core.hooksPath` setups) are respected:
foreign hooks are chain-loaded and run first with their stdin/argv intact —
their failure still aborts the git operation; css never does.

## Claude Code plugin (`plugin/`)

SessionStart pulls newer sessions and surfaces a one-line notice inside
Claude; SessionEnd pushes in a detached background process; Stop debounce-
pushes (10 min) to cover laptop-lid-close. `/sessions list|push|pull|status`
wraps the CLI. Marketplace listing comes with M4 — until then, point Claude
Code at the `plugin/` directory (requires `css` on PATH via `npm i -g .`).

Sessions are namespaced per-repo (hash of the normalized `origin` URL), so one
vault serves every project forever, and session data never touches the
project's own history — safe for open-source repos by construction.

## Threat model, plainly

Transcripts contain **whatever your sessions saw** — possibly env vars, tool
output, proprietary code. The vault must be a **private** repo; `css init`
refuses a public GitHub vault when it can check. Secret-scanning and
`.cssignore` land in M3; until then, treat the vault like you treat `.env`.

## Development

```sh
npm run build     # tsc -> dist/
npm test          # vitest — includes a full 2-device sync simulation (local git only)
scripts/e2e-local.sh <dir>   # live demo: real claude session through a real vault
```

Design docs: `PLAN-repo-sessions.md` (architecture ADRs, roadmap),
`M0-FINDINGS.md` (empirical spike results the design rests on).
