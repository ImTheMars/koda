#!/bin/sh
# Koda CLI installer for Unix systems.
# Usage: curl -fsSL https://raw.githubusercontent.com/ImTheMars/koda/master/scripts/install.sh | sh

set -e

REPO="ImTheMars/koda"
INSTALL_DIR="/usr/local/bin"
FALLBACK_DIR="$HOME/.local/bin"
TMPFILE=""

cleanup() {
  [ -n "$TMPFILE" ] && rm -f "$TMPFILE"
}
trap cleanup EXIT INT TERM

# Detect OS and arch
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *)
    echo "error: unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "error: unsupported architecture: $ARCH"
    exit 1
    ;;
esac

ASSET="koda-${PLATFORM}-${ARCH}"

echo "koda installer"
echo "  platform: ${PLATFORM}-${ARCH}"

# Parse JSON for download URL — prefer jq, fall back to python3
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")

if command -v jq >/dev/null 2>&1; then
  RELEASE_URL=$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.name == \"${ASSET}\") | .browser_download_url")
elif command -v python3 >/dev/null 2>&1; then
  RELEASE_URL=$(echo "$RELEASE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for asset in data.get('assets', []):
    if asset['name'] == '${ASSET}':
        print(asset['browser_download_url'])
        break
")
else
  # Last resort: grep + cut (fragile but works for current API shape)
  RELEASE_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url.*${ASSET}\"" | cut -d '"' -f 4)
fi

if [ -z "$RELEASE_URL" ]; then
  echo "error: no binary found for ${PLATFORM}-${ARCH}"
  exit 1
fi

echo "  downloading: ${ASSET}"

# Download to temp file
TMPFILE=$(mktemp)
curl -fsSL "$RELEASE_URL" -o "$TMPFILE"

# Verify download is a binary (ELF or Mach-O header)
FILE_HEADER=$(head -c 4 "$TMPFILE" | od -A n -t x1 | tr -d ' ')
case "$FILE_HEADER" in
  7f454c46) ;; # ELF
  cafebabe|feedface|feedfacf|cffaedfe|cefaedfe) ;; # Mach-O
  *)
    echo "error: downloaded file does not appear to be a valid binary"
    exit 1
    ;;
esac

chmod +x "$TMPFILE"

# Try system install first, fall back to user install
if [ -w "$INSTALL_DIR" ] || [ "$(id -u)" = "0" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/koda"
  TMPFILE=""
  echo "  installed: ${INSTALL_DIR}/koda"
else
  mkdir -p "$FALLBACK_DIR"
  mv "$TMPFILE" "${FALLBACK_DIR}/koda"
  TMPFILE=""
  echo "  installed: ${FALLBACK_DIR}/koda"

  # Check if fallback dir is in PATH
  case ":$PATH:" in
    *":${FALLBACK_DIR}:"*) ;;
    *)
      echo ""
      echo "  add to your shell profile:"
      echo "    export PATH=\"${FALLBACK_DIR}:\$PATH\""
      ;;
  esac
fi

echo ""
echo "  run 'koda setup' to configure."
echo ""
