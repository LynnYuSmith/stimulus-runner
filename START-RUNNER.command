#!/bin/bash
# ============================================================
#  Grating Stimulator — double-click launcher (macOS / Linux)
#  Starts the local server and opens the runner in Chrome/Edge.
#  Protocols live in the protocols/ folder next to this file.
# ============================================================
cd "$(dirname "$0")" || exit 1

# find a Python 3 interpreter
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c 'import sys; sys.exit(0 if sys.version_info[0]==3 else 1)' 2>/dev/null; then PY="$c"; break; fi
  fi
done

if [ -z "$PY" ]; then
  echo
  echo "  Python 3 was not found on this computer."
  echo "  macOS: install from https://www.python.org/downloads/ (or 'brew install python')."
  echo "  Then double-click this file again."
  echo
  echo "  (Without Python the gratings still work by opening index.html in"
  echo "   Chrome/Edge — but saved protocols need this server.)"
  echo
  read -r -p "Press Enter to close." _
  exit 1
fi

echo "  Starting the Grating Stimulator server..."
echo "  A browser window will open. Keep THIS window open while you work."
echo "  Press Ctrl-C (or close this window) to stop."
echo
"$PY" serve.py
