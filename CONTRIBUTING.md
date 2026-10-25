# Contributing to VHO

> **Türkçe özet:** Katkılar memnuniyetle karşılanır. Temiz bir klondan `npm ci` + `npm test` ağ
> bağlantısı olmadan çalışır (Node 24). Uygulamayı derlemek için Rust 1.85+ gerekir; libmpv
> oynatma motoru yalnızca Windows'ta ayrı bir LGPL derlemesiyle gelir, yoksa uygulama HTML5
> yedeğiyle açılır. Her değişiklik ilgili test katmanını (birim / Rust / E2E / gerçek AI) ve
> TR + EN metinleri içermeli; yeni bağımlılık lisans politikasına uymalı ve envantere/SBOM'a
> eklenmeli. Güvenlik açıklarını herkese açık issue olarak değil [SECURITY.md](SECURITY.md)'deki
> yoldan bildirin. Davranış kuralları: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Thank you for helping. This guide gets you from a clean clone to a passing test run, explains
where things live, and lists what a change must include to be merged.

## 1. Set up from a clean clone

| Need | Version | For |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20.19+ or 22.12+ (tests are run with **Node 24**) | `npm test`, Vite, Tauri CLI |
| [Rust](https://rustup.rs/) (stable, MSVC on Windows) | 1.85+ (edition 2024) | building the app, `npm run test:rust` |
| Windows: WebView2 runtime + "Desktop development with C++" build tools | current | building/running the app |
| macOS / Linux: the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) | current | building (not tested on real devices yet, see [docs/platform-support.md](docs/platform-support.md)) |

```bash
git clone <repository-url> vho
cd vho
npm ci          # dev tools only (Tauri CLI, Vite); nothing from npm is shipped in the app
npm test        # unit layer: fast, network-free
```

`npm test` needs no Rust toolchain, no network and no media: it is the check every contributor can
run. The remaining layers need a build:

```bash
npm run build:release      # src-tauri/target/release/vho.exe (no installer)
npm run test:rust          # Rust unit/integration tests (loopback only)
npm run e2e                # Windows: drives the freshly built vho.exe over CDP
npm run tauri dev          # run the app with a dev window
```

### Optional: the libmpv engine (Windows)

VHO plays video through an **LGPL build of libmpv + FFmpeg** that lives next to `vho.exe` as
separate DLLs. It is not in the repository. Without it the app falls back to the HTML5 engine
(and the libmpv E2E tests fail, they are not skipped).

1. Build it once: [third_party/mpv/build-windows.md](third_party/mpv/build-windows.md) (MSYS2,
   ~30 min), or get the exact DLL set from a maintainer.
2. `npm run stage:mpv` (or `powershell -File scripts\stage-mpv.ps1 -Source <dist>`).

