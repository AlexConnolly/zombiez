#!/bin/sh
# Renders each new-weapon concept view in weapons.html to png/weapon-<view>.png with headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR=$(cd "$(dirname "$0")" && pwd -W)
for view in ${*:-blowtorch grinder sentry}; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=15000 --window-size=1280,720 \
    --screenshot="$DIR/png/weapon-$view.png" "file:///$DIR/weapons.html#$view" 2>/dev/null
done
