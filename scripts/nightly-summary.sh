#!/bin/bash
# Nightly Summary Report - 6 AM daily
# Aggregates all nightly job results and posts to stickies
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/nightly-summary.log
  exit 0
fi

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="/tmp/nightly-summary.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
DATE=$(date '+%Y-%m-%d')

echo "========================================" >> "$LOG"
echo "Nightly Summary - $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

# Gather results from all nightly jobs
REPORT="# Nightly Report - $DATE\n\n"

# Git Pull
if [ -f /tmp/git-pull-all.log ]; then
  PULL_LINE=$(grep "SUMMARY:" /tmp/git-pull-all.log | tail -1)
  REPORT="$REPORT## Git Pull\n$PULL_LINE\n\n"
fi

# Tests
if [ -f /tmp/nightly-tests-summary.json ]; then
  TESTS=$(python3 -c "import json; d=json.load(open('/tmp/nightly-tests-summary.json')); print(f\"Passed: {d['passed']}/{d['total']}, Failed: {d['failed']}, Fixed: {d.get('fixed',0)}\")" 2>/dev/null)
  REPORT="$REPORT## Tests\n$TESTS\n\n"
fi

# Screenshots
if [ -f /tmp/nightly-screenshots.log ]; then
  SS_LINE=$(grep "All done" /tmp/nightly-screenshots.log | tail -1)
  REPORT="$REPORT## Screenshots\n${SS_LINE:-Completed}\n\n"
fi

# GIFs
if [ -f /tmp/nightly-gifs.log ]; then
  GIF_COUNT=$(grep -c "\.gif" /tmp/nightly-gifs.log 2>/dev/null || echo 0)
  REPORT="$REPORT## GIFs\n$GIF_COUNT recordings\n\n"
fi

# Deep Audit
if [ -f /tmp/deep-audit-summary.json ]; then
  AUDIT=$(python3 -c "import json; d=json.load(open('/tmp/deep-audit-summary.json')); print(f\"Fixed: {d['fixed']}, Issues: {d['issues']}\")" 2>/dev/null)
  REPORT="$REPORT## Deep Audit\n$AUDIT\n\n"
fi

# Security & Performance Scan
if [ -f /tmp/nightly-scan-summary.json ]; then
  SCAN=$(python3 -c "import json; d=json.load(open('/tmp/nightly-scan-summary.json')); print(f\"Security: {d['securityFlags']} flags, Performance: {d['performanceFlags']} flags\")" 2>/dev/null)
  REPORT="$REPORT## Security & Performance\n$SCAN\n\n"
fi

# App Status
STATUS=$(curl -s http://localhost:9876/api/status 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
up=sum(1 for a in d['apps'] if a['status']=='up')
total=len(d['apps'])
print(f'{up}/{total} apps running')
" 2>/dev/null)
REPORT="$REPORT## App Status\n$STATUS\n"

echo -e "$REPORT" >> "$LOG"

# Post to stickies
source ~/.zshrc 2>/dev/null
if command -v stickies &>/dev/null; then
  echo -e "$REPORT" | stickies --title="Nightly Report $DATE" --tags=nightly,report --path=/Reporting 2>/dev/null || true
  echo "  Posted to stickies" >> "$LOG"
fi

echo "Done" >> "$LOG"
