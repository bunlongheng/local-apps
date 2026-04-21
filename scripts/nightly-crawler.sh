#!/bin/bash
# Nightly Link Crawler - 1:30 AM
# Phase 1: Restart down apps
# Phase 2: Crawl all pages, screenshot errors
# Phase 3: Deploy Claude Code agents to fix page errors
# Only runs on HUB machines

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROLE_FILE="$SCRIPT_DIR/../machine-role.json"
ROLE="hub"
[ -f "$ROLE_FILE" ] && ROLE=$(python3 -c "import json; print(json.load(open('$ROLE_FILE')).get('role','hub'))" 2>/dev/null || echo "hub")

if [ "$ROLE" = "agent" ]; then
  echo "$(date) - Skipped: machine role is AGENT" >> /tmp/link-crawler.log
  exit 0
fi

export PATH="$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LOG="/tmp/link-crawler.log"

echo "========================================" >> "$LOG"
echo "Link Crawler - $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
echo "========================================" >> "$LOG"

cd $HOME/Sites/local-apps

# App paths lookup
declare -A APP_PATHS
APP_PATHS=(
  [bheng]="$HOME/Sites/bheng"
  [tools]="$HOME/Sites/tools"
  [diagrams]="$HOME/Sites/diagrams"
  [claude]="$HOME/Sites/claude"
  [stickies]="$HOME/Sites/stickies"
  [mindmaps]="$HOME/Sites/mindmaps"
  [safe]="$HOME/Sites/safe"
  [drop]="$HOME/Sites/drop"
  [audit]="$HOME/Sites/audit"
  [workflows]="$HOME/Sites/workflows"
  [system-design]="$HOME/Sites/system-design"
)

# ── Phase 1: Restart down apps ──────────────────────────────────────────────

echo "  Phase 1: restarting down apps..." >> "$LOG"
  IFS=':' read -r name port <<< "$pair"
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$port/" 2>/dev/null)
  if [ "$code" = "000" ] || [ "$code" -ge 500 ]; then
    echo "    $name (:$port) down ($code), restarting..." >> "$LOG"
    lsof -ti :"$port" 2>/dev/null | xargs kill -9 2>/dev/null
    rm -f "${APP_PATHS[$name]}/.next/dev/lock" 2>/dev/null
    launchctl stop "com.bheng.$name" 2>/dev/null
    sleep 1
    launchctl start "com.bheng.$name" 2>/dev/null
  fi
done
sleep 15

# ── Phase 2: Crawl all pages ────────────────────────────────────────────────

echo "  Phase 2: crawling..." >> "$LOG"
node scripts/link-crawler.js >> "$LOG" 2>&1

# ── Phase 3: Deploy agents to fix page errors ───────────────────────────────

SUMMARY="/tmp/link-crawler-summary.json"
if [ ! -f "$SUMMARY" ]; then
  echo "  No summary file, skipping Phase 3" >> "$LOG"
  exit 0
fi

# Extract apps with errors
FAILED_APPS=$(python3 -c "
import json
d = json.load(open('$SUMMARY'))
for r in d.get('results', []):
    errors = [e for e in r.get('errors', []) if e.get('type') in ('page-error', 'crash', 'http')]
    if errors:
        urls = ', '.join(e.get('url', '') for e in errors[:5])
        print(f\"{r['id']}|{urls}\")
" 2>/dev/null)

if [ -z "$FAILED_APPS" ]; then
  echo "  Phase 3: no page errors to fix" >> "$LOG"
  echo "Done: $(date '+%H:%M:%S')" >> "$LOG"
  exit 0
fi

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "Phase 3: Deploying agents to fix page errors" >> "$LOG"
echo "========================================" >> "$LOG"

AGENT_PIDS=()
AGENT_NAMES=()

while IFS='|' read -r name urls; do
  dir="${APP_PATHS[$name]}"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "  SKIP $name - no path found" >> "$LOG"
    continue
  fi

  AGENT_LOG="/tmp/crawler-fix-${name}.log"
  echo "  Agent for $name ($urls)..." >> "$LOG"

  claude -p \
    --dangerously-skip-permissions \
    --max-budget-usd 1.00 \
    --allowedTools "Bash Edit Read Write Glob Grep" \
    "You are an automated fix agent for the app '$name' at $dir.

The link crawler found page errors on these URLs:
$urls

Your task:
1. Visit each failing URL with curl to confirm the error
2. Check the app log at /tmp/${name}.log for related errors
3. Read the page source code for those routes
4. Fix the root cause (missing data, broken imports, unhandled errors, etc.)
5. Run npm test to make sure you didn't break anything
6. Verify the pages now load without errors
7. If you fixed code, run: git add -A && git commit -m 'fix: resolve page errors found by crawler' && git push

Common page errors:
- Hydration mismatch: Date.now() or window checks in SSR components
- Missing env vars: API keys not set locally
- Broken imports: renamed files or moved components
- Unhandled null: data not loaded, missing null checks
- Timeout: slow API calls, missing loading states

Rules:
- Do NOT delete pages or routes
- Keep fixes minimal
- Max 3 attempts
- If a page error is caused by missing external data (API key, database), just add a graceful fallback instead of crashing" \
    > "$AGENT_LOG" 2>&1 &

  AGENT_PIDS+=($!)
  AGENT_NAMES+=("$name")
done <<< "$FAILED_APPS"

# Wait for all agents
FIXED=0
for i in "${!AGENT_PIDS[@]}"; do
  wait "${AGENT_PIDS[$i]}"
  name="${AGENT_NAMES[$i]}"
  echo "  Agent $name finished" >> "$LOG"
  FIXED=$((FIXED + 1))
done

echo "" >> "$LOG"
echo "Phase 3: $FIXED agent(s) deployed" >> "$LOG"
echo "Done: $(date '+%H:%M:%S')" >> "$LOG"
