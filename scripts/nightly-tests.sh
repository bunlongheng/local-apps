#!/bin/bash
# Nightly test runner — runs `npm test` on all apps
# Scheduled via launchctl at 1:00 AM daily

LOG="/tmp/nightly-tests.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PASS=0
FAIL=0
TOTAL=0
RESULTS=""

export PATH="/Users/bheng/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "Nightly Test Run — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

APPS=(
  "bheng|/Users/bheng/Sites/bheng"
  "tools|/Users/bheng/Sites/tools"
  "diagrams|/Users/bheng/Sites/diagrams"
  "claude|/Users/bheng/Sites/claude"
  "3pi|/Users/bheng/Sites/3pi"
  "3pi-poc|/Users/bheng/Sites/3pi-poc"
  "stickies|/Users/bheng/Sites/stickies"
  "vault|/Users/bheng/Sites/vault"
  "mindmaps|/Users/bheng/Sites/mindmaps"
  "safe|/Users/bheng/Sites/safe"
  "drop-web|/Users/bheng/Sites/drop"
)

for entry in "${APPS[@]}"; do
  IFS='|' read -r name dir <<< "$entry"
  TOTAL=$((TOTAL + 1))
  echo "" >> "$LOG"
  echo "▶ $name ($dir)" >> "$LOG"

  if [ ! -d "$dir" ]; then
    echo "  ✗ directory not found" >> "$LOG"
    FAIL=$((FAIL + 1))
    RESULTS="$RESULTS\n✗ $name — directory not found"
    continue
  fi

  cd "$dir"
  OUTPUT=$(npm test 2>&1)
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "  ✓ PASS" >> "$LOG"
    PASS=$((PASS + 1))
    RESULTS="$RESULTS\n✓ $name"
  else
    echo "  ✗ FAIL (exit $EXIT_CODE)" >> "$LOG"
    echo "$OUTPUT" | tail -20 >> "$LOG"
    FAIL=$((FAIL + 1))
    RESULTS="$RESULTS\n✗ $name — exit $EXIT_CODE"
  fi
done

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "SUMMARY: $PASS/$TOTAL passed, $FAIL failed" >> "$LOG"
echo "========================================" >> "$LOG"

# Write summary to a JSON file for the dashboard
cat > /tmp/nightly-tests-summary.json << ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "total": $TOTAL,
  "passed": $PASS,
  "failed": $FAIL,
  "apps": "$(echo -e "$RESULTS" | sed 's/"/\\"/g')"
}
ENDJSON

exit $FAIL
