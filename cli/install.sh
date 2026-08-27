#!/bin/sh
# Vigil CLI installer. Usage: curl -fsSL https://cli.tryvigil.dev | bash
# Downloads the single file CLI and puts a `vigil` command on PATH.
# Requires Node.js 18 or newer. Set VIGIL_INSTALL_DIR to change the location.

set -e

BASE_URL="${VIGIL_CLI_URL:-https://cli.tryvigil.dev}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: the Vigil CLI needs Node.js 18 or newer and no 'node' was found." >&2
  echo "Install Node from https://nodejs.org and run this installer again." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js 18 or newer is required (found $(node -v))." >&2
  exit 1
fi

if [ -n "$VIGIL_INSTALL_DIR" ]; then
  BIN_DIR="$VIGIL_INSTALL_DIR"
elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

TMP="$(mktemp)"
curl -fsSL "$BASE_URL/vigil.mjs" -o "$TMP"
head -n 1 "$TMP" | grep -q '^#!/usr/bin/env node' || {
  echo "Error: download from $BASE_URL/vigil.mjs did not look like the CLI." >&2
  rm -f "$TMP"
  exit 1
}

mv "$TMP" "$BIN_DIR/vigil"
chmod +x "$BIN_DIR/vigil"

VERSION="$("$BIN_DIR/vigil" version 2>/dev/null || echo unknown)"

# `vigil update` runs this same script with VIGIL_UPDATE set: the tool is
# already installed and on PATH, so only the outcome is worth printing.
if [ -n "$VIGIL_UPDATE" ]; then
  echo "Updated vigil to $VERSION"
  exit 0
fi

echo "Installed vigil to $BIN_DIR/vigil ($VERSION)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Get started:"
echo "  vigil login"
echo "  vigil monitors create --project <project> --name \"My site\" --target https://example.com"
