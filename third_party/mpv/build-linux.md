# LGPL libmpv for Linux

Goal: `libmpv.so.2` + LGPL FFmpeg `.so` files shipped in `<resources>/mpv/` of the AppImage / .deb,
loaded at runtime with `dlopen` by the engine facade (ADR 0002).

> Distribution packages (`libmpv2`, `libavcodec60` on Debian/Ubuntu/Fedora) are usually built with
> `--enable-gpl`. VHO **never** loads them from the system library path; only `VHO_MPV_DLL` can
> point at one, as the user's own explicit choice. Anything we **ship** comes from this LGPL recipe.

## Executed recipe (2026-10-27): `build-linux.sh`

The script that was actually run is [`build-linux.sh`](build-linux.sh), on **Ubuntu 24.04 (WSL2)**
with the distribution's libplacebo 6.338.2 (dependencies: `scripts/linux/setup-dev.sh`). It builds
FFmpeg n8.1.3 and mpv v0.41.0, copies the files under their SONAMEs into `dist/` with
`RUNPATH=$ORIGIN`, and fails when FFmpeg has `--enable-gpl`/`--enable-nonfree`, when `ffmpeg -L`
is not LGPL, when meson's `gpl` option is not `false`, or when `libmpv.so.2` resolves a system
FFmpeg. Evidence: [`evidence/linux/`](evidence/linux/) (configure line, `gpl = False`, VO/AO lists —
no `x11`/`xv` VO —, `ldd`, `RUNPATH`, SHA-256, source commits); inventory
`legal/inventory/native-linux-x64.json`.

Not yet done: a release build on an older glibc baseline runner (AppImage portability, R02/P05).
The section below is the earlier CI draft for such a runner (Ubuntu 22.04 needs libplacebo from
source); it has not been run.

## CI draft for a glibc 2.35 runner (not run)

`ubuntu-22.04` (glibc 2.35 baseline for AppImage portability).
```bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y build-essential git meson ninja-build pkg-config nasm \
  libass-dev libfreetype-dev libharfbuzz-dev libfribidi-dev libdav1d-dev liblcms2-dev \
  libuchardet-dev libjpeg-dev zlib1g-dev libva-dev libvdpau-dev libdrm-dev \
  libx11-dev libxext-dev libxrandr-dev libxpresent-dev libxss-dev libxv-dev libxkbcommon-dev \
  libwayland-dev wayland-protocols libegl-dev libgl-dev libvulkan-dev libpulse-dev libpipewire-0.3-dev \
  libasound2-dev glslang-dev libshaderc-dev
# libplacebo from source (distro versions on 22.04 are too old for mpv 0.41)
git clone --depth 1 --branch v7.351.0 --recursive https://code.videolan.org/videolan/libplacebo.git
(cd libplacebo && meson setup build --prefix=$PWD/../_build/prefix -Dvulkan=enabled -Dopengl=enabled -Ddemos=false \
   && ninja -C build install)

PREFIX=$PWD/_build/prefix
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig:$PREFIX/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}

git clone --depth 1 --branch n8.1.3 https://github.com/FFmpeg/FFmpeg.git ffmpeg
(cd ffmpeg && ./configure --prefix=$PREFIX --enable-shared --disable-static \
   --disable-doc --disable-debug --disable-ffplay \
   --enable-libdav1d --enable-vaapi --enable-vdpau --enable-zlib \
   && make -j"$(nproc)" && make install)                 # NO --enable-gpl / --enable-nonfree

git clone --depth 1 --branch v0.41.0 https://github.com/mpv-player/mpv.git mpv
(cd mpv && meson setup build --prefix=$PREFIX --buildtype=release --default-library=shared \
   -Dgpl=false -Dlibmpv=true -Dcplayer=true \
   -Dx11=disabled -Dwayland=enabled -Degl=enabled -Degl-wayland=enabled -Dvulkan=enabled \
   -Dvaapi=enabled -Dvaapi-drm=enabled -Dvaapi-wayland=enabled \
   -Dpulse=enabled -Dpipewire=enabled -Dalsa=enabled \
   -Dlua=disabled -Djavascript=disabled -Drubberband=disabled -Dcdda=disabled -Ddvdnav=disabled \
   -Dlibbluray=disabled -Dlibarchive=disabled -Dvapoursynth=disabled -Dzimg=disabled \
   -Dmanpage-build=disabled \
 && meson compile -C build && meson install -C build)

# evidence
$PREFIX/bin/ffmpeg -hide_banner -buildconf | tee evidence-ffmpeg-buildconf.txt
! grep -q -- '--enable-gpl' evidence-ffmpeg-buildconf.txt
LD_LIBRARY_PATH=$PREFIX/lib $PREFIX/bin/mpv --version | tee evidence-mpv-version.txt
ldd $PREFIX/lib/libmpv.so.2 | tee evidence-ldd.txt
```

**Important (verified in mpv v0.41.0 `meson.build`, line ~1084):** `x11_opt = get_option('x11').require(get_option('gpl'), ...)`
— **the X11 backend is GPL-only**. An LGPL libmpv on Linux therefore has **no X11 window
backend and cannot use `wid` embedding at all** (neither on X11 nor on Wayland). Other GPL-only
features in 0.41: `cdda`, `dvbin`, `dvdnav`, `jack`, `oss-audio`, `caca`, `direct3d` (Windows d3d9 VO).

Consequence: on Linux VHO must use **path B (render API, `MPV_RENDER_API_TYPE_OPENGL`)**, where
VHO owns the GL/EGL context and mpv's windowing code is not used. The render API itself
(`video/out/vo_libmpv.c`, `render_gl.h`) is LGPL. `libva` hwdec with EGL interop
(`vaapi` + `egl`/`egl-wayland`, `egl-x11` is part of the GPL x11 feature) works with the render API via
`MPV_RENDER_PARAM_WL_DISPLAY` (Wayland) — for X11 sessions, use software decoding or `vaapi-copy`
unless VHO provides `MPV_RENDER_PARAM_X11_DISPLAY` (the param is in the LGPL API; the interop
code path `hwdec_vaapi` + `egl` must be checked in CI).

## Bundling
* AppImage + deb: `scripts/linux/package.sh` stages `dist/` into `<resources>/mpv/` (file set checked against the inventory) and the legal folder; the deb declares the system libraries as dependencies (`src-tauri/packaging/linux/appimage-deb.conf.json`, Ubuntu 24.04 package names).
* Flatpak: build FFmpeg/mpv as modules in the manifest with the same flags (org.freedesktop.Platform's
  `ffmpeg-full` extension is GPL — do not use it).

## Embedding notes (Linux)
* X11 and Wayland: path A is **not available** in an LGPL build (x11 backend is GPL-gated; Wayland
  has no foreign-window embedding anyway). Use path B: render API into a GL surface VHO owns
  (e.g. a `GtkGLArea` placed in a `GtkOverlay` below the transparent WebKitGTK webview), see
  docs/adr/0001-oynatma-motoru.md §Linux/Wayland.
