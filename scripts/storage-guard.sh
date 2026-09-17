#!/bin/bash
# Storage Guard - proactive disk + memory brake for the Mac.
# Modes:
#   (default / check)  evaluate disk + swap, notify + post Stickies when low (rate-limited)
#   report             print top reclaimable targets with live sizes (no action)
#   clean              run SAFE reclaim only (regenerable caches + Trash), no project data
# Exit codes: 0 = ok, 1 = warn, 2 = critical

set -uo pipefail

# ---- thresholds (GiB) ----
DISK_WARN=20      # free below this -> warn
DISK_CRIT=10      # free below this -> critical
SWAP_FREE_WARN=3  # free swap below this -> warn (memory pressure proxy)
SWAP_FREE_CRIT=1.5

LOG="/tmp/storage-guard.log"
STATE="/tmp/storage-guard.state"   # last-posted level + timestamp (rate limit)
POST_COOLDOWN=$((4 * 3600))        # min seconds between Stickies posts

# ---- readings ----
disk_free_gb() {
  df -g /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}'
}
swap_free_gb() {
  # vm.swapusage free is in MB
  sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*free = ([0-9.]+)M.*/\1/' | awk '{printf "%.2f", $1/1024}'
}
mem_free_pct() {
  vm_stat 2>/dev/null | awk '
    /page size of/ {ps=$8}
    /Pages free/ {f=$3}
    /Pages inactive/ {i=$3}
    /Pages speculative/ {s=$3}
    /Pages active/ {a=$3}
    /Pages wired/ {w=$4}
    END {
      gsub(/\./,"",f); gsub(/\./,"",i); gsub(/\./,"",s); gsub(/\./,"",a); gsub(/\./,"",w);
      avail=f+i+s; total=avail+a+w;
      if (total>0) printf "%d", (avail*100)/total; else print "0";
    }'
}

DISK=$(disk_free_gb)
SWAP=$(swap_free_gb)
MEMPCT=$(mem_free_pct)
[ -z "$DISK" ] && DISK=999
[ -z "$SWAP" ] && SWAP=999
[ -z "$MEMPCT" ] && MEMPCT=100

# float compare helper
lt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<b)}'; }

level=0
reasons=""
if lt "$DISK" "$DISK_CRIT"; then level=2; reasons="${reasons}disk ${DISK}GB free (CRIT); ";
elif lt "$DISK" "$DISK_WARN"; then [ "$level" -lt 1 ] && level=1; reasons="${reasons}disk ${DISK}GB free (warn); "; fi
if lt "$SWAP" "$SWAP_FREE_CRIT"; then level=2; reasons="${reasons}swap ${SWAP}GB free (CRIT); ";
elif lt "$SWAP" "$SWAP_FREE_WARN"; then [ "$level" -lt 1 ] && level=1; reasons="${reasons}swap ${SWAP}GB free (warn); "; fi

label="OK"; [ "$level" -eq 1 ] && label="WARN"; [ "$level" -eq 2 ] && label="CRITICAL"

# ---- cleanup target sizer ----
size_of() { du -sh "$@" 2>/dev/null | awk '{print $1}' | head -1; }
print_targets() {
  printf "%-34s %8s  %s\n" "TARGET" "SIZE" "RECLAIM COMMAND"
  printf "%-34s %8s  %s\n" "npm cache"        "$(size_of ~/.npm)"                         "npm cache clean --force"
  printf "%-34s %8s  %s\n" "playwright browsers" "$(size_of ~/Library/Caches/ms-playwright)" "rm -rf ~/Library/Caches/ms-playwright (reinstall via: npx playwright install)"
  printf "%-34s %8s  %s\n" "puppeteer browsers" "$(size_of ~/.cache/puppeteer)"            "rm -rf ~/.cache/puppeteer"
  printf "%-34s %8s  %s\n" "Chrome cache"      "$(size_of ~/Library/Caches/Google)"        "rm -rf ~/Library/Caches/Google/* (close Chrome first)"
  printf "%-34s %8s  %s\n" "pip cache"         "$(size_of ~/Library/Caches/pip)"           "pip cache purge"
  printf "%-34s %8s  %s\n" "go-build cache"    "$(size_of ~/Library/Caches/go-build)"      "go clean -cache"
  printf "%-34s %8s  %s\n" "huggingface models" "$(size_of ~/.cache/huggingface)"          "rm -rf ~/.cache/huggingface (re-downloads on next use)"
  printf "%-34s %8s  %s\n" "whisper models"    "$(size_of ~/.cache/whisper)"               "rm -rf ~/.cache/whisper (re-downloads on next use)"
  printf "%-34s %8s  %s\n" "Downloads"         "$(size_of ~/Downloads)"                    "review + clear ~/Downloads"
  printf "%-34s %8s  %s\n" "Trash"             "$(size_of ~/.Trash)"                       "empty Trash"
  echo
  echo "Heavy but project data (manual review): ~/Sites node_modules (32 dirs). Remove for inactive repos:"
  echo "  find ~/Sites -maxdepth 3 -name node_modules -type d -prune | xargs du -sh | sort -rh | head"
}

# ---- modes ----
MODE="${1:-check}"

