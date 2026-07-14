#!/bin/bash
# Nightly GIF Recordings - 3 AM daily
# Records animated GIFs for key apps via LAN
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/nightly-gifs.log
  exit 0
fi

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="/tmp/nightly-gifs.log"
echo "========================================" >> "$LOG"
echo "Nightly GIFs - $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
echo "========================================" >> "$LOG"

cd $HOME/Sites/local-apps

# Record 3pi GIFs (5 batches of 5 in parallel)
PAGES_ALL="/:dashboard /quality:quality /security:security /bugs:bugs /performance:performance /tech-debt:tech-debt /deployment:deployment /releases:releases /cycles:cycles /capacity:capacity /velocity:velocity /metrics:metrics /architecture:architecture /data-flow:data-flow /database:database /jira-view:jira-view /pm:pm /slack:slack /links:links /notifications:notifications /api-reference:api-reference /me:me /settings:settings /admin/users:admin-users /admin/completed:admin-completed"

# Detect 3pi URL (LAN or local)
URL="http://localhost:3333"
LAN_URL=$(curl -s http://localhost:9876/api/machines | python3 -c "import sys,json; ms=json.load(sys.stdin); print(next((f'http://{m[\"ip\"]}:3333' for m in ms if m.get('ip')), ''))" 2>/dev/null)
if [ -n "$LAN_URL" ]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$LAN_URL" 2>/dev/null)
  [ "$code" != "000" ] && URL="$LAN_URL"
fi

echo "  URL: $URL" >> "$LOG"

BATCH=0
PAIRS=($PAGES_ALL)
for ((i=0; i<${#PAIRS[@]}; i+=5)); do
  BATCH=$((BATCH + 1))
  for ((j=i; j<i+5 && j<${#PAIRS[@]}; j++)); do
    IFS=':' read -r p name <<< "${PAIRS[$j]}"
    node scripts/gif-bot.js 3pi --url "$URL" --pages "$p" >> "$LOG" 2>&1 &
  done
  wait
  echo "  Batch $BATCH done" >> "$LOG"
done

echo "Done: $(date '+%H:%M:%S')" >> "$LOG"
