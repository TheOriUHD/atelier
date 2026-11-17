#!/bin/sh
# Builds Atelier for a simulator (once, into BUILD) and screenshots it launched with the given arguments.
#
#   apps/ios/scripts/shot.sh <udid> <out.png> [--appearance light|dark] [--wait seconds] -- <launch arguments…>
#
# e.g. apps/ios/scripts/shot.sh $UDID /tmp/a.png -- --demo settings --open settings/providers
#      apps/ios/scripts/shot.sh $UDID /tmp/b.png -- --autologin https://127.0.0.1:17401 demo atelier-demo-pass --open settings/users
# Environment: BUILD (derived data folder, default $TMPDIR/atelier-ios-sim), NOBUILD=1 to skip the build,
# KEEP=1 to leave the simulator running afterwards (by default it is shut down: simulators are the biggest memory users).
# Builds and simulator sessions take a machine-wide slot (scripts/build-lock.sh) so they queue instead of piling up.
set -eu
cd "$(dirname "$0")/.."
UDID="$1"; OUT="$2"; shift 2
APPEARANCE=light; WAIT=12
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  case "$1" in --appearance) APPEARANCE="$2"; shift 2;; --wait) WAIT="$2"; shift 2;; *) shift;; esac
done
[ "${1:-}" = "--" ] && shift
BUILD="${BUILD:-${TMPDIR:-/tmp}/atelier-ios-sim}"
if [ -z "${NOBUILD:-}" ]; then
  xcodegen generate --quiet
  scripts/build-lock.sh xcodebuild -project Atelier.xcodeproj -scheme Atelier -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$BUILD" \
    -jobs 3 COMPILER_INDEX_STORE_ENABLE=NO CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true
fi
APP="$BUILD/Build/Products/Debug-iphonesimulator/Atelier.app"
ATELIER_LOCK=sim scripts/build-lock.sh sh -c '
  UDID="$1"; OUT="$2"; APPEARANCE="$3"; WAIT="$4"; APP="$5"; shift 5
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
  xcrun simctl ui "$UDID" appearance "$APPEARANCE" >/dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$APP"
  xcrun simctl terminate "$UDID" app.atelier.mobile >/dev/null 2>&1 || true
  xcrun simctl launch "$UDID" app.atelier.mobile "$@" >/dev/null
  sleep "$WAIT"
  xcrun simctl io "$UDID" screenshot "$OUT" >/dev/null 2>&1
  [ -n "${KEEP:-}" ] || xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
' sh "$UDID" "$OUT" "$APPEARANCE" "$WAIT" "$APP" "$@"
echo "$OUT"
