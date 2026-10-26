# License inventory, SBOM and release obligations

> **Türkçe özet:** Bu klasör HS Studio'nun (eski adı VHO) dağıttığı ve kullandığı her şeyin
> lisans envanteridir: Rust/npm paketleri (SBOM'da otomatik), yerel ikili dosyalar (libmpv/FFmpeg
> DLL'leri), indirilebilir AI bileşenleri (kod lisansı ≠ ağırlık lisansı), font/ikon/vendored JS ve
> test dosyaları. `npm run sbom` CycloneDX 1.6 SBOM'u üretir ve lisans politikasını denetler;
> `npm test` envanter, bildirim ve SBOM'un tutarlı olduğunu doğrular. Proje lisansı
> **GPL-3.0-only**; tüm bağımlılıkların GPL-3.0 uyumluluğu aşağıdaki tabloda. Yayından önce
> kullanıcının vermesi gereken kararlar en altta ("Open items"). Bu belge hukuki görüş değildir.

Project license: **GPL-3.0-only** ([LICENSE](../LICENSE), set in `src-tauri/Cargo.toml` and
`package.json`; owner decision 2026-10-25, previously MIT). Name and logo: [TRADEMARKS.md](../TRADEMARKS.md).
Dependency policy (unchanged by the license switch, to keep relicensing possible):
[docs/plans/00-YOL-HARITASI.md](../docs/plans/00-YOL-HARITASI.md) — accepted MIT, Apache-2.0,
BSD-2/3, ISC, Zlib, BSL-1.0, MPL-2.0, Unicode, CC0, public domain, CC-BY-4.0, OFL-1.1 (fonts
only); LGPL only as a separate DLL/process; no GPL/AGPL/non-commercial dependencies.

## Files

| File | Covers | Maintained |
|---|---|---|
| [`sbom/vho-<version>-<target>.cdx.json`](sbom/) | Everything below in one CycloneDX 1.6 SBOM, with SHA-256, licenses, policy status per component, Rust dependency graph | generated: `npm run sbom` |
| `../src-tauri/Cargo.lock` | Rust crates (compiled into the exe) | cargo |
| `../package-lock.json` | npm packages: **dev/build tools only** (Tauri CLI, Vite); nothing from npm is shipped | npm |
| [`inventory/native-windows-x64.json`](inventory/native-windows-x64.json) | 38 DLLs + `ffmpeg.exe`/`ffprobe.exe` next to the exe: version, origin (source build or MSYS2 package), license, policy, sha256, bytes, source commit, build flags, corresponding-source location | by hand; hashes via `--update-native` |
| [`inventory/models.json`](inventory/models.json) | AI downloads (ONNX Runtime Web + weights): weight license vs. code license, author, architecture, training data, attribution, modifications | by hand; URLs/sizes/SHA-256 come from `src-tauri/src/ai/manifest.rs` |
| [`inventory/assets.json`](inventory/assets.json) | Font, icons (incl. Material Icons path data), Leaflet, AMD FSR port, C libraries inside crates (libwebp, SQLite), test fixtures, spike evidence | by hand; files hashed by the SBOM script |
| [`NOTICES_HEADER.txt`](NOTICES_HEADER.txt) → `../src/legal/THIRD_PARTY_NOTICES.txt` | Human-readable notices + full license texts shown in the app (Licenses window) | `generate-notices.ps1` (cargo-about), `mpv-notices.py` |

## Commands

```powershell
npm run sbom                      # legal/sbom/vho-<version>-x86_64-pc-windows-msvc.cdx.json; exit 1 on a policy "reject"
node legal/generate-sbom.mjs --target x86_64-unknown-linux-gnu        # other targets (no native inventory yet)
node legal/generate-sbom.mjs --native-dist third_party\mpv\_build\dist            # verify DLL hashes of a build
node legal/generate-sbom.mjs --native-dist <dist> --native-bin <prefix\bin> --update-native   # refresh them
powershell -File legal\generate-notices.ps1   # after Rust dependency changes (cargo-about)
npm run scan:history              # read-only scan of all git refs for secrets / media / large files
npm test                          # includes tests/unit/legal-inventory.test.mjs
```

The SBOM script needs no network (`cargo metadata --offline --locked`) and no new tool: Node and
Cargo only. Its output is deterministic per commit (timestamp = HEAD commit date, serial number
derived from content). After editing an inventory, `Cargo.lock`, `package-lock.json` or the AI
manifest, run `npm run sbom` and commit the regenerated file; `legal-inventory.test.mjs` fails
otherwise (hash/version drift, missing notices, unlisted shipped asset, policy reject).

`vho:policy` per SBOM component: `ok` (accepted), `review` (permissive but not on the explicit
list, or an open question: listed for the owner), `reject` (blocks: GPL/AGPL/NC, LGPL compiled
in, OFL outside fonts).

## Current result (Windows x64, 2026-10-25)

394 Rust crates (372 compiled into the exe, 22 build-time only), 52 npm dev packages, 40 native
files, 8 AI files, 10 asset groups. **0 rejected.** 12 `review` items; **11 acknowledged by the owner on
2026-10-25** (recorded as `acknowledged` in the inventories and as `vho:acknowledged` in the SBOM),
**1 still open** (logo). `legal-inventory.test.mjs` fails if a new review item appears without a decision.

| Item | License | Why review | Status |
|---|---|---|---|
| libfreetype-6.dll | FTL OR GPL-2.0-or-later | FTL not on the explicit list; see GPL note below | acknowledged |
| libjpeg-8.dll | IJG AND BSD-3-Clause AND Zlib | IJG not on the explicit list (permissive; requires credit in docs) | acknowledged |
| libpng16-16.dll | libpng-2.0 | permissive, not on the list | acknowledged |
| libbz2-1.dll | bzip2-1.0.6 | permissive (BSD-style), not on the list | acknowledged |
| liblzma-5.dll | 0BSD | permissive, not on the list | acknowledged |
| libfontconfig-1.dll | fontconfig license (MIT/HPND-style) | custom permissive text | acknowledged |
| libwinpthread-1.dll | MIT AND ZPL-2.1 | ZPL-2.1 permissive, not on the list | acknowledged |
| libgcc_s_seh-1.dll, libstdc++-6.dll | GPL-3.0-or-later WITH GCC-exception-3.1 | GCC Runtime Library Exception (permits use with any license); acknowledge | acknowledged |
| YuNet, GFPGAN weights | MIT, Apache-2.0 | weights fine; **training data** (WIDER FACE / FFHQ) has non-commercial terms | **accepted risk, owner decision 2026-10-25** ("kaliteyi önceliyoruz"): models stay; lawyer review later; re-verify training data before each release |
| App logo/icons | not yet stated | owner must confirm authorship/rights | **open** (see [docs/legal/on-arastirma.md](../docs/legal/on-arastirma.md)) |

## GPL-3.0 compatibility (project license since 2026-10-25)

Statically linked code becomes part of the GPL-3.0 work and must be GPL-3.0-compatible.
Separately loaded DLLs are treated conservatively as part of the combined work as well. Separate
processes, downloaded data and OS components are aggregates.

| Group | Licenses | GPL-3.0-only compatible? | Notes |
|---|---|---|---|
| Rust crates compiled into the exe (372) | MIT, Apache-2.0, BSD-2/3, ISC, Zlib, BSL-1.0, Unicode-3.0, CC0, Unlicense, 0BSD, MPL-2.0 (5 crates: cssparser, cssparser-macros, selectors, dtoa-short, option-ext) | **yes** | Apache-2.0 is compatible with GPLv3 (not GPLv2). MPL-2.0 via its secondary-license clause; none of the 5 crates carries the "Incompatible With Secondary Licenses" notice (checked in the crate sources). `ring` 0.17.14 is Apache-2.0 AND ISC (no OpenSSL-license code). |
| C code inside crates | libwebp (BSD-3-Clause), SQLite (public domain), rav1e/AV1 (BSD-2-Clause + AOM patent license) | **yes** | |
| libmpv, FFmpeg, FriBidi, GLib, libintl, libiconv, libplacebo, uchardet (LGPL option) | LGPL-2.1-or-later | **yes** | LGPL code may be used in a GPL work. Kept as separate replaceable DLLs anyway (policy + LGPL §6 relinking). |
| Other DLLs | ISC, MIT, BSD-2/3, Apache-2.0, Zlib, libpng-2.0, bzip2-1.0.6, 0BSD, IJG, HPND-style, MIT AND ZPL-2.1, MPL-2.0 option (Graphite2), BSD-3 + PCRE2 exception | **yes** | Listed as GPL-compatible by the FSF (IJG, libpng, zlib, Expat, ZPL-2.x, X11/HPND-style) or plain permissive. |
| libfreetype-6.dll | FTL OR GPL-2.0-or-later | **yes, via the GPL-2.0-or-later option** | FTL alone is GPL-incompatible (FSF: credit clause). Both options are passed on; the notices should say so (done in the inventory note). |
| GCC runtime DLLs | GPL-3.0-or-later WITH GCC-exception-3.1 | **yes** | |
| ffmpeg.exe / ffprobe.exe | LGPL-2.1-or-later | **yes** (separate processes) | |
| ONNX Runtime Web (download) | MIT (+ its ThirdPartyNotices) | **yes** | Downloaded at runtime, not part of the shipped program. |
| Model weights (download) | CC-BY-4.0 (photo-x4), Apache-2.0 (GFPGAN), MIT (YuNet) | **yes / not part of the program** | Data fetched at runtime. FSF lists CC BY 4.0 as GPLv3-compatible. Training-data terms are a separate, open question (below). |
| Outfit font | OFL-1.1 | **acceptable as a separate font file** | OFL is not GPL-compatible for merging code, but a font shipped as its own file is aggregation; keep it unmodified with its license, never embed it into program code. |
| Leaflet, Material Icons path data, AMD FSR port | BSD-2-Clause, Apache-2.0, MIT | **yes** | |
| npm dev tools | MIT, Apache-2.0, ISC, BSD-3, MPL-2.0 (lightningcss) | not shipped | |
| WebView2, Media Foundation, WIC codecs, Windows OCR/share | OS components | **yes** (system library exception) | |
| OpenStreetMap tiles | ODbL (data, service) | not distributed | attribution shown in the map |

**Nothing incompatible was found.** Consequences of the license switch to keep in mind:

- GPL-3.0-only (not "or later"): a future GPL v4 cannot be adopted without relicensing — possible
  only because of the CLA.
- GPLv3 binaries must come with the Corresponding Source of the whole app (section 6): publish
  the exact tagged source with every release, ship `LICENSE`, and keep the notices window.
- Some app stores' terms are widely considered incompatible with GPLv3 (notably Apple's App
  Store); check store terms before planning store releases (plan 10/P05).
