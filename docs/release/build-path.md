# Release builds: neutral build path

> **Türkçe özet:** Yayın ikilileri, kullanıcı adı içermeyen bir klasörden derlenir (örn.
> `C:\build\hs-studio`). Derleyiciler kaynak ve kurulum yollarını ikiliye gömer. `C:\Users\<ad>\…`
> altında derlenen exe/DLL, kullanıcı hesabının adını yayına taşır.

## Why

Build tools embed absolute paths into the files they produce:

- The FFmpeg build prints its `configure` line with `--prefix=…` (`ffmpeg -buildconf`, also stored in the DLLs).
  The reference build of 2026-10-23 was made under the developer's user profile.
- Rust embeds source paths in panic messages and debug information. Cargo's registry path
  (`C:\Users\<name>\.cargo\registry\…`) is part of them unless remapped.
- meson/MSYS2 builds embed the prefix in pkg-config files and sometimes in strings.

A release built under `C:\Users\<name>\…` therefore publishes the account name and folder layout.

## Rule

Build every published binary (VHO/HS Studio exe, the libmpv/FFmpeg DLL set, `ffmpeg.exe`/`ffprobe.exe`)
from a clean clone in a neutral path, for example:

```powershell
git clone <public repository> C:\build\hs-studio
cd C:\build\hs-studio
npm ci
npm test
# Rust: map the home and source paths away (rustc --remap-path-prefix)
$env:RUSTFLAGS = "--remap-path-prefix=$env:USERPROFILE=~ --remap-path-prefix=C:\build\hs-studio=."
npm run build:release
# libmpv/FFmpeg (third_party/mpv/build-windows.md): run the MSYS2 build from C:\build\hs-studio
# as well, so --prefix becomes C:/build/hs-studio/third_party/mpv/_build/prefix
```

Then:

1. Check the binaries before publishing, e.g.
   `Select-String -Path src-tauri\target\release\*.exe,third_party\mpv\_build\dist\*.dll -Pattern $env:USERNAME -SimpleMatch -List`.
   Expected result: no output.
2. Re-hash the native set into the inventory:
   `node legal/generate-sbom.mjs --native-dist third_party\mpv\_build\dist --native-bin third_party\mpv\_build\prefix\bin --update-native`.
3. Run `npm run sbom` and commit the regenerated inventory and SBOM with the release.

CI runners (plan 14/R02) build in neutral paths by default. The rule matters for local release builds.
