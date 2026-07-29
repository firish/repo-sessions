# RepoSessions (working name) — Project Plan

> "Your Claude Code conversations follow your repo, not your laptop."
>
> Git-native sync of Claude Code sessions across devices, using a single private
> "vault" repo, wired into the developer's existing `git push` / `git pull` habit.

---

## 1. Goals & Non-Goals

**Goals (v1)**

- G1: `claude --resume` on laptop B finds sessions started on laptop A, scoped to the repo you're standing in.
- G2: Zero per-repo ceremony after one-time global setup. `git pull` pulls conversations; `git push` pushes them.
- G3: Session data never appears in the project's own git history, branches, PRs, or remote — safe for open-source repos by construction.
- G4: Works on macOS, Linux, Windows (he has 3 laptops; assume mixed paths at minimum, possibly mixed OS).
- G5: Degrades gracefully: if the vault is unreachable, Claude Code works exactly as before.
- G6: **Two adapters at launch: Claude Code and Codex.** Each tool syncs and resumes *its own* sessions (`claude --resume` resumes Claude sessions, `codex resume` resumes Codex sessions). Same vault, same git triggers, per-tool namespaces.

**Non-goals (v1)**

- **Cross-tool resume — permanently out of scope**, not just v1. Transcripts are provider-specific execution logs; Claude cannot resume a Codex session or vice versa. The cross-tool bridge is `distill` (v2), never resume. (Post-M0 addendum: prior art like npow/session-sync and CASR proves lossy translation works for tool-free chats — that becomes v2 `css seed <id> --to <tool>`, explicit and lossy-by-contract, never automatic write-time fan-out.)
- **Copilot/Cursor IDE chat resume-adapters — permanently out** (decided 2026-07-26). Copilot VS Code ships default-on cloud session sync since June 2026 → a second sync system on the same store means loops/dupes; both IDEs have no resume contract and churning internal stores (Copilot chat files went `.json`→`.jsonl` within months). Both become v2 **capture/distill sources** (read-only into the vault, seedable via `css seed`), never resume targets. cursor-agent (Cursor's CLI) is a legitimate future adapter — local resumable sessions, real resume command.
- Gemini CLI, opencode, and other adapters (v2 — the adapter interface ships in v1 so these are additive).
- Real-time mirroring of a *live* session (that's Anthropic's Remote Control; don't compete).
- Syncing global config (`settings.json`, agents, skills) — claude-sync and dotfiles already cover this; staying session-only keeps scope tight and avoids credential-sync footguns.
- Claude.ai chat import (v2: `css import` distill-and-seed).
- Team/shared sessions (v2 — see §8.1; v1 keys are chosen so it's purely additive).

---

## 2. Architecture Decision Record

### ADR-1: Storage = one global private "vault" repo (not per-project companion repos, not hidden refs on origin)

- A single private repo, e.g. `firish/claude-sessions-vault`, auto-created on `css init` via `gh repo create --private` (fallback: user pastes any git URL — works with GitLab, self-hosted, a bare repo on a NAS).
- Each project namespaced inside the vault by a **repo key** = short SHA-256 of the normalized `origin` URL (strip protocol, `.git`, credentials, case-fold host) + a human-readable slug for browsability: `a1b2c3d4-claude_code_vs/`.
- Why not hidden refs (`refs/claude/*`) on origin: on public repos anyone can fetch them; on org repos you may lack push rights to non-branch refs; and GitHub GC behavior for unreferenced custom refs is not contractual. One private vault sidesteps all three and means **one setup for all projects forever** — the seamlessness requirement wins.
- Why not per-project companion repos: N repos to create/manage; vault is one.

### ADR-2: Layout inside the vault = plain directories on `main`, not custom refs

Vault is private, so there's nothing to hide. Plain files = inspectable with any git UI, trivially debuggable, no plumbing surprises.

```
vault/
  index.json                      # global manifest (schema below)
  <repo-key>-<slug>/
    project.json                  # origin URL, slug, created_at
    claude/                       # tool namespace (adapter id)
      sessions/
        <session-uuid>/
          transcript.jsonl        # the session transcript (paths tokenized)
          meta.json               # summary, device, last_ts, git HEAD/branch,
                                  # tool + tool version, byte_len, sha256
          subagents/              # sidecar/subagent transcripts if present
    codex/                        # same shape, Codex adapter
      sessions/
        <session-uuid>/...
```

Tool namespace sits *under* the repo key: the unit of organization is the project, and each agent tool is a channel within it. `css list` shows both, tagged by tool.

`index.json` (one small file, updated every push) lets `css list` and the SessionStart hook answer "anything new for this repo?" from a shallow fetch of one file instead of walking trees.

### ADR-3: Path portability = tokenize on push, rehydrate on pull

Claude Code indexes sessions under `~/.claude/projects/<munged-abs-path>/` and embeds `cwd` in transcript lines. Verbatim copies break `--resume` across machines (the known killer). So:

- On **push**: rewrite the project's absolute path → `${PROJECT_ROOT}` token, `$HOME` → `${HOME}`, in both the storage key and transcript content. Also normalize path separators to `/` in tokenized form (Windows).
- On **pull**: resolve tokens against the *local* clone location (we know it — we're running inside the repo) and write into the correctly munged local `~/.claude/projects/` dir.
- Store the original path in `meta.json` for debugging.
- **M0 spike must validate**: after rehydration, `claude --resume` lists and resumes the session. Test matrix: same OS/different path, macOS↔Linux, →Windows.

### ADR-4: Trigger model = git hooks primary, Claude Code plugin hooks secondary

He asked for "push/pull convos every time we push and pull." Deliver exactly that, plus session-lifecycle coverage:

**Git hooks (installed per-repo by `css enable`, chain-loaded so existing hooks like husky keep working):**

| Hook | Action |
|---|---|
| `pre-push` | `css push -q` (sync sessions before code leaves) |
| `post-merge` | `css pull -q &` (after `git pull`) |
| `post-checkout` | `css pull -q &` (after clone/branch switch; also catches fresh clones) |

**Claude Code plugin hooks (verified against current hooks reference):**

| Event | Action | Notes |
|---|---|---|
| `SessionStart` | `css pull -q` then, if newer remote sessions exist for this repo, inject a one-line notice via `hookSpecificOutput.additionalContext` ("2 sessions synced from other devices — /sessions list") | Fires on startup *and* resume; keep it fast — shallow fetch of `index.json` first, full pull only if changed |
| `SessionEnd` | `css push -q` in a **background subshell that exits immediately** (the documented pattern for slow hooks) | Fires on exit/clear/logout |
| `Stop` | debounce-push (write a "dirty" marker; a background push runs if >N min since last push) | Covers laptop-lid-close where SessionEnd may never fire |

Rationale for both layers: git hooks make it ride his muscle memory; CC hooks catch the case where he ends a session but never pushes code that day.

### ADR-5: Language/runtime = TypeScript on Node, npm-distributed

Matches Claude Code's own distribution channel, his stack, and the plugin ecosystem. Single dependency users already have. Use `simple-git`/child-process git (no libgit2 native deps → painless Windows). Go single-binary is the fallback if Node startup latency in hooks proves annoying (>150 ms budget per hook invocation; measure in M0).

### ADR-6: Adapter interface — Claude and Codex ship in v1, everything else plugs in later

Every tool-specific assumption lives behind one interface; the sync engine, vault, git hooks, and CLI are tool-agnostic:

```ts
interface Adapter {
  id: string;                                  // "claude" | "codex"
  detect(): boolean;                           // is the tool installed?
  locate(repoRoot: string): SessionRef[];      // local session files for this repo
  tokenize(raw: Buffer, ctx: PathCtx): Buffer; // abs paths -> ${TOKENS}
  rehydrate(tok: Buffer, ctx: PathCtx): Buffer;// ${TOKENS} -> local abs paths
  installDir(repoRoot: string): string;        // where rehydrated sessions go
  verifyResume(sessionId: string): Promise<boolean>; // doctor/CI check
}
```

- **claude adapter (v1, first):** sessions in `~/.claude/projects/<munged-cwd>/*.jsonl`, keyed by absolute cwd — the tokenize/rehydrate pipeline from ADR-3.
- **codex adapter (v1, second):** Codex stores rollout JSONLs under `~/.codex/sessions/` (date-tree layout, session id in filename) and resumes via `codex resume <id>`. Same conceptual job — locate, tokenize embedded cwd paths, rehydrate — but **treat the storage layout, id scheme, and resume tolerance as unverified until the M0 spike confirms them on a current Codex build**. Codex's layout is keyed by date rather than by project path, so `locate()` must filter sessions by the cwd recorded *inside* the rollout, not by directory name. Its trigger story also differs: no Claude-plugin hooks, so Codex sync rides the git hooks only (which is fine — that's the primary trigger anyway).
- Expected asymmetry: the claude adapter gets lifecycle hooks + git hooks; codex gets git hooks. Document this rather than papering over it.
- Gemini/opencode/etc. are v2 adapters behind the same interface — additive, no engine changes.

Is Codex-resumes-Codex a problem? In principle no — it's the same rehydration trick against a different directory tree. In practice it roughly **doubles the M0 surface and the format-drift risk**: two independent session formats, two release trains that can break us, and Codex's format stability guarantees are weaker than Claude Code's (no plugin/hook contract around sessions). Budget for it (see M0/M3) and keep the launch honest: if the Codex resume spike fails or drags, launch claude-only and ship codex as v1.1 — don't let the second adapter sink the first.

---

## 3. CLI Surface (`css` — claude-session-sync)

```
css init                 # one-time: auth (gh or pasted URL), create/clone vault,
                         #           write ~/.config/css/config.json
css enable               # in a repo: register repo-key in vault, install git hooks,
                         #           write .git/css.json (never tracked)
css push [-q] [--all]    # push this repo's local sessions → vault
css pull [-q] [--id X]   # pull vault sessions → local ~/.claude/projects/
css list                 # sessions for this repo: id, summary, device, age, synced?
css status               # dirty sessions, last push/pull, vault reachability
css disable | css gc | css doctor
```

Plugin adds `/sessions list|push|pull|status` as slash-command sugar over the same CLI.

**Sync algorithm (per repo):**

1. For each detected adapter: `adapter.locate(repoRoot)` (claude: munged-path dir under `~/.claude/projects/`; codex: filter `~/.codex/sessions/` date tree by recorded cwd).
2. Diff by `(session-uuid, byte_len, sha256)` against `index.json`. JSONL transcripts are **append-only**, so "remote is a prefix of local" → fast-forward upload of the tail; disjoint growth on two devices for the *same* uuid (rare: requires resuming the same session on two machines between syncs) → keep both, suffix the loser `.conflict-<device>`, surface in `css status`. Never silently drop turns.
3. Commit to vault with message `sync(<slug>): <n> sessions from <device>` and push with one retry + exponential backoff; on failure, mark dirty and stay silent in `-q` mode (G5).

---

## 4. Security & Privacy

- Vault repo is **private** — verify visibility on `init` and on every `push`; hard-fail with a loud error if it ever reads public.
- **Transcripts contain whatever the session saw**: env vars Claude echoed, API keys in tool output, proprietary code. v1 mitigations: (a) `css doctor` runs a secret scan (gitleaks-style regexes) and warns before first push; (b) `.cssignore` per repo to exclude sessions by id/pattern; (c) README states the threat model plainly.
- Optional at-rest encryption (`age`, passphrase-derived, same UX claude-sync proved) as a v1.1 flag — vault-private is acceptable for launch, encryption is the paranoid tier.
- Never touch `~/.claude/.credentials.json`, `history.jsonl`, or anything outside `projects/` — session-scope only (ADR non-goal doing us a favor).
- ToS check: we only read/write local files and a user-owned git remote. No Agent SDK, no unofficial APIs. Clean.

---

## 5. Edge Cases Register

- Repo with no `origin` yet → `css enable` prompts; key can be minted from first remote later (`css doctor` re-keys).
- Origin URL changes (SSH↔HTTPS, org rename) → normalization handles protocol; rename handled by `css doctor --rekey` (writes alias into `project.json`).
- Worktrees → resolve to the main repo's origin; sessions from all worktrees share the namespace, `meta.json` records the worktree path.
- Monorepo, sessions started in subdirs → Claude Code keys by cwd, so one repo may map to several `~/.claude/projects/` dirs; enumerate all local project dirs whose path is inside the repo root.
- Huge transcripts (100 MB JSONL after long sessions) → gzip in vault (store `.jsonl.gz`), `css gc --keep 20 --days 90`.
- Claude Code updates change JSONL/session format → pin known-good CC versions in `meta.json`; `css doctor` warns on major-version drift. This is the #1 ongoing maintenance risk — subscribe to release notes, add a canary CI job that runs latest CC against a fixture.
- Two laptops, both dirty, push order races → vault pushes are serialized by git itself (non-FF rejected → pull --rebase → retry).

---

## 6. Milestones

**M0 — De-risking spike (2–3 evenings, now two tracks).**
*Track A (claude):* hand-copy a session between two machines with manual path rewriting; confirm `claude --resume` works after rehydration (macOS↔Linux, different paths, then Windows). Measure Node cold-start inside a hook.
*Track B (codex):* map the actual on-disk layout of `~/.codex/sessions/` on a current build, confirm session ids and cwd fields, hand-copy + rewrite one rollout and confirm `codex resume <id>` accepts it cross-machine.
*Kill criteria per track: if a tool rejects rehydrated transcripts (integrity checks), that adapter pivots to "context-seed sync" (distill + fork-and-reseed) or drops to v1.1 — Track B failing must not block Track A shipping.*

**M1 — CLI core + claude adapter (1–2 weeks of evenings).** Adapter interface (ADR-6), `init/enable/push/pull/list/status`, vault layout with tool namespaces, tokenization, conflict handling, tests with fixture JSONLs from your own sessions.

**M2 — Hooks (1 week).** Git hook installer with chain-loading; CC plugin manifest with SessionStart/SessionEnd/Stop hooks (background-subshell pattern, explicit timeouts); `/sessions` commands.

**M2.5 — codex adapter (1 week, gated on M0 Track B pass).** Implement `codex` adapter against the interface; git-hook triggers only; `css doctor` gains a per-tool `verifyResume` check; fixtures from real Codex rollouts.

**M3 — Hardening (1 week).** Windows pass, secret-scan doctor, gc, gzip, README with the threat model and the per-tool support matrix (what resumes where, what triggers exist per tool), demo GIF (start on laptop A, `git push`, `git pull` on B, `claude --resume` — that GIF *is* the launch; second GIF for `codex resume`).

**M4 — Launch.** npm publish + plugin marketplace listing; Show HN / r/ClaudeAI / Dev.to (same playbook as the VS extension). Positioning: "claude-sync syncs your machine; RepoSessions syncs your *project*. Sessions travel with the repo — private vault, zero per-repo setup, rides your existing git push/pull."

---

## 7. Risks

1. **Anthropic ships native session sync** — Remote Control shows they're moving here. Mitigation: ship fast; the repo-scoped model, multi-tool support, and merge tooling remain differentiated; worst case it's a strong portfolio piece feeding the VS extension. *This risk is now confirmed-by-pattern: Microsoft reversed a "not planned" and shipped default-on Copilot session sync in June 2026. Vendors move; the launch window decays — positioning leans on what account-cloud sync can't do (repo-scoped, your own remote, multi-tool, OSS-safe).*
2. **Format drift, now ×2** — Claude Code JSONL *and* Codex rollout format can each break us independently, and Codex has no plugin/hook contract around its session files. Canary CI runs latest builds of *both* tools against fixtures; `meta.json` pins tool versions; `css doctor` warns on drift.
3. **Resume integrity checks** — per-track M0 kill criteria + pivot path defined; Codex adapter can drop to v1.1 without blocking launch.
4. **Secrets-in-transcripts incident** — doctor scan + loud docs; consider push-time scan blocking by default with `--force` override. Doubly important once team sharing (§8.1) exists.
5. **Second-adapter scope creep** — the honest answer to "Codex at launch shouldn't be a problem, right?" is: *conceptually no, operationally it's real added surface.* The gate is M0 Track B; the escape hatch is v1.1.

## 8. v2 (explicitly out of v1, designed-for in v1)

### 8.1 Team sharing — opt-in publish to a shared vault, keyed by dev username

- **Model:** every dev keeps their personal private vault (v1 behavior, unchanged). A project can additionally declare a **team vault** — a private repo the whole team can push to (org repo, branch protection off, or a plain shared private repo).
- **Layout:** `<repo-key>-<slug>/<tool>/<username>/<session-uuid>/…` — username = git `user.name`-derived slug (configurable), so provenance is structural, listing is browsable per-dev, and two devs can never write-conflict on each other's sessions.
- **Publishing is deliberate, never automatic:** `css publish <session-id> [--distilled]` copies a session (or its distilled summary) from personal vault → team vault. No hook ever auto-publishes; the git-push/pull automation applies only to the personal vault. Rationale: transcripts contain half-formed thinking and possibly secrets — the sharing unit must be a conscious act, like opening a PR.
- **Consuming:** `css pull --team` fetches teammates' published sessions read-only into a `shared/` area; `claude --resume`-ability of *someone else's* rehydrated session is a bonus to validate, not a promise (their paths, their tool version) — the reliable consumption modes are read/browse and distill-to-seed.
- **Enable path:** `css enable --team <git-url>` writes the team vault URL into `.claude/css-team.json` *tracked in the project repo* — so joining the team vault is itself distributed by git clone. (The personal vault URL never goes in the repo.)
- **Killer use case to market:** onboarding — "read the conversations behind the architecture."
- Push-time secret scanning becomes **blocking by default** for `publish`.

### 8.2 Other v2 items

- **Adapters:** Gemini CLI first (v1.1 fast-follow — spike during M1 downtime using the M0 codeword pattern; check Google hasn't shipped native sync first), then cursor-agent (v1.2, spike-gated, demand-driven), then Copilot CLI (gated on evidence that GitHub's session sync/chronicle leaves a real gap for CLI users), opencode and others as community PRs behind the ADR-6 interface (v1 ships claude + codex only). Format reference libraries: jazzyalex/agent-sessions, CASR/CASS.
- **Permissions sync (v1.1, decided 2026-07-29):** "always allow" rules live in `.claude/settings.local.json` — project-scoped but force-ignored by git, so laptop B re-prompts for everything laptop A approved. Sync the `permissions.allow`/`deny` keys ONLY (never `env` — that block holds secrets), tokenized (rules embed absolute paths), and **opt-in** — permissions are a security boundary, so propagation must be deliberate, unlike memory. Global `~/.claude/settings.json` stays out (dotfiles territory). Until then, the zero-code answer is moving rules into tracked `.claude/settings.json`.
- **Skills / agents / MCP servers: explicitly NOT synced (decided 2026-07-29).** Claude Code already gives every one of these a repo-tracked project-scoped home (`.claude/skills/`, `.claude/agents/`, `.claude/commands/`, `.mcp.json`) — for those, *git itself is the sync* and it rides the exact same push/pull we hook. The global variants (`~/.claude/skills`, user-scope `mcpServers` in `~/.claude.json`) are machine config, not project state — the plan's original non-goal (claude-sync/dotfiles cover it; MCP definitions are the most secret-laden config there is, and syncing a server definition doesn't install the server). The one genuine gap — local-scope per-project MCP servers in `~/.claude.json` — is local-scoped precisely because the user chose not to share it; documenting "promote it to `.mcp.json` if you want it to travel" beats building a parallel sync.
- `css import` — claude.ai paste → distilled seed session.
- `css distill` — session → context doc / CLAUDE.md-rules PR against the project repo (cross-tool bridge; the refinery on top of the ore).
- Cross-device session **merge/splice** — your existing tooling as the feature the claude-sync cluster can't match.
- Selective "distilled sync" mode for huge sessions; per-member encryption for team vaults; VS extension surface (session browser over the vault); provenance index ("which conversation produced this commit").
