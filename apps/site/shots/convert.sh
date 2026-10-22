#!/usr/bin/env bash
# Turns the masters from capture.mjs into the website's images: WebP at three widths each, for srcset
# (1280 for phones and the half-width rows, 2560 for 2x screens, 3840 for 3x and large displays).
#
#   apps/site/shots/convert.sh <captures dir> [dest dir=apps/site/public/img]
#
# Needs `cwebp` (brew install webp) and ImageMagick. Quality 88 with sharp chroma keeps UI text crisp at ~150 KB per 4K frame.
set -euo pipefail

src="${1:?usage: convert.sh <captures dir> [dest dir]}"
dest="${2:-$(cd "$(dirname "$0")/.." && pwd)/public/img}"
mkdir -p "$dest"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

encode() { # <master png> <width> <output webp>
  magick "$1" -filter Lanczos -resize "${2}x" "$tmp/frame.png"
  cwebp -quiet -q 88 -m 6 -sharp_yuv "$tmp/frame.png" -o "$3"
}

for name in chat artifact cowork code permission; do
  for width in 1280 2560 3840; do encode "$src/$name.png" "$width" "$dest/$name-$width.webp"; done
done
# The providers shot is a crop of the settings dialog, 2496 wide at most.
for width in 1280 2496; do encode "$src/providers.png" "$width" "$dest/providers-$width.webp"; done

ls -l "$dest" | awk 'NR>1 {printf "%8d  %s\n", $5, $9}'
