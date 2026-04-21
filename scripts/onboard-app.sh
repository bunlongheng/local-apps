#!/bin/bash
# Onboard a new app into the local-apps ecosystem
# Usage: ./onboard-app.sh <app-id> <app-name> <local-path> [--color R,G,B]
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
#  10. Take first screenshot

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

MONITOR="http://localhost:9876"
TABS_FILE="$HOME/.claude-tabs.sh"

# --- Args ---
APP_ID="$1"
APP_NAME="$2"
LOCAL_PATH="$3"
COLOR="130,130,130"

if [ -z "$APP_ID" ] || [ -z "$APP_NAME" ] || [ -z "$LOCAL_PATH" ]; then
  echo -e "${RED}Usage: ./onboard-app.sh <app-id> <app-name> <local-path> [--color R,G,B]${NC}"
  echo "  Example: ./onboard-app.sh my-app \"My App\" /Users/bheng/Sites/my-app --color 100,200,150"
  exit 1
fi

# Parse optional color flag
shift 3
while [[ $# -gt 0 ]]; do
  case $1 in
    --color) COLOR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

IFS=',' read -r CR CG CB <<< "$COLOR"

echo -e "\n${CYAN}=== Onboarding: $APP_NAME ($APP_ID) ===${NC}\n"

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
curl -s -X POST "$MONITOR/api/generate-icons/$APP_ID" > /dev/null 2>&1 \
  && pass "Favicon generation triggered" \
  || skip "Favicon generation failed"

# --- 6. Shell alias ---
ALIAS_NAME="_${APP_ID//-/}"
ALIAS_LABEL=$(echo "$APP_NAME" | tr '[:lower:]' '[:upper:]')
DIR_NAME=$(basename "$LOCAL_PATH")

if grep -q "\"$DIR_NAME\"" "$TABS_FILE" 2>/dev/null; then
  skip "Shell alias already exists in .claude-tabs.sh"
else
  # Pad to align with existing entries
  printf '%-16s{ _tab %-22s %-17s %-5s %-5s %s; }\n' \
    "${ALIAS_NAME}()" "\"$DIR_NAME\"" "\"$ALIAS_LABEL\"" "$CR" "$CG" "$CB" >> "$TABS_FILE"
  pass "Added alias ${ALIAS_NAME} to .claude-tabs.sh"
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

# --- 10. First screenshot ---
curl -s -X POST "$MONITOR/api/screenshots/$APP_ID" > /dev/null 2>&1 \
  && pass "First screenshot triggered" \
  || skip "Screenshot capture failed"

# --- Summary ---
echo ""
echo -e "${CYAN}=== Onboarding Complete ===${NC}"
echo ""

# Get assigned port
APP_DATA=$(curl -s "$MONITOR/api/apps/$APP_ID" 2>/dev/null)
APP_PORT=$(echo "$APP_DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('local_url','').split(':')[-1] if d.get('local_url') else '?')" 2>/dev/null)
APP_CADDY=$(echo "$APP_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('caddy_url','?'))" 2>/dev/null)

echo "  App ID:      $APP_ID"
echo "  Local:       http://localhost:$APP_PORT"
echo "  Caddy:       $APP_CADDY"
echo "  GitHub:      https://github.com/bunlongheng/$APP_ID"
echo "  Alias:       $ALIAS_NAME"
echo ""
echo -e "  ${YELLOW}Next: source ~/.zshrc && $ALIAS_NAME${NC}"
echo ""
