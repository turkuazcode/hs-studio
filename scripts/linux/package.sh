#!/usr/bin/env bash
# Linux package (P03/P05): AppImage + deb with the LGPL libmpv/FFmpeg set in <resources>/mpv/
# and the legal folder, like scripts/package-windows.ps1 does for NSIS.
#   bash scripts/linux/package.sh [DIST]      (default DIST: ~/vho-mpv-build/dist)
# The native set must match legal/inventory/native-linux-x64.json (file names); hashes are
# written to the package manifest. Never copies the distribution's mpv/FFmpeg.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIST=${1:-${VHO_MPV_DIST:-$HOME/vho-mpv-build/dist}}
STAGE=$ROOT/src-tauri/target/package-staging
INV=$ROOT/legal/inventory/native-linux-x64.json

[ -f "$DIST/libmpv.so.2" ] || { echo "libmpv.so.2 not found in $DIST (run third_party/mpv/build-linux.sh)"; exit 1; }
# File set must equal the inventory (no unlisted library may be shipped)
want=$(node -e 'const i=require(process.argv[1]); console.log(i.files.map(f=>f.name).sort().join("\n"))' "$INV")
have=$(cd "$DIST" && ls | sort)
if [ "$want" != "$have" ]; then
  echo "native files differ from $INV:"; diff <(echo "$want") <(echo "$have") || true; exit 1
fi
# No file may resolve a system FFmpeg / libmpv
for f in "$DIST"/*; do
  if ldd "$f" 2>/dev/null | grep -E "lib(av|sw|mpv|postproc)[a-z]*\.so" | grep -v "$DIST" | grep -q "=>"; then
    echo "$f resolves a system FFmpeg/libmpv:"; ldd "$f" | grep -E "lib(av|sw|mpv)"; exit 1
  fi
done

rm -rf "$STAGE" && mkdir -p "$STAGE/mpv" "$STAGE/legal"
cp -a "$DIST"/. "$STAGE/mpv/"
cp "$ROOT/LICENSE" "$STAGE/legal/LICENSE.txt"
cp "$ROOT/NOTICE" "$STAGE/legal/NOTICE.txt"
cp "$ROOT/src/legal/THIRD_PARTY_NOTICES.txt" "$STAGE/legal/THIRD_PARTY_NOTICES.txt"
cp "$ROOT/legal/SOURCE-OFFER.txt" "$STAGE/legal/SOURCE-OFFER.txt"
cp "$INV" "$STAGE/legal/native-inventory.json"
node "$ROOT/legal/generate-sbom.mjs" --target x86_64-unknown-linux-gnu --out "$STAGE/legal/sbom.cdx.json"

cd "$ROOT"
npx tauri build --bundles appimage,deb --config src-tauri/packaging/linux/appimage-deb.conf.json

OUT=$ROOT/src-tauri/target/release/bundle
MAN=$OUT/package-manifest-linux.txt
{
  echo "# VHO Linux package manifest ($(date -u +%FT%TZ))"
  (cd "$STAGE" && find mpv legal -type f -print0 | sort -z | xargs -0 sha256sum)
  find "$OUT" -maxdepth 2 -type f \( -name '*.AppImage' -o -name '*.deb' \) -print0 | xargs -0 sha256sum
} > "$MAN"
cat "$MAN"
