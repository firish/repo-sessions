# repo-sessions (`css`)

> Your Claude Code conversations follow your repo, not your laptop.

Git-native sync of coding-agent sessions across devices through a single
**private vault repo**. Start a session on laptop A, `git push`; on laptop B,
`git pull` and `claude --resume` — the conversation is there, with every
embedded path rewritten for that machine. Claude Code ships first; Codex is
next (its mechanics are already validated — see `M0-FINDINGS.md`).

**Status: M1 core.** CLI + claude adapter + vault engine work end-to-end
(17 unit tests, plus a live two-"device" round-trip in `scripts/e2e-local.sh`).
Git/session hooks (M2) and the codex adapter (M2.5) are next; not yet published.

## Quickstart

```sh
css init                # one-time per machine: creates/clones your private vault
                        #   (or: css init --url <any-private-git-url>)
css enable              # once per repo, on any machine
css push                # local sessions -> vault
css pull                # vault sessions -> this machine, rewritten for its paths
css list                # sessions for this repo: id, state, device, summary
css status              # sync state, conflicts, vault reachability
css doctor [--verify <session-id>]   # env checks; --verify resumes for real
```

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
