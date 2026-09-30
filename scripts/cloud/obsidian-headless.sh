#!/bin/bash
# Starts the Obsidian installed by install-obsidian.sh on a virtual display,
# with the Chrome DevTools Protocol on $OBSIDIAN_CDP_PORT (default 9222) so it
# can be driven with Playwright (chromium.connectOverCDP) or plain CDP.
# Extra arguments are passed to Obsidian.
#
# Obsidian's config (vault registry etc.) lives in $XDG_CONFIG_HOME/obsidian,
# i.e. ~/.config/obsidian by default.
set -euo pipefail

ROOT="${OBSIDIAN_ROOT:-/opt/obsidian}"
PORT="${OBSIDIAN_CDP_PORT:-9222}"

exec xvfb-run -a -s "-screen 0 1600x1000x24" \
    "$ROOT/current/app/obsidian" \
    --no-sandbox \
    --remote-debugging-port="$PORT" \
    "$@"