- The dependency policy still excludes GPL/AGPL libraries, so the owner can relicense (CLA) later.

## LGPL obligations and corresponding source (native binaries)

For each LGPL DLL we ship: (1) it stays a separate file that users can replace (VHO loads
`libmpv-2.dll` at runtime; fallback to HTML5 if missing), (2) license texts are in the notices,
(3) the complete corresponding source is available. For the source-built parts the inventory
records tag **and commit** (FFmpeg n8.1.3 `1041abdc…`, mpv v0.41.0 `41f6a645…`, both without
local patches), the full configure/meson flags, toolchain (MSYS2 UCRT64, GCC 16.2.0-6) and the
build script `third_party/mpv/build-windows.sh` with its evidence (`third_party/mpv/evidence/`).
The MSYS2-provided DLLs are prebuilt binary packages: their corresponding source is the MSYS2
source package of exactly the listed version (`repo.msys2.org/mingw/sources/<pkgbase>-<version>.src.tar.zst`,
upstream tarball + MSYS2 patches + PKGBUILD).

**Not done yet (release requirement):** download and archive the source of every shipped DLL
(at least the LGPL ones: FFmpeg, mpv, FriBidi, GLib, gettext, libiconv, libplacebo, uchardet) at
these exact versions, and publish them next to the release (or keep them for the 3-year written
offer the notices make). MSYS2 does not guarantee old source packages stay online forever. The
native hashes in the inventory belong to the 2026-10-23 reference build; the release build must
be re-hashed (`--update-native`) because the build is not bit-reproducible. The FFmpeg binaries
embed the local build prefix (`--prefix=C:/Users/<user>/…`, visible in `ffmpeg -buildconf`):
build releases from a neutral path.

