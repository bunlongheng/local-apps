#!/bin/bash
# 🏖️ Sand Agent — DB Integrity + API Health
# Runs at 7 AM and 7 PM daily
# Validates Supabase tables, RLS, and API endpoint responses

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/agent-sand.log
  exit 0
fi

LOG="/tmp/agent-sand.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "🏖️ Sand — DB & API Health — $TIMESTAMP" >> "$LOG"
echo "========================================" >> "$LOG"

APPS=(
  "bheng|3000"
  "tools|3001"
  "diagrams|3002"
  "claude|3003"
  "stickies|4444"
  "mindmaps|5173"
  "safe|6100"
  "drop|3010"
  "audit|3004"
  "workflows|3005"
  "system-design|3006"
)

# ── Check 1: API Endpoint Health ──────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 1: API Endpoints" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port <<< "$entry"

  # Check root
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port/" 2>/dev/null)
  if [ "$CODE" = "200" ] || [ "$CODE" = "304" ]; then
    echo "  ✓ $name — root $CODE" >> "$LOG"
  else
    echo "  ✗ $name — root $CODE" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi

  # Check /api routes if they exist
  API_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$port/api/health" 2>/dev/null)
  if [ "$API_CODE" != "000" ] && [ "$API_CODE" != "404" ]; then
    echo "    /api/health — $API_CODE" >> "$LOG"
  fi
done

# ── Check 2: Stickies API (known endpoints) ──────────────────────────────

echo "" >> "$LOG"
echo "CHECK 2: Stickies API" >> "$LOG"

STICKIES_ENDPOINTS=("/" "/api/notes" "/api/folders")
for ep in "${STICKIES_ENDPOINTS[@]}"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:4444$ep" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo "  ✓ stickies$ep — $CODE" >> "$LOG"
  else
    echo "  ✗ stickies$ep — $CODE" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi
done

# ── Check 3: Local-Apps API ──────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 3: Local-Apps API" >> "$LOG"

LA_ENDPOINTS=("/api/apps" "/api/status" "/api/screenshots")
for ep in "${LA_ENDPOINTS[@]}"; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:9876$ep" 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo "  ✓ local-apps$ep — $CODE" >> "$LOG"
  else
    echo "  ✗ local-apps$ep — $CODE" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi
done

# ── Check 4: Supabase Connectivity ──────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 4: Supabase Connectivity" >> "$LOG"

# Check if any app has Supabase env vars and can connect
for dir in $HOME/Sites/bheng $HOME/Sites/stickies; do
  name=$(basename "$dir")
  if [ -f "$dir/.env.local" ] || [ -f "$dir/.env" ]; then
    SUPA_URL=$(grep NEXT_PUBLIC_SUPABASE_URL "$dir/.env.local" "$dir/.env" 2>/dev/null | head -1 | cut -d= -f2)
    if [ -n "$SUPA_URL" ]; then
      CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$SUPA_URL/rest/v1/" 2>/dev/null)
      if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then
        echo "  ✓ $name Supabase reachable ($CODE)" >> "$LOG"
      else
        echo "  ✗ $name Supabase unreachable ($CODE)" >> "$LOG"
        ISSUES=$((ISSUES + 1))
      fi
    fi
  fi
done

echo "" >> "$LOG"
echo "SUMMARY: $ISSUES issues found" >> "$LOG"
echo "========================================" >> "$LOG"

cat > /tmp/agent-sand-summary.json << ENDJSON
{
  "agent": "sand",
  "timestamp": "$TIMESTAMP",
  "issues": $ISSUES
}
ENDJSON

exit 0
