#!/bin/sh
# Stops sessions that hold a build or simulator slot for too long, so one long batch cannot starve everyone else.
#   Start: nohup scripts/slot-enforcer.sh >> ~/atelier-ios-work/guard.log 2>&1 &     Stop: pkill -f slot-enforcer.sh
SIM_MAX="${SIM_MAX:-360}"      # seconds
BUILD_MAX="${BUILD_MAX:-1200}"
killtree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do killtree "$child"; done
  kill -TERM "$1" 2>/dev/null
}
while :; do
  now=$(date +%s)
  for kind in sim build; do
    max=$SIM_MAX; [ "$kind" = build ] && max=$BUILD_MAX
    for s in /private/tmp/atelier-slots-$kind/slot-*; do
      [ -d "$s" ] || continue
      held=$((now - $(stat -f %m "$s")))
      if [ "$held" -gt "$max" ]; then
        pid=$(cat "$s/pid" 2>/dev/null || echo 0)
        echo "$(date +%H:%M:%S) $kind slot held ${held}s (max $max): stopping pid $pid"
        [ "$pid" -gt 0 ] && killtree "$pid"
        sleep 2; rm -rf "$s"
        [ "$kind" = sim ] && xcrun simctl shutdown all >/dev/null 2>&1
      fi
    done
  done
  sleep 10
done
