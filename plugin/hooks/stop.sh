#!/bin/sh
# Stop: fires after every response — the CLI debounces (stopDebounceMinutes)
# and detaches, so this is near-free. Covers laptop-lid-close handoffs.
if command -v chat >/dev/null 2>&1; then exec chat hook stop; fi
command -v css >/dev/null 2>&1 || exit 0
exec css hook stop
