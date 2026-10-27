#!/usr/bin/env bash
# Linux engine smoke (P03): the same basic media scenario in an X11 and a Wayland GTK session.
# Runs the real release binary with a GENERATED multitrack MKV (2 audio tracks, 1 subtitle) and
# reads the JSON report written by src-tauri/src/engine/smoke.rs.
#   bash scripts/linux/engine-smoke.sh [x11|wayland|both]
# Isolated: fresh VHO_DATA_DIR / HOME-independent temp folder, system actions disabled.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BIN=${VHO_EXE:-$ROOT/src-tauri/target/release/vho}
FF=$(dirname "$BIN")/ffmpeg
MODE=${1:-both}
TMP=$(mktemp -d /tmp/vho-smoke-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

[ -x "$BIN" ] || { echo "binary missing: $BIN"; exit 2; }
[ -x "$FF" ] || { echo "staged ffmpeg missing next to the binary (scripts/linux/stage-mpv.sh)"; exit 2; }
printf '1\n00:00:00,000 --> 00:00:09,000\nVHO altyazi testi\n' > "$TMP/s.srt"
"$FF" -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x360:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000" -i "$TMP/s.srt" -t 8 \
  -map 0 -map 1 -map 2 -map 3 -c:v mpeg4 -q:v 4 -c:a aac -c:s srt \
  -metadata:s:a:0 language=tur -metadata:s:a:1 language=eng -metadata:s:s:0 language=tur \
  "$TMP/smoke.mkv" || exit 2

# WSLg: the compositor socket lives in /mnt/wslg/runtime-dir
if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY:-wayland-0}" ]; then
  [ -S /mnt/wslg/runtime-dir/wayland-0 ] && export XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
fi

rc=0
run() {
  local backend=$1
  local data=$TMP/data-$backend
  mkdir -p "$data"
  echo "=== $backend ==="
  env GDK_BACKEND="$backend" VHO_DATA_DIR="$data" VHO_DISABLE_SYSTEM_SUSPEND=1 VHO_DISABLE_SYSTEM_CHANGES=1 \
      VHO_SCREENSHOT_DIR="$data/shots" VHO_ENGINE_SMOKE_REPORT="$TMP/report-$backend.json" \
      timeout 120 "$BIN" "$TMP/smoke.mkv" > "$TMP/log-$backend.txt" 2>&1
  local code=$?
  grep -E "\[VHO\] (smoke|engine smoke|linux video)|libmpv unavailable" "$TMP/log-$backend.txt"
  if [ -f "$TMP/report-$backend.json" ]; then
    mkdir -p "$ROOT/tests/.results"
    cp "$TMP/report-$backend.json" "$ROOT/tests/.results/linux-engine-smoke-$backend.json"
  else
    echo "no report (exit $code)"; tail -20 "$TMP/log-$backend.txt"
  fi
  [ $code -eq 0 ] || rc=1
  echo "$backend: exit $code"
}
case "$MODE" in
  x11) run x11 ;;
  wayland) run wayland ;;
  *) run x11; run wayland ;;
esac
exit $rc
