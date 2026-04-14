#!/bin/bash
# Deep Audit - 4 AM daily
# Catches and fixes infrastructure issues that quick health checks miss
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/deep-audit.log
  exit 0
fi

LOG="/tmp/deep-audit.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=0
FIXED=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "Deep Audit - $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

APPS=(
  "bheng|3000|$HOME/Sites/bheng"
  "tools|3001|$HOME/Sites/tools"
  "diagrams|3002|$HOME/Sites/diagrams"
  "claude|3003|$HOME/Sites/claude"
  "3pi|3333|$HOME/Sites/3pi"
  "3pi-poc|3334|$HOME/Sites/3pi-poc"
  "stickies|4444|$HOME/Sites/stickies"
  "vault|4445|$HOME/Sites/vault"
  "mindmaps|5173|$HOME/Sites/mindmaps"
  "safe|6100|$HOME/Sites/safe"
  "drop-web|3010|$HOME/Sites/drop"
)

# ── Check 1: Turbopack/Next.js cache corruption ─────────────────────────────

echo "" >> "$LOG"
echo "CHECK 1: Turbopack cache health" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"
  NEXT_DIR="$dir/.next"

  if [ -d "$NEXT_DIR" ]; then
    # Check for corrupted SST files (Turbopack persistence)
    CORRUPT=$(find "$NEXT_DIR" -name "*.sst" -size 0 2>/dev/null | wc -l | tr -d ' ')
    if [ "$CORRUPT" -gt 0 ]; then
      echo "  FIX $name - $CORRUPT empty SST files, clearing .next cache" >> "$LOG"
      rm -rf "$NEXT_DIR"
      FIXED=$((FIXED + 1))
    fi

    # Check for stale lock files
    if [ -f "$NEXT_DIR/dev/lock" ]; then
      LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$NEXT_DIR/dev/lock" 2>/dev/null || echo 0) ))
      if [ "$LOCK_AGE" -gt 300 ]; then
        echo "  FIX $name - stale .next/dev/lock (${LOCK_AGE}s old), removing" >> "$LOG"
        rm -f "$NEXT_DIR/dev/lock"
        FIXED=$((FIXED + 1))
      fi
    fi

    # Check cache size (warn if > 2GB)
    CACHE_SIZE=$(du -sm "$NEXT_DIR" 2>/dev/null | cut -f1)
    if [ "${CACHE_SIZE:-0}" -gt 2000 ]; then
      echo "  WARN $name - .next cache is ${CACHE_SIZE}MB, clearing" >> "$LOG"
      rm -rf "$NEXT_DIR"
      FIXED=$((FIXED + 1))
    fi
  fi
done

# ── Check 2: Native module compatibility ─────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 2: Native modules (better-sqlite3, sharp)" >> "$LOG"

NODE_VER=$(node -v)
for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  for mod in better-sqlite3 sharp; do
    MOD_DIR="$dir/node_modules/$mod"
    if [ -d "$MOD_DIR" ]; then
      # Try to require it - if it fails, rebuild
      RESULT=$(cd "$dir" && node -e "try{require('$mod');console.log('ok')}catch(e){console.log(e.code||'fail')}" 2>&1)
      if [ "$RESULT" != "ok" ]; then
        echo "  FIX $name - $mod broken ($RESULT), rebuilding + clearing .next" >> "$LOG"
        cd "$dir" && npm rebuild "$mod" >> "$LOG" 2>&1
        rm -rf "$dir/.next" "$dir/node_modules/.cache" 2>/dev/null
        FIXED=$((FIXED + 1))
      fi
    fi
  done
done

# ── Check 3: Port conflicts ──────────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 3: Port conflicts" >> "$LOG"

declare -A PORT_OWNER
for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  PIDS=$(lsof -ti :"$port" 2>/dev/null)
  PID_COUNT=$(echo "$PIDS" | grep -c '[0-9]' 2>/dev/null || echo 0)

  if [ "$PID_COUNT" -gt 5 ]; then
    echo "  WARN $name - $PID_COUNT processes on port $port, possible leak" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi

  if [ -n "${PORT_OWNER[$port]}" ]; then
    echo "  BUG port $port claimed by both ${PORT_OWNER[$port]} and $name" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi
  PORT_OWNER[$port]="$name"
done

