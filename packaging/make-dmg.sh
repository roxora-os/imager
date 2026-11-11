#!/bin/bash
# Build the macOS DMG: the app, an Applications link to drop it on, a
# background with first-launch instructions, and a note about Gatekeeper.
# From gahingwoo/RKDevelopTool-GUI packaging/make-dmg.sh; the background is
# rendered from packaging/dmg/background.svg instead of with Qt.
#   packaging/make-dmg.sh "dist/mac-arm64/Roxora Imager.app" dist/roxora-imager-0.1.0-macos-arm64.dmg
set -euo pipefail
APP="$1"; DMG="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
NOTE="$HERE/dmg/If it won't open.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node "$HERE/../scripts/dmg-background.mjs" "$WORK"
# One TIFF with both resolutions: Finder picks the sharp one on Retina.
tiffutil -cathidpicheck "$WORK/background.png" "$WORK/background@2x.png" -out "$WORK/background.tiff"

rm -f "$DMG"
if create-dmg \
    --volname "Roxora Imager" \
    --background "$WORK/background.tiff" \
    --window-size 660 500 \
    --icon-size 104 \
    --icon "$(basename "$APP")" 165 170 \
    --app-drop-link 495 170 \
    --add-file "$(basename "$NOTE")" "$NOTE" 330 430 \
    --hide-extension "$(basename "$APP")" \
    --no-internet-enable \
    "$DMG" "$APP"; then
  exit 0
fi

# create-dmg lays the window out through Finder, which can fail on a
# headless runner. Without the layout, still give people somewhere to drop
# the app and the instructions.
echo "create-dmg failed; building a plain DMG with the Applications link" >&2
STAGE="$WORK/stage"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"
cp "$NOTE" "$STAGE/"
rm -f "$DMG"
hdiutil create -volname "Roxora Imager" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