Linux "system GPL fallback" (plan 02/B): distributions often ship mpv/FFmpeg built with
`--enable-gpl`. Loading a GPL libmpv into the GPL-3.0 app is license-compatible now, but it
conflicts with the "no GPL dependency" policy (relicensing option) — decide before shipping Linux.

## AI models: code license ≠ weight license

Each AI component has three separate questions, recorded per file in `inventory/models.json`:
the license of the **runtime/code** (ONNX Runtime Web: MIT; architectures DAT: Apache-2.0,
GFPGAN code: Apache-2.0), the license of the **weights** (CC-BY-4.0 / Apache-2.0 / MIT), and the
terms of the **training data**. Weight files are never bundled; they are downloaded after the
user confirms, pinned to a commit URL and checked against SHA-256 (A01).

## Open items before a public release (owner decisions / inputs)

1. ~~Security contact~~ — **done 2026-10-25**: turkuazcode@gmail.com in SECURITY.md,
   CODE_OF_CONDUCT.md, TRADEMARKS.md and the issue templates. Add the repository's security-policy
   link to `.github/ISSUE_TEMPLATE/config.yml` once the URL exists.
2. **CLA** (pre-research for the lawyer: [docs/legal/on-arastirma.md](../docs/legal/on-arastirma.md)): lawyer review of [CLA.md](../CLA.md) (Harmony-based draft, Option Five), fill the
   jurisdiction, confirm the media license, choose the signing mechanism (CLA bot or PR
   statement + record keeping), and decide whether an Entity CLA is needed.
