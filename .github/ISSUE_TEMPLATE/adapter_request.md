---
name: Adapter request
about: Ask for (or offer to build) support for another agent tool
labels: adapter
---

**Tool + version:**

**Where do its sessions live on disk?** (paths, format — jsonl/sqlite/other)

**Does it have a resume-by-id command?** (`tool resume <id>` or equivalent —
this is the gating requirement; see CONTRIBUTING.md)

**Does the vendor already sync sessions natively?** (If yes, an adapter may
be the wrong move — see the README's "What travels, and why".)

**Willing to build it?** ADR-6 interface + the codex adapter are the
templates; happy to review.
