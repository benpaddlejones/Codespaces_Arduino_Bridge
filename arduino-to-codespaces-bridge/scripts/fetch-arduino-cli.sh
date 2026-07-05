#!/bin/bash
# Fetch the arduino-cli binary bundled with the extension.
# The binary lives in bin/ (git-ignored) and ships inside the VSIX so the
# extension works without any system-level arduino-cli install.
#
# Usage: ./scripts/fetch-arduino-cli.sh [version]
set -euo pipefail

VERSION="${1:-1.4.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../bin"

if [ -x "$BIN_DIR/arduino-cli" ]; then
  INSTALLED=$("$BIN_DIR/arduino-cli" version 2>/dev/null | grep -oE 'Version: [0-9.]+' | cut -d' ' -f2 || true)
  if [ "$INSTALLED" = "$VERSION" ]; then
    echo "arduino-cli $VERSION already present in bin/"
    exit 0
  fi
fi

echo "Fetching arduino-cli $VERSION..."
mkdir -p "$BIN_DIR"
curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${VERSION}/arduino-cli_${VERSION}_Linux_64bit.tar.gz" \
  | tar -xz -C "$BIN_DIR" arduino-cli
chmod +x "$BIN_DIR/arduino-cli"
"$BIN_DIR/arduino-cli" version
echo "Done: $BIN_DIR/arduino-cli"
