#!/bin/bash
# ❄️ Snow Agent — Summary Report + Auto-Fix Orchestrator
# Runs at 11 AM and 11 PM daily
# Aggregates all agent findings and deploys Claude Code agents to fix issues

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/agent-snow.log
  exit 0
fi

LOG="/tmp/agent-snow.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
TOTAL_ISSUES=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "❄️ Snow — Summary & Auto-Fix — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

# ── Phase 1: Aggregate all agent summaries ────────────────────────────────

echo "" >> "$LOG"
echo "PHASE 1: Agent Report Aggregation" >> "$LOG"

AGENTS=("zap" "sand" "venus" "blaze" "frost" "earth" "shadow" "blitz" "arrow" "rock" "pulse")
REPORT=""

for agent in "${AGENTS[@]}"; do
  SUMMARY="/tmp/agent-${agent}-summary.json"
  if [ -f "$SUMMARY" ]; then
    ISSUES=$(node -e "try{const s=require('$SUMMARY');console.log(s.issues||s.changes||s.failed||0)}catch{console.log('?')}" 2>/dev/null)
    TS=$(node -e "try{const s=require('$SUMMARY');console.log(s.timestamp||'unknown')}catch{console.log('unknown')}" 2>/dev/null)
    echo "  $agent — issues: $ISSUES (last run: $TS)" >> "$LOG"
    REPORT="$REPORT- $agent: $ISSUES issues\n"
    if [ "$ISSUES" != "?" ] && [ "$ISSUES" -gt 0 ] 2>/dev/null; then
      TOTAL_ISSUES=$((TOTAL_ISSUES + ISSUES))
    fi
  else
    echo "  $agent — no summary found" >> "$LOG"
    REPORT="$REPORT- $agent: no data\n"
  fi
done

# Also check nightly test/scan summaries
for legacy in "nightly-tests" "nightly-scan" "deep-audit"; do
  SUMMARY="/tmp/${legacy}-summary.json"
  if [ -f "$SUMMARY" ]; then
    FAILED=$(node -e "try{const s=require('$SUMMARY');console.log(s.failed||s.issues||0)}catch{console.log('?')}" 2>/dev/null)
    echo "  $legacy — failures: $FAILED" >> "$LOG"
    if [ "$FAILED" != "?" ] && [ "$FAILED" -gt 0 ] 2>/dev/null; then
      TOTAL_ISSUES=$((TOTAL_ISSUES + FAILED))
    fi
  fi
done

echo "" >> "$LOG"
echo "TOTAL ISSUES ACROSS ALL AGENTS: $TOTAL_ISSUES" >> "$LOG"

# ── Phase 2: Post summary to Stickies ────────────────────────────────────

echo "" >> "$LOG"
echo "PHASE 2: Posting to Stickies" >> "$LOG"

STICKIES_API_URL="${STICKIES_API_URL:-http://localhost:4444}"
STICKIES_API_TOKEN="${STICKIES_API_TOKEN:-}"

SUMMARY_BODY="# Snow Agent Summary\n\nTimestamp: $TIMESTAMP\nTotal issues: $TOTAL_ISSUES\n\n## Agent Reports\n\n$(echo -e "$REPORT")"

curl -s -X POST "$STICKIES_API_URL/api/notes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $STICKIES_API_TOKEN" \
  -d "$(node -e "console.log(JSON.stringify({
    title: '⬡ Snow Agent Report — $(date +%Y-%m-%d)',
    content: $(echo -e "$SUMMARY_BODY" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.stringify(d))"),
    path: '/AI/Reports',
    type: 'markdown',
    tags: ['agent','snow','report'],
    color: '#1C1C1E'
  }))")" >> "$LOG" 2>&1

echo "  Posted to Stickies" >> "$LOG"

# ── Phase 3: Auto-fix (if issues found) ──────────────────────────────────

if [ $TOTAL_ISSUES -gt 0 ]; then
  echo "" >> "$LOG"
  echo "PHASE 3: Scanning logs for fixable issues" >> "$LOG"

  # Check for down apps
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

  DOWN_APPS=()
  for entry in "${APPS[@]}"; do
    IFS='|' read -r name port dir <<< "$entry"
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port/" 2>/dev/null)
    if [ "$CODE" != "200" ] && [ "$CODE" != "304" ]; then
      DOWN_APPS+=("$name|$port|$dir")
      echo "  ✗ $name is DOWN ($CODE) — queuing for fix" >> "$LOG"
    fi
  done

  # Deploy Claude agents for down apps
  if [ ${#DOWN_APPS[@]} -gt 0 ]; then
    echo "" >> "$LOG"
    echo "  Deploying ${#DOWN_APPS[@]} fix agent(s)..." >> "$LOG"

    for entry in "${DOWN_APPS[@]}"; do
      IFS='|' read -r name port dir <<< "$entry"
      AGENT_LOG="/tmp/snow-fix-${name}.log"

      cd "$dir" 2>/dev/null || continue

      ERROR_LOG=$(cat /tmp/${name}.log 2>/dev/null | tail -30)

      claude -p \
        --dangerously-skip-permissions \
        --max-budget-usd 0.50 \
        --allowedTools "Bash Edit Read Write Glob Grep" \
        "You are Snow, the orchestrator agent. App '$name' on port $port is DOWN.

Working directory: $dir

Recent error log:
\`\`\`
$ERROR_LOG
\`\`\`

Fix the app:
1. Check /tmp/${name}.log for errors
2. Check if node_modules exists, if not run npm install
3. Check for TypeScript errors: npm run typecheck
4. Check for .next/cache corruption and clear if needed
5. Try restarting: launchctl unload ~/Library/LaunchAgents/com.bheng.${name}.plist && launchctl load ~/Library/LaunchAgents/com.bheng.${name}.plist
6. Verify it comes back up

Keep changes minimal. Do not push." \
        > "$AGENT_LOG" 2>&1 &

      echo "  ↻ Agent launched for $name (PID $!)" >> "$LOG"
    done

    wait
    echo "  All fix agents completed" >> "$LOG"
  fi
else
  echo "" >> "$LOG"
  echo "PHASE 3: No issues — skipping auto-fix" >> "$LOG"
fi

echo "" >> "$LOG"
echo "FINAL: $TOTAL_ISSUES total issues across all agents" >> "$LOG"
echo "========================================" >> "$LOG"

cat > /tmp/agent-snow-summary.json << ENDJSON
{
  "agent": "snow",
  "timestamp": "$TIMESTAMP",
  "total_issues": $TOTAL_ISSUES
}
ENDJSON

exit 0
