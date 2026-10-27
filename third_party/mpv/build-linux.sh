#!/usr/bin/env bash
# LGPL libmpv + FFmpeg for Linux (P03). Executed on Ubuntu 24.04 (WSL2); see build-linux.md.
#   bash third_party/mpv/build-linux.sh [WORKDIR]      (deps: scripts/linux/setup-dev.sh)
# Output: $WORKDIR/dist/{libmpv.so.2, libav*.so.*, libsw*.so.*, ffmpeg, ffprobe} with
# RUNPATH=$ORIGIN, plus $WORKDIR/evidence/*.txt (configure lines, GPL checks, ldd).
# Never uses the distribution's libmpv/libav* (GPL builds).
set -euo pipefail

WORK=${1:-$HOME/vho-mpv-build}
JOBS=${JOBS:-5}
FFMPEG_TAG=n8.1.3
MPV_TAG=v0.41.0
PREFIX=$WORK/prefix
mkdir -p "$WORK/src" "$WORK/evidence" "$WORK/dist"
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig:$PREFIX/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}

cd "$WORK/src"
[ -d ffmpeg ] || git clone -q --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg.git ffmpeg
[ -d mpv ] || git clone -q --depth 1 --branch "$MPV_TAG" https://github.com/mpv-player/mpv.git mpv

# FFmpeg: LGPL (no --enable-gpl / --enable-nonfree), shared, VAAPI for hwdec
if [ ! -f "$PREFIX/lib/libavcodec.so" ]; then
  (cd ffmpeg && ./configure --prefix="$PREFIX" --enable-shared --disable-static \
     --disable-doc --disable-debug --disable-ffplay \
     --enable-libdav1d --enable-vaapi --enable-zlib \
   && make -j"$JOBS" && make install)
fi

# mpv: -Dgpl=false (the X11 backend is GPL-gated in 0.41, so it is off by construction);
# libmpv for the render API (OpenGL via EGL/GLX is provided by VHO's GL context)
if [ ! -f "$PREFIX/lib/x86_64-linux-gnu/libmpv.so.2" ] && [ ! -f "$PREFIX/lib/libmpv.so.2" ]; then
  (cd mpv && meson setup build --prefix="$PREFIX" --buildtype=release --default-library=shared \
     -Dgpl=false -Dlibmpv=true -Dcplayer=true \
     -Dwayland=enabled -Degl=enabled -Degl-wayland=enabled -Dgl=enabled \
     -Dvaapi=enabled -Dvaapi-drm=enabled -Dvaapi-wayland=enabled \
     -Dpulse=enabled -Dpipewire=enabled -Dalsa=enabled \
     -Dlua=disabled -Djavascript=disabled -Drubberband=disabled -Dcdda=disabled -Ddvdnav=disabled \
     -Dlibbluray=disabled -Dlibarchive=disabled -Dvapoursynth=disabled -Dzimg=disabled \
     -Dmanpage-build=disabled -Dhtml-build=disabled \
   && meson compile -C build -j "$JOBS" && meson install -C build)
fi

LIBDIR=$PREFIX/lib
[ -f "$LIBDIR/libmpv.so.2" ] || LIBDIR=$PREFIX/lib/x86_64-linux-gnu
MPVLIB=$(readlink -f "$LIBDIR/libmpv.so.2")

# dist: real files under their SONAMEs, RUNPATH=$ORIGIN so the app's dlopen resolves our FFmpeg
rm -rf "$WORK/dist" && mkdir -p "$WORK/dist"
cp "$MPVLIB" "$WORK/dist/libmpv.so.2"
for lib in avcodec avformat avutil avfilter avdevice swscale swresample; do
  f=$(ls "$PREFIX/lib/lib$lib.so."* | sort | head -1)       # libavcodec.so.62 (SONAME link)
  cp -L "$f" "$WORK/dist/$(basename "$f")"
done
cp -L "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$WORK/dist/"
for f in "$WORK/dist"/*; do patchelf --set-rpath '$ORIGIN' "$f"; done

# evidence (license + dependency resolution)
"$WORK/dist/ffmpeg" -hide_banner -buildconf > "$WORK/evidence/ffmpeg-buildconf.txt"
"$WORK/dist/ffmpeg" -hide_banner -L 2>/dev/null | head -5 > "$WORK/evidence/ffmpeg-license.txt" || true
if grep -q -- '--enable-gpl\|--enable-nonfree' "$WORK/evidence/ffmpeg-buildconf.txt"; then echo "GPL FFmpeg!"; exit 1; fi
grep -q "LGPL" "$WORK/evidence/ffmpeg-license.txt"
meson introspect mpv/build --buildoptions | python3 -c 'import json,sys; o={x["name"]:x["value"] for x in json.load(sys.stdin)}; print("gpl =", o["gpl"]); print("x11 =", o["x11"]); assert o["gpl"] is False' \
  | tee "$WORK/evidence/mpv-options.txt"
LD_LIBRARY_PATH="$WORK/dist" "$PREFIX/bin/mpv" --version > "$WORK/evidence/mpv-version.txt" 2>&1 || true
ldd "$WORK/dist/libmpv.so.2" > "$WORK/evidence/ldd-libmpv.txt"
if grep -E "libav(codec|format|util)" "$WORK/evidence/ldd-libmpv.txt" | grep -v "$WORK/dist" ; then
  echo "libmpv resolves a system FFmpeg"; exit 1
fi
(cd "$WORK/dist" && sha256sum * > "$WORK/evidence/dist-sha256.txt")
ls -la "$WORK/dist"
cat "$WORK/evidence/mpv-options.txt"
