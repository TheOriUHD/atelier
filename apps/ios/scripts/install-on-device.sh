#!/bin/sh
# Builds Atelier for iPhone and iPad, signed with your Apple developer team, and installs it on a connected device.
#
#   apps/ios/scripts/install-on-device.sh "Philipps iPad"
#
# The device must show up as available in `xcrun devicectl list devices` (plugged in, unlocked, trusted). The team is
# taken from ATELIER_TEAM, or else from the team Xcode is signed in with.
set -eu
cd "$(dirname "$0")/.."
DEVICE="${1:?Give the device name or UDID, as listed by: xcrun devicectl list devices}"
TEAM="${ATELIER_TEAM:-}"
if [ -z "$TEAM" ]; then
  TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]*\);.*/\1/p' | head -1)
fi
[ -n "$TEAM" ] || { echo "Set ATELIER_TEAM to your Apple developer team ID." >&2; exit 1; }

xcodegen generate --quiet
# CONFIG=Debug builds a copy that understands the --demo and --open launch arguments (see Launch.swift).
CONFIG="${CONFIG:-Release}"
BUILD="${TMPDIR:-/tmp}/atelier-ios-device-$CONFIG"
scripts/build-lock.sh xcodebuild -jobs 3 COMPILER_INDEX_STORE_ENABLE=NO -project Atelier.xcodeproj -scheme Atelier -configuration "$CONFIG" -destination 'generic/platform=iOS' \
  -derivedDataPath "$BUILD" DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build | tail -3
APP="$BUILD/Build/Products/$CONFIG-iphoneos/Atelier.app"
xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device process launch --device "$DEVICE" app.atelier.mobile
