#!/bin/bash
# Health Check & Auto-Fix — ensures all apps are running
# Deploys Claude Code agents to diagnose and fix any down apps
# Can be run manually or via cron
# Only runs on HUB machines — agents skip silently

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) — Skipped: machine role is AGENT (bots disabled)" >> /tmp/health-check-fix.log
  exit 0
fi

LOG="/tmp/health-check-fix.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
PASS=0
FAIL=0
FIXED=0
TOTAL=0
FAILED_APPS=()

export PATH="/Users/bheng/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "Health Check & Fix — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

# ── Step 1: Ensure infrastructure is up ──────────────────────────────────────

# Check local-apps monitor
if ! curl -s -o /dev/null -w "" --max-time 3 http://localhost:9876/api/status 2>/dev/null; then
  echo "  ↻ Starting local-apps monitor..." >> "$LOG"
  cd /Users/bheng/Sites/local-apps
  node server.js > /tmp/local-apps.log 2>&1 &
  sleep 3
fi

# Check Caddy
if ! pgrep -q caddy 2>/dev/null; then
  echo "  ↻ Starting Caddy..." >> "$LOG"
  caddy start --config /opt/homebrew/etc/Caddyfile --adapter caddyfile 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "  ✗ Caddy failed to start — config error" >> "$LOG"
    # Try to validate and report
    caddy validate --config /opt/homebrew/etc/Caddyfile --adapter caddyfile >> "$LOG" 2>&1
  fi
fi

# ── Step 2: Check all apps ───────────────────────────────────────────────────

APPS=(
  "bheng|3000|/Users/bheng/Sites/bheng|http"
  "tools|3001|/Users/bheng/Sites/tools|http"
  "diagrams|3002|/Users/bheng/Sites/diagrams|http"
  "claude|3003|/Users/bheng/Sites/claude|http"
  "3pi|3333|/Users/bheng/Sites/3pi|http"
  "3pi-poc|3334|/Users/bheng/Sites/3pi-poc|http"
  "stickies|4444|/Users/bheng/Sites/stickies|http"
  "vault|4445|/Users/bheng/Sites/vault|http"
  "mindmaps|5173|/Users/bheng/Sites/mindmaps|http"
  "safe|6100|/Users/bheng/Sites/safe|http"
  "drop-web|3010|/Users/bheng/Sites/drop|http"
  "drop-menu|0|/Users/bheng/Sites/drop/electron|process:drop/electron"
  "ai-spinner|0|/Users/bheng/Sites/streamdeck|process:streamdeck"
)

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir check_type <<< "$entry"
  TOTAL=$((TOTAL + 1))

  UP=false
  if [[ "$check_type" == http ]]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
    [[ "$code" =~ ^[1-4] ]] && UP=true
  elif [[ "$check_type" == process:* ]]; then
    proc="${check_type#process:}"
    pgrep -f "$proc" > /dev/null 2>&1 && UP=true
  fi

  if $UP; then
    echo "  ✓ $name" >> "$LOG"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (port $port) — DOWN" >> "$LOG"
    FAIL=$((FAIL + 1))
    FAILED_APPS+=("$name|$port|$dir|$check_type")
  fi
done

echo "" >> "$LOG"
echo "Phase 1: $PASS/$TOTAL up, $FAIL down" >> "$LOG"

# ── Step 3: Quick fixes (before deploying agents) ────────────────────────────

STILL_FAILED=()

for entry in "${FAILED_APPS[@]}"; do
  IFS='|' read -r name port dir check_type <<< "$entry"
  echo "" >> "$LOG"
  echo "  ↻ Attempting quick fix for $name..." >> "$LOG"

  # Clear stale Next.js lock
  rm -f "$dir/.next/dev/lock" 2>/dev/null

  # Kill stale process on port
  if [ "$port" != "0" ]; then
    lsof -ti :"$port" 2>/dev/null | xargs kill -9 2>/dev/null
    sleep 1
  fi

  # Restart via launchctl
  launchctl stop "com.bheng.$name" 2>/dev/null
  sleep 1
  launchctl start "com.bheng.$name" 2>/dev/null
  sleep 8

  # Re-check
  UP=false
  if [[ "$check_type" == http ]]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
    [[ "$code" =~ ^[1-4] ]] && UP=true
  elif [[ "$check_type" == process:* ]]; then
    proc="${check_type#process:}"
    pgrep -f "$proc" > /dev/null 2>&1 && UP=true
  fi

  if $UP; then
    echo "  ✓ $name — quick fix worked" >> "$LOG"
    FIXED=$((FIXED + 1))
  else
    echo "  ✗ $name — still down, needs agent" >> "$LOG"
    STILL_FAILED+=("$name|$port|$dir|$check_type")
  fi
