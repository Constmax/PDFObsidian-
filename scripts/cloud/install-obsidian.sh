#!/bin/bash
# Installs a pinned Obsidian desktop build (Linux AppImage, extracted) for
# Claude Code cloud sessions, plus an unpacked copy of its app sources so the
# bundled pdf.js (lib/pdfjs/) can be inspected.
#
# Layout:
#   /opt/obsidian/<version>/app/obsidian    Electron binary
#   /opt/obsidian/<version>/src/            unpacked obsidian.asar
#   /opt/obsidian/current -> <version>
#
# Idempotent: does nothing if the version is already installed.
set -euo pipefail

OBSIDIAN_VERSION="${OBSIDIAN_VERSION:-1.13.4}"
ROOT="${OBSIDIAN_ROOT:-/opt/obsidian}"
DEST="$ROOT/$OBSIDIAN_VERSION"

if [ -x "$DEST/app/obsidian" ] && [ -f "$DEST/src/lib/pdfjs/version.json" ]; then
    ln -sfn "$DEST" "$ROOT/current"
    exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/obsidianmd/obsidian-releases/releases/download/v$OBSIDIAN_VERSION/Obsidian-$OBSIDIAN_VERSION.AppImage"
echo "Downloading Obsidian $OBSIDIAN_VERSION" >&2
curl -fsSL --retry 3 -o "$tmp/Obsidian.AppImage" "$url"
chmod +x "$tmp/Obsidian.AppImage"

# No FUSE in the container, so extract instead of mounting.
(cd "$tmp" && ./Obsidian.AppImage --appimage-extract >/dev/null)

rm -rf "$DEST"
mkdir -p "$DEST"
mv "$tmp/squashfs-root" "$DEST/app"
npx -y @electron/asar@4 extract "$DEST/app/resources/obsidian.asar" "$DEST/src" >&2

ln -sfn "$DEST" "$ROOT/current"
echo "Installed Obsidian $OBSIDIAN_VERSION (pdf.js $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DEST/src/lib/pdfjs/version.json"))" >&2
