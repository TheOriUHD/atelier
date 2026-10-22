# Each account keeps its temporary files in its own folder (mode 0700) instead of the container's shared /tmp, and what it
# creates is private to it by default. Read by the login shell the runner starts to learn the environment commands get.
umask 077
if [ -n "${HOME-}" ] && [ -d "$HOME" ]; then
  TMPDIR="$HOME/.tmp"
  export TMPDIR
  [ -d "$TMPDIR" ] || mkdir -p -m 700 "$TMPDIR" 2>/dev/null
fi
