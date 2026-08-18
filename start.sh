#!/bin/bash
cd "$(dirname "$0")"
# Load nvm and select Node 22 - matches CI and the better-sqlite3 prebuilt ABI (running an
# older node here breaks the native module: ERR_DLOPEN_FAILED). Falls back to PATH node.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
nvm use 22 >/dev/null 2>&1 || true

# Single service: Express serves the dashboard UI (public/) AND the control API on :9875.
# No Next.js, no build step. launchd KeepAlive is the watchdog - if node exits, it respawns.
export API_BIND="${API_BIND:-0.0.0.0}"
exec node server.js
