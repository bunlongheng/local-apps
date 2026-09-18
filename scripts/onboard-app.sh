#!/bin/bash
# Onboard a new app into the local-apps ecosystem
# Usage: ./onboard-app.sh <app-id> <app-name> <local-path> [--color R,G,B] [--dry-run]
#   --dry-run prints the plan (the 9 steps with their resolved arguments) and exits before any side effect.
#
# What it does:
#   1. Create GitHub repo (private)
#   2. Register in local-apps (auto port, Caddy, LaunchAgent)
#   3. Deploy to Vercel (public)
#   4. Generate favicon
#   5. Add shell alias to ~/.claude-tabs.sh
#   6. GitHub repo polish (description, topics, homepage)
#   7. Scaffold vercel.json with ignoreCommand
#   8. Disable Dependabot
#   9. Run npm audit

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

MONITOR="http://localhost:9875"
MONITOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TABS_FILE="$HOME/.claude-tabs.sh"

# --- Args ---
APP_ID="$1"
APP_NAME="$2"
LOCAL_PATH="$3"
COLOR="130,130,130"
DRY_RUN=0

if [ -z "$APP_ID" ] || [ -z "$APP_NAME" ] || [ -z "$LOCAL_PATH" ]; then
  echo -e "${RED}Usage: ./onboard-app.sh <app-id> <app-name> <local-path> [--color R,G,B]${NC}"
  echo "  Example: ./onboard-app.sh my-app \"My App\" \$HOME/Sites/my-app --color 100,200,150"
  exit 1
fi

# Parse optional color flag
shift 3
while [[ $# -gt 0 ]]; do
  case $1 in
    --color) COLOR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done

IFS=',' read -r CR CG CB <<< "$COLOR"

echo -e "\n${CYAN}=== Onboarding: $APP_NAME ($APP_ID) ===${NC}\n"

# --- Dry run: the plan, nothing else ---
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN for $APP_ID ($APP_NAME) at $LOCAL_PATH, color $COLOR, monitor $MONITOR"
  echo "  1. gh repo create bunlongheng/$APP_ID --private"
  echo "  2. POST $MONITOR/api/apps {id: $APP_ID, name: $APP_NAME, localPath: $LOCAL_PATH}"
  echo "  3. vercel deploy from $LOCAL_PATH"
  echo "  4. scaffold $LOCAL_PATH/vercel.json (ignoreCommand)"
  echo "  5. generate favicon -> $MONITOR_DIR/public/favicons/$APP_ID.png"
  echo "  6. tab registry entry $APP_ID ($COLOR) in ~/.claude/tab-colors.json"
  echo "  7. gh repo edit (description, topics, homepage)"
  echo "  8. disable Dependabot"
  echo "  9. npm audit in $LOCAL_PATH"
  exit 0
fi

# --- Checks ---
if [ ! -d "$LOCAL_PATH" ]; then
  echo -e "${RED}Error: $LOCAL_PATH does not exist${NC}"
  exit 1
fi

if ! curl -s "$MONITOR/api/status" > /dev/null 2>&1; then
  echo -e "${RED}Error: local-apps monitor not running at $MONITOR${NC}"
  exit 1
fi

STEP=0
pass() { STEP=$((STEP+1)); echo -e "${GREEN}[$STEP] $1${NC}"; }
skip() { STEP=$((STEP+1)); echo -e "${YELLOW}[$STEP] SKIP: $1${NC}"; }
fail() { STEP=$((STEP+1)); echo -e "${RED}[$STEP] FAIL: $1${NC}"; }

# --- 1. GitHub repo ---
if gh repo view "bunlongheng/$APP_ID" > /dev/null 2>&1; then
  skip "GitHub repo already exists"
else
  cd "$LOCAL_PATH"
  if [ ! -d .git ]; then
    git init && git add -A && git commit -m "feat: initial commit"
  fi
  gh repo create "bunlongheng/$APP_ID" --private --source="$LOCAL_PATH" --push 2>/dev/null \
    && pass "Created GitHub repo (private)" \
    || fail "GitHub repo creation failed"
fi

# --- 2. Register in local-apps ---
EXISTING=$(curl -s "$MONITOR/api/apps/$APP_ID" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ "$EXISTING" = "$APP_ID" ]; then
  skip "Already registered in local-apps"
else
  RESULT=$(curl -s -X POST "$MONITOR/api/apps" \
    -H "Content-Type: application/json" \
    -d "{\"id\":\"$APP_ID\",\"name\":\"$APP_NAME\",\"localPath\":\"$LOCAL_PATH\",\"repo\":\"https://github.com/bunlongheng/$APP_ID\"}")
  PORT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('localUrl','?'))" 2>/dev/null)
  pass "Registered in local-apps ($PORT)"
fi

# --- 3. Vercel deployment ---
cd "$LOCAL_PATH"
if [ -f .vercel/project.json ]; then
  skip "Already linked to Vercel"
