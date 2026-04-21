#!/bin/bash
# Git Pull All Repos - 12 AM daily
# Syncs latest code from GitHub before nightly jobs run
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/git-pull-all.log
  exit 0
fi

LOG="/tmp/git-pull-all.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "Git Pull All - $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

REPOS=(
  "$HOME/Sites/bheng"
  "$HOME/Sites/tools"
  "$HOME/Sites/diagrams"
  "$HOME/Sites/claude"
  "$HOME/Sites/stickies"
  "$HOME/Sites/mindmaps"
  "$HOME/Sites/safe"
  "$HOME/Sites/drop"
  "$HOME/Sites/audit"
  "$HOME/Sites/workflows"
  "$HOME/Sites/system-design"
  "$HOME/Sites/local-apps"
)

PULLED=0
FAILED=0

for dir in "${REPOS[@]}"; do
  name=$(basename "$dir")
  if [ ! -d "$dir/.git" ]; then
    echo "  SKIP $name - not a git repo" >> "$LOG"
    continue
  fi

  cd "$dir"
  OUTPUT=$(git pull --ff-only 2>&1)
  EXIT=$?

  if [ $EXIT -eq 0 ]; then
    if echo "$OUTPUT" | grep -q "Already up to date"; then
      echo "  OK $name - up to date" >> "$LOG"
    else
      echo "  PULL $name - updated" >> "$LOG"
      echo "  $OUTPUT" | head -3 >> "$LOG"
      PULLED=$((PULLED + 1))

      # Rebuild if package.json has a build script
      if [ -f "$dir/package.json" ] && grep -q '"build"' "$dir/package.json" 2>/dev/null; then
        echo "  BUILD $name..." >> "$LOG"
        cd "$dir" && npm run build >> "$LOG" 2>&1
        if [ $? -eq 0 ]; then
          echo "  BUILD $name - OK" >> "$LOG"
          # Restart the app to pick up new build
          launchctl stop "com.bheng.$name" 2>/dev/null
          sleep 1
          launchctl start "com.bheng.$name" 2>/dev/null
          echo "  RESTART $name" >> "$LOG"
        else
          echo "  BUILD $name - FAILED" >> "$LOG"
        fi
      fi
    fi
  else
    echo "  FAIL $name - $OUTPUT" >> "$LOG"
    FAILED=$((FAILED + 1))
  fi
done

echo "" >> "$LOG"
echo "SUMMARY: $PULLED updated, $FAILED failed" >> "$LOG"

exit $FAILED
