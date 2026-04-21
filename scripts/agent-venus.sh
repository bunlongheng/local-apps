#!/bin/bash
# 💜 Venus Agent — UI Regression (Screenshot Diff)
# Runs at 8 AM and 8 PM daily
# Compares today's screenshots with yesterday's to detect visual changes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/agent-venus.log
  exit 0
fi

LOG="/tmp/agent-venus.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
CHANGES=0
CHECKED=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "💜 Venus — UI Regression — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

SCREENSHOT_DIR="$HOME/Sites/local-apps/public/screenshots"
DIFF_DIR="/tmp/venus-diffs"
mkdir -p "$DIFF_DIR"

TODAY=$(date '+%Y-%m-%d')
YESTERDAY=$(date -v-1d '+%Y-%m-%d' 2>/dev/null || date -d 'yesterday' '+%Y-%m-%d' 2>/dev/null)

APPS=(
  "bheng"
  "tools"
  "diagrams"
  "claude"
  "stickies"
  "mindmaps"
  "safe"
  "drop"
  "audit"
  "workflows"
  "system-design"
)

# ── Take fresh screenshots ────────────────────────────────────────────────

echo "" >> "$LOG"
echo "PHASE 1: Capturing fresh screenshots" >> "$LOG"

cd "$HOME/Sites/local-apps"
node scripts/screenshot-bot.js >> "$LOG" 2>&1

# ── Compare with previous screenshots ─────────────────────────────────────

echo "" >> "$LOG"
echo "PHASE 2: Comparing screenshots" >> "$LOG"

for name in "${APPS[@]}"; do
  CURRENT="$SCREENSHOT_DIR/${name}-desktop.png"
  PREVIOUS="$SCREENSHOT_DIR/${name}-desktop.prev.png"

  if [ ! -f "$CURRENT" ]; then
    echo "  - $name — no screenshot found" >> "$LOG"
    continue
  fi

  CHECKED=$((CHECKED + 1))

  if [ ! -f "$PREVIOUS" ]; then
    echo "  ◐ $name — no previous screenshot to compare (first run)" >> "$LOG"
    cp "$CURRENT" "$PREVIOUS"
    continue
  fi

  # Compare file sizes as quick diff
  SIZE_CURR=$(stat -f%z "$CURRENT" 2>/dev/null || stat -c%s "$CURRENT" 2>/dev/null)
  SIZE_PREV=$(stat -f%z "$PREVIOUS" 2>/dev/null || stat -c%s "$PREVIOUS" 2>/dev/null)

  if [ "$SIZE_CURR" = "$SIZE_PREV" ]; then
    # Same size, do byte comparison
    if cmp -s "$CURRENT" "$PREVIOUS"; then
      echo "  ✓ $name — no visual change" >> "$LOG"
    else
      echo "  ⚠ $name — visual change detected (same size, different pixels)" >> "$LOG"
      CHANGES=$((CHANGES + 1))
    fi
  else
    DIFF_KB=$(( (SIZE_CURR - SIZE_PREV) / 1024 ))
    echo "  ⚠ $name — visual change detected (size diff: ${DIFF_KB}KB)" >> "$LOG"
    CHANGES=$((CHANGES + 1))
  fi

  # Rotate: current becomes previous for next run
  cp "$CURRENT" "$PREVIOUS"
done

echo "" >> "$LOG"
echo "SUMMARY: $CHECKED checked, $CHANGES visual changes detected" >> "$LOG"
echo "========================================" >> "$LOG"

cat > /tmp/agent-venus-summary.json << ENDJSON
{
  "agent": "venus",
  "timestamp": "$TIMESTAMP",
  "checked": $CHECKED,
  "changes": $CHANGES
}
ENDJSON

exit 0
