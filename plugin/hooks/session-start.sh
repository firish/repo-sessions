#!/bin/sh
# SessionStart: pull newer sessions before the session begins; emits
# hookSpecificOutput JSON (sync notices, stale-resume warning). Silent no-op
# when the CLI is absent or the repo is not enabled.
if command -v chat >/dev/null 2>&1; then exec chat hook session-start; fi
command -v css >/dev/null 2>&1 || exit 0
exec css hook session-start
