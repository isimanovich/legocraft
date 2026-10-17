#!/usr/bin/env bash
# Serve LEGOCRAFT and its multiplayer rooms on this machine's network.
set -euo pipefail
cd "$(dirname "$0")"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 20.19 or newer (22/24 LTS recommended), then run npm ci." >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)'; then
  echo "Node.js 20.19 or newer is required (22/24 LTS recommended)." >&2
  exit 1
fi
if [[ ! -d node_modules/ws || ! -d node_modules/three ]]; then
  echo "Install dependencies first: npm ci" >&2
  exit 1
fi

URL_HOST="${HOST}"
if [[ "${HOST}" == "0.0.0.0" || "${HOST}" == "::" ]]; then
  URL_HOST="127.0.0.1"
elif [[ "${HOST}" == *:* ]]; then
  URL_HOST="[${HOST}]"
fi
URL="http://${URL_HOST}:${PORT}/"

echo "LEGOCRAFT -> ${URL}   (Ctrl+C to stop)"
echo "On another device, open http://<this machine's LAN IP>:${PORT}/"
if [[ "${OPEN_BROWSER:-0}" == "1" ]]; then
  if command -v open >/dev/null 2>&1; then
    ( sleep 1; open "${URL}" >/dev/null 2>&1 || true ) &
  elif command -v xdg-open >/dev/null 2>&1; then
    ( sleep 1; xdg-open "${URL}" >/dev/null 2>&1 || true ) &
  fi
fi
exec node server/main.mjs
