#!/bin/sh
# Runs a command while holding one of a few machine-wide slots, so several people building and running simulators at the
# same time cannot exhaust the Mac's memory. First come, first served.
#
#   scripts/build-lock.sh xcodebuild …            a build slot
#   ATELIER_LOCK=sim scripts/build-lock.sh …      a simulator slot: boot, launch, screenshot, shut down
#
# The slot counts are in /private/tmp/atelier-slots.conf (lines `build=2`, `sim=2`) and can change while people wait.
# A session may hold its slot for at most ~6 minutes (simulator) or ~20 minutes (build): scripts/slot-enforcer.sh stops
# anything that holds longer, so keep sessions short and take the slot again for the next batch.
set -eu
NAME="${ATELIER_LOCK:-build}"
slots() {
  n=$(sed -n "s/^$NAME=//p" /private/tmp/atelier-slots.conf 2>/dev/null | head -1)
  echo "${n:-1}"
}
ROOT=/private/tmp/atelier-slots-$NAME
QUEUE="$ROOT/queue"
mkdir -p "$ROOT" "$QUEUE"
HELD=""
TICKET=""
cleanup() { [ -n "$HELD" ] && rm -rf "$HELD"; [ -n "$TICKET" ] && rm -f "$TICKET"; return 0; }
trap cleanup EXIT INT TERM
# A ticket per waiting process, named by arrival time in milliseconds and pid: the oldest ticket goes first.
stamp=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
TICKET="$QUEUE/$stamp-$$"
: > "$TICKET"
waited=0
while :; do
  # Forget tickets and slots whose owner has died.
  for t in "$QUEUE"/*; do
    [ -e "$t" ] || continue
    owner=${t##*-}
    kill -0 "$owner" 2>/dev/null || rm -f "$t"
  done
  for s in "$ROOT"/slot-*; do
    [ -d "$s" ] || continue
    owner=$(cat "$s/pid" 2>/dev/null || echo 0)
    if [ "$owner" -gt 0 ] && ! kill -0 "$owner" 2>/dev/null; then rm -rf "$s"; fi
  done
  SLOTS=$(slots)
  # How many tickets are ahead of mine?
  ahead=0
  for t in "$QUEUE"/*; do
    [ -e "$t" ] || continue
    [ "$(basename "$t")" \< "$(basename "$TICKET")" ] && ahead=$((ahead + 1))
  done
  if [ "$ahead" -lt "$SLOTS" ]; then
    i=1
    while [ "$i" -le "$SLOTS" ]; do
      if mkdir "$ROOT/slot-$i" 2>/dev/null; then echo "$$" > "$ROOT/slot-$i/pid"; HELD="$ROOT/slot-$i"; break; fi
      i=$((i + 1))
    done
    [ -n "$HELD" ] && break
  fi
  waited=$((waited + 3)); [ "$waited" -gt 14400 ] && { echo "gave up waiting for a $NAME slot" >&2; exit 1; }
  sleep 3
done
rm -f "$TICKET"; TICKET=""
# Builds run at lower priority so the machine stays responsive even when every core is busy.
nice -n 10 "$@"