# ── Check 4: Disk space ──────────────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 4: Disk space" >> "$LOG"

DISK_FREE=$(df -g / | tail -1 | awk '{print $4}')
echo "  Free: ${DISK_FREE}GB" >> "$LOG"
if [ "$DISK_FREE" -lt 10 ]; then
  echo "  WARN Low disk space (${DISK_FREE}GB free)" >> "$LOG"
  # Clean node_modules caches
  for entry in "${APPS[@]}"; do
    IFS='|' read -r name port dir <<< "$entry"
    rm -rf "$dir/.next/cache" 2>/dev/null
  done
  echo "  FIX Cleared .next/cache dirs" >> "$LOG"
  FIXED=$((FIXED + 1))
fi

# ── Check 5: Caddy health ────────────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 5: Caddy" >> "$LOG"

if ! pgrep -q caddy 2>/dev/null; then
  echo "  FIX Caddy not running, starting..." >> "$LOG"
  caddy start --config /opt/homebrew/etc/Caddyfile --adapter caddyfile >> "$LOG" 2>&1
  if [ $? -ne 0 ]; then
    echo "  BUG Caddy failed to start - config error" >> "$LOG"
    caddy validate --config /opt/homebrew/etc/Caddyfile --adapter caddyfile >> "$LOG" 2>&1
    ISSUES=$((ISSUES + 1))
  else
    FIXED=$((FIXED + 1))
  fi
else
  echo "  OK Caddy running" >> "$LOG"
fi

# ── Check 6: Restart any apps that were fixed ────────────────────────────────

if [ "$FIXED" -gt 0 ]; then
  echo "" >> "$LOG"
  echo "RESTARTING fixed apps..." >> "$LOG"

  for entry in "${APPS[@]}"; do
    IFS='|' read -r name port dir <<< "$entry"
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
    if [ "$code" = "000" ] || [ "$code" -ge 400 ]; then
      echo "  Restarting $name (was $code)..." >> "$LOG"
      lsof -ti :"$port" 2>/dev/null | xargs kill -9 2>/dev/null
      sleep 1
      rm -f "$dir/.next/dev/lock" 2>/dev/null
      launchctl stop "com.bheng.$name" 2>/dev/null
      sleep 1
      launchctl start "com.bheng.$name" 2>/dev/null
    fi
  done

  # Wait and verify
  sleep 15
  echo "" >> "$LOG"
  echo "POST-FIX STATUS:" >> "$LOG"
  for entry in "${APPS[@]}"; do
    IFS='|' read -r name port dir <<< "$entry"
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
    status="UP"
    [ "$code" = "000" ] || [ "$code" -ge 400 ] && status="DOWN"
    echo "  $status $name (:$port) - $code" >> "$LOG"
  done
fi

# ── Check 7: App log errors (last 24h) ───────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 7: App log errors (last 24h)" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"
  LOGFILE="/tmp/${name}.log"
  if [ -f "$LOGFILE" ]; then
    ERRORS=$(grep -ci "error\|crash\|panic\|EADDRINUSE\|ENOENT\|MODULE_VERSION" "$LOGFILE" 2>/dev/null || echo 0)
    if [ "$ERRORS" -gt 0 ]; then
      echo "  WARN $name - $ERRORS error(s) in log" >> "$LOG"
      grep -i "error\|crash\|panic" "$LOGFILE" | tail -3 >> "$LOG"
    fi
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "SUMMARY: $FIXED fixed, $ISSUES unresolved issues" >> "$LOG"
echo "========================================" >> "$LOG"

# Save to JSON
cat > /tmp/deep-audit-summary.json << ENDJSON
{
  "timestamp": "$TIMESTAMP",
  "fixed": $FIXED,
  "issues": $ISSUES
}
ENDJSON

# Post to stickies if there were issues
if [ "$ISSUES" -gt 0 ] || [ "$FIXED" -gt 0 ]; then
  source ~/.zshrc 2>/dev/null
  SUMMARY="Deep Audit $TIMESTAMP: $FIXED fixed, $ISSUES unresolved"
  if command -v stickies &>/dev/null; then
    tail -30 "$LOG" | stickies --title="$SUMMARY" --tags=audit,infra --path=/Reporting 2>/dev/null || true
  fi
fi

exit $ISSUES
