# Git history scan (R01)

**Date:** 2026-10-25 · **Tool:** `npm run scan:history` (`scripts/scan-history.mjs`, read-only:
`git rev-list --objects --all` + `git cat-file`) · **Scope:** all 16 local refs (main, wave1–3
branches incl. every worktree branch), 107 commits, 893 blobs. History was **not** rewritten;
nothing was removed. Secret values would never be printed by the tool (only rule, blob, path, line).

> **Türkçe özet:** Sır (anahtar/token/parola) bulunmadı. Kişisel medya bulunmadı: geçmişteki tüm
> görseller/videolar sentetik test desenleri veya uygulama ikonları. Bulgular: (1) bir commit'te
> yanlışlıkla eklenip sonraki commit'te çıkarılan ~70 MB derleme çıktısı (`tests/fixtures/gen/target/`)
> geçmişte duruyor; (2) deney kayıtlarında geliştiricinin Windows kullanıcı klasörü yolu (726
> yerde) var; (3) commit kimliği (ad + kişisel e-posta) herkese açık olacak. Hangisinin
> temizleneceği kullanıcı kararıdır; geçmiş yeniden yazılmadı.

## Results

| Check | Result |
|---|---|
| Secrets (private keys, Tauri/minisign updater keys, AWS/GitHub/GitLab/Slack/Google/OpenAI/Anthropic/HF/npm/Stripe tokens, JWTs, `password=`-style assignments, URLs with credentials) | **0 hits** |
| Sensitive file names (`.env`, `id_rsa`, `*.pem/*.key/*.pfx/*.p12`, credentials files) | **0** |
| Model weights / archives in history (`.onnx`, `.pt`, `.safetensors`, `.zip`, …) | **0** |
| Media files in history | 52: spike screenshots (`experiments/mpv-spike/results/captures/*.png`, synthetic colour-bar test pattern; 3 largest opened and checked), synthetic test fixtures (`tests/fixtures/*`, `tests/ai/fixtures/*`), app icons, Leaflet images. **No personal photos/videos.** |
| Large blobs (≥ 1 MiB) | 9, all build output of the fixture generator (below) |

## Findings for the owner

1. **Build output committed once** — commit `329d31d` ("WIP: progress saved after unexpected PC
   shutdown", 2026-10-23) added `tests/fixtures/gen/target/release/**` (`.rlib`, `.rmeta`, DLLs,
   `vho_fixture_gen-*.exe`, build-script exes; largest 23.6 MiB, ~70 MiB uncompressed in total);
   commit `3b8209b` removed it and it is now in `.gitignore`. It is still in the history of every
   branch. Impact: clone size (the pack is ~28 MiB compressed) and third-party binaries
   (compiled `windows`/`syn` crates, MIT/Apache) in the public history. No secrets inside.
   Options: leave it (simplest), or publish a fresh history / filtered copy (`git filter-repo
   --path tests/fixtures/gen/target --invert-paths`) **before the first push** — a rewrite after
   publishing breaks all clones. Owner decision.
2. **Local user path** — `C:\Users\<developer>\…` appears 726 times, almost all in
   `experiments/mpv-spike/results/*.log.jsonl` and `*.samples.csv` (spike logs), and in
   `third_party/mpv/evidence/windows/*` (FFmpeg `--prefix`, which is also embedded in the built
   `ffmpeg.exe`/DLLs). Reveals the Windows account name and folder layout only. Option: drop or
   sanitize `experiments/mpv-spike/results/` before publishing; build release binaries from a
   neutral path.
3. **Commit identity** — all 107 commits use one identity: the owner's name with a personal
   e-mail address. It becomes public with the history. Option: keep, or publish with a
   no-reply/project address (requires rewriting author metadata before the first push).
4. Third-party e-mail addresses (FreeType, zlib, libjpeg, crate authors…) occur only inside
   license texts in the notices files: expected, no action.
5. `C:\Users\me` in `tests/unit/studio.test.mjs` is a fake test path: no action.

## Limits

- Only reachable objects of local refs were scanned (no remotes exist; stashes/reflogs/dangling
  objects are not published by a normal push and were not scanned).
- Pattern-based: a secret in an unusual format, inside a binary, or in a blob > 8 MiB (only the
  build artifacts above) would not be found. Minified lines > 4000 characters are skipped.
- Images were checked by file type plus a manual look at the three largest screenshots, not by
  opening all 52.
