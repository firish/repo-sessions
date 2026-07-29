# Launch checklist — polish & publish

Gates are ordered; nothing in a later gate blocks work in an earlier one.
Owner tags: [C] Claude can do it, [R] needs Rishi, [C+R] both.

## Gate 0 — Correctness (the "is it true" gate)

- [ ] [C] **3-OS CI matrix**: GitHub Actions — ubuntu / macos / windows ×
      (tsc + 56 tests). Suite is hermetic (local git remotes, no API calls),
      so this is free Linux coverage and converts "should work" into "proven
      on every push". Badge feeds the README.
- [ ] [R] **Phase 2 dogfood**: install the plugin from `plugin/` on both
      laptops; confirm the SessionStart notice appears natively and
      `/sessions list` works.
- [ ] [R] **Phase 3 dogfood**: `chat init` on 1–2 real repos; a week of
      normal work where the tool should disappear. Log anything that
      surfaces in DOGFOOD.md results.
- [ ] [C+R] **e2e regression rerun on the Mac** (post-Windows fixes):
      `scripts/e2e-local.sh` + `scripts/e2e-codex.sh` — proves the
      json-flag changes didn't disturb POSIX.
- [ ] [C] Stretch: **format-drift canary** — scheduled CI job running the
      newest claude/codex CLIs against fixtures (plan §7 risk 2). Can land
      post-launch.

## Gate 1 — Repo goes public

- [ ] [C] **LICENSE file** (MIT — declared in package.json, file missing).
- [ ] [C+R] **History secrets audit** before flipping visibility: gitleaks
      over full history; eyeball DOGFOOD/M0-FINDINGS for anything you'd
      rather not publish (machine names/paths are in there — fine, but
      decide consciously).
- [ ] [C] **Community files**: CONTRIBUTING.md (short; "community adapters
      welcome" + ADR-6 pointer), SECURITY.md (threat-model pointer +
      disclosure contact), issue templates (bug / adapter-request).
- [ ] [R] **Repo polish**: description, topics (`claude-code`, `codex`,
      `ai-sessions`, `sync`, `cli`), social-preview image.
- [ ] [R] Flip `firish/repo-sessions` to public.

## Gate 2 — npm publish

- [ ] [C] **package.json completeness**: `repository`, `homepage`, `bugs`,
      `author`, sharpened `description` + keywords;
      `prepublishOnly: tsc && vitest run`.
- [ ] [C+R] **Pack sanity**: `npm pack` → install the tarball in a clean
      dir → `chat --version`, `chat help`, `chat setup --url` against a
      scratch vault. Catches missing-files bugs npm is famous for.
- [ ] [R] **Version call**: recommend launching as `1.0.0` — the invariants
      are proven on 3 OSes and two real machines; 0.x signals "don't trust
      me" to exactly the audience we're courting.
- [ ] [R] `npm publish` (consider `--provenance` via GitHub Actions trusted
      publishing — supply-chain badge for free).

## Gate 3 — Plugin distribution (the surfaces that market for us)

- [ ] [C] **Self-host the marketplace**: add `.claude-plugin/marketplace.json`
      to this repo so `/plugin marketplace add firish/repo-sessions` +
      `/plugin install repo-sessions` just works. Zero gatekeepers; README
      gets the two-line install.
- [ ] [C+R] **Test the real install flow** end-to-end on a clean machine
      profile (marketplace add → install → hooks fire).
- [ ] [R] **Submit to `anthropics/claude-plugins-official`** — Anthropic's
      managed directory (submission form; quality/security review). This is
      the highest-value discovery surface: users browsing plugins find us
      without ever hearing the launch.
- [ ] [R] **Community directories**: claudemarketplaces.com, aitmpl.com
      plugin directory, awesome-claude-code PR.
- [ ] N/A **OpenAI side**: Codex has no third-party plugin marketplace —
      our codex integration is git-hooks + CLI, nothing to submit. Codex
      users are reached via npm/GitHub SEO ("codex session sync"),
      r/ChatGPTCoding, and the README saying "Codex" loudly and early.

## Gate 4 — Launch content

- [ ] [C+R] **Demo GIFs** ×2 — the e2e scripts are the shot lists:
      (1) laptop A session → `git push` → laptop B `git pull` →
      `claude --resume` knows everything; (2) same for `codex resume`.
      The GIF is the launch.
- [ ] [C] **README hero pass**: GIF at top, install one-liner, badges
      (CI, npm), positioning line — "Copilot syncs your chats to
      Microsoft's cloud. Your Claude & Codex sessions sync to a private
      vault *you* own, riding the git push you already make." FAQ section
      (= the questions asked while building: IDE coverage, memory,
      permissions, scratchpad, divergence).
- [ ] [C] **CHANGELOG.md** seeded at 1.0.0.
- [ ] [C+R] **Show HN** draft (title candidates: "Show HN: Your Claude
      Code sessions follow your repo, not your laptop"), **r/ClaudeAI** and
      **r/ChatGPTCoding** posts, X thread.
- [ ] [C] **Engineering post** for dev.to/blog: M0-FINDINGS is the material;
      the Windows `\U`-corruption war story is a strong second post.
- [ ] [R] Cross-promote to the VS-extension audience (same playbook).

## Post-launch week 1

- [ ] Gemini CLI spike (M0 codeword pattern; check Google native-sync
      status first) → v1.1 alongside opt-in permissions sync.
- [ ] Issue triage SLA for the first wave; drift canary if not done.
- [ ] Second announcement beat: "now with Gemini" + onboarding/team-vault
      teaser (§8.1).

## Distribution map (where people find us without us pushing)

| Surface | Mechanism |
|---|---|
| Anthropic official plugin directory | curated browse + `/plugin` discovery — the big one |
| Self-hosted marketplace (this repo) | `/plugin marketplace add firish/repo-sessions` |
| npm | search for "claude code sessions / codex sync"; README is the landing page |
| GitHub | topics, stars → trending; social preview |
| Community plugin directories & awesome-lists | evergreen referrals |
| HN / Reddit / dev.to / X | launch-day spikes; posts keep ranking in search |
