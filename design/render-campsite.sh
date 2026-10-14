#!/bin/sh
# Renders each Camp Morrow concept view in campsite.html to png/campsite-<view>.png with headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR=$(cd "$(dirname "$0")" && pwd -W)
for spec in ${*:-road:1280,720 overview:1280,900 fire:1280,720 messhall:1280,720 lake:1280,720 tower:1280,720 plan:1280,900}; do
  view=${spec%%:*}; size=${spec#*:}
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=15000 --window-size=$size \
    --screenshot="$DIR/png/campsite-$view.png" "file:///$DIR/campsite.html#$view" 2>/dev/null
done
