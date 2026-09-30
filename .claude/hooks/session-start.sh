#!/bin/bash
# SessionStart hook: prepares Claude Code cloud sessions (no-op locally).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Electron is only needed for its types; skip the ~100 MB binary download.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile >&2

# Obsidian for trying builds and for looking up the pdf.js it ships.
./scripts/cloud/install-obsidian.sh >&2

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    {
        echo 'export OBSIDIAN_HOME=/opt/obsidian/current'
        echo "export PATH=\"$CLAUDE_PROJECT_DIR/scripts/cloud:\$PATH\""
    } >> "$CLAUDE_ENV_FILE"
fi
