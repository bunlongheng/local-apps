#!/bin/bash
# Nightly test runner — runs `npm test` on all apps
# If any fail, spawns a Claude Code agent per failed repo to auto-fix
# Scheduled via launchctl at 1:00 AM daily

LOG="/tmp/nightly-tests.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PASS=0
FAIL=0
TOTAL=0
FIXED=0
RESULTS=""
FAILED_APPS=()

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

# ── Phase 1: Run all tests ──────────────────────────────────────────────────

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
    FAILED_APPS+=("$name|$dir")
  fi
done

echo "" >> "$LOG"
echo "Phase 1 SUMMARY: $PASS/$TOTAL passed, $FAIL failed" >> "$LOG"

# ── Phase 2: Auto-fix failed repos with Claude Code agents ──────────────────

if [ ${#FAILED_APPS[@]} -gt 0 ]; then
  echo "" >> "$LOG"
  echo "========================================" >> "$LOG"
  echo "Phase 2: Deploying Claude Code agents to fix ${#FAILED_APPS[@]} failing repo(s)" >> "$LOG"
  echo "========================================" >> "$LOG"

  AGENT_PIDS=()
  AGENT_LOGS=()
  AGENT_NAMES=()
  AGENT_DIRS=()

  # Launch one Claude agent per failed repo (in parallel)
  for entry in "${FAILED_APPS[@]}"; do
    IFS='|' read -r name dir <<< "$entry"
    AGENT_LOG="/tmp/nightly-fix-${name}.log"

    echo "  ↻ Launching agent for $name..." >> "$LOG"

    cd "$dir"

    # Capture test output for the agent's context
    FAIL_OUTPUT=$(npm test 2>&1 | tail -50)

    claude -p \
      --dangerously-skip-permissions \
      --max-budget-usd 1.00 \
      --allowedTools "Bash Edit Read Write Glob Grep" \
      "You are an automated test-fix agent for the app at $dir.

The nightly test run failed. Here is the test output:

\`\`\`
$FAIL_OUTPUT
\`\`\`

Your task:
1. Read the failing test files and the source code they test
2. Fix the tests or source code so all tests pass
3. Run \`npm test\` to verify 0 failures
4. If you fixed code (not just tests), make sure the fix is correct and doesn't break functionality
5. After all tests pass, run: git add -A && git commit -m 'fix: auto-fix failing tests (nightly)' && git push

Rules:
- Do NOT delete tests to make them pass
- Do NOT add --skip or .skip to tests
- Do NOT change test assertions to match wrong behavior — fix the source code instead
- Keep changes minimal — only fix what's broken
- Max 3 attempts to fix. If still failing after 3 tries, stop and log the error." \
      > "$AGENT_LOG" 2>&1 &

    AGENT_PIDS+=($!)
    AGENT_LOGS+=("$AGENT_LOG")
    AGENT_NAMES+=("$name")
    AGENT_DIRS+=("$dir")
  done

  # Wait for all agents to finish
  for i in "${!AGENT_PIDS[@]}"; do
    pid="${AGENT_PIDS[$i]}"
    name="${AGENT_NAMES[$i]}"
    dir="${AGENT_DIRS[$i]}"
    agent_log="${AGENT_LOGS[$i]}"

    wait "$pid"
    AGENT_EXIT=$?

    echo "" >> "$LOG"
    echo "  Agent $name finished (exit $AGENT_EXIT)" >> "$LOG"

    # Re-run tests to verify the fix
    cd "$dir"
    RETEST=$(npm test 2>&1)
    RETEST_EXIT=$?

    if [ $RETEST_EXIT -eq 0 ]; then
      echo "  ✓ $name FIXED by agent" >> "$LOG"
      FIXED=$((FIXED + 1))
      RESULTS="$RESULTS\n✓ $name — auto-fixed by agent"
    else
      echo "  ✗ $name still failing after agent fix attempt" >> "$LOG"
      echo "$RETEST" | tail -10 >> "$LOG"
      RESULTS="$RESULTS\n✗ $name — agent could not fix"
    fi

    # Append agent log summary
    echo "  Agent log: $agent_log" >> "$LOG"
    tail -5 "$agent_log" >> "$LOG" 2>/dev/null
  done

  # Update counts
  FAIL=$((FAIL - FIXED))
  PASS=$((PASS + FIXED))
fi

# ── Final summary ────────────────────────────────────────────────────────────

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "FINAL SUMMARY: $PASS/$TOTAL passed, $FAIL failed, $FIXED auto-fixed" >> "$LOG"
echo "========================================" >> "$LOG"

# Write summary JSON for dashboard
cat > /tmp/nightly-tests-summary.json << ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "total": $TOTAL,
  "passed": $PASS,
  "failed": $FAIL,
  "fixed": $FIXED,
  "apps": "$(echo -e "$RESULTS" | sed 's/"/\\"/g')"
}
ENDJSON

exit $FAIL
