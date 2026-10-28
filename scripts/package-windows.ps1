<#
  Builds the Windows installer (NSIS, per-user, no admin) with the LGPL libmpv/FFmpeg set and the
  license files inside (plan 10/P05). Separate from `npm run build:release` (developer exe only).

    npm run package:windows -- -MpvDist C:\build\hs-studio\third_party\mpv\_build\dist
    powershell -File scripts\package-windows.ps1 -Variant test -MpvDist <dist>      # test identity

  Variants
    release : the real package (identifier com.vho.app, file associations registered).
              The DLL set must match legal/inventory/native-windows-x64.json byte for byte.
    test-renamed : "HS Studio PackageTest" / com.hsstudio.app.packagetest: rehearses the product
              rename (its installer removes a "VHO PackageTest" install first).
    test    : "VHO PackageTest" / com.vho.app.packagetest, NO file associations: used by
              scripts/test-installer.ps1 so a test install can never collide with or change a
              real install. Hash differences of the DLL set are only warnings.

  Layout inside the install folder (what engine/mod.rs and actions/ffmpeg.rs look for):
    <install>\HS Studio.exe (main binary, tauri.conf.json mainBinaryName), <install>\mpv\libmpv-2.dll + dependent DLLs + ffmpeg.exe +
    ffprobe.exe, <install>\legal\{LICENSE.txt, NOTICE.txt, THIRD_PARTY_NOTICES.txt, SOURCE-OFFER.txt,
    native-inventory.json, sbom.cdx.json}, uninstall.exe.
  Output: src-tauri\target\release\bundle\nsis\*.exe + .sha256 + package-manifest.json
  (every packaged file with size and SHA-256).

  Build from a neutral path for releases (docs/release/build-path.md); -RemapPaths (default for
  the release variant) sets RUSTFLAGS --remap-path-prefix (forces a full Rust rebuild).
