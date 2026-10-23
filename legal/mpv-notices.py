"""Builds the libmpv section of legal/NOTICES_HEADER.txt (the 38 DLLs of the LGPL build).

  python legal/mpv-notices.py <ffmpeg source dir> [<MSYS2 ucrt64 share/licenses dir>]

Replaces the text between the "BEGIN libmpv" / "END libmpv" marker lines of NOTICES_HEADER.txt.
License texts come from the FFmpeg source tree (LGPL-2.1) and from the MSYS2 packages the
DLLs were taken from (third_party/mpv/evidence/windows/msys2-packages.txt has the versions).
Run legal/generate-notices.ps1 afterwards.
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FFMPEG = sys.argv[1]
LIC = sys.argv[2] if len(sys.argv) > 2 else r"C:\msys64\ucrt64\share\licenses"

pkgs = {}
for line in io.open(os.path.join(ROOT, "third_party/mpv/evidence/windows/msys2-packages.txt"), encoding="utf-8"):
    name, ver = line.split()
    pkgs[name.replace("mingw-w64-ucrt-x86_64-", "")] = ver

# dll, component, msys2 package (None = built from source), license, source, license files
DLLS = [
    ("libmpv-2.dll", "mpv v0.41.0 (built with -Dgpl=false)", None, "LGPL-2.1-or-later",
     "https://github.com/mpv-player/mpv/tree/v0.41.0", []),
    ("avcodec-62.dll, avdevice-62.dll, avfilter-11.dll, avformat-62.dll, avutil-60.dll, swresample-6.dll, swscale-9.dll",
     "FFmpeg n8.1.3 (built without --enable-gpl / --enable-nonfree)", None, "LGPL-2.1-or-later",
     "https://git.ffmpeg.org/gitweb/ffmpeg.git/tree/refs/tags/n8.1.3", []),
    ("libass-9.dll", "libass", "libass", "ISC", "https://github.com/libass/libass", []),
    ("libfreetype-6.dll", "FreeType", "freetype", "FreeType License (FTL)", "https://freetype.org", ["freetype/FTL.TXT"]),
    ("libharfbuzz-0.dll", "HarfBuzz", "harfbuzz", "MIT (Old MIT)", "https://github.com/harfbuzz/harfbuzz", ["harfbuzz/COPYING"]),
    ("libfribidi-0.dll", "GNU FriBidi", "fribidi", "LGPL-2.1-or-later", "https://github.com/fribidi/fribidi", ["fribidi/COPYING"]),
    ("libglib-2.0-0.dll", "GLib", "glib2", "LGPL-2.1-or-later", "https://gitlab.gnome.org/GNOME/glib", ["glib2/COPYING"]),
    ("libintl-8.dll", "GNU gettext runtime (libintl)", "gettext-runtime", "LGPL-2.1-or-later", "https://www.gnu.org/software/gettext/", ["gettext-runtime/intl/COPYING.LIB"]),
    ("libiconv-2.dll", "GNU libiconv", "libiconv", "LGPL-2.1-or-later", "https://www.gnu.org/software/libiconv/", ["libiconv/COPYING.LIB"]),
    ("libgraphite2.dll", "Graphite2", "graphite2", "LGPL-2.1-or-later OR MPL-2.0 OR GPL-2.0-or-later OR MIT (used under LGPL-2.1/MPL-2.0)", "https://github.com/silnrsi/graphite", ["graphite2/LICENSE"]),
    ("libplacebo-360.dll", "libplacebo", "libplacebo", "LGPL-2.1-or-later", "https://code.videolan.org/videolan/libplacebo", ["libplacebo/LICENSE"]),
    ("libdovi.dll", "libdovi (dovi_tool)", "libdovi", "MIT", "https://github.com/quietvoid/dovi_tool", ["libdovi/LICENSE"]),
    ("libdav1d-7.dll", "dav1d", "dav1d", "BSD-2-Clause", "https://code.videolan.org/videolan/dav1d", ["dav1d/COPYING", "dav1d/PATENTS"]),
    ("libshaderc_shared.dll", "shaderc", "shaderc", "Apache-2.0", "https://github.com/google/shaderc", ["shaderc/LICENSE"]),
    ("libspirv-cross-c-shared.dll", "SPIRV-Cross", "spirv-cross", "Apache-2.0", "https://github.com/KhronosGroup/SPIRV-Cross", ["spirv-cross/LICENSE"]),
    ("vulkan-1.dll", "Vulkan Loader", "vulkan-loader", "Apache-2.0", "https://github.com/KhronosGroup/Vulkan-Loader", ["vulkan-loader/LICENSE"]),
    ("liblcms2-2.dll", "Little CMS", "lcms2", "MIT", "https://github.com/mm2/Little-CMS", ["lcms2/LICENSE", "lcms2/LICENSE-fast_float"]),
    ("libjpeg-8.dll", "libjpeg-turbo", "libjpeg-turbo", "IJG AND BSD-3-Clause AND Zlib", "https://libjpeg-turbo.org", ["libjpeg-turbo/LICENSE.md", "libjpeg-turbo/README.ijg"]),
    ("libuchardet.dll", "uchardet", "uchardet", "MPL-1.1 OR GPL-2.0-or-later OR LGPL-2.1-or-later (used under LGPL-2.1/MPL-1.1)", "https://www.freedesktop.org/wiki/Software/uchardet/", ["uchardet/COPYING"]),
    ("libpng16-16.dll", "libpng", "libpng", "libpng-2.0", "http://www.libpng.org/pub/png/libpng.html", ["libpng/LICENSE"]),
    ("zlib1.dll", "zlib", "zlib", "Zlib", "https://zlib.net", ["zlib/LICENSE"]),
    ("libbz2-1.dll", "bzip2", "bzip2", "bzip2-1.0.6 (BSD-style)", "https://sourceware.org/bzip2/", ["bzip2/LICENSE"]),
    ("liblzma-5.dll", "XZ Utils (liblzma)", "xz", "0BSD", "https://tukaani.org/xz/", ["xz/COPYING.0BSD"]),
    ("libbrotlicommon.dll, libbrotlidec.dll", "Brotli", "brotli", "MIT", "https://github.com/google/brotli", ["brotli/LICENSE"]),
    ("libpcre2-8-0.dll", "PCRE2", "pcre2", "BSD-3-Clause (with PCRE2 exception)", "https://github.com/PCRE2Project/pcre2", ["pcre2/LICENCE.md"]),
    ("libexpat-1.dll", "Expat", "expat", "MIT", "https://libexpat.github.io", ["expat/COPYING"]),
    ("libfontconfig-1.dll", "Fontconfig", "fontconfig", "MIT-style (HPND)", "https://www.freedesktop.org/wiki/Software/fontconfig/", ["fontconfig/COPYING"]),
    ("libunibreak-7.dll", "libunibreak", "libunibreak", "Zlib", "https://github.com/adah1972/libunibreak", ["libunibreak/LICENCE"]),
    ("libwinpthread-1.dll", "mingw-w64 winpthreads", "libwinpthread", "MIT AND ZPL-2.1", "https://www.mingw-w64.org", ["libwinpthread/COPYING"]),
    ("libstdc++-6.dll, libgcc_s_seh-1.dll", "GCC runtime libraries", "libstdc++", "GPL-3.0-or-later WITH GCC-exception-3.1", "https://gcc.gnu.org", ["libstdc++/COPYING.RUNTIME", "libstdc++/COPYING3"]),
]

ISC_LIBASS = """Copyright (C) 2006-2016 libass contributors

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
"""


def read(path):
    with io.open(path, encoding="utf-8", errors="replace") as f:
        return f.read().replace("\r\n", "\n").strip("\n") + "\n"


def kind(text):
    head = re.sub(r"\s+", " ", text[:400])
    if "LESSER GENERAL PUBLIC LICENSE Version 2.1" in head:
        return "LGPL-2.1"
    if "Apache License Version 2.0" in head:
        return "Apache-2.0"
    return None


out = []
w = out.append
w("2.5 libmpv playback engine (Windows: separate DLLs next to VHO.exe, loaded at runtime)")
w("")
w("    VHO plays video with libmpv. The DLLs below are an LGPL build (mpv -Dgpl=false, FFmpeg")
w("    without --enable-gpl / --enable-version3 / --enable-nonfree). They are NOT linked into")
w("    VHO.exe: VHO loads libmpv-2.dll at runtime, so you may replace these DLLs with your own")
w("    (compatible) build; without them VHO falls back to its HTML5 video engine.")
w("    Corresponding source: the exact upstream tags below, the build script")
w("    third_party/mpv/build-windows.sh and the MSYS2 package versions in")
w("    third_party/mpv/evidence/windows/msys2-packages.txt (VHO source repository). On request")
w("    the VHO authors provide the complete corresponding source of these DLLs for three years")
w("    from the release that shipped them.")
w("")
for dll, comp, pkg, lic, src, _ in DLLS:
    ver = f" {pkgs[pkg]} (MSYS2 package)" if pkg and pkg in pkgs else ""
    w(f"    - {dll}")
    w(f"        {comp}{ver} — {lic}")
    w(f"        Source: {src}")
w("")
w("    License texts of the DLLs (LGPL-2.1 and Apache-2.0 are reproduced once, at their first use):")
w("")
seen = set()
lgpl = read(os.path.join(FFMPEG, "COPYING.LGPLv2.1"))
w("    ---- GNU Lesser General Public License 2.1 (mpv, FFmpeg, FriBidi, GLib, libintl, libiconv,")
w("         libplacebo; Graphite2 and uchardet are used under it) ----")
w("")
out.append(lgpl)
seen.add("LGPL-2.1")
for dll, comp, pkg, lic, src, files in DLLS:
    if pkg == "libass":
        w(f"    ---- {comp} ({dll}) ----")
        w("")
        out.append(ISC_LIBASS)
        continue
    for rel in files:
        path = os.path.join(LIC, rel)
        if not os.path.isfile(path):
            raise SystemExit(f"missing license file {path}")
        text = read(path)
        k = kind(text)
        if k in seen:
            w(f"    ---- {comp}: {os.path.basename(rel)} = {k}, text reproduced above ----")
            w("")
            continue
        if k:
            seen.add(k)
        w(f"    ---- {comp} ({dll}): {os.path.basename(rel)} ----")
        w("")
        out.append(text)

section = "\n".join(out).rstrip("\n") + "\n"
hdr_path = os.path.join(HERE, "NOTICES_HEADER.txt")
hdr = io.open(hdr_path, encoding="utf-8").read()
begin, end = "<<< BEGIN libmpv (generated by legal/mpv-notices.py) >>>\n", "<<< END libmpv >>>\n"
block = begin + "\n" + section + "\n" + end
if begin in hdr:
    hdr = hdr[: hdr.index(begin)] + block + hdr[hdr.index(end) + len(end):]
else:
    anchor = "--------------------------------------------------------------------------\n3. USED BUT NOT DISTRIBUTED BY VHO"
    assert anchor in hdr
    hdr = hdr.replace(anchor, block + "\n" + anchor, 1)
io.open(hdr_path, "w", encoding="utf-8", newline="\n").write(hdr)
print(f"libmpv section: {len(section) // 1024} KB, {len(DLLS)} entries")
