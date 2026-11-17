#!/bin/sh
# Stops new builds and simulator sessions while the disk is nearly full, so nothing can fill it completely.
# Below LOW_GB free the slot counts are set to 0 (everyone waits in the queue); above HIGH_GB they come back.
#   Start: nohup scripts/disk-guard.sh >> ~/atelier-ios-work/guard.log 2>&1 &      Stop: pkill -f disk-guard.sh
LOW_GB="${LOW_GB:-1.5}"; HIGH_GB="${HIGH_GB:-2.5}"
CONF=/private/tmp/atelier-slots.conf
SAVED=/private/tmp/atelier-slots.conf.saved
paused=0
while :; do
  free_kb=$(df -k /System/Volumes/Data | awk 'NR==2 {print $4}')
  low=$(awk -v f="$free_kb" -v l="$LOW_GB" 'BEGIN {print (f/1048576 < l) ? 1 : 0}')
  high=$(awk -v f="$free_kb" -v h="$HIGH_GB" 'BEGIN {print (f/1048576 >= h) ? 1 : 0}')
  if [ "$paused" -eq 0 ] && [ "$low" -eq 1 ]; then
    cp "$CONF" "$SAVED" 2>/dev/null
    printf 'build=0\nsim=0\n' > "$CONF"; paused=1
    echo "$(date +%H:%M:%S) disk almost full ($((free_kb / 1024)) MB free): no new builds or simulator sessions until there is space"
  elif [ "$paused" -eq 1 ] && [ "$high" -eq 1 ]; then
    [ -f "$SAVED" ] && cp "$SAVED" "$CONF" || printf 'build=2\nsim=2\n' > "$CONF"; paused=0
    echo "$(date +%H:%M:%S) disk space is back ($((free_kb / 1024)) MB free): builds and simulator sessions resume"
  fi
  sleep 15
done
