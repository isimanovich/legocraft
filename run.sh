#!/usr/bin/env bash
# Serve LEGOCRAFT on localhost and open it in the default browser.
# ES modules need http://, so file:// won't work.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"
URL="http://127.0.0.1:${PORT}/"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (ships with macOS / Xcode CLT)." >&2
  exit 1
fi

echo "LEGOCRAFT -> ${URL}   (Ctrl+C to stop)"
( sleep 0.7; open "${URL}" ) &
exec python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory .
