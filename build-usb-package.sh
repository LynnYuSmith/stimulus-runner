#!/bin/bash
# Build the offline USB package: runner + protocols + launchers + both bundled
# Windows Pythons, zipped for the (offline, possibly 32-bit) stimulation PC.
#
#   ./build-usb-package.sh            -> ~/Downloads/stimulus-runner-portable.zip
#   ./build-usb-package.sh /path/out  -> writes there instead
#
# The embeddable Pythons (python-win32/, python-win64/) are NOT in git (heavy
# Windows binaries). Fetch them once with:  ./build-usb-package.sh --fetch
set -euo pipefail
cd "$(dirname "$0")"

PYVER=3.10.11
fetch_pythons() {
  echo "Fetching embeddable Python $PYVER (32 + 64 bit)..."
  for arch in win32 amd64; do
    dst="python-win${arch/amd64/64}"; dst="${dst/win32/-win32}"
    # normalise: amd64 -> python-win64, win32 -> python-win32
    case "$arch" in amd64) dst=python-win64;; win32) dst=python-win32;; esac
    if [ -x "$dst/python.exe" ]; then echo "  $dst already present"; continue; fi
    url="https://www.python.org/ftp/python/$PYVER/python-$PYVER-embed-$arch.zip"
    tmp="$(mktemp)"; curl -fsSL "$url" -o "$tmp"
    rm -rf "$dst"; mkdir "$dst"; ( cd "$dst" && unzip -q "$tmp" ); rm -f "$tmp"
    echo "  $dst ready"
  done
}

if [ "${1:-}" = "--fetch" ]; then fetch_pythons; exit 0; fi

# ensure the bundled Pythons exist (fetch if missing)
[ -x python-win32/python.exe ] && [ -x python-win64/python.exe ] || fetch_pythons

OUT="${1:-$HOME/Downloads/stimulus-runner-portable.zip}"
STAGE="$(mktemp -d)/stimulus-runner"
mkdir -p "$STAGE"
cp index.html protocol.js serve.py START-RUNNER.bat START-RUNNER.command \
   READ-ME-FIRST.txt LICENSE README.md "$STAGE/"
cp -R protocols "$STAGE/protocols"
cp -R python-win32 "$STAGE/python-win32"
cp -R python-win64 "$STAGE/python-win64"
find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
chmod +x "$STAGE/START-RUNNER.command" "$STAGE/serve.py"

rm -f "$OUT"
( cd "$(dirname "$STAGE")" && zip -rqX "$OUT" "$(basename "$STAGE")" -x '*.DS_Store' )
echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
echo "  protocols: $(ls protocols/*.json | wc -l | tr -d ' ')  |  bundled Python: 32-bit + 64-bit"
