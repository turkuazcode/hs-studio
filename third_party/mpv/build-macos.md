# LGPL libmpv for macOS (recipe — to be executed in CI, not yet run)

Goal: `libmpv.2.dylib` + LGPL FFmpeg dylibs, universal or per-arch (arm64 + x86_64), bundled in
`VHO.app/Contents/Frameworks/`, loaded at runtime (`dlopen`) by the engine facade.

> Do **not** use `brew install mpv` / `brew install ffmpeg` as-is: Homebrew's `ffmpeg` formula is
> configured with `--enable-gpl` (x264, x265, ...), so a libmpv linked against it is GPL.
> Homebrew is used only for build tools and LGPL-compatible libraries.

## Runner
`macos-14` (arm64) and `macos-13` (x86_64) GitHub runners, Xcode CLT. Set
`MACOSX_DEPLOYMENT_TARGET=11.0`.

## Steps
```bash
set -euo pipefail
brew install meson ninja pkg-config nasm \
  libass freetype harfbuzz fribidi dav1d libplacebo little-cms2 uchardet jpeg-turbo \
  shaderc spirv-cross vulkan-headers molten-vk
# guard: these must NOT be present (GPL), or FFmpeg/mpv could pick them up
for f in x264 x265 rubberband libdvdnav libcdio xvid; do brew list "$f" >/dev/null 2>&1 && { echo "GPL dep $f installed"; exit 2; }; done

PREFIX=$PWD/_build/prefix
export PKG_CONFIG_PATH=$PREFIX/lib/pkgconfig:$PKG_CONFIG_PATH

git clone --depth 1 --branch n8.1.3 https://github.com/FFmpeg/FFmpeg.git ffmpeg
(cd ffmpeg && ./configure --prefix=$PREFIX --enable-shared --disable-static \
   --disable-doc --disable-debug --disable-ffplay \
   --enable-libdav1d --enable-videotoolbox --enable-audiotoolbox --enable-zlib \
   && make -j"$(sysctl -n hw.ncpu)" && make install)      # NO --enable-gpl / --enable-nonfree

git clone --depth 1 --branch v0.41.0 https://github.com/mpv-player/mpv.git mpv
(cd mpv && meson setup build --prefix=$PREFIX --buildtype=release --default-library=shared \
   -Dgpl=false -Dlibmpv=true -Dcplayer=true \
   -Dcocoa=enabled -Dgl-cocoa=enabled -Dvideotoolbox-gl=enabled -Dmacos-media-player=enabled \
   -Dswift-build=enabled -Dvulkan=enabled \
   -Dlua=disabled -Djavascript=disabled -Drubberband=disabled -Dcdda=disabled -Ddvdnav=disabled \
   -Dlibbluray=disabled -Dlibarchive=disabled -Dvapoursynth=disabled -Dzimg=disabled \
   -Dmanpage-build=disabled \
 && meson compile -C build && meson install -C build)

# evidence
$PREFIX/bin/ffmpeg -hide_banner -buildconf | tee evidence-ffmpeg-buildconf.txt
! grep -q -- '--enable-gpl' evidence-ffmpeg-buildconf.txt
$PREFIX/bin/mpv --version | tee evidence-mpv-version.txt      # must not print "GPL"
otool -L $PREFIX/lib/libmpv.2.dylib | tee evidence-otool.txt
```

## Bundling
* Collect `libmpv.2.dylib` and every non-system dependency with
  [`dylibbundler`](https://github.com/auriamg/macdylibbundler) (MIT) into `Frameworks/`, rewriting
  install names to `@rpath/...`; add `@executable_path/../Frameworks` as rpath of the VHO binary.
* Each dylib is code-signed with the app's Developer ID (hardened runtime; no `disable-library-validation`
  needed because everything is signed with the same team ID).
* Notarize the whole `.app`.

## Embedding notes (macOS)
* Path A: create an `NSView` beneath the `WKWebView` (same `NSWindow` content view), pass its pointer
  as `wid` (int64). The WKWebView needs `drawsBackground = NO` (`_setDrawsBackground:` / Tauri
  `transparent: true` + `macOSPrivateApi: true`) so the video shows through. mpv's cocoa backend
  renders through its own `CAOpenGLLayer`/Metal-backed layer inside that view.
* `macOSPrivateApi: true` blocks Mac App Store distribution; for MAS, use path B (render API into a
  `CAOpenGLLayer`/`CAMetalLayer` we own) instead.
