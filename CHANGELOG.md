# Changelog

All notable changes to HS Studio (formerly VHO) are documented in this file.
The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the
project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it has
public releases.

> **Türkçe özet:** Henüz herkese açık sürüm yok. "Unreleased" bölümü bugün kodda olanı özetler;
> yalnızca Windows 11 x64'te gerçek cihazda test edildi. Ayrıntılı durum:
> [docs/status/implementation-status.md](docs/status/implementation-status.md).

## [Unreleased]

- Product renamed to **HS Studio** (formerly VHO). On first start the app copies the data of
  the old identifier (com.vho.app) to com.turkuazcode.hsstudio; the installer removes an old per-user "VHO"
  install first. Exports now go to the "HS Studio" folder (existing "VHO" folders are left as they are).

Status: pre-alpha, no public release. Verified on a real device only on **Windows 11 x64**;
macOS and Linux builds are untested ([docs/platform-support.md](docs/platform-support.md)).

### Added

- **Video player** on an LGPL libmpv + FFmpeg build (Windows, separate replaceable DLLs) with an
  HTML5 `<video>` fallback: audio/subtitle tracks, chapters, frame stepping, A-B loop, HDR tone
  mapping, hardware decoding, screenshots, equalizer, up to 200 % volume with a limiter, legacy
  codec conversion (WMV9) through Windows Media Foundation.
- **Photo viewer and photo studio**: grid, editor, before/after compare, batch jobs, EXIF info and
  GPS map (Leaflet + OpenStreetMap tiles on demand), HEIC/AVIF/RAW through the operating system's
  codecs, AVIF/WebP export.
- **Photo AI** (downloaded on first use after confirmation, SHA-256 verified): 4× restoration
  (4xRealWebPhoto v4, DAT-2) and face restoration (GFPGAN v1.4 + YuNet) on ONNX Runtime Web
  (WebGPU, WASM fallback); AI model manager in Settings (verify, repair, resume, cancel, remove).
- **Media actions**: delete to recycle bin, rename, copy, print/share/wallpaper (Windows), OCR
  (Windows), video cut/convert/GIF/extract audio/subtitles via ffmpeg as a separate process,
  music tags, lyrics and ReplayGain.
- **Shared library database** (`library.db`, SQLite) with schema migrations, backup/recovery and
  migration of older settings.
- Settings, keyboard shortcuts (editable), themes, single instance, recent files, Turkish and
  English UI, fully offline start (bundled Outfit font).
- Test layers: unit (network-free), Rust, Windows end-to-end, real-AI smoke; test map and runner
  with separate pass/fail/skip counts.
- Open-source pack: CONTRIBUTING, SECURITY (reporting channel still to be set), Code of Conduct
  (Contributor Covenant 2.1), NOTICE, name/logo policy, license inventories
  (`legal/inventory/`), CycloneDX SBOM generator (`npm run sbom`) and a git-history scanner
  (`npm run scan:history`).

### Changed

- Project license: MIT → GPL-3.0-only (2026-10-25) → **Apache-2.0** with a [NOTICE](NOTICE) file
  (owner decision, 2026-10-26; no release was ever made under GPL-3.0). The name and logo are
  covered by [TRADEMARKS.md](TRADEMARKS.md). Product name will become **HS Studio**
  (working name VHO; the rename in the application itself is pending).
- The GPU image filter is labelled as a filter ("not a neural network"); video "AI restoration"
  is shown as not ready.

### Known limitations

- Only Windows 11 x64 is tested; libmpv is not embedded on macOS/Linux yet.
- No installer, code signing or auto-update yet (plans 10/P05, 14/R02).
- Photo AI drops alpha (opaque output) and does not keep EXIF/ICC; no quality benchmark yet.
- Library scanning, music mode, DLNA and video AI are planned, not implemented.

[Unreleased]: #unreleased