case "$MODE" in
  warn)
    # fast, side-effect-free: print a single warning line only when low (for session hooks)
    if [ "$level" -gt 0 ]; then
      echo "STORAGE ${label}: disk ${DISK}GB free, swap ${SWAP}GB free, mem ${MEMPCT}% free. Suggest cleanup before heavy work -> scripts/storage-guard.sh report (safe auto-reclaim: scripts/storage-guard.sh clean)"
    fi
    exit "$level"
    ;;

  report)
    echo "Disk free: ${DISK}GB | Swap free: ${SWAP}GB | Mem free: ${MEMPCT}% | Status: ${label}"
    echo
    print_targets
    exit "$level"
    ;;

  clean)
    echo "[storage-guard] safe reclaim starting. Disk free before: ${DISK}GB"
    BEFORE=$(disk_free_gb)
    npm cache clean --force 2>/dev/null && echo "  cleaned npm cache"
    command -v yarn >/dev/null 2>&1 && yarn cache clean 2>/dev/null && echo "  cleaned yarn cache"
    command -v pip3 >/dev/null 2>&1 && pip3 cache purge 2>/dev/null && echo "  cleaned pip cache"
    command -v go >/dev/null 2>&1 && go clean -cache 2>/dev/null && echo "  cleaned go-build cache"
    command -v brew >/dev/null 2>&1 && brew cleanup -s 2>/dev/null >/dev/null && echo "  ran brew cleanup"
    osascript -e 'tell application "Finder" to empty trash' 2>/dev/null && echo "  emptied Trash"
    AFTER=$(disk_free_gb)
    echo "[storage-guard] done. Disk free after: ${AFTER}GB (was ${BEFORE}GB)"
    echo "Bigger wins (manual): playwright/huggingface/whisper caches + inactive node_modules. Run: $0 report"
    exit 0
    ;;

  check|*)
    STAMP=$(date '+%Y-%m-%d %H:%M')
    echo "${STAMP} ${label} disk=${DISK}GB swap=${SWAP}GB mem=${MEMPCT}% ${reasons}" >> "$LOG"

    if [ "$level" -eq 0 ]; then
      exit 0
    fi

    # notify every run when low
    SOUND="Submarine"; [ "$level" -eq 2 ] && SOUND="Sosumi"
    osascript -e "display notification \"Disk ${DISK}GB free, swap ${SWAP}GB free. Run: storage-guard.sh report\" with title \"Storage ${label}\" sound name \"${SOUND}\"" 2>/dev/null

    # rate-limit Stickies posts
    NOW=$(date +%s)
    LAST_LEVEL=""; LAST_TS=0
    [ -f "$STATE" ] && IFS='|' read -r LAST_LEVEL LAST_TS < "$STATE"
    if [ "$label" != "$LAST_LEVEL" ] || [ $((NOW - LAST_TS)) -ge "$POST_COOLDOWN" ]; then
      TARGETS_HTML=$(print_targets | sed '1d' | awk 'NF && !/^Heavy|^  find/{printf "<tr><td style=\"padding:4px 10px;border-bottom:1px solid #2a2a2a;\">%s</td><td style=\"padding:4px 10px;border-bottom:1px solid #2a2a2a;text-align:right;color:#facc15;font-weight:600;\">%s</td></tr>", $1" "$2, $3}' 2>/dev/null)
      TOKEN=$(grep -oE 'sk_ext_[0-9a-f]+' ~/.claude/skills/stickies/SKILL.md 2>/dev/null | head -1)
      ACCENT="#f59e0b"; [ "$level" -eq 2 ] && ACCENT="#ef4444"
      BODY=$(cat <<HTML
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:100%;color:#e4e4e7;">
<div style="background:${ACCENT};color:#111;font-weight:700;padding:10px 14px;border-radius:8px 8px 0 0;font-size:16px;">Storage ${label} - ${STAMP}</div>
<div style="background:#161616;padding:14px;border-radius:0 0 8px 8px;">
<div style="display:flex;gap:14px;margin-bottom:12px;flex-wrap:wrap;">
<div style="flex:1;min-width:90px;background:#1f1f1f;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:${ACCENT};">${DISK}GB</div><div style="font-size:11px;color:#888;">disk free</div></div>
<div style="flex:1;min-width:90px;background:#1f1f1f;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:${ACCENT};">${SWAP}GB</div><div style="font-size:11px;color:#888;">swap free</div></div>
<div style="flex:1;min-width:90px;background:#1f1f1f;border-radius:8px;padding:10px;text-align:center;"><div style="font-size:22px;font-weight:700;color:${ACCENT};">${MEMPCT}%</div><div style="font-size:11px;color:#888;">mem free</div></div>
</div>
<div style="font-size:13px;color:#aaa;margin-bottom:8px;">Safe to clean now (regenerable caches):</div>
<table style="width:100%;border-collapse:collapse;font-size:13px;">${TARGETS_HTML}</table>
<div style="margin-top:12px;padding:10px;background:#1f1f1f;border-radius:8px;font-size:13px;">One-command safe reclaim:<br><code style="color:#22c55e;">~/Sites/local-apps/scripts/storage-guard.sh clean</code></div>
</div></div>
HTML
)
      if [ -n "$TOKEN" ]; then
        curl -s -X POST "http://localhost:4444/api/stickies/ext" \
          -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
          -d "$(python3 -c 'import json,sys;print(json.dumps({"title":"Storage '"$label"' - Mac running low","type":"html","folder_name":"Alerts","content":sys.stdin.read()}))' <<<"$BODY")" \
          >/dev/null 2>&1 && echo "  posted Stickies alert"
      fi
      echo "${label}|${NOW}" > "$STATE"
    fi
    exit "$level"
    ;;
esac
