<#
  Copies the LGPL libmpv DLL set (38 DLLs, see third_party/mpv/build-windows.md) next to the built
  VHO executable so the libmpv engine can load it at runtime. DLLs are never committed.

    npm run stage:mpv                                   # default source, release + debug targets
    powershell -File scripts\stage-mpv.ps1 -Source D:\mpv\dist
    powershell -File scripts\stage-mpv.ps1 -Remove      # delete the staged DLLs again (HTML5 engine)

  Source lookup: -Source, $env:VHO_MPV_DIST, <repo>\third_party\mpv\_build\dist (output of
  third_party/mpv/build-windows.sh).
  The LGPL ffmpeg.exe / ffprobe.exe of the same build (media actions, Plan 06: cut, convert,
  extract audio...; run as separate processes, never linked) are staged too: from the source
  folder, or from <source>\..\prefix\bin when the dist folder only holds the DLLs.
  Packaging (later work package): the same folder becomes a Tauri bundle resource, see
  docs/engine.md ("DLL'ler ve paketleme").
#>
param(
  [string]$Source,
  [string[]]$Targets = @('release', 'debug'),
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Source) { $Source = $env:VHO_MPV_DIST }
if (-not $Source) { $Source = Join-Path $root 'third_party\mpv\_build\dist' }
if (-not $Remove -and -not (Test-Path (Join-Path $Source 'libmpv-2.dll'))) {
  throw "libmpv-2.dll not found in '$Source'. Build it (third_party/mpv/build-windows.md) or pass -Source / set VHO_MPV_DIST."
}
$dlls = if ($Remove) { $null } else { Get-ChildItem $Source -Filter *.dll -File }
# ffmpeg.exe + ffprobe.exe (they use the same av*.dll set)
$tools = @()
if (-not $Remove) {
  foreach ($dir in @($Source, (Join-Path (Split-Path $Source -Parent) 'prefix\bin'))) {
    $found = @('ffmpeg.exe', 'ffprobe.exe') | ForEach-Object { Join-Path $dir $_ } | Where-Object { Test-Path $_ }
    if ($found.Count -eq 2) { $tools = $found | ForEach-Object { Get-Item $_ }; break }
  }
  if (-not $tools) { Write-Warning "ffmpeg.exe / ffprobe.exe not found next to '$Source': media exports stay disabled" }
}
foreach ($t in $Targets) {
  $dest = Join-Path $root "src-tauri\target\$t"
  if (-not (Test-Path $dest)) { continue }
  if ($Remove) {
    $names = if (Test-Path (Join-Path $dest 'mpv-dlls.txt')) { Get-Content (Join-Path $dest 'mpv-dlls.txt') } else { @() }
    foreach ($n in $names) { Remove-Item -LiteralPath (Join-Path $dest $n) -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Join-Path $dest 'mpv-dlls.txt') -ErrorAction SilentlyContinue
    "removed $($names.Count) DLLs from $dest"
    continue
  }
  $copied = 0
  foreach ($d in @($dlls) + @($tools)) {
    $to = Join-Path $dest $d.Name
    if (-not (Test-Path $to) -or (Get-Item $to).Length -ne $d.Length -or (Get-Item $to).LastWriteTime -lt $d.LastWriteTime) {
      Copy-Item -LiteralPath $d.FullName -Destination $to -Force
      $copied++
    }
  }
  (@($dlls.Name) + @($tools | ForEach-Object { $_.Name })) | Set-Content -Encoding ascii (Join-Path $dest 'mpv-dlls.txt')
  $mb = [math]::Round(($dlls | Measure-Object Length -Sum).Sum / 1MB, 1)
  "staged $($dlls.Count) DLLs + $($tools.Count) ffmpeg tools ($mb MB, $copied copied) -> $dest"
}
