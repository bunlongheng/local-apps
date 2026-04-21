#!/bin/bash
# 🔥 Blaze Agent — SEO Check + Documentation Audit
# Runs at 10 AM and 10 PM daily
# Validates meta tags, OG images, README/CLAUDE.md freshness

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/agent-blaze.log
  exit 0
fi

LOG="/tmp/agent-blaze.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
ISSUES=0

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "========================================" >> "$LOG"
echo "🔥 Blaze — SEO & Docs — $TIMESTAMP" >> "$LOG"
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

# ── Check 1: Meta Tags & SEO ─────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 1: SEO Meta Tags" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  HTML=$(curl -s --max-time 5 "http://localhost:$port/" 2>/dev/null)

  if [ -z "$HTML" ]; then
    echo "  ✗ $name — not reachable" >> "$LOG"
    ISSUES=$((ISSUES + 1))
    continue
  fi

  HAS_TITLE=$(echo "$HTML" | grep -c '<title>' 2>/dev/null)
  HAS_DESC=$(echo "$HTML" | grep -ci 'meta.*description' 2>/dev/null)
  HAS_VIEWPORT=$(echo "$HTML" | grep -ci 'meta.*viewport' 2>/dev/null)
  HAS_OG=$(echo "$HTML" | grep -ci 'og:title\|og:description\|og:image' 2>/dev/null)

  STATUS=""
  if [ "$HAS_TITLE" -gt 0 ]; then STATUS="$STATUS title"; fi
  if [ "$HAS_DESC" -gt 0 ]; then STATUS="$STATUS desc"; fi
  if [ "$HAS_VIEWPORT" -gt 0 ]; then STATUS="$STATUS viewport"; fi
  if [ "$HAS_OG" -gt 0 ]; then STATUS="$STATUS og"; fi

  MISSING=""
  if [ "$HAS_TITLE" -eq 0 ]; then MISSING="$MISSING title"; fi
  if [ "$HAS_DESC" -eq 0 ]; then MISSING="$MISSING desc"; fi
  if [ "$HAS_VIEWPORT" -eq 0 ]; then MISSING="$MISSING viewport"; fi

  if [ -z "$MISSING" ]; then
    echo "  ✓ $name —$STATUS" >> "$LOG"
  else
    echo "  ⚠ $name — missing:$MISSING" >> "$LOG"
    ISSUES=$((ISSUES + 1))
  fi
done

# ── Check 2: Documentation Freshness ─────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 2: Documentation" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  HAS_README="✗"
  HAS_CLAUDE="✗"
  HAS_PKG_DESC="✗"

  [ -f "$dir/README.md" ] && HAS_README="✓"
  [ -f "$dir/.claude/instructions.md" ] || [ -f "$dir/CLAUDE.md" ] && HAS_CLAUDE="✓"

  PKG_DESC=$(node -e "try{const p=require('$dir/package.json');console.log(p.description||'')}catch{}" 2>/dev/null)
  [ -n "$PKG_DESC" ] && HAS_PKG_DESC="✓"

  if [ "$HAS_README" = "✗" ]; then ISSUES=$((ISSUES + 1)); fi

  echo "  $name — README:$HAS_README CLAUDE.md:$HAS_CLAUDE pkg.desc:$HAS_PKG_DESC" >> "$LOG"
done

# ── Check 3: Git repo health ─────────────────────────────────────────────

echo "" >> "$LOG"
echo "CHECK 3: Git Health" >> "$LOG"

for entry in "${APPS[@]}"; do
  IFS='|' read -r name port dir <<< "$entry"

  if [ ! -d "$dir/.git" ]; then
    echo "  ✗ $name — not a git repo" >> "$LOG"
    ISSUES=$((ISSUES + 1))
    continue
  fi

  cd "$dir"
  BRANCH=$(git branch --show-current 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  AHEAD=$(git rev-list --count HEAD@{upstream}..HEAD 2>/dev/null || echo "?")

  echo "  $name — branch:$BRANCH dirty:$DIRTY ahead:$AHEAD" >> "$LOG"
done

echo "" >> "$LOG"
echo "SUMMARY: $ISSUES issues found" >> "$LOG"
echo "========================================" >> "$LOG"

cat > /tmp/agent-blaze-summary.json << ENDJSON
{
  "agent": "blaze",
  "timestamp": "$TIMESTAMP",
  "issues": $ISSUES
}
ENDJSON

exit 0
