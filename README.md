# repo-sessions (`chat`)

[![ci](https://github.com/firish/repo-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/firish/repo-sessions/actions/workflows/ci.yml)

> Your Claude Code and Codex sessions follow your **repo**, not your laptop.

<!-- demo GIF goes here: laptop A session → git push → laptop B git pull → claude --resume -->

Start a session on laptop A, `git push`. On laptop B, `git pull` — and
`claude --resume` (or `codex resume`) picks up the conversation with every
embedded path rewritten for that machine. **Project memory travels too.**
Everything syncs through a single **private vault repo you own** — Copilot
syncs your chats to Microsoft's cloud; your sessions sync to *your* git
remote, riding the push/pull you already make.

```sh
npm install -g repo-sessions
hash -r         # refresh the shell's command cache (zsh caches lookups;
                #   without this, already-open shells can miss the new bin)
chat setup      # once per machine — creates/reuses your private vault
chat init       # once per repo — from here, git push/pull carry your sessions
```

Optional Claude Code plugin (in-session sync notices, `/sessions`):

```
/plugin marketplace add firish/repo-sessions
/plugin install repo-sessions
```

Proven on macOS, Windows, and Linux (hermetic 3-OS CI; dogfooded across
three real machines). The binary is `chat` (`css`, the original working
name, remains an alias). If a machine ships pppd's ancient
`/usr/sbin/chat` (macOS does), the npm bin shadows it on PATH order — but
shells opened before the install may have the old path cached and will
silently run the pppd tool instead (it blocks waiting on stdin, so `chat`
appears to "do nothing"). `hash -r` (or a new terminal) fixes it.

## Support matrix

| | Claude Code | Codex |
|---|---|---|
| Sessions synced | CLI + VS Code extension (same store) | CLI + VS Code extension (same store) |
| Project memory | synced automatically (markdown files; newest-wins per file, vault history is the undo) | no separate sync needed: codex *derives* memory from rollouts via an internal job pipeline — syncing the rollouts (which we do) carries the source it regenerates from |
| Sync triggers | git hooks + SessionStart/End/Stop plugin hooks | git hooks only (no plugin surface) |
| Resume on another machine | `claude --resume <id>` immediately | `codex resume <id>` immediately; interactive **picker** lists it after first resume (index self-heals; we never write codex's SQLite) |
| Format risk | munge rule drifted before — `locate()` scans variants; `doctor --verify` is the canary | rollout schema is younger; pinned per-session via `meta.json` `toolVersion` |

## Quickstart

```sh
chat setup               # one-time per machine: creates/clones your private vault
                         #   (or: chat setup --url <any-private-git-url>)
chat init                # once per repo — after this, git push/pull sync sessions
chat list                # sessions for this repo: name, id, state, device, summary
chat status              # sync state, conflicts, vault reachability (incl. memory)
chat memory              # project-memory files and their sync state
chat resume <name>       # resume any session (pulls it first if needed, picks the tool)
chat name <session> <n>  # names sync via the vault, usable anywhere an id is
chat open <session>      # open a transcript or memory file in $EDITOR,
                         #   else the OS default app (pulls it if needed)
chat rm <session>        # delete local + vault (refuses unsynced turns without --force)
chat restore [<id>]      # resurrect a deleted session; no args lists deleted ones
chat ignore <session>    # never sync this session (.chatignore; globs work)
chat push / chat pull    # manual sync (hooks make this mostly unnecessary)
chat gc --keep 20 --days 90           # vault retention (per project/tool)
chat doctor [--verify <session-id>]   # env checks, secret scan; --verify resumes for real
```

Verbs follow git where the semantics genuinely match (`init`, `rm`, `status`,
`gc`, `rebase`) and use plain words where they don't (`resume`, not
`checkout`; `fork`, not `clone`; `ignore`, not `stash`). Aliases kept:
`css` bin, `enable`→`init`, `duplicate`→`fork`, `merge`→`rebase`.

Existing hooks (including husky-style `core.hooksPath` setups) are respected:
foreign hooks are chain-loaded and run first with their stdin/argv intact —
their failure still aborts the git operation; chat never does.

## Working from any laptop

Sequential use (one laptop at a time) never diverges as long as syncs are
tight: SessionEnd pushes immediately, the Stop hook pushes after every
response (`stopDebounceMinutes` in config.json; default 0 — raise it on
slow connections to push at most that many minutes behind your last
message), and SessionStart/`chat enable` pull before you resume.
When divergence does happen — you resumed on B before A's tail pushed —
nothing is lost and two commands reconcile:

- `chat rebase <session|name>` splices the divergent tails into one transcript
  ("meanwhile, on the other laptop"), re-parenting the seam so every turn
  replays. All devices converge on the rebased transcript on their next pull.
- `chat split <session|name>` (also what rebase recommends when a tail
  contains a compaction boundary, which cannot be safely spliced): the
  divergent branch becomes its own new session, the old id converges.
- `chat fork <session|name>` forks any session into a new id — useful before
  experiments, or to deliberately branch work per machine. `--at <vault-hash>`
  forks from a **past vault state** ("the chat as of Tuesday") — the safe way
  to rewind, since in-place truncation would fight the append-only sync model
  (other devices would push the "missing" turns right back). The vault being
  git means every synced state is recoverable: `chat restore` resurrects
  deleted sessions the same way.
- `chat name <session|name> <new-name>` names a session; names live in the
  vault index so they follow you across machines, work for both tools, and are
  accepted anywhere an id is. Split/fork derive names automatically
  (`auth-work/laptop-b`, `auth-work-fork`).

If you resume a stale snapshot, the SessionStart hook warns *inside the
session* that newer turns were just pulled and how to pick them up.

## Project memory travels too

Claude Code's per-project memory (`~/.claude/projects/<munged>/memory/*.md`)
syncs automatically with every push/pull — same tokenizer (embedded paths
rewrite per machine), same hooks, same secret scan. Memory files are mutable
markdown, so the semantics differ from append-only transcripts: **newest
mtime wins per file**, every overwrite is logged with the losing device
named, and the vault's git history keeps every synced state (`git log` in
the vault is your undo). `chat memory` shows per-file state; `chat status`
summarizes it. CLAUDE.md travels with the repo, sessions travel in the
vault, memory travels in the vault — the project's whole AI state moves as
one.

## What travels, and why

Claude Code splits project state into two kinds: **intentional** state you
author (skills, agents, commands, `.mcp.json`, `CLAUDE.md`, settings) gets a
git-tracked home inside the repo — for those, *git itself is the sync*, and
it rides the same push/pull we hook. **Emergent** state your work produces
(sessions, memory) lands machine-local under `~/.claude` — that's the gap
this tool exists to close.

| State | Travels via | Notes |
|---|---|---|
| Sessions, project memory | **the vault (us)** | tokenized, secret-scanned, history-recoverable |
| `CLAUDE.md`, `.claude/skills\|agents\|commands`, `.mcp.json`, `.claude/settings.json` | **the repo (git, natively)** | want it on every machine? put it here |
| "Always allow" rules (`.claude/settings.local.json`) | nothing today | v1.1: opt-in sync of `permissions` keys only — never `env` |
| Global config (`~/.claude/*`, user-scope MCP servers) | dotfiles managers | machine state, not project state — out of scope by design |
| Local-scope MCP servers (`~/.claude.json`) | nothing, on purpose | local-scope *is* the choice not to share; promote to `.mcp.json` to travel |
| Session scratchpad (OS temp) | nothing, by design | ephemeral per-session workspace; resume needs the transcript, not the workspace — artifacts that matter belong in the repo |

## Claude Code plugin (`plugin/`)

SessionStart pulls newer sessions, names what arrived, and warns if you
resumed a stale snapshot; SessionEnd pushes in a detached background process;
Stop pushes after every response (`stopDebounceMinutes`, default 0) to cover
laptop-lid-close. `/sessions list|push|pull|status` wraps the CLI. Marketplace listing comes with M4 — until then, point Claude
Code at the `plugin/` directory (requires `chat` on PATH via `npm i -g .`).

Sessions are namespaced per-repo (hash of the normalized `origin` URL), so one
vault serves every project forever, and session data never touches the
project's own history — safe for open-source repos by construction.

## Threat model, plainly

Transcripts contain **whatever your sessions saw** — possibly env vars, tool
output, proprietary code. The vault must be a **private** repo; `chat setup`
refuses a public GitHub vault when it can check. `chat push` and `chat doctor`
run a gitleaks-style secret scan and **warn** (never block, in v1 — blocking
is planned for team-vault publishing). `.chatignore` (or `chat ignore`) keeps
chosen sessions off the vault entirely; `chat rm` deletes synced copies.
Treat the vault like you treat `.env`.

## Known gaps (pre-launch)

- **Codex picker visibility** before first resume (see matrix) — deliberate:
  fabricating rows in codex's SQLite risks more than it buys.
- Demo GIFs not yet recorded — `scripts/e2e-local.sh` and `e2e-codex.sh` are
  the choreography.

(Windows was on this list; it's now fully tested — real-machine dogfood
found and fixed the JSON-escaped `\\` path class, and CI runs the suite on
all three OSes.)

## FAQ

**Does this cover IDE sessions or just the CLI?** Both — Claude Code's CLI,
VS Code extension, and desktop app share one local store, and so do Codex's
CLI + VS Code extension. We sync the store, so every surface travels.

**What if I resume the same chat on two machines?** Sequential use with the
hooks on never diverges (push-on-stop, pull-on-start, stale-resume warning).
When it does diverge, nothing is lost: `chat rebase` splices the tails,
`chat split` turns a branch into its own session.

**Do my "always allow" permissions / skills / MCP servers travel?** See
"What travels, and why" above — skills, agents, and `.mcp.json` already have
git-tracked homes (git is their sync); permissions sync is planned (v1.1,
opt-in, never the `env` block).

**Is my code safe in the vault?** The vault must be private (`chat setup`
refuses public GitHub vaults), pushes are secret-scanned, `.chatignore`
keeps any session out entirely, and session data never touches your
project's own git history by construction. Full story: "Threat model,
plainly" below.

**I deleted something — recoverable?** The vault is git. `chat restore`
resurrects deleted sessions; `chat fork --at <hash>` forks any past state;
memory overwrites keep every prior state in vault history.

## Development

```sh
npm run build     # tsc -> dist/
npm test          # vitest — includes a full 2-device sync simulation (local git only)
scripts/e2e-local.sh <dir>   # live demo: real claude session through a real vault
```

Design docs: `PLAN-repo-sessions.md` (architecture ADRs, roadmap),
`M0-FINDINGS.md` (empirical spike results the design rests on),
`DOGFOOD.md` (the two-laptop test protocol gating hooks-on-real-repos).
