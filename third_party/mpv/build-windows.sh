#!/usr/bin/env bash
# LGPL-only libmpv + FFmpeg build for Windows x64 (MSYS2 UCRT64 / MinGW-w64).
#
# Run from PowerShell (see build-windows.md):
#   $env:MSYSTEM='UCRT64'; $env:CHERE_INVOKING='1'
#   C:\msys64\usr\bin\bash.exe -lc "./third_party/mpv/build-windows.sh"
#
# Produces (gitignored):
#   third_party/mpv/_build/prefix/bin/libmpv-2.dll, mpv.exe, ffmpeg.exe, avcodec-*.dll ...
#   third_party/mpv/_build/dist/        -> redistributable DLL set (libmpv + all non-system deps)
#   third_party/mpv/_build/evidence/    -> license verification outputs
#
# License policy (docs/plans/00-YOL-HARITASI.md): FFmpeg WITHOUT --enable-gpl/--enable-nonfree,
# mpv with -Dgpl=false, no GPL libraries installed (x264, x265, rubberband, libdvdnav, libcdio...).
set -euo pipefail

FFMPEG_TAG="${FFMPEG_TAG:-n8.1.3}"
MPV_TAG="${MPV_TAG:-v0.41.0}"
JOBS="${JOBS:-3}"   # other agents share the CPU

if [[ "${MSYSTEM:-}" != "UCRT64" ]]; then
  echo "Run inside MSYS2 with MSYSTEM=UCRT64" >&2; exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HERE/_build"
SRC="$WORK/src"
PREFIX="$WORK/prefix"
EVID="$WORK/evidence"
DIST="$WORK/dist"
mkdir -p "$SRC" "$PREFIX" "$EVID"

step() { echo; echo "==== [$(date +%T)] $*"; }

# ---------------------------------------------------------------- 1. toolchain + LGPL-compatible deps
if [[ "${SKIP_PACMAN:-0}" != "1" ]]; then
  step "pacman packages"
  P=mingw-w64-ucrt-x86_64
  pacman -S --needed --noconfirm git make diffutils \
    $P-gcc $P-meson $P-ninja $P-pkgconf $P-nasm $P-cmake $P-python \
    $P-libass $P-freetype $P-harfbuzz $P-fribidi $P-fontconfig \
    $P-dav1d $P-libplacebo $P-zlib $P-uchardet $P-lcms2 $P-libjpeg-turbo \
    $P-shaderc $P-spirv-cross $P-vulkan-headers $P-vulkan-loader $P-libiconv \
    $P-ntldd
fi

# Guard: refuse to continue if known GPL-only libraries are installed (they could be auto-detected).
for bad in x264 x265 rubberband libdvdnav libdvdread libcdio libcdio-paranoia xvidcore frei0r-plugins libvidstab; do
  if pacman -Q "mingw-w64-ucrt-x86_64-$bad" >/dev/null 2>&1; then
    echo "GPL package mingw-w64-ucrt-x86_64-$bad is installed; remove it before building." >&2; exit 2
  fi
done
pacman -Q | grep '^mingw-w64-ucrt' > "$EVID/msys2-packages.txt"

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export PATH="$PREFIX/bin:$PATH"

# ---------------------------------------------------------------- 2. FFmpeg (LGPL v2.1+)
if [[ ! -f "$PREFIX/bin/ffmpeg.exe" ]]; then
  step "FFmpeg $FFMPEG_TAG"
  [[ -d "$SRC/ffmpeg" ]] || git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git "$SRC/ffmpeg"
  cd "$SRC/ffmpeg"
  # NOTE: deliberately NO --enable-gpl, NO --enable-version3, NO --enable-nonfree.
  ./configure \
    --prefix="$PREFIX" \
    --target-os=mingw32 --arch=x86_64 \
    --enable-shared --disable-static \
    --disable-doc --disable-debug --disable-ffplay \
    --enable-libdav1d \
    --enable-d3d11va --enable-dxva2 --enable-d3d12va \
    --enable-mediafoundation \
    --enable-zlib --enable-iconv \
    --enable-schannel \
    --disable-sdl2 --disable-libxcb \
    2>&1 | tee "$EVID/ffmpeg-configure.log"
  make -j"$JOBS"
  make install