Never stage a GPL build (e.g. shinchiro's `libmpv-2.dll`) for a release: see the license rules below.

## 2. Tests: which layer proves what

The full map is [docs/status/test-map.md](docs/status/test-map.md). One runner,
`scripts/run-tests.mjs`, prints pass / fail / **skip** separately (a skip is never a pass) and the
path of the binary under test.

| Layer | Command | Use it when you change |
|---|---|---|
| Unit | `npm test` | pure JS logic, settings schema, i18n, file names, recipes, inventories |
| Rust | `npm run test:rust` | anything in `src-tauri/src` (storage, downloads/hashes, photo codecs, ffmpeg jobs) |
| E2E | `npm run e2e` (Windows) | user-visible flows; needs `npm run build:release` first |
| Real AI | `npm run test:ai` | AI pipelines/manifest; downloads ~76 MB once into `tests/.cache` |
| Quality/perf | `npm run test:quality`, `npm run bench:media` | not populated yet (plan 14/Q02) |

Run one file: `npm run e2e -- tests/e2e/photo.e2e.mjs`. Release candidates use
`VHO_TEST_NO_SKIP=1`.

Tests must never touch your real data: they use temporary profiles (`VHO_DATA_DIR`), synthetic
fixtures (`npm run fixtures`, `npm run fixtures:engine`) and mock/gate system actions (sleep,
wallpaper, print, share). Do not commit personal photos, videos, model weights, keys or
certificates.

## 3. Where things live

| Area | Path | Notes |
|---|---|---|
| Frontend (vanilla JS, no framework) | `src/` (`main.js`, `core/`, `ui/`, `media/`, `studio/`) | served as-is by Tauri (`frontendDist: ../src`), no bundler step |
| Translations | `src/i18n/tr.json`, `src/i18n/en.json` | every user-visible string; checked by `i18n-coverage.test.mjs` |
| Rust backend | `src-tauri/src/` (`engine/` libmpv, `photo/`, `actions/` ffmpeg jobs, `storage/` SQLite, `ai/` model manager) | Tauri commands are the only IPC surface |
| Playback engine | [docs/engine.md](docs/engine.md), [docs/adr/0001-oynatma-motoru.md](docs/adr/0001-oynatma-motoru.md) | |
| Media actions | [docs/media-actions.md](docs/media-actions.md) | |
| Storage schema | [docs/storage-schema.md](docs/storage-schema.md) | |
| Platform matrix | [docs/platform-support.md](docs/platform-support.md) | only Windows 11 x64 is verified on a real device |
| Plans and status | [docs/plans/00-YOL-HARITASI.md](docs/plans/00-YOL-HARITASI.md), [docs/plans/08-uygulama-sirasi-ve-durum.md](docs/plans/08-uygulama-sirasi-ve-durum.md), [docs/status/implementation-status.md](docs/status/implementation-status.md) | mostly Turkish |
| Licenses | `legal/`, [legal/INVENTORY.md](legal/INVENTORY.md) | notices, inventories, SBOM |

Product principles (keep them): a minimal UI; rarely used options go to Settings; video, photo and
music each keep their own layout; original files are never modified in place.

## 4. What a change must include

- **Tests** in the layer that proves it (see the table above), and a passing `npm test`.
- **Both languages**: new UI text as keys in `tr.json` **and** `en.json`; no hard-coded strings.
- **Honest platform claims**: if you could only test on Windows, say so; do not mark macOS/Linux
  as working.
- **Licenses** (policy in [docs/plans/00-YOL-HARITASI.md](docs/plans/00-YOL-HARITASI.md)):
  - accepted: MIT, Apache-2.0, BSD-2/3-Clause, ISC, Zlib, BSL-1.0, MPL-2.0, Unicode, CC0,
    public domain, CC-BY-4.0 (model weights), OFL-1.1 (fonts only);
  - LGPL only as a separate, replaceable library or process (never compiled into `vho.exe`);
  - rejected: GPL, AGPL, non-commercial (NC) or unlicensed code/weights.
  - A new Rust crate: run `powershell -File legal\generate-notices.ps1` and `npm run sbom`.
    A new native binary, model, font, icon or vendored file: add it to `legal/inventory/*.json`
    and `legal/NOTICES_HEADER.txt`, then `npm run sbom`. `tests/unit/legal-inventory.test.mjs`
    fails when the inventories, notices and SBOM disagree.
  - Model weights have their own license, independent of the code: record weight license,
    author, source commit, SHA-256 and training-data notes in `legal/inventory/models.json`.
- **Small, reviewable commits** with a message that says what and why.
- **Formatting**: follow the surrounding code (2-space JS, `cargo fmt` defaults for Rust). There is
  no enforced formatter yet; do not reformat files you do not otherwise change.

By submitting a contribution you agree that it is licensed under the project's license (see
[LICENSE](LICENSE)).

## 5. Pull requests and issues

- Use the issue templates (bug report needs steps, expected/actual, OS, VHO version/commit and
  which engine was active: libmpv or HTML5).
- **Security problems are not reported in public issues**: see [SECURITY.md](SECURITY.md).
- The PR template has a checklist (tests run, TR/EN strings, license inventory, platforms tested).

## 6. Good first tasks

Small, self-contained items that need no special hardware:

- Add a missing unit test for a pure helper in `src/core/format.js` or `src/media/classify.js`.
- Improve an English translation in `src/i18n/en.json` (keep the key set identical to `tr.json`).
- Add a synthetic subtitle edge case (encoding, overlapping cues) to
  `tests/fixtures/make-subtitles.mjs` and a test for it.
- Keyboard/accessibility polish: accessible names for icon-only buttons (plan 14/Q03).
- Documentation: translate a Turkish section of `docs/` into English (keep both).
- Linux/macOS: try a build and record the exact result in `docs/platform-support.md`
  (state the device, OS version and what you did, even if it failed).

## 7. Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