3. **Trademark**: lawyer review of [TRADEMARKS.md](../TRADEMARKS.md); decide on registration;
   confirm the logo's authorship/rights (`inventory/assets.json`, `app-icons`) and whether the logo
   files are also offered under GPL-3.0 as copyright while the mark stays protected.
4. **Repository URL**: README links to `github.com/hsrts/vho` (not verified to exist); the notices
   promise source "from the project repository" — set the final URL.
5. **History cleanup** — **approved 2026-10-25**, runs only right before the first push after all
   branches are merged: [docs/release/history-cleanup.md](../docs/release/history-cleanup.md)
   (`scripts/prepare-public-history.ps1`: build output, logs with the local path, commit e-mail).
   Owner still chooses the public commit e-mail.
6. **Corresponding source archive** of all native DLLs (section above) + re-hash of the release DLL set,
   built from a neutral path ([docs/release/build-path.md](../docs/release/build-path.md)).
7. **Training data** of YuNet (WIDER FACE) and GFPGAN (FFHQ): **decided 2026-10-25 — models are
   kept** (accepted risk, lawyer review later). Still open: record the 4xRealWebPhoto training data
   from its model card; re-verify all training-data notes before each release.
8. ~~Review list~~ — **done 2026-10-25**: 11 of 12 acknowledged; the logo stays open (item 3).
9. **Product rename** to HS Studio in code (window title, exe, bundle id, i18n, notices title) —
   integrator, after all branches merge; then regenerate notices and the SBOM.
10. Codec patents (H.264/HEVC/AAC decoders in FFmpeg, AV1 patent license) are a jurisdiction
    question outside copyright licensing; the plan does not claim legal clearance.

This inventory is a technical record, not a legal opinion.
