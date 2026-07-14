#!/bin/bash
cd "$(dirname "$0")"
# Load nvm's node if present (falls back to whatever node is on PATH otherwise)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

# Build once, skip if .next already exists and is fresh (< 1 hour old)
if [ ! -d .next ] || [ "$(find .next -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
  npm run build 2>/dev/null || true
fi

# Express watchdog: auto-restart if it crashes
start_express() {
  while true; do
    node server.js
    echo "[$(date)] Express crashed (exit $?), restarting in 3s..." >> /tmp/local-apps-express.log
    sleep 3
  done
}

start_express &
EXPRESS_WATCHDOG_PID=$!

trap "kill $EXPRESS_WATCHDOG_PID 2>/dev/null; lsof -ti:9875 | xargs kill 2>/dev/null" EXIT

exec npx next start -p 9876 --hostname 0.0.0.0
