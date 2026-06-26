#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$root_dir/build"
source_png="$build_dir/icon.png"
iconset_dir="$build_dir/icon.iconset"

rm -rf "$iconset_dir"
mkdir -p "$iconset_dir"

make_icon() {
  local size="$1"
  local name="$2"
  sips -s format png -z "$size" "$size" "$source_png" --out "$iconset_dir/$name" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png

iconutil -c icns "$iconset_dir" -o "$build_dir/icon.icns"
rm -rf "$iconset_dir"
