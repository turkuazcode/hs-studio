# Changelog

All notable changes to HS Studio are documented in this file.
The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Türkçe özet:** İlk herkese açık sürüm 0.1.0 (alfa). Yalnızca Windows 11 x64'te otomatik
> testlerle doğrulandı; Linux paketleri test edilmemiş önizlemedir, macOS henüz yok.
> Sürüm notları: [docs/releases/notes/v0.1.0.md](docs/releases/notes/v0.1.0.md).

## [Unreleased]

## [0.1.0] — alpha (Windows; Linux preview)

First public release. Tested automatically on **Windows 11 x64** only (unit, Rust, end-to-end,
real-AI and quality layers on the released binary; installer test with a test identity). Clean
machine, screen reader and real-user sessions were not done yet
([checklist](docs/releases/0.1.0-alpha-checklist.md)). Linux AppImage/deb are an **untested
preview**; there is no macOS build (its video engine is not written yet).

### Added

- **Video player** on an LGPL libmpv + FFmpeg build (separate, replaceable libraries): audio and
  subtitle tracks, chapters, frame stepping, A-B loop, speed, HDR tone mapping, hardware decoding,
  screenshots, 10-band equalizer, up to 200 % volume with a limiter, sleep timer, resume.
- **Photo viewer and studio**: grid, EXIF and histogram, crop/rotate, compare, batch convert,
  stars and tags, GPS map (OpenStreetMap tiles on demand); HEIC/AVIF through Windows codecs.
- **Photo enhance without AI** (default): guided-filter clean-up, shadow lift, halo-free
  sharpening, 2× upscale, optional grain; result written to a new file.
- **Video enhance without AI**: deinterlace when needed, block and temporal noise reduction,
  scaling, light sharpening; 10 s side-by-side preview; new MKV next to the original with audio and
  subtitles kept; HDR input refused (output SDR 8-bit); an interrupted run leaves no file.
- **Smart editing**: object removal (LaMa) and colorization (DDColor), models downloaded on first
  use after consent and SHA-256 verified. Background removal is experimental and hidden.
- **Library and music**: SQLite library with migrations and backups, folder scan and search,
  playlists (M3U/PLS), gapless playback, ReplayGain, Windows media keys.
- **Network**: HTTP/HTTPS streams, HLS, internet radio titles (ICY), UPnP/DLNA casting
  (not tried on a real TV yet).
- **Media actions**: cut, convert, GIF, extract audio, save frame, tags, lyrics, OCR, share/print.
- **Persistent job queue** with recovery after a crash, cancel and path grants: the app only writes
  into folders you chose.
- Turkish and English UI, fully offline start.

### Changed

- Product renamed to **HS Studio** (working name VHO); data of the old identifier is migrated on
  first start. License **Apache-2.0** with a NOTICE file, © 2026 TurkuazCode; name and logo in
  [TRADEMARKS.md](TRADEMARKS.md).
- The earlier neural photo enhancer (DAT-2 ×4, GFPGAN) is switched off in this release.

### Fixed (before release)

- HLS streams stalled after the first segment (chunked segments were downloaded again).
- An FFV1 video froze the app (GPU-only Vulkan decoder); FFV1, ProRes RAW and DPX decode in software.
- Video enhance: mirrored phone videos came out flipped; MP4 text subtitles made the run fail.

### Known limitations

- Windows installer is not code-signed (SmartScreen may warn); no automatic updates.
- Linux: untested preview. macOS: not available.
- Enhancements make no "better quality" claim: in our measurements they are close to plain
  Lanczos scaling ([report](docs/benchmarks/2026-10-28-klasik-zincir.md)); no blind human review yet.
- No segment resume for long video jobs; no model-based video enhancement; no Chromecast.

[Unreleased]: https://github.com/turkuazcode/hs-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/turkuazcode/hs-studio/releases/tag/v0.1.0