else
  if command -v vercel &> /dev/null; then
    vercel link --yes 2>/dev/null && pass "Linked to Vercel" || skip "Vercel link failed (do manually)"
  else
    skip "Vercel CLI not installed"
  fi
fi

# --- 4. vercel.json scaffold ---
if [ ! -f "$LOCAL_PATH/vercel.json" ]; then
  cat > "$LOCAL_PATH/vercel.json" << 'VJSON'
{
  "ignoreCommand": "git log -1 --format=%s | grep -qE '^(chore|ci|test|docs):'"
}
VJSON
  pass "Created vercel.json with ignoreCommand"
else
  skip "vercel.json already exists"
fi

# --- 5. Generate favicon ---
(cd "$MONITOR_DIR" && node scripts/generate-favicons.js "$APP_ID") > /dev/null 2>&1 \
  && pass "Favicon generated" \
  || skip "Favicon generation failed"

# --- 6. Tab registry (NOT a shell append) ---
# ~/.claude/tab-colors.json is the single source of truth. The _<name> shell
# function is generated from it on every new shell, so registering here is the
# only step. Appending a function to ~/.claude-tabs.sh by hand is what let the
# two drift apart.
ALIAS_LABEL=$(echo "$APP_NAME" | tr '[:lower:]' '[:upper:]')
DIR_NAME=$(basename "$LOCAL_PATH")

if python3 - "$DIR_NAME" <<'PYEOF' 2>/dev/null
import json, os, sys
reg = os.path.expanduser("~/.claude/tab-colors.json")
sys.exit(0 if sys.argv[1] in json.load(open(reg)) else 1)
PYEOF
then
  skip "Tab registry already has $DIR_NAME"
else
  python3 - "$DIR_NAME" "$ALIAS_LABEL" "$CR" "$CG" "$CB" <<'PYEOF'
import json, os, sys
d, label, r, g, b = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:6])
reg = os.path.expanduser("~/.claude/tab-colors.json")
cfg = json.load(open(reg))
cfg[d] = {"label": label, "r": r, "g": g, "b": b, "icon": ""}
json.dump(cfg, open(reg, "w"), indent=2, ensure_ascii=False)
PYEOF
  pass "Registered $DIR_NAME in tab-colors.json (alias _$DIR_NAME generates on next shell)"
fi


# --- 7. GitHub repo polish ---
cd "$LOCAL_PATH"
REPO_DESC=$([ -f package.json ] && python3 -c "import json; print(json.load(open('package.json')).get('description',''))" 2>/dev/null || echo "")
if [ -z "$REPO_DESC" ]; then
  REPO_DESC="$APP_NAME"
fi
gh repo edit "bunlongheng/$APP_ID" \
  --description "$REPO_DESC" \
  --add-topic "nextjs" --add-topic "react" --add-topic "typescript" \
  2>/dev/null && pass "GitHub repo polished (description + topics)" || skip "GitHub polish failed"

# --- 8. Disable Dependabot ---
if [ -f "$LOCAL_PATH/.github/dependabot.yml" ]; then
  rm "$LOCAL_PATH/.github/dependabot.yml"
  pass "Removed dependabot.yml"
else
  skip "No dependabot.yml to remove"
fi

# --- 9. npm audit ---
cd "$LOCAL_PATH"
if [ -f package.json ]; then
  VULNS=$(npm audit --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('metadata',{}).get('vulnerabilities',{}).get('total',0))" 2>/dev/null || echo "?")
  if [ "$VULNS" = "0" ]; then
    pass "npm audit clean (0 vulnerabilities)"
  else
    fail "npm audit found $VULNS vulnerabilities - run: npm audit fix"
  fi
else
  skip "No package.json"
fi

# --- Summary ---
echo ""
echo -e "${CYAN}=== Onboarding Complete ===${NC}"
echo ""

# Get assigned port
APP_DATA=$(curl -s "$MONITOR/api/apps/$APP_ID" 2>/dev/null)
# The API returns camelCase (localUrl, caddyUrl, repo); the tab alias is the registry convention _<id_with_underscores>.
APP_PORT=$(echo "$APP_DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('localUrl','').split(':')[-1] if d.get('localUrl') else '?')" 2>/dev/null)
APP_CADDY=$(echo "$APP_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('caddyUrl') or '?')" 2>/dev/null)
APP_REPO=$(echo "$APP_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('repo') or '')" 2>/dev/null)
ALIAS_NAME="_${APP_ID//-/_}"

echo "  App ID:      $APP_ID"
echo "  Local:       http://localhost:$APP_PORT"
echo "  Caddy:       $APP_CADDY"
[ -n "$APP_REPO" ] && echo "  Repo:        $APP_REPO"
echo "  Alias:       $ALIAS_NAME"
echo ""
echo -e "  ${YELLOW}Next: source ~/.zshrc && $ALIAS_NAME${NC}"
echo ""
