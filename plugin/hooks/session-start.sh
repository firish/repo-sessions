#!/bin/sh
# SessionStart: pull newer sessions for this repo before the session begins.
# css prints hookSpecificOutput.additionalContext JSON when something arrived.
# No css on PATH (or repo not enabled) -> exit silently; never block a session.
command -v css >/dev/null 2>&1 || exit 0
exec css hook session-start
