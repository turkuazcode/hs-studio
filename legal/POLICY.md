# Dependency license policy

> **Türkçe özet:** HS Studio'ya giren her kod, kütüphane, model ağırlığı, font ve ikon bu politikaya
> uyar. Kabul: MIT, Apache-2.0, BSD-2/3, ISC, Zlib, BSL-1.0, MPL-2.0, Unicode, CC0, kamu malı,
> CC-BY-4.0, OFL-1.1 (yalnızca fontlar) ve **yalnızca ayrı, değiştirilebilir kütüphane olarak** LGPL.
> Red: GPL, AGPL, ticari olmayan (NC, S-Lab) ve lisanssız kod/ağırlık.

The project itself is licensed under [Apache-2.0](../LICENSE) with a [NOTICE](../NOTICE) file. The
"HS Studio" name and logo are covered separately by [TRADEMARKS.md](../TRADEMARKS.md). Contributions
come in under the same license, signed off with the DCO. There is no CLA.

## Accepted

| License | Notes |
|---|---|
| MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, BSL-1.0 | Code, any linking |
| MPL-2.0 | File-level copyleft; changes to MPL files stay MPL |
| Unicode, CC0, public domain | Data and code |
| CC-BY-4.0 | Model weights and data, with attribution |
| OFL-1.1 | Fonts only |
| LGPL-2.1 / LGPL-3.0 | **Only dynamically linked**: a separate, replaceable DLL / dylib / .so or a separate process, never compiled into the app binary. The source offer ships in the package (`legal/SOURCE-OFFER.txt`). The playback engine (libmpv, FFmpeg) is built LGPL-only (`-Dgpl=false`, no `--enable-gpl`) |

## Rejected

GPL and AGPL (any version), non-commercial licenses (CC-BY-NC, S-Lab and similar), and code or weights
without a license.

## Rules

- An expression with OR is judged by its best option; AND by its worst (`legal/generate-sbom.mjs`,
  tested in `tests/unit/legal-inventory.test.mjs`).
- Model weights have their own license, independent of the code. Weight license, author, source
  commit, SHA-256 and training-data notes are recorded in [inventory/models.json](inventory/models.json).
- A new dependency, binary, model, font or icon is added to `legal/inventory/*.json` and the notices,
  then `npm run sbom` is run. The unit test fails when inventories, notices and SBOM disagree. Steps:
  [CONTRIBUTING.md](../CONTRIBUTING.md) and [INVENTORY.md](INVENTORY.md).
- Code from other projects is not copied in under a different license. A feature seen elsewhere is
  written from scratch, or the original library is used under its own license.
- The policy is not changed silently: a change is a commit to this file, with the reason.
