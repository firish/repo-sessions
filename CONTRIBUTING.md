# Contributing

## Dev setup

```sh
npm install
npm run build      # tsc -> dist/
npm test           # vitest — hermetic (local git remotes, no API calls)
node dist/cli.js help
```

Live end-to-end demos (these DO call the real CLIs and need `claude` /
codex auth): `scripts/e2e-local.sh <dir>`, `scripts/e2e-codex.sh <dir>`.

## Adapters are the contribution surface

Every tool-specific assumption lives behind one interface —
[`src/adapters/types.ts`](src/adapters/types.ts) (ADR-6 in
`PLAN-repo-sessions.md`). The claude and codex adapters are the reference
implementations; Gemini CLI, cursor-agent, opencode and friends are welcome
as community adapters. A good adapter PR includes:

1. `locate` / `tokenize` / `rehydrate` / `installPath` / `verifyResume`
   against the interface — study `src/adapters/codex/index.ts` for the
   date-tree + external-index shape.
2. A tokenized fixture + tests mirroring `tests/codex.test.ts` (two-device
   round-trip through a local vault).
3. Evidence the real tool resumes a rehydrated session (the M0 "codeword"
   pattern — see `M0-FINDINGS.md`).

Hard rules we won't merge around: never write another tool's internal
databases when a file-level path exists; never rewrite a live transcript
(append-only invariant); paths must round-trip through tokenization on
POSIX **and** Windows (JSON-escaped spellings — see
`src/adapters/pathforms.ts`).

## Commits

Scoped conventional-ish messages (`fix(adapters): …`), body explains why.
CI must be green on all three OSes.