#>
param(
  [string]$MpvDist,
  [string]$MpvBin,
  [ValidateSet('release', 'test', 'test-renamed')][string]$Variant = 'release',
  # previous product name whose per-user install the new installer removes first (rename;
  # src-tauri/packaging/windows/legacy-install.nsh.in). No-op while it equals productName.
  [string]$LegacyProductName,
  [string]$Version,
  [string]$SourceUrl,
  [switch]$RemapPaths,
  [switch]$NoRemapPaths,
  # all: stage + build + bundle. build: stage + exe only (then sign vho.exe, e.g. SignPath).
  # bundle: bundle the existing (signed) exe with the payload staged by a previous 'build' phase.
  [ValidateSet('all', 'build', 'bundle')][string]$Phase = 'all',
  # merge src-tauri/packaging/updater.conf.json (needs TAURI_SIGNING_PRIVATE_KEY; docs/release/signing-and-updates.md)
  [switch]$Updater
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$tauriDir = Join-Path $root 'src-tauri'
$packDir = Join-Path $tauriDir 'packaging\windows'

if (-not $MpvDist) { $MpvDist = $env:VHO_MPV_DIST }
if (-not $MpvDist) { $MpvDist = Join-Path $root 'third_party\mpv\_build\dist' }
if (-not (Test-Path (Join-Path $MpvDist 'libmpv-2.dll'))) { throw "libmpv-2.dll not found in '$MpvDist' (third_party/mpv/build-windows.md, or pass -MpvDist)" }
$MpvDist = (Resolve-Path $MpvDist).Path
if (-not $MpvBin) { $MpvBin = if (Test-Path (Join-Path $MpvDist 'ffmpeg.exe')) { $MpvDist } else { Join-Path (Split-Path $MpvDist -Parent) 'prefix\bin' } }
foreach ($t in 'ffmpeg.exe', 'ffprobe.exe') { if (-not (Test-Path (Join-Path $MpvBin $t))) { throw "$t not found in '$MpvBin' (pass -MpvBin)" } }
$MpvBin = (Resolve-Path $MpvBin).Path

$conf = Get-Content (Join-Path $tauriDir 'tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = $conf.version }
# main binary: tauri.conf.json mainBinaryName ("HS Studio"), else the crate name
$exeName = "$(if ($conf.mainBinaryName) { $conf.mainBinaryName } else { 'vho' }).exe"
if (-not $SourceUrl) { $SourceUrl = "<repository URL to be set before the first public release>/tree/v$Version" }
$native = Get-Content (Join-Path $root 'legal\inventory\native-windows-x64.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# ---------------------------------------------------------------- 1. stage payload
$stage = Join-Path $tauriDir 'target\package-staging'
$mismatch = @()
if ($Phase -eq 'bundle') {
  if (-not (Test-Path (Join-Path $stage 'mpv\libmpv-2.dll'))) { throw "no staged payload in $stage (run -Phase build first)" }
} else {
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
$stageMpv = New-Item -ItemType Directory -Force (Join-Path $stage 'mpv')
$stageLegal = New-Item -ItemType Directory -Force (Join-Path $stage 'legal')

Write-Host "== native set: $MpvDist (+ $MpvBin)"
foreach ($c in $native.components) {
  foreach ($f in $c.files) {
    $src = if ($f.name -like '*.exe') { Join-Path $MpvBin $f.name } else { Join-Path $MpvDist $f.name }
    if (-not (Test-Path $src)) { throw "missing native file $src (inventory: $($c.id))" }
    $h = (Get-FileHash -Algorithm SHA256 -LiteralPath $src).Hash.ToLowerInvariant()
    if ($h -ne $f.sha256) { $mismatch += "$($f.name) ($h)" }
    Copy-Item -LiteralPath $src -Destination $stageMpv.FullName
  }
}
$listed = @($native.components | ForEach-Object { $_.files.name })
$extra = @(Get-ChildItem $MpvDist -Filter *.dll -File | Where-Object { $listed -notcontains $_.Name } | ForEach-Object Name)
if ($extra) { throw "DLLs in '$MpvDist' that are not in the license inventory: $($extra -join ', ') (add them to legal/inventory/native-windows-x64.json and the notices first)" }
if ($mismatch) {
  $msg = "native files differ from legal/inventory/native-windows-x64.json: $($mismatch -join '; '). Refresh with: node legal/generate-sbom.mjs --native-dist `"$MpvDist`" --native-bin `"$MpvBin`" --update-native, review, commit."
  if ($Variant -eq 'release') { throw $msg } else { Write-Warning $msg }
}

Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stageLegal 'LICENSE.txt')
Copy-Item (Join-Path $root 'NOTICE') (Join-Path $stageLegal 'NOTICE.txt')
Copy-Item (Join-Path $root 'src\legal\THIRD_PARTY_NOTICES.txt') (Join-Path $stageLegal 'THIRD_PARTY_NOTICES.txt')
Copy-Item (Join-Path $root 'legal\inventory\native-windows-x64.json') (Join-Path $stageLegal 'native-inventory.json')
Copy-Item (Join-Path $root 'TRADEMARKS.md') (Join-Path $stageLegal 'TRADEMARKS.md')
$offer = Get-Content (Join-Path $root 'legal\SOURCE-OFFER.txt') -Raw -Encoding UTF8
$repl = @{
  '{{VERSION}}' = $Version; '{{INSTALLER}}' = "NSIS per-user installer ($Variant)"; '{{SOURCE_URL}}' = $SourceUrl
  '{{MPV_TAG}}' = $native.sources.mpv.tag; '{{MPV_COMMIT}}' = $native.sources.mpv.commit
  '{{FFMPEG_TAG}}' = $native.sources.ffmpeg.tag; '{{FFMPEG_COMMIT}}' = $native.sources.ffmpeg.commit
}
foreach ($k in $repl.Keys) { $offer = $offer.Replace($k, [string]$repl[$k]) }
[IO.File]::WriteAllText((Join-Path $stageLegal 'SOURCE-OFFER.txt'), $offer, (New-Object Text.UTF8Encoding $true))
# SBOM of exactly this package (written to the staging folder, the repository copy is untouched)
& node (Join-Path $root 'legal\generate-sbom.mjs') --out (Join-Path $stageLegal 'sbom.cdx.json') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'SBOM generation / license policy check failed' }
}

# ---------------------------------------------------------------- 2. build + bundle
$configs = @('--config', (Join-Path $packDir 'nsis.conf.json'))
if ($Variant -eq 'test') { $configs += @('--config', (Join-Path $packDir 'nsis.test.conf.json')) }
if ($Variant -eq 'test-renamed') { $configs += @('--config', (Join-Path $packDir 'nsis.test-renamed.conf.json')) }
# installer hook: remove a per-user install of the previous product name before installing
if (-not $LegacyProductName) { $LegacyProductName = if ($Variant -eq 'release') { 'VHO' } else { 'VHO PackageTest' } }
$hook = Join-Path $stage 'legacy-install.nsh'
$hookText = (Get-Content (Join-Path $packDir 'legacy-install.nsh.in') -Raw -Encoding UTF8).Replace('@LEGACY@', $LegacyProductName)
[IO.File]::WriteAllText($hook, $hookText, (New-Object Text.UTF8Encoding $true))
$hookConf = Join-Path $stage 'hooks.conf.json'
[IO.File]::WriteAllText($hookConf, (@{ bundle = @{ windows = @{ nsis = @{ installerHooks = $hook } } } } | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
$configs += @('--config', $hookConf)
if ($Updater) {
  # the public key and endpoint are compiled into the exe: -Updater belongs on the 'build' phase
  # too, or the shipped app has no updater configuration (audit D04)
  $updConf = Join-Path $tauriDir 'packaging\updater.conf.json'
  $upd = (Get-Content $updConf -Raw -Encoding UTF8 | ConvertFrom-Json).plugins.updater
  if (-not $upd.pubkey -or $upd.pubkey -match 'REPLACE_WITH' -or @($upd.endpoints | Where-Object { $_ -match '<owner>|<repo>' }).Count) {
    throw "-Updater: set the real public key and endpoint in $updConf first (docs/release/signing-and-updates.md)"
  }
  if ($Phase -ne 'build' -and -not $env:TAURI_SIGNING_PRIVATE_KEY) { throw '-Updater needs TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) in the environment' }
  $configs += @('--config', $updConf)
}
if ($Version -ne $conf.version) {
  $vfile = Join-Path $stage 'version.conf.json'
  [IO.File]::WriteAllText($vfile, "{`"version`": `"$Version`"}", (New-Object Text.UTF8Encoding $false))
  $configs += @('--config', $vfile)
}
$remap = ($Variant -eq 'release' -and -not $NoRemapPaths) -or $RemapPaths
$oldFlags = $env:RUSTFLAGS
if ($remap) {
  $env:RUSTFLAGS = (("$oldFlags --remap-path-prefix=$env:USERPROFILE=~ --remap-path-prefix=$root=.").Trim())
  Write-Host "== RUSTFLAGS: $env:RUSTFLAGS"
}
$bundleDir = Join-Path $tauriDir 'target\release\bundle\nsis'
$started = Get-Date
Push-Location $root
try {
  switch ($Phase) {
    'all' { & npx tauri build --bundles nsis @configs }
    'build' { & npx tauri build --no-bundle @configs }
    'bundle' { & npx tauri bundle --bundles nsis @configs }
  }
  if ($LASTEXITCODE -ne 0) { throw "tauri $Phase failed ($LASTEXITCODE)" }
} finally { Pop-Location; $env:RUSTFLAGS = $oldFlags }
if ($Phase -eq 'build') {
  Write-Host "`n== built $(Join-Path $tauriDir "target\release\$exeName"); sign it, then run -Phase bundle"
  return
}

$installer = Get-ChildItem $bundleDir -Filter *-setup.exe | Where-Object { $_.LastWriteTime -ge $started } | Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $installer) { throw "no new installer in $bundleDir" }
if ($Updater) {
  # the updater signature must belong to exactly this file (re-signed after code signing: release.yml)
  & node (Join-Path $root 'scripts\verify-updater-sig.mjs') $installer.FullName --version $Version | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "updater signature of $($installer.Name) does not verify" }
}

# ---------------------------------------------------------------- 3. checksums + manifest
$hash = (Get-FileHash -Algorithm SHA256 $installer.FullName).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$($installer.FullName).sha256", "$hash  $($installer.Name)`n", (New-Object Text.UTF8Encoding $false))
$exe = Join-Path $tauriDir "target\release\$exeName"
$files = @(Get-ChildItem $stage -Recurse -File | Where-Object { $_.Name -notin 'version.conf.json', 'hooks.conf.json', 'legacy-install.nsh' } | ForEach-Object {
  [ordered]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); bytes = $_.Length; sha256 = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant() }
})
$files += [ordered]@{ path = "$exeName (main binary, before installation)"; bytes = (Get-Item $exe).Length; sha256 = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLowerInvariant() }
$commit = (& git -C $root rev-parse HEAD).Trim()
$manifest = [ordered]@{
  installer = $installer.Name; sha256 = $hash; bytes = $installer.Length; variant = $Variant; version = $Version
  sourceCommit = $commit; built = (Get-Date).ToString('o'); remappedPaths = [bool]$remap; nativeHashesMatchInventory = (-not $mismatch)
  updater = [bool]$Updater
  files = $files
}
$manifestPath = Join-Path $bundleDir ("package-manifest-$Variant-$Version.json")
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
Write-Host "`n== installer : $($installer.FullName)"
Write-Host "   sha256    : $hash"
Write-Host "   manifest  : $manifestPath ($($files.Count) files)"
