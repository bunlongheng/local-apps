#!/bin/bash
# Nightly Link Crawler - 1:30 AM
# Visits every page in every app, detects crashes, screenshots errors
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/link-crawler.log
  exit 0
fi

export PATH="/Users/bheng/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> /tmp/link-crawler.log
echo "Link Crawler - $(date '+%Y-%m-%d %H:%M:%S')" >> /tmp/link-crawler.log
echo "========================================" >> /tmp/link-crawler.log

cd /Users/bheng/Sites/local-apps
node scripts/link-crawler.js >> /tmp/link-crawler.log 2>&1

echo "Done: $(date '+%H:%M:%S')" >> /tmp/link-crawler.log
