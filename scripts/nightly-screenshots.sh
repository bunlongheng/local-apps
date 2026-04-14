#!/bin/bash
# Nightly Screenshots - 2 AM daily
# Retakes screenshots for all apps
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/nightly-screenshots.log
  exit 0
fi

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="/tmp/nightly-screenshots.log"
echo "========================================" >> "$LOG"
echo "Nightly Screenshots - $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
echo "========================================" >> "$LOG"

cd $HOME/Sites/local-apps
node scripts/screenshot-bot.js >> "$LOG" 2>&1

echo "Done: $(date '+%H:%M:%S')" >> "$LOG"
