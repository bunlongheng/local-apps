#!/bin/bash
# ⚡ Zap Agent — Bundle Analyzer + Performance Profiler
# Runs at 6 AM and 6 PM daily
# Checks JS bundle sizes and server response times across all apps

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/agent-zap.log
  exit 0
fi

LOG="/tmp/agent-zap.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "⚡ Zap — Bundle & Performance — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

APPS=(
  "bheng|3000|$HOME/Sites/bheng"
  "tools|3001|$HOME/Sites/tools"
  "diagrams|3002|$HOME/Sites/diagrams"
  "claude|3003|$HOME/Sites/claude"
  "stickies|4444|$HOME/Sites/stickies"
  "mindmaps|5173|$HOME/Sites/mindmaps"
  "safe|6100|$HOME/Sites/safe"
  "drop|3010|$HOME/Sites/drop"
  "audit|3004|$HOME/Sites/audit"
  "workflows|3005|$HOME/Sites/workflows"
  "system-design|3006|$HOME/Sites/system-design"
)

# ── Check 1: Server Response Times (TTFB) ─────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 1: Server Response Times" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  TTFB=$(curl -s -o /dev/null -w '%{time_starttransfer}' --max-time 10 "http://localhost:$port/" 2>/dev/null)
  TOTAL_TIME=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 "http://localhost:$port/" 2>/dev/null)

  if [ -z "$TTFB" ] || [ "$TTFB" = "0.000000" ]; then
    echo "  ✗ $name — not reachable on port $port" >> "$LOG"
    ISSUES=$((ISSUES + 1))
    continue
  fi

  TTFB_MS=$(echo "$TTFB * 1000" | bc 2>/dev/null | cut -d. -f1)
  TOTAL_MS=$(echo "$TOTAL_TIME * 1000" | bc 2>/dev/null | cut -d. -f1)

  if [ "${TTFB_MS:-0}" -gt 3000 ]; then
    echo "  ⚠ $name — TTFB ${TTFB_MS}ms (slow!)" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  elif [ "${TTFB_MS:-0}" -gt 1000 ]; then
    echo "  ◐ $name — TTFB ${TTFB_MS}ms (borderline)" >> "$LOG"
  else
    echo "  ✓ $name — TTFB ${TTFB_MS}ms, total ${TOTAL_MS}ms" >> "$LOG"
  fi
done

# ── Check 2: Bundle Size (.next/static) ───────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 2: Bundle Sizes" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  if [ -d "$dir/.next/static" ]; then
    SIZE=$(du -sh "$dir/.next/static" 2>/dev/null | awk '{print $1}')
    JS_SIZE=$(find "$dir/.next/static" -name "*.js" -exec du -ch {} + 2>/dev/null | tail -1 | awk '{print $1}')
    echo "  $name — static: $SIZE, JS: $JS_SIZE" >> "$LOG"
  elif [ -d "$dir/dist" ]; then
    SIZE=$(du -sh "$dir/dist" 2>/dev/null | awk '{print $1}')
    echo "  $name — dist: $SIZE" >> "$LOG"
  else
    echo "  $name — no build output found" >> "$LOG"
  fi
done

# ── Check 3: node_modules size ────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 3: node_modules Sizes" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  if [ -d "$dir/node_modules" ]; then
    SIZE=$(du -sh "$dir/node_modules" 2>/dev/null | awk '{print $1}')
    echo "  $name — $SIZE" >> "$LOG"
  fi
done

echo "" >> "$LOG"
echo "SUMMARY: $ISSUES performance issues found" >> "$LOG"
echo "========================================" >> "$LOG"

# Write summary JSON
cat > /tmp/agent-zap-summary.json << ENDJSON
{
  "agent": "zap",
  "timestamp": "$TIMESTAMP",
  "issues": $ISSUES
}
ENDJSON

exit 0
