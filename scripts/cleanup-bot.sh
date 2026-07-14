#!/bin/bash
# Cleanup Bot - native scan / audit / clean for the Mac dev environment.
#
# Defines an ORPHAN as a dev-server process (next-server / vite / npm run) living
# under ~/Sites/<app> whose owning com.local-apps LaunchAgent is NOT currently loaded.
# When an app is disabled but its process lingers, this is what reclaims the RAM.
#
# Modes:
#   audit  (default)  read-only report: loaded agents, orphan dev servers, fat logs/locks
#   clean             kill orphan dev-server trees, truncate fat logs, drop dead lock/pid
#                     files, then run the safe cache reclaim (storage-guard clean)
#
# Safety: never touches the `claude` CLI, only dev-server signatures, only orphan dirs.

set -uo pipefail
SITES="$HOME/Sites"
LA="$HOME/Library/LaunchAgents"
GUARD="$SITES/local-apps/scripts/storage-guard.sh"
LOG_FAT_MB=50          # truncate /tmp logs bigger than this
MODE="${1:-audit}"

# ---- loaded com.local-apps agents (these own apps that SHOULD be running) ----
loaded_labels() { launchctl list | awk '/com\.local-apps\./{print $3}'; }

# protected Sites dirs = working dir of every loaded agent
protected_dirs() {
  local label wd
  while read -r label; do
    [ -z "$label" ] && continue
    wd=$(/usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$LA/$label.plist" 2>/dev/null)
    [ -n "$wd" ] && echo "$wd"
  done < <(loaded_labels)
}

# running dev-server dirs under ~/Sites (next-server / vite / npm run dev|start)
running_dev_dirs() {
  ps -axo args 2>/dev/null \
    | grep -E 'next-server|next/dist|vite|npm run (dev|start)' \
    | grep -v 'grep' \
    | grep -oE "$SITES/[A-Za-z0-9_.-]+" \
    | sort -u
}

# ---- compute orphans: running dev dirs that are NOT protected ----
mapfile -t PROT < <(protected_dirs | sort -u)
is_protected() { local d="$1"; for p in "${PROT[@]}"; do [ "$d" = "$p" ] && return 0; done; return 1; }

ORPHANS=()
while read -r d; do
  [ -z "$d" ] && continue
  is_protected "$d" || ORPHANS+=("$d")
done < <(running_dev_dirs)

dir_rss_mb() { # total RSS of dev procs under a dir
  ps -axo rss,args 2>/dev/null | grep -E 'next-server|next/dist|vite|npm run' | grep -F "$1" | grep -v grep \
    | awk '{s+=$1} END{printf "%.0f", s/1024}'
}

# ---- fat logs + dead lock/pid files ----
fat_logs() { find /tmp -maxdepth 1 -name '*.log' -size +${LOG_FAT_MB}M 2>/dev/null; }
dead_locks() {
  find "$SITES" -maxdepth 2 \( -name '.deploy.lock' -o -name '*.pid' \) 2>/dev/null
}

print_audit() {
  echo "==================== CLEANUP AUDIT ===================="
  echo "Loaded com.local-apps agents: $(loaded_labels | wc -l | tr -d ' ')"
  echo
  echo "ORPHAN dev servers (agent disabled, process still alive):"
  if [ "${#ORPHANS[@]}" -eq 0 ]; then
    echo "  none"
  else
    for d in "${ORPHANS[@]}"; do printf "  %-40s ~%s MB\n" "$d" "$(dir_rss_mb "$d")"; done
  fi
  echo
  echo "Fat /tmp logs (> ${LOG_FAT_MB}MB):"
  local any=0
  while read -r f; do [ -n "$f" ] && { printf "  %8s  %s\n" "$(du -h "$f" | cut -f1)" "$f"; any=1; }; done < <(fat_logs)
  [ "$any" -eq 0 ] && echo "  none"
  echo
  echo "Lock/pid files (verify dead before removing):"
  local l=0
  while read -r f; do [ -n "$f" ] && { echo "  $f"; l=1; }; done < <(dead_locks)
  [ "$l" -eq 0 ] && echo "  none"
  echo "======================================================="
}

case "$MODE" in
  clean)
    echo "[cleanup-bot] killing orphan dev servers..."
    SWAP_B=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
    for d in "${ORPHANS[@]}"; do
      # never match the claude CLI; only dev-server signatures inside this dir
      pids=$(ps -axo pid,args | grep -E 'next-server|next/dist|vite|npm run' | grep -F "$d" | grep -v grep | awk '{print $1}')
      if [ -n "$pids" ]; then
        echo "  $d -> kill $(echo $pids | tr '\n' ' ')"
        kill $pids 2>/dev/null; sleep 1; kill -9 $pids 2>/dev/null
      fi
    done

    echo "[cleanup-bot] truncating fat logs..."
    while read -r f; do [ -n "$f" ] && { : > "$f" && echo "  truncated $f"; }; done < <(fat_logs)

    echo "[cleanup-bot] removing dead lock/pid files..."
    while read -r f; do
      [ -z "$f" ] && continue
      pid=$(cat "$f" 2>/dev/null | grep -oE '^[0-9]+' | head -1)
      if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$f" && echo "  removed $f"
      else
        echo "  kept $f (pid $pid alive)"
      fi
    done < <(dead_locks)

    echo "[cleanup-bot] safe cache reclaim..."
    [ -x "$GUARD" ] && "$GUARD" clean | sed 's/^/  /'

    sleep 1
    SWAP_A=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
    echo "[cleanup-bot] done. swap used ${SWAP_B}M -> ${SWAP_A}M"
    ;;

  audit|*)
    print_audit
    ;;
esac
