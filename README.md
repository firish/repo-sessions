# repo-sessions (`css`)

> Your Claude Code conversations follow your repo, not your laptop.

Git-native sync of coding-agent sessions across devices through a single
**private vault repo**. Start a session on laptop A, `git push`; on laptop B,
`git pull` and `claude --resume` — the conversation is there, with every
embedded path rewritten for that machine. Claude Code ships first; Codex is
next (its mechanics are already validated — see `M0-FINDINGS.md`).

**Status: M3 (pre-launch).** Both launch adapters work end-to-end and sync
rides your git muscle memory: `css enable` installs chain-loading git hooks
(`pre-push` syncs out, `post-merge`/`post-checkout` sync in, in the
background), and the bundled Claude Code plugin adds SessionStart/SessionEnd/
Stop lifecycle sync plus `/sessions` commands. Vault transcripts are gzipped,
`css gc` handles retention, and push/doctor run a secret scan. 30 unit tests;
`scripts/e2e-local.sh` (claude, hook-driven) and `scripts/e2e-codex.sh`
(codex, real CLI) prove both flows live. Not yet published.

## Support matrix

| | Claude Code | Codex |
|---|---|---|
| Sessions synced | CLI + VS Code extension (same store) | CLI + VS Code extension (same store) |
| Sync triggers | git hooks + SessionStart/End/Stop plugin hooks | git hooks only (no plugin surface) |
| Resume on another machine | `claude --resume <id>` immediately | `codex resume <id>` immediately; interactive **picker** lists it after first resume (index self-heals; we never write codex's SQLite) |
| Format risk | munge rule drifted before — `locate()` scans variants; `doctor --verify` is the canary | rollout schema is younger; pinned per-session via `meta.json` `toolVersion` |

## Quickstart

```sh
css init                # one-time per machine: creates/clones your private vault
                        #   (or: css init --url <any-private-git-url>)
css enable              # once per repo — after this, git push/pull sync sessions
css list                # sessions for this repo: id, state, device, summary
css status              # sync state, conflicts, vault reachability
css hooks status        # what's installed; install|uninstall to manage
css push / css pull     # manual sync (hooks make this mostly unnecessary)
css gc --keep 20 --days 90           # vault retention (per project/tool)
css doctor [--verify <session-id>]   # env checks, secret scan; --verify resumes for real
```

Existing hooks (including husky-style `core.hooksPath` setups) are respected:
foreign hooks are chain-loaded and run first with their stdin/argv intact —
their failure still aborts the git operation; css never does.

## Working from any laptop

Sequential use (one laptop at a time) never diverges as long as syncs are
tight: SessionEnd pushes immediately, the Stop hook pushes at most
`stopDebounceMinutes` (config.json; default 2, `0` = every response) behind
your last message, and SessionStart/`css enable` pull before you resume.
When divergence does happen — you resumed on B before A's tail pushed —
nothing is lost and two commands reconcile:

- `css merge <id>` splices the divergent tails into one transcript
  ("meanwhile, on the other laptop"), re-parenting the seam so every turn
  replays. All devices converge on the merged transcript on their next pull.
- `css merge <id> --split` (also what merge recommends when a tail contains a
  compaction boundary, which cannot be safely spliced): the divergent branch
  becomes its own new session, the old id converges on the vault transcript.
- `css duplicate <id>` forks any session into a new id — useful before
  experiments, or to deliberately branch work per machine.

If you resume a stale snapshot, the SessionStart hook warns *inside the
session* that newer turns were just pulled and how to pick them up.

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
refuses a public GitHub vault when it can check. `css push` and `css doctor`
run a gitleaks-style secret scan and **warn** (never block, in v1 — blocking
is planned for team-vault publishing). Treat the vault like you treat `.env`.

## Known gaps (pre-launch)

- **Windows is untested.** JSON-escaped `\\` paths break the plain
  string-replacement assumption; the ADR-3 matrix cell needs a Windows machine.
- **Codex picker visibility** before first resume (see matrix) — deliberate:
  fabricating rows in codex's SQLite risks more than it buys.
- Demo GIFs not yet recorded — `scripts/e2e-local.sh` and `e2e-codex.sh` are
  the choreography.
- `.cssignore` (exclude sessions by id/pattern) not yet implemented.

## Development

```sh
npm run build     # tsc -> dist/
npm test          # vitest — includes a full 2-device sync simulation (local git only)
scripts/e2e-local.sh <dir>   # live demo: real claude session through a real vault
```

Design docs: `PLAN-repo-sessions.md` (architecture ADRs, roadmap),
`M0-FINDINGS.md` (empirical spike results the design rests on),
`DOGFOOD.md` (the two-laptop test protocol gating hooks-on-real-repos).
