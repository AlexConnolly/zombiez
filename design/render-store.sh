#!/bin/sh
# Renders each Abandoned Store concept view in store.html to png/store-<view>.png with headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR=$(cd "$(dirname "$0")" && pwd -W)
for spec in carpark:1280,720 dark:1280,720 lit:1280,720 overview:1280,900 freezer:1280,720 office:1280,720; do
  view=${spec%%:*}; size=${spec#*:}
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=8000 --window-size=$size \
    --screenshot="$DIR/png/store-$view.png" "file:///$DIR/store.html#$view" 2>/dev/null
done
