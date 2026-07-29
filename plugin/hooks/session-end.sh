#!/bin/sh
# SessionEnd: push this repo's sessions. The CLI detaches the push into a
# background process and exits immediately, so session exit is never delayed.
if command -v chat >/dev/null 2>&1; then exec chat hook session-end; fi
command -v css >/dev/null 2>&1 || exit 0
exec css hook session-end
