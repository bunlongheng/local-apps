#!/bin/bash
# Nightly Security & Performance Scan - 5 AM
# Deploys Claude Code agents to audit each app
# FLAGS issues to stickies - does NOT auto-fix (owner decides)
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/nightly-scan.log
  exit 0
fi

LOG="/tmp/nightly-scan.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "Security & Performance Scan - $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

APPS=(
  "bheng|$HOME/Sites/bheng|3000"
  "tools|$HOME/Sites/tools|3001"
  "diagrams|$HOME/Sites/diagrams|3002"
  "claude|$HOME/Sites/claude|3003"
  "stickies|$HOME/Sites/stickies|4444"
  "mindmaps|$HOME/Sites/mindmaps|5173"
  "safe|$HOME/Sites/safe|6100"
  "drop|$HOME/Sites/drop|3010"
  "audit|$HOME/Sites/audit|3004"
  "workflows|$HOME/Sites/workflows|3005"
  "system-design|$HOME/Sites/system-design|3006"
)

AGENT_PIDS=()
AGENT_NAMES=()
AGENT_LOGS=()

for entry in "${APPS[@]}"; do
  IFS='|' read -r name dir port <<< "$entry"
  AGENT_LOG="/tmp/scan-${name}.log"

  echo "  Launching scan agent for $name..." >> "$LOG"

  claude -p \
    --dangerously-skip-permissions \
    --max-budget-usd 0.50 \
    --allowedTools "Bash Read Glob Grep" \
    "You are a security and performance auditor for the app '$name' at $dir (port $port).

DO NOT FIX ANYTHING. Only scan and report.

SECURITY CHECKS:
1. Scan for hardcoded secrets, API keys, passwords in source files (not .env)
2. Check if .env or .env.local is in .gitignore
3. Check for SQL injection risks (raw queries without parameterization)
4. Check for XSS risks (dangerouslySetInnerHTML without sanitization)
5. Check middleware.ts for auth bypass issues
6. Check API routes for missing auth guards
7. Check for exposed debug endpoints
8. Check package.json for known vulnerable dependency versions

PERFORMANCE CHECKS:
1. Check for large bundle imports (moment.js, lodash full import vs lodash/xxx)
2. Check for missing React.memo, useMemo, useCallback on heavy components
3. Check for N+1 query patterns in API routes
4. Check image optimization (next/image usage vs raw img tags)
5. Check for missing loading states / Suspense boundaries
6. Count total dependencies in package.json

OUTPUT FORMAT (exactly this, one per finding):
FLAG: [security|performance] [high|medium|low] $name - description

End with a summary line:
SUMMARY: $name - X security flags, Y performance flags

Be thorough but concise. Max 20 flags per app." \
    > "$AGENT_LOG" 2>&1 &

  AGENT_PIDS+=($!)
  AGENT_NAMES+=("$name")
  AGENT_LOGS+=("$AGENT_LOG")
done

echo "  Waiting for ${#AGENT_PIDS[@]} agents..." >> "$LOG"

# Wait and collect results
ALL_FLAGS=""
for i in "${!AGENT_PIDS[@]}"; do
  wait "${AGENT_PIDS[$i]}"
  name="${AGENT_NAMES[$i]}"
  agent_log="${AGENT_LOGS[$i]}"

  # Extract flags
  FLAGS=$(grep "^FLAG:" "$agent_log" 2>/dev/null || echo "")
  SUMMARY_LINE=$(grep "^SUMMARY:" "$agent_log" 2>/dev/null || echo "SUMMARY: $name - scan complete")

  echo "" >> "$LOG"
  echo "  $SUMMARY_LINE" >> "$LOG"
  if [ -n "$FLAGS" ]; then
    echo "$FLAGS" >> "$LOG"
    ALL_FLAGS="$ALL_FLAGS\n$FLAGS"
  fi
done

# Count totals
SEC_FLAGS=$(echo -e "$ALL_FLAGS" | grep -c "\[security\]" 2>/dev/null || echo 0)
PERF_FLAGS=$(echo -e "$ALL_FLAGS" | grep -c "\[performance\]" 2>/dev/null || echo 0)
TOTAL_FLAGS=$((SEC_FLAGS + PERF_FLAGS))

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "TOTAL: $SEC_FLAGS security flags, $PERF_FLAGS performance flags" >> "$LOG"
echo "========================================" >> "$LOG"

# Post to stickies
if [ "$TOTAL_FLAGS" -gt 0 ]; then
  source ~/.zshrc 2>/dev/null
  if command -v stickies &>/dev/null; then
    echo -e "# Nightly Scan - $TIMESTAMP\n\n$SEC_FLAGS security flags, $PERF_FLAGS performance flags\n\n$ALL_FLAGS" | \
      stickies --title="Nightly Scan: ${TOTAL_FLAGS} flags" --tags=security,performance,audit --path=/Reporting 2>/dev/null || true
  fi
fi

# Save JSON
cat > /tmp/nightly-scan-summary.json << ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "securityFlags": $SEC_FLAGS,
  "performanceFlags": $PERF_FLAGS,
  "total": $TOTAL_FLAGS
}
ENDJSON

exit 0
