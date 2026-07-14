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

APPS=()
while IFS= read -r line; do APPS+=("$line"); done < <(curl -s "http://localhost:9876/api/apps" | jq -r '.[] | select(.localPath) | "\(.id)|\(.localUrl|split(":")|last)|\(.localPath)"' 2>/dev/null)

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
  PID_COUNT=$(echo "$PIDS" | grep -c '[0-9]' 2>/dev/null | head -1)
  PID_COUNT=${PID_COUNT:-0}

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
      launchctl stop "com.local-apps.$name" 2>/dev/null
      sleep 1
      launchctl start "com.local-apps.$name" 2>/dev/null
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
    ERRORS=$(grep -ci "error\|crash\|panic\|EADDRINUSE\|ENOENT\|MODULE_VERSION" "$LOGFILE" 2>/dev/null | head -1)
    ERRORS=${ERRORS:-0}
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

# Post a self-contained HTML report to Stickies if there were issues or fixes.
# HTML (not text/markdown) is required by the Stickies API; inline styles only
# because <style> blocks get stripped. Title is plain text (no emoji).
if [ "$ISSUES" -gt 0 ] || [ "$FIXED" -gt 0 ]; then
  source ~/.zshrc 2>/dev/null

  HTML_FILE=$(mktemp /tmp/deep-audit-XXXXXX.html)
  HOST_SHORT=$(hostname -s)

  # Pull just THIS run's lines from the accumulating log.
  RUN_SECTION=$(awk -v marker="Deep Audit - $TIMESTAMP" 'index($0,marker){p=1} p' "$LOG")

  # Color the summary pills by status.
  if [ "$ISSUES" -gt 0 ]; then PILL_BG="#fee2e2"; PILL_FG="#991b1b"; else PILL_BG="#dcfce7"; PILL_FG="#166534"; fi
  if [ "$FIXED"  -gt 0 ]; then FIX_BG="#dbeafe";  FIX_FG="#1e40af";  else FIX_BG="#f1f5f9";  FIX_FG="#475569";  fi

  # Render one section card: heading line + every line in $LOG between it and
  # the next "CHECK N:" / divider, as a small table with colored WARN/FIX/BUG/OK chips.
  build_section() {
    local heading="$1"
    local body
    body=$(printf '%s\n' "$RUN_SECTION" | awk -v h="$heading" '
      $0 == h { p=1; next }
      p && (/^CHECK [0-9]+:/ || /^RESTARTING/ || /^POST-FIX STATUS:/ || /^=====/) { p=0 }
      p && NF { print }')
    [ -z "$body" ] && return

    printf '  <div style="padding:14px 16px;border-bottom:1px solid #e2e8f0">\n'
    printf '    <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:10px">%s</div>\n' "$heading"
    printf '    <table style="width:100%%;border-collapse:collapse;font-size:14px">\n'

    printf '%s\n' "$body" | while IFS= read -r line; do
      [ -z "$line" ] && continue
      # Escape HTML special chars in the message.
      safe=$(printf '%s' "$line" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
      # Strip leading whitespace and a known tag token.
      token=$(printf '%s' "$safe" | sed -E 's/^[[:space:]]+//' | awk '{print $1}')
      msg=$(printf '%s' "$safe" | sed -E 's/^[[:space:]]+//; s/^(WARN|FIX|BUG|OK|UP|DOWN)[[:space:]]+//')
      case "$token" in
        WARN) chip="background:#fef3c7;color:#92400e" ;;
        FIX)  chip="background:#dbeafe;color:#1e40af" ;;
        BUG)  chip="background:#fee2e2;color:#991b1b" ;;
        OK|UP) chip="background:#dcfce7;color:#166534" ;;
        DOWN) chip="background:#fee2e2;color:#991b1b" ;;
        *)    chip="" ;;
      esac
      if [ -n "$chip" ]; then
        printf '      <tr><td style="padding:5px 0;width:64px;vertical-align:top"><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-weight:600;font-size:11px;%s">%s</span></td><td style="padding:5px 0 5px 10px;color:#1a1a1a">%s</td></tr>\n' "$chip" "$token" "$msg"
      else
        printf '      <tr><td colspan="2" style="padding:4px 0;color:#64748b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">%s</td></tr>\n' "$safe"
      fi
    done

    printf '    </table>\n  </div>\n'
  }

  {
    cat <<HTMLHEAD
<div style="font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:100%;color:#1a1a1a;font-size:15px;line-height:1.5;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
  <div style="background:#0f172a;color:#ffffff;padding:18px 18px 16px">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="flex:none;display:inline-flex;width:36px;height:36px;align-items:center;justify-content:center;background:rgba(255,255,255,.12);border-radius:9px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
      </span>
      <div>
        <div style="font-size:19px;font-weight:700;letter-spacing:-.01em">Deep Audit</div>
        <div style="opacity:.75;font-size:13px;margin-top:3px">$TIMESTAMP &middot; $HOST_SHORT</div>
      </div>
    </div>
  </div>
  <div style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0">
    <span style="display:inline-block;background:$FIX_BG;color:$FIX_FG;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600;margin-right:6px">$FIXED fixed</span>
    <span style="display:inline-block;background:$PILL_BG;color:$PILL_FG;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600">$ISSUES unresolved</span>
  </div>
HTMLHEAD

    build_section "CHECK 1: Turbopack cache health"
    build_section "CHECK 2: Native modules (better-sqlite3, sharp)"
    build_section "CHECK 3: Port conflicts"
    build_section "CHECK 4: Disk space"
    build_section "CHECK 5: Caddy"
    build_section "POST-FIX STATUS:"
    build_section "CHECK 7: App log errors (last 24h)"

    cat <<HTMLFOOT
  <div style="padding:10px 16px;background:#f8fafc;color:#94a3b8;font-size:11px;text-align:center;border-top:1px solid #e2e8f0">deep-audit.sh &middot; launchd com.local-apps.deep-audit &middot; 04:00 daily</div>
</div>
HTMLFOOT
  } > "$HTML_FILE"

  SUMMARY="$HOST_SHORT Deep Audit - $FIXED fixed, $ISSUES unresolved"

  # Sourcing .zshrc above gives us STICKIES_API_URL / _TOKEN, but it also
  # shifts $PATH so the wrong "stickies" wins (the subcommand-style one in
  # ~/.local/bin). Pin to the stickies-cli that supports --file=.
  STICKIES_BIN="$HOME/.nvm/versions/node/v20.19.5/bin/stickies"
  [ -x "$STICKIES_BIN" ] || STICKIES_BIN=$(ls "$HOME"/.nvm/versions/node/*/bin/stickies 2>/dev/null | head -1)

  if [ -x "$STICKIES_BIN" ]; then
    "$STICKIES_BIN" --title="$SUMMARY" --type=html --tags=audit,infra --path=/Reporting --file="$HTML_FILE" 2>/dev/null || true
  fi
  rm -f "$HTML_FILE"
fi

exit $ISSUES
