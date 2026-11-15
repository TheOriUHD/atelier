#!/bin/sh
# Builds atelier-computer, the macOS computer-use helper, and atelier-speech, dictation with the Mac's own speech
# recognition, as universal (arm64 + x86_64) release binaries, and copies them to native/bin/atelier-computer-darwin
# and native/bin/atelier-speech-darwin. `pnpm computer:build`; then `node native/computer-macos/smoke.mjs`.
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
cp "$bin/atelier-speech" "$out/atelier-speech-darwin"
chmod 755 "$out/atelier-speech-darwin"
echo "built $out/atelier-speech-darwin ($(lipo -archs "$out/atelier-speech-darwin"))"
