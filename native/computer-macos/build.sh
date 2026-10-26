#!/bin/sh
# Builds atelier-computer, the macOS computer-use helper, as a universal (arm64 + x86_64) release binary and copies
# it to native/bin/atelier-computer-darwin. `pnpm computer:build`; then `node native/computer-macos/smoke.mjs`.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "computer:build: the macOS helper builds on macOS only; skipped." >&2
  exit 0
fi

here="$(cd "$(dirname "$0")" && pwd)"
out="$(cd "$here/../.." && pwd)/native/bin"

cd "$here"
swift build -c release --arch arm64 --arch x86_64
bin="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)"

mkdir -p "$out"
cp "$bin/atelier-computer" "$out/atelier-computer-darwin"
chmod 755 "$out/atelier-computer-darwin"
echo "built $out/atelier-computer-darwin ($(lipo -archs "$out/atelier-computer-darwin"))"
