#!/usr/bin/env bash
# Copies the LGPL libmpv/FFmpeg build (third_party/mpv/build-linux.sh -> <work>/dist) next to the
# built Linux binary, like scripts/stage-mpv.ps1 does on Windows. Never copies system libraries.
#   bash scripts/linux/stage-mpv.sh [DIST] [TARGET...]     (default DIST: ~/vho-mpv-build/dist)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST=${1:-${VHO_MPV_DIST:-$HOME/vho-mpv-build/dist}}
shift || true
TARGETS=("$@")
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=(release debug)
[ -f "$DIST/libmpv.so.2" ] || { echo "libmpv.so.2 not found in $DIST (run third_party/mpv/build-linux.sh)"; exit 1; }
for t in "${TARGETS[@]}"; do
  dest=$ROOT/src-tauri/target/$t
  [ -d "$dest" ] || continue
  cp -f "$DIST"/* "$dest/"
  (cd "$DIST" && ls) > "$dest/mpv-libs.txt"
  echo "staged $(wc -l < "$dest/mpv-libs.txt") files -> $dest"
done
