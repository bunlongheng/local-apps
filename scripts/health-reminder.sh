#!/bin/bash
# Health Reminder - runs every 45 min during work hours (8 AM - 8 PM)
# Rotates through reminders: water, break, walk, eyes, stretch

HOUR=$(date +%-H)
if [ "$HOUR" -lt 8 ] || [ "$HOUR" -ge 20 ]; then
  exit 0
fi

LOG="/tmp/health-reminder.log"

# Cycle through reminders based on time
REMINDERS=(
  "Drink Water|Time to hydrate. Grab a glass of water.|Glass"
  "Take a Break|Step away from the screen for 5 minutes. Your code will still be here.|Caution"
  "Go for a Walk|10 minute walk. Fresh air, clear mind, better code.|Finder"
  "Rest Your Eyes|Look at something 20 feet away for 20 seconds. 20-20-20 rule.|Accessibility"
  "Stretch|Stand up and stretch your neck, shoulders, and back.|Shovel"
)

# Pick reminder based on minutes past midnight (rotates through all 5)
MINS=$(( $(date +%s) / 60 ))
IDX=$(( MINS % ${#REMINDERS[@]} ))
IFS='|' read -r TITLE MSG ICON <<< "${REMINDERS[$IDX]}"

# macOS notification
osascript -e "display notification \"$MSG\" with title \"$TITLE\" sound name \"Blow\""

# Log it
echo "$(date '+%Y-%m-%d %H:%M') $TITLE" >> "$LOG"

# Every 3 hours, post a health summary to Stickies
if [ $(( HOUR % 3 )) -eq 0 ] && [ "$(date +%-M)" -lt 46 ]; then
  WATER_COUNT=$(grep -c "Drink Water" "$LOG" 2>/dev/null || echo 0)
  BREAK_COUNT=$(grep -c "Take a Break" "$LOG" 2>/dev/null || echo 0)
  WALK_COUNT=$(grep -c "Go for a Walk" "$LOG" 2>/dev/null || echo 0)

  TODAY=$(date '+%Y-%m-%d')
  TODAY_WATER=$(grep "$TODAY" "$LOG" 2>/dev/null | grep -c "Drink Water")
  TODAY_BREAKS=$(grep "$TODAY" "$LOG" 2>/dev/null | grep -c "Take a Break")
  TODAY_WALKS=$(grep "$TODAY" "$LOG" 2>/dev/null | grep -c "Go for a Walk")

  osascript -e "display notification \"Water: ${TODAY_WATER}x | Breaks: ${TODAY_BREAKS}x | Walks: ${TODAY_WALKS}x\" with title \"Health Check-in\" sound name \"Purr\""
fi
