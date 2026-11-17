#!/bin/sh
# A safety net for the Mac while several people build and run simulators: every few seconds it looks at free memory and
# the simulators that are booted, and steps in BEFORE the system gets into trouble.
#   - more than MAX_SIMS (default 1) simulators booted for over 20 s: the extra ones are shut down
#   - free memory under 25%: every simulator is shut down
#   - free memory under 12%: running Swift compiler jobs are stopped as well (the build fails, the next one retries)
# Start:  nohup scripts/mem-guard.sh >> ~/atelier-ios-work/guard.log 2>&1 &      Stop: pkill -f mem-guard.sh
MAX_SIMS="${MAX_SIMS:-1}"
seen=0
while :; do
  free=$(memory_pressure 2>/dev/null | sed -n 's/.*free percentage: \([0-9]*\)%.*/\1/p' | head -1)
  free=${free:-100}
  booted=$(xcrun simctl list devices booted 2>/dev/null | grep -c Booted)
  now=$(date +%H:%M:%S)
  if [ "$free" -lt 12 ]; then
    echo "$now free ${free}%: stopping compiler jobs and simulators"
    pkill -9 swift-frontend 2>/dev/null; pkill -9 swift-driver 2>/dev/null
    xcrun simctl shutdown all >/dev/null 2>&1
  elif [ "$free" -lt 25 ] && [ "$booted" -gt 0 ]; then
    echo "$now free ${free}%: shutting down all simulators"
    xcrun simctl shutdown all >/dev/null 2>&1
  elif [ "$booted" -gt "$MAX_SIMS" ]; then
    seen=$((seen + 1))
    if [ "$seen" -ge 5 ]; then
      echo "$now $booted simulators booted (max $MAX_SIMS): shutting down the extra ones"
      xcrun simctl list devices booted | grep Booted | sed -n "$((MAX_SIMS + 1)),\$p" | grep -o '[0-9A-F]\{8\}-[0-9A-F-]\{27\}' | while read -r udid; do xcrun simctl shutdown "$udid" >/dev/null 2>&1; done
      seen=0
    fi
  else seen=0; fi
  sleep 4
done
