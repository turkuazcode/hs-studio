<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="HS Studio logo">

# HS Studio

**Video player, photo studio and music player in one open-source desktop app.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/turkuazcode/hs-studio?include_prereleases&label=release)](https://github.com/turkuazcode/hs-studio/releases)
[![Windows](https://img.shields.io/badge/Windows%2011%20x64-alpha-2ea44f)](docs/platform-support.md)
[![Linux](https://img.shields.io/badge/Linux-preview%2C%20untested-orange)](docs/status/platform-plan-macos-linux.md)
[![macOS](https://img.shields.io/badge/macOS-not%20yet-lightgrey)](docs/status/platform-plan-macos-linux.md)

[Download](https://github.com/turkuazcode/hs-studio/releases) · [Features](#features) · [How to install](#how-to-install) · [Platform status](#platform-status) · [Building from source](#building-from-source) · [License](#license)

</div>

<p align="center"><img src="docs/screenshots/02-video.png" alt="HS Studio playing a video" width="900"></p>

HS Studio uses **libmpv** (LGPL) as its playback engine and **Tauri 2 + Rust** as its desktop layer. It opens videos, photos and music in the same simple interface, and it can enhance photos and videos **without AI models**, never changing the original file.

> **Alpha release.** Verified by automated tests on Windows 11 x64 only. Installation on a clean machine, screen reader use and real user testing have not been done yet. Details: [release checklist](docs/releases/0.1.0-alpha-checklist.md).

The app interface is available in Turkish and English.

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/01-baslangic.png" alt="Start screen" width="440"> | <img src="docs/screenshots/04-foto-studyo.png" alt="Photo studio" width="440"> |
| **Start screen**: open a file, open a URL or browse a folder | **Photo studio**: folder grid, search, sorting, batch actions |
| <img src="docs/screenshots/03-fotograf-iyilestirme.png" alt="Photo enhancement" width="440"> | <img src="docs/screenshots/05-video-iyilestirme.png" alt="Video enhancement" width="440"> |
| **Enhance photo**: denoise, shadow lift, 2× upscale; no AI | **Enhance video**: noise/block reduction, sharpening, 10 s side-by-side preview |

<sub>The photos in the screenshots are in the public domain (NASA; Library of Congress / Dorothea Lange; publications before 1930). The video was made from NASA's Earthrise photo. The screenshots can be regenerated with `node scripts/screenshots.mjs`. The screenshots show the Turkish interface.</sub>

## Features

| | |
|---|---|
| 🎞️ **Playback** | libmpv + FFmpeg: audio/subtitle tracks, chapters, frame stepping, A-B loop, speed, HDR tone mapping, hardware decoding. SRT/VTT/ASS subtitles (UTF-8 and Windows-1254). Volume up to 200% (with a limiter), 10-band equalizer, audio filters, sleep timer, resume where you left off |
| 🖼️ **Photos** | Viewer and studio: grid, EXIF and histogram, crop/rotate, compare, batch convert, stars and tags. HEIC/AVIF through the Windows codecs; embedded previews for RAW |
| ✨ **Enhance photo** | A classic chain without models: denoise, shadow lift, halo-free sharpening, 2× upscale, optional film grain. The result is written to a separate file; lost detail is not “invented” |
| 🎬 **Enhance video** | An FFmpeg chain without models: deinterlacing when needed, block and temporal noise reduction, scaling, light sharpening. 10 s side-by-side preview, progress and cancel; the result is a new MKV next to the original, with audio and subtitles kept. HDR input is blocked (the output is 8-bit SDR) |
| 🪄 **Smart editing** | Object removal (LaMa) and colorizing black-and-white photos (DDColor). The models are downloaded on first use, only with your consent, and verified with SHA-256 |
| 🎵 **Music and library** | Library scanning and search, playlists (M3U/PLS), gapless playback, ReplayGain, Windows media keys |
| 🧰 **Media actions** | Trim, convert, GIF, extract audio, save frame, edit tags and lyrics, OCR, share/print |
| 🌐 **Network** | HTTP/HTTPS streams, HLS, internet radio (ICY titles), cast to UPnP/DLNA devices. Not yet tried on a real TV or speaker |
| 🔒 **Safe file handling** | Originals are kept; output goes to a separate file; an interrupted job leaves no half-written file. The app writes only to folders you choose |
| 🌍 **Language** | Turkish and English interface; works offline (fonts included) |

**Deliberately not in this release:** model-based video enhancement, resuming long videos from the last segment, Chromecast, mobile apps. Background removal is experimental and hidden by default. No “higher quality” claim is made for the enhancements: [measurement report](docs/benchmarks/2026-10-28-klasik-zincir.md).

## Download

The installers are on the [Releases](https://github.com/turkuazcode/hs-studio/releases) page. Each file's SHA-256 is listed in `SHA256SUMS.txt`.

| Platform | File | Status |
|---|---|---|
| **Windows 10/11 x64** | `HS.Studio_<version>_x64-UNSIGNED-setup.exe` | Alpha. Installs per user, no administrator rights needed. Not code-signed yet, so Windows SmartScreen may show an “unrecognized app” warning |
| **Linux x64** | `.AppImage`, `.deb` | **Preview, not tested on a real device.** Bug reports are very welcome |
| **macOS** | — | Not available yet: the macOS video engine is not written ([plan](docs/status/platform-plan-macos-linux.md)) |

## How to install

### Windows 10/11 x64

1. Open the latest release on the [Releases](https://github.com/turkuazcode/hs-studio/releases) page and download `HS.Studio_<version>_x64-UNSIGNED-setup.exe` from *Assets*.
2. Optional: check the file. In PowerShell, `Get-FileHash ".\HS.Studio_<version>_x64-UNSIGNED-setup.exe"` must print the value listed in `SHA256SUMS.txt` (the list names the file with a space instead of the dot GitHub uses).
3. Double-click the file. The installer is not code-signed yet, so if SmartScreen says “Windows protected your PC”, choose **More info → Run anyway**.
4. Finish the setup wizard. HS Studio is installed for your user account only and needs no administrator rights. Start it from the Start menu.

To uninstall: *Settings → Apps → Installed apps → HS Studio → Uninstall*.

Auto-update is off in this release. To update, download the newer release and install it over the old one.

### Linux x64 (untested preview)

- AppImage: `chmod +x HS*.AppImage`, then `./HS*.AppImage`
- Debian/Ubuntu: `sudo apt install ./HS*-PREVIEW-UNTESTED.deb`

Checksums are in `SHA256SUMS-linux.txt`.

## Platform status

| | Windows | Linux | macOS |
|---|---|---|---|
| Video engine (libmpv) | ✅ tested | code ready, not tried on a real GPU | ❌ not written |
| Installer | ✅ NSIS (unsigned) | AppImage/deb (untested) | ❌ |
| Automated tests | ✅ unit, Rust, end-to-end, real AI, quality | — | — |

Per-feature table: [docs/platform-support.md](docs/platform-support.md).

## Building from source

Requirements: [Node.js](https://nodejs.org/) 24, [Rust](https://rustup.rs/) 1.99.1, and WebView2 on Windows (built into Windows 11).

```bash
git clone https://github.com/turkuazcode/hs-studio.git
cd hs-studio
npm ci
npm test                 # unit tests (no network, a few seconds)
npm run tauri dev        # development window
```

- **libmpv / FFmpeg (LGPL):** not in the repository. On Windows they are built with [third_party/mpv/build-windows.md](third_party/mpv/build-windows.md) (in CI: `native-windows.yml`), then `npm run stage:mpv`. Without them the app opens with limited HTML5 playback.
- **Release build and installer:** `npm run build:release`, `npm run package:windows`; details in [docs/release/packaging.md](docs/release/packaging.md). Linux: `scripts/linux/`.
- **Test layers:** `npm test`, `npm run test:rust`, `npm run e2e`, `npm run test:ai`, `npm run test:quality`; see [docs/status/test-map.md](docs/status/test-map.md). Release gate: `node scripts/release-gate.mjs` ([rules](docs/releases/release-gate.md)).

Architecture: the front end is framework-free JavaScript ES modules (`src/`), the core is Rust/Tauri (`src-tauri/src/`), and the playback engine is libmpv, loaded as a separate LGPL DLL ([docs/engine.md](docs/engine.md)).

## Privacy

HS Studio asks for no account, collects no usage data and shows no ads. It goes online only for things you start: opening a network stream, downloading an AI model with your consent, showing a location on a map, or opening a link in your browser.

## Contributing and support

- Bugs and suggestions: [GitHub Issues](https://github.com/turkuazcode/hs-studio/issues)
- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are made under Apache-2.0, signed off with `git commit -s` (DCO)
- Security vulnerabilities: **do not open a public issue**; report them to the address in [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

<!-- license-section: the only README place that states the project license (with the badge above) -->
**HS Studio**, Copyright 2026 **TurkuazCode**.

Open-source software licensed under the [Apache License 2.0](LICENSE): you may use, study, change and redistribute it. When you redistribute it, keep the [LICENSE](LICENSE) and [NOTICE](NOTICE) files. The software is provided “as is”, without any warranty.

**Name and logo:** the “HS Studio” name and logo are not covered by the Apache license (section 6 of the license). Modified versions must use a different name and logo: [TRADEMARKS.md](TRADEMARKS.md).
<!-- /license-section -->

**Third-party components:** only open-source components are used. libmpv and FFmpeg are LGPL-licensed and ship as separate DLLs (the source offer is in the package at `legal/SOURCE-OFFER.txt`). The full list is in the app under *Settings → About / Licenses* and in [src/legal/THIRD_PARTY_NOTICES.txt](src/legal/THIRD_PARTY_NOTICES.txt); inventory and SBOM: [legal/INVENTORY.md](legal/INVENTORY.md). AI models do not ship with the app; they are downloaded on first use, with your consent, together with their own license files.
