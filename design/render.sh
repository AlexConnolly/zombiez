#!/bin/sh
# Renders each mockup view in mockups.html to png/<view>.png with headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR=$(cd "$(dirname "$0")" && pwd -W)
for spec in palette:1280,520 hud:1280,720 menu:1280,720 select:1280,720 confirm:1280,720 pause:1280,720 gameover:1280,720 assets:1280,1330 plans:1280,760; do
  view=${spec%%:*}; size=${spec#*:}
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --virtual-time-budget=4000 --window-size=$size \
    --screenshot="$DIR/png/$view.png" "file:///$DIR/mockups.html#$view" 2>/dev/null
done
