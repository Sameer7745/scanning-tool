#!/usr/bin/env bash
# ============================================================
#  Scan Tool - Linux/macOS launcher
#  Installs dependencies, builds the UI, and starts the bridge.
#  Then open http://localhost:3001 in a browser.
# ============================================================
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node 18+ first." >&2
  exit 1
fi

echo "=== Installing server dependencies ==="
( cd server && npm install --no-fund --no-audit )

echo "=== Building the web UI ==="
( cd web && npm install --no-fund --no-audit && npm run build )

echo
echo "=== Starting Scan Tool ==="
echo "Open http://localhost:3001 (or http://<this-server-ip>:3001 from other devices)."
echo "Press Ctrl+C to stop."
echo
exec sh -c 'cd server && npm start'
