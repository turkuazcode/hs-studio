# LGPL libmpv for Windows x64 (MSYS2 UCRT64) — executed and verified

Result of the Plan 02 §1a spike (2026-10-23). Script: [`build-windows.sh`](build-windows.sh).
Evidence (sanitized copies of the build outputs): [`evidence/windows/`](evidence/windows/).

| | |
|---|---|
| FFmpeg | `n8.1.3`, shared, **no `--enable-gpl` / `--enable-version3` / `--enable-nonfree`** → `License: LGPL version 2.1 or later` |
| mpv | `v0.41.0`, meson `-Dgpl=false`, `-Dlibmpv=true` (client API 2.5) |
| Toolchain | MSYS2 UCRT64, GCC 16.2.0, meson/ninja (MSYS2 installed with `winget install --id MSYS2.MSYS2`) |
| Wall time | 27 min on a Ryzen 5 7535U with `-j6` while other builds were running: pacman deps 6 min, FFmpeg clone+configure 6 min, FFmpeg compile 12 min, mpv configure+compile 2.5 min, evidence/dist 1 min |
| Output | `_build/prefix/bin/` (mpv.exe, ffmpeg.exe, ffprobe.exe, libmpv-2.dll, av*.dll) and `_build/dist/` (redistributable set) — gitignored |

## Reproduce
```powershell
winget install --id MSYS2.MSYS2 -e --accept-package-agreements --accept-source-agreements --silent
$env:MSYSTEM='UCRT64'; $env:CHERE_INVOKING='1'
# first run of pacman -Syuu updates the MSYS2 core and closes the shell; run it twice
C:\msys64\usr\bin\bash.exe -lc "pacman -Syuu --noconfirm"; C:\msys64\usr\bin\bash.exe -lc "pacman -Syuu --noconfirm"
cd <repo>
C:\msys64\usr\bin\bash.exe -lc "JOBS=3 ./third_party/mpv/build-windows.sh"
```
Environment knobs: `FFMPEG_TAG`, `MPV_TAG`, `JOBS` (default 3), `SKIP_PACMAN=1`. The script is
idempotent: finished stages (ffmpeg.exe / libmpv-2.dll present) are skipped, so a re-run only
refreshes `evidence/` and `dist/`.

## License verification (what to check, and what we saw)
1. **FFmpeg configure summary** prints `License: LGPL version 2.1 or later`
   (`evidence/windows/ffmpeg-configure.txt`). FFmpeg's configure refuses GPL-only components
   (x264, x265, libvidstab, frei0r, …) unless `--enable-gpl` is given, so this line is authoritative.
2. **`ffmpeg -buildconf`** (`ffmpeg-buildconf.txt`): configuration contains no `--enable-gpl`,
   `--enable-version3` or `--enable-nonfree`. `ffmpeg -L` prints the LGPL 2.1+ notice (`ffmpeg-L.txt`).
3. **mpv meson**: `gpl : false` in the setup summary (`mpv-meson-setup.txt` l.193) and in
   `mpv-buildoptions-user.json`. In mpv 0.41 `-Dgpl=false` hard-disables (`.require(get_option('gpl'))`)
   these GPL-only features: `cdda`, `dvbin`, `dvdnav`, `jack`, `oss-audio`, `caca`, `direct3d` (old d3d9 VO)
   and **`x11`**. Nothing VHO needs on Windows is lost: `d3d11`, `gpu-next`/libplacebo, `d3d11va`
   hwdec, `wasapi`, `libass`, `win32-desktop` (needed for `wid` embedding) are all LGPL.
   Enabled feature list: `build-date cplugins d3d-hwaccel d3d11 d3d9-hwaccel … libass libavdevice
   libplacebo shaderc spirv-cross uchardet vulkan wasapi win32 win32-desktop zlib`.
4. **Guard**: the script aborts if GPL-only MSYS2 packages (x264, x265, rubberband, libdvdnav,
   libcdio, xvidcore, frei0r, vidstab) are installed. Lua/JavaScript are disabled (VHO draws its
   own UI; no OSC/ytdl scripts).
5. **Runtime check**: the spike app reads `mpv-version` = `mpv v0.41.0`, `ffmpeg-version` = `n8.1.3`,
   client API `2.5` from the loaded DLL (see `experiments/mpv-spike/results/owned-*.log.jsonl`).

## Redistributable set (`_build/dist`, 38 DLLs)
Total **67.3 MB** uncompressed, **28.2 MB** zipped (for comparison: the GPL shinchiro
`libmpv-2.dll` used only as a reference in the spike is a single 121 MB static DLL).
Largest: `avcodec-62.dll` 19.4 MB, `libshaderc_shared.dll` 10.7 MB, `avfilter-11.dll` 5.9 MB,
`libspirv-cross-c-shared.dll` 3.4 MB, **`libmpv-2.dll` 3.2 MB**, `avformat-62.dll` 2.8 MB,
`libstdc++-6.dll` 2.7 MB. Full list: `evidence/windows/dist-sizes.tsv`; dependency tree:
`libmpv-ntldd.txt`. Windows system DLLs (System32 / WinSxS: gdiplus, comctl32, d3d11, …) are not shipped.

Licenses of the non-FFmpeg/mpv DLLs (all compatible with the policy, dynamic linking):
libass ISC · freetype FTL (BSD-style, credit required) · harfbuzz MIT · fribidi LGPL-2.1+ ·
glib/libintl/libiconv LGPL-2.1+ · graphite2 LGPL-2.1+/MPL-2.0 · libplacebo LGPL-2.1+ · libdovi MIT ·
dav1d BSD-2 · shaderc / spirv-cross / vulkan-loader Apache-2.0 · lcms2 MIT · libjpeg-turbo BSD-3/IJG ·
uchardet MPL-1.1 (tri-license) · libpng libpng-2.0 · zlib Zlib · bzip2 BSD-style · liblzma 0BSD ·
brotli MIT · pcre2 BSD-3 · expat MIT · fontconfig MIT-style · libunibreak Zlib ·
libwinpthread MIT/ZPL · **libstdc++ / libgcc_s: GPL-3 with the GCC Runtime Library Exception**
(explicitly permits shipping with non-GPL software).
Every DLL must be listed in `legal/NOTICES_HEADER.txt` / `legal/generate-notices.ps1` when B1 ships it.

## Size reductions to consider (Dalga 2)
* `--disable-avdevice`-like trimming is not possible for mpv (needs libavfilter), but FFmpeg can drop
  encoders/muxers mpv never uses (`--disable-encoders --enable-encoder=mjpeg,png` for screenshots,
  `--disable-muxers --enable-muxer=image2`) → avcodec roughly −30 %.
* Build harfbuzz without glib (`-Dglib=disabled`) → drop glib, pcre2, libintl (~2.6 MB).
* Static-link everything into a single `libmpv-2.dll` (LGPL allows it as long as the DLL as a whole
  stays replaceable and the sources/build script are offered) → fewer files, smaller with LTO.

## LGPL obligations for VHO releases
* Load `libmpv-2.dll` dynamically (VHO does: `libloading` at runtime) and allow the user to replace it.
* Ship/offer: this build script, the exact source tags (FFmpeg `n8.1.3`, mpv `v0.41.0`, MSYS2 package
  list `evidence/windows/msys2-packages.txt`), and the license texts; link to them from the About/
  notices screen.