fi

# ---------------------------------------------------------------- 3. mpv / libmpv (LGPL v2.1+)
if [[ ! -f "$PREFIX/bin/libmpv-2.dll" ]]; then
  step "mpv $MPV_TAG"
  [[ -d "$SRC/mpv" ]] || git clone --depth 1 --branch "$MPV_TAG" https://github.com/mpv-player/mpv.git "$SRC/mpv"
  cd "$SRC/mpv"
  rm -rf build
  meson setup build \
    --prefix="$PREFIX" --buildtype=release --default-library=shared \
    -Dgpl=false \
    -Dlibmpv=true -Dcplayer=true \
    -Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled \
    -Duchardet=enabled -Dlcms2=enabled -Djpeg=enabled -Diconv=enabled \
    -Dlua=disabled -Djavascript=disabled -Drubberband=disabled -Dcdda=disabled \
    -Ddvdnav=disabled -Dlibbluray=disabled -Dlibarchive=disabled -Dvapoursynth=disabled \
    -Dzimg=disabled -Dsdl2-audio=disabled -Dsdl2-video=disabled -Dsdl2-gamepad=disabled \
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled \
    2>&1 | tee "$EVID/mpv-meson-setup.log"
  meson compile -C build -j "$JOBS"
  meson install -C build
fi

# ---------------------------------------------------------------- 4. evidence
step "evidence"
cd "$WORK"
"$PREFIX/bin/ffmpeg.exe" -hide_banner -buildconf > "$EVID/ffmpeg-buildconf.txt" 2>&1 || true
"$PREFIX/bin/ffmpeg.exe" -hide_banner -L > "$EVID/ffmpeg-L.txt" 2>&1 || true
"$PREFIX/bin/ffmpeg.exe" -version > "$EVID/ffmpeg-version.txt" 2>&1 || true
"$PREFIX/bin/mpv.exe" --version > "$EVID/mpv-version.txt" 2>&1 || true
"$PREFIX/bin/mpv.exe" --list-options > /dev/null 2>&1 || true
grep -E '^(gpl|.*GPL)' "$SRC/mpv/build/meson-logs/meson-log.txt" > "$EVID/mpv-meson-gpl-lines.txt" 2>/dev/null || true
cp "$SRC/mpv/build/meson-info/intro-buildoptions.json" "$EVID/mpv-buildoptions.json" 2>/dev/null || true

# Redistributable set: libmpv-2.dll + every non-system DLL it pulls in (recursive, via ntldd).
step "dist"
rm -rf "$DIST"; mkdir -p "$DIST"
ntldd -R "$PREFIX/bin/libmpv-2.dll" > "$EVID/libmpv-ntldd.txt" 2>&1 || true
cp "$PREFIX/bin/libmpv-2.dll" "$DIST/"
grep -oiE '=> [A-Za-z]:[^ ]+\.dll' "$EVID/libmpv-ntldd.txt" | sed 's/^=> //' | sort -u | while read -r dll; do
  case "$(echo "$dll" | tr 'A-Z' 'a-z')" in
    [a-z]:\\windows\\*|[a-z]:/windows/*) ;;  # OS DLLs (System32, WinSxS: gdiplus, comctl32) are not shipped
    *) cp "$(cygpath -u "$dll")" "$DIST/" ;;
  esac
done
cp "$PREFIX/include/mpv/"*.h "$EVID/" 2>/dev/null || true
( cd "$DIST" && ls -l --block-size=1 *.dll | awk '{print $5"\t"$9}' | sort -rn ) > "$EVID/dist-sizes.tsv"
du -sb "$DIST" > "$EVID/dist-total.txt"
step "done"
echo "DIST: $DIST"
