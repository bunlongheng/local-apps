#!/bin/bash
cd "$(dirname "$0")"
# Load nvm's node if present (falls back to whatever node is on PATH otherwise)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

# Single service: Express serves the dashboard UI (public/) AND the control API on :9875.
# No Next.js, no build step. launchd KeepAlive is the watchdog - if node exits, it respawns.
export API_BIND="${API_BIND:-0.0.0.0}"
exec node server.js
