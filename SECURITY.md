# Security

## Threat model

Read ["Threat model, plainly"](README.md#threat-model-plainly) first: session
transcripts contain **whatever your sessions saw** — possibly env vars, tool
output, proprietary code. The core mitigations are: the vault must be a
private repo (`chat setup` refuses a public GitHub vault when it can check),
`chat push` / `chat doctor` run a gitleaks-style secret scan (warn-only in
v1), `.chatignore` keeps individual sessions off the vault entirely, and
session data never touches the project's own git history by construction.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
("Security" tab → "Report a vulnerability") rather than opening a public
issue. Reports that touch the vault-privacy or secret-scanning guarantees
are treated as highest priority.
