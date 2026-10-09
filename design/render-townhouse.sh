#!/bin/sh
# Renders each Townhouse concept view in townhouse.html to png/townhouse-<view>.png with headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR=$(cd "$(dirname "$0")" && pwd -W)
for spec in street:1280,720 cutaway:1280,900 kitchen:1280,720 drawing:1280,720 loft:1280,720 plans:1280,620; do
  view=${spec%%:*}; size=${spec#*:}
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=6000 --window-size=$size \
    --screenshot="$DIR/png/townhouse-$view.png" "file:///$DIR/townhouse.html#$view" 2>/dev/null
done
