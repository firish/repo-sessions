#!/bin/sh
# Stop: fires after every response — css debounces (10 min since last push,
# 2 min attempt cooldown) and detaches the push, so this is near-free. Covers
# laptop-lid-close where SessionEnd may never fire.
command -v css >/dev/null 2>&1 || exit 0
exec css hook stop
