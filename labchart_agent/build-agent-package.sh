#!/bin/bash
# Build the LabChart-PC folder: 64-bit embeddable Python + comtypes (pure Python COM) + the agent.
#   ./build-agent-package.sh [out.zip]     -> ~/Downloads/labchart-agent-portable.zip by default
set -euo pipefail
cd "$(dirname "$0")"
PYVER=3.10.11
if [ ! -x python-win64/python.exe ]; then
  tmp="$(mktemp)"; curl -fsSL "https://www.python.org/ftp/python/$PYVER/python-$PYVER-embed-amd64.zip" -o "$tmp"
  rm -rf python-win64; mkdir python-win64; (cd python-win64 && unzip -q "$tmp"); rm -f "$tmp"
fi
SP=python-win64/Lib/site-packages
if [ ! -d "$SP/comtypes" ]; then
  rm -rf "$SP" wheels; mkdir -p "$SP" wheels
  python3 -m pip download -q --dest wheels --only-binary=:all: --platform win_amd64 \
      --python-version 3.10 --implementation cp comtypes
  for w in wheels/*.whl; do unzip -qo "$w" -d "$SP"; done
  rm -f "$SP"/*.whl; rm -rf wheels
fi
printf 'python310.zip\n.\nLib\\site-packages\nimport site\n' > python-win64/python310._pth
python3 ../test/labchart_comments.test.py >/dev/null || { echo "comment tests fail -- not building"; exit 1; }
OUT="${1:-$HOME/Downloads/labchart-agent-portable.zip}"
STAGE="$(mktemp -d)/labchart-agent"; mkdir -p "$STAGE"
cp labchart_agent.py START-AGENT.bat START-COM-TEST.bat README.md "$STAGE/"; cp -R python-win64 "$STAGE/"
find "$STAGE" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
rm -f "$OUT"; (cd "$(dirname "$STAGE")" && zip -rqX "$OUT" labchart-agent -x '*.DS_Store')
echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