done

# ── Step 4: Deploy Claude Code agents for stubborn failures ──────────────────

if [ ${#STILL_FAILED[@]} -gt 0 ]; then
  echo "" >> "$LOG"
  echo "========================================" >> "$LOG"
  echo "Deploying Claude Code agents for ${#STILL_FAILED[@]} app(s)" >> "$LOG"
  echo "========================================" >> "$LOG"

  AGENT_PIDS=()
  AGENT_NAMES=()
  AGENT_DIRS=()
  AGENT_PORTS=()

  for entry in "${STILL_FAILED[@]}"; do
    IFS='|' read -r name port dir check_type <<< "$entry"
    AGENT_LOG="/tmp/health-fix-${name}.log"

    echo "  ↻ Agent for $name..." >> "$LOG"

    # Gather diagnostics
    DIAG=""
    [ -f "/tmp/${name}.log" ] && DIAG="App log (last 30 lines):\n$(tail -30 /tmp/${name}.log 2>/dev/null)"
    PLIST_INFO=""
    [ -f "$HOME/Library/LaunchAgents/com.bheng.${name}.plist" ] && PLIST_INFO="$(cat $HOME/Library/LaunchAgents/com.bheng.${name}.plist)"

    claude -p \
      --dangerously-skip-permissions \
      --max-budget-usd 1.00 \
      --allowedTools "Bash Edit Read Write Glob Grep" \
      "You are an automated health-fix agent for the app '$name' at $dir (port $port).

The app is DOWN and quick fixes (kill stale process, clear lock, launchctl restart) did not work.

Diagnostics:
$DIAG

LaunchAgent plist:
$PLIST_INFO

Your task:
1. Check /tmp/${name}.log for crash errors
2. Check if the app's dependencies are installed (node_modules exists)
3. Check if there's a port conflict: lsof -i :${port}
4. Check for native module issues (better-sqlite3, sharp, etc.) — run npm rebuild if needed
5. Check package.json dev script has the correct port
6. Fix whatever is preventing the app from starting
7. Start the app and verify it responds on port $port
8. If you changed code, commit and push with message 'fix: auto-fix app startup ($name)'

Common issues:
- 'Another next dev server is already running' → rm .next/dev/lock, kill stale PID
- NODE_MODULE_VERSION mismatch → npm rebuild
- Missing node_modules → npm install
- Wrong port in dev script → fix package.json
- Permission denied → check file ownership

Rules:
- Do NOT change app functionality
- Keep fixes minimal
- Max 3 attempts" \
      > "$AGENT_LOG" 2>&1 &

    AGENT_PIDS+=($!)
    AGENT_NAMES+=("$name")
    AGENT_DIRS+=("$dir")
    AGENT_PORTS+=("$port")
  done

  # Wait for all agents
  for i in "${!AGENT_PIDS[@]}"; do
    pid="${AGENT_PIDS[$i]}"
    name="${AGENT_NAMES[$i]}"
    port="${AGENT_PORTS[$i]}"
    dir="${AGENT_DIRS[$i]}"

    wait "$pid"

    # Re-check
    UP=false
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
    [[ "$code" =~ ^[1-4] ]] && UP=true

    if $UP; then
      echo "  ✓ $name — FIXED by agent" >> "$LOG"
      FIXED=$((FIXED + 1))
    else
      echo "  ✗ $name — agent could not fix" >> "$LOG"
      echo "    See: /tmp/health-fix-${name}.log" >> "$LOG"
    fi
  done
fi

# ── Final summary ────────────────────────────────────────────────────────────

FINAL_FAIL=$((FAIL - FIXED))
FINAL_PASS=$((PASS + FIXED))

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "FINAL: $FINAL_PASS/$TOTAL up, $FINAL_FAIL down, $FIXED fixed" >> "$LOG"
echo "========================================" >> "$LOG"

cat > /tmp/health-check-summary.json << ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "total": $TOTAL,
  "up": $FINAL_PASS,
  "down": $FINAL_FAIL,
  "fixed": $FIXED
}
ENDJSON

exit $FINAL_FAIL
