#!/bin/sh
# SessionEnd: push this repo's sessions to the vault. css detaches the actual
# push into a background process and exits immediately (documented pattern for
# hooks that would otherwise slow down exit).
command -v css >/dev/null 2>&1 || exit 0
exec css hook session-end
