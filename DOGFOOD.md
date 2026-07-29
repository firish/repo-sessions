# Dogfood protocol — two real laptops

## Results log

- **2026-07-28 — Phase 1 PASS, both laptops.** Init auto-created then reused
  the private vault; hooks fired on plain git push/pull; `claude --resume` on
  laptop B recovered the project session with an accurate recap (via CC's
  compacted-resume flow — the session was ~400k tokens). Notes: exactly 1
  session synced, which is correct (all spike/e2e sessions live in scratchpad
  fixture namespaces, not this repo's); the resumed session was still live on
  laptop A, so a divergence conflict copy is expected on next sync — designed
  behavior, no turns lost. Phase 3 (real repos) is unblocked.

Goal: prove on real hardware what the e2e proves in simulation, then (and only
then) turn hooks on for real repos. This repo is itself the first sync target —
the sessions that built the tool travel with it.

**Prereqs on BOTH laptops:** node ≥ 20, git, `gh` authed as the same account
(`gh auth status`), `claude` CLI logged in. Codex optional (phase 2).

## Phase 1 — Laptop A (this machine)

```sh
cd <repo> && npm run build && npm install -g .   # global `css` FIRST, so hooks embed "css"
which css && css --version
css doctor                       # expect: all ok; note the secret-scan line
css init                         # creates/reuses private firish/claude-sessions-vault
css enable                       # hooks: installed ×3
css push                         # first sync — this project's own sessions
css list                         # expect rows incl. the session that built css
```

Then make any commit and `git push` — output should be silent, `css status`
should show a fresh "last push".

## Phase 1 — Laptop B

```sh
git clone https://github.com/firish/repo-sessions.git && cd repo-sessions
npm install && npm run build && npm install -g .
css doctor && css init           # MUST say "reusing existing private vault repo"
css enable
css list                         # laptop A's sessions, state=remote
css pull                         # first pull is manual (clone predates enable)
claude --resume <session-id>     # then ask: "what were we working on?"
```

**Pass = the resumed session knows the project history from laptop A.**
Then: make turns in that session, commit something, `git push`; back on
laptop A `git pull`, start a claude session in the repo, and expect the
"N session(s) synced from other devices" notice (needs phase 2 plugin, or run
`css hook session-start` manually to see the JSON).

## Phase 2 — optional surfaces

- **Plugin:** point Claude Code at `plugin/` (marketplace comes with M4) and
  confirm SessionStart notice + `/sessions list`.
- **Codex:** if a codex CLI is installed, repeat resume with
  `codex resume <id>` in a repo with codex sessions.

## Phase 3 — real repos (the gate)

Only after phases 1–2: `css enable` in one or two real projects. Watch for a
week. Husky/core.hooksPath repos will refuse hooks with instructions — that is
expected behavior, not a bug.

## If something fails

Capture: the exact command + stderr, `css status`, `css doctor` output, and
`cat .git/hooks/pre-push` from the repo. Transient claude/codex API errors do
happen — retry once before recording a failure.

## Rollback (complete)

```sh
css disable                      # per repo: hooks out, registration gone
npm rm -g repo-sessions
rm -rf ~/.config/css ~/.local/share/css
# vault repo on GitHub keeps your data; delete it only if you want everything gone
```
