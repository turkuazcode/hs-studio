<#
  Safe installer test on a developer machine (plan 10/P05). Uses ONLY the test identity built by
    powershell -File scripts\package-windows.ps1 -Variant test ...
  ("VHO PackageTest", com.vho.app.packagetest, no file associations), so it cannot touch a real
  VHO install, the user's settings/library, file associations or default apps.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-installer.ps1 `
      -Installer "src-tauri\target\release\bundle\nsis\VHO PackageTest_0.1.0_x64-setup.exe" `
      [-UpgradeInstaller "...\VHO PackageTest_0.1.1_x64-setup.exe"] [-SkipE2E]

  Steps: snapshot (HKCU uninstall keys, HKCU\Software\Classes, HKCU Run, Start menu, Desktop)
  -> silent per-user install (/S /NS: no shortcuts) into a temp folder whose name has spaces and
  Turkish characters -> file + hash check against the package manifest -> E2E (smoke + engine)
  against the INSTALLED exe with a minimal PATH (no MSYS2/dev tools), isolated VHO_DATA_DIR and
  WebView2 profile, CDP ports 10900-10999 -> data written by the installed app -> optional
  upgrade over it (data must survive) -> silent uninstall -> cleanup verification (data folder
  must remain) -> removal of the test-only leftovers -> snapshot comparison.
  No admin rights are used; nothing outside the temp folder and the test identity is changed.
#>
param(
  [Parameter(Mandatory)][string]$Installer,
  [string]$UpgradeInstaller,
  # rename rehearsal: a "HS Studio PackageTest" installer (package-windows.ps1 -Variant test-renamed)
  # installed after the old one must remove the old per-user install and keep the user data
  [string]$RenamedInstaller,
  [string]$WorkRoot,
  [string[]]$E2EFiles = @('tests/e2e/smoke.e2e.mjs', 'tests/e2e/engine.e2e.mjs'),
  [switch]$SkipE2E,
  [switch]$KeepWorkRoot
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$Product = 'VHO PackageTest'
$Identifier = 'com.vho.app.packagetest'
$results = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  [void]$results.Add([pscustomobject]@{ check = $name; ok = $ok; detail = $detail })
  Write-Host ("  [{0}] {1} {2}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $name, $detail)
}

$Installer = (Resolve-Path $Installer).Path
$RenamedProduct = 'HS Studio PackageTest'
$RenamedIdentifier = 'com.hsstudio.app.packagetest'
foreach ($i in @($Installer, $UpgradeInstaller) | Where-Object { $_ }) {
  if ((Split-Path $i -Leaf) -notlike "$Product*") { throw "Refusing '$i': only the test identity ($Product, built with -Variant test) may be installed by this script." }
}
if ($RenamedInstaller) {
  if ((Split-Path $RenamedInstaller -Leaf) -notlike "$RenamedProduct*") { throw "Refusing '$RenamedInstaller': expected a $RenamedProduct installer (-Variant test-renamed)." }
  $RenamedInstaller = (Resolve-Path $RenamedInstaller).Path
}
$renamedKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$RenamedProduct"
if (Test-Path $renamedKey) { throw "A '$RenamedProduct' install is already registered. Uninstall it first." }
if ($UpgradeInstaller) { $UpgradeInstaller = (Resolve-Path $UpgradeInstaller).Path }
$uninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product"
if (Test-Path $uninstKey) { throw "A '$Product' install is already registered ($uninstKey). Uninstall it first." }

if (-not $WorkRoot) { $WorkRoot = Join-Path ([IO.Path]::GetTempPath()) ('vho-pkgtest-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force $WorkRoot | Out-Null
$installDir = Join-Path $WorkRoot ('Kurulum Dizini ' + [string][char]0x011F + [char]0x00FC + [char]0x015F + [char]0x0131 + [char]0x00F6 + [char]0x00E7)  # "ğüşıöç"
$dataDir = Join-Path $WorkRoot 'veri klasörü'
New-Item -ItemType Directory -Force $dataDir | Out-Null

function Snapshot {
  $s = [ordered]@{}
  $s.uninstall = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object PSChildName | Sort-Object)
  $s.classes = @(Get-ChildItem 'HKCU:\Software\Classes' -ErrorAction SilentlyContinue | ForEach-Object PSChildName | Sort-Object)
  $run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  $s.run = @(if ($run) { $run.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object Name | Sort-Object })
  $s.startMenu = @(Get-ChildItem ([Environment]::GetFolderPath('Programs')) -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName | Sort-Object)
  $s.desktop = @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object)
  return $s
}
function Compare-Snapshot($a, $b) {
  $out = @()
  foreach ($k in $a.Keys) {
    $d = Compare-Object @($a[$k]) @($b[$k]) -ErrorAction SilentlyContinue
    if ($d) { $out += "$k`: " + (($d | ForEach-Object { "$($_.SideIndicator)$($_.InputObject)" }) -join ', ') }
  }
  return $out
}
function RunInstaller([string]$exe, [string]$dir) {
  # NSIS: /S silent, /NS no shortcuts, /D= must be last and unquoted
  $p = Start-Process -FilePath $exe -ArgumentList @('/S', '/NS', "/D=$dir") -PassThru -Wait
  return $p.ExitCode
}
function MainExe([string]$dir) {
  Get-ChildItem $dir -Filter *.exe -File | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
}
function LaunchOnce([string]$exe, [string]$data, [int]$seconds = 10) {
  $wv = Join-Path $WorkRoot ('webview-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $psi = New-Object Diagnostics.ProcessStartInfo $exe
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['VHO_DATA_DIR'] = $data
  $psi.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = $wv
  $psi.EnvironmentVariables['VHO_DISABLE_SYSTEM_SUSPEND'] = '1'
  $psi.EnvironmentVariables['VHO_DISABLE_SYSTEM_CHANGES'] = '1'
  $psi.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
  $p = [Diagnostics.Process]::Start($psi)
  Start-Sleep -Seconds $seconds
  $alive = -not $p.HasExited
  if ($alive) { $p.CloseMainWindow() | Out-Null; if (-not $p.WaitForExit(8000)) { $p.Kill(); $p.WaitForExit() } }
  # the uninstaller refuses while a process of this exe still runs: wait until none is left (max 20 s)
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  return $alive
}

Write-Host "== work folder : $WorkRoot"
Write-Host "== install to  : $installDir"
$before = Snapshot
# the manifest written for exactly this installer (variant "test", same version)
$installerVersion = if ((Split-Path $Installer -Leaf) -match '_(\d+\.\d+\.\d+)_x64-setup\.exe$') { $Matches[1] } else { '' }
$manifestPath = Get-Item (Join-Path (Split-Path $Installer -Parent) "package-manifest-test-$installerVersion.json") -ErrorAction SilentlyContinue

try {
  # ------------------------------------------------------------ install
  Write-Host "`n== install"
  $code = RunInstaller $Installer $installDir
  Check 'installer exit code 0' ($code -eq 0) "($code)"
  $exe = MainExe $installDir
  Check 'main exe installed' ([bool]$exe) "$($exe.FullName)"
  foreach ($f in 'mpv\libmpv-2.dll', 'mpv\ffmpeg.exe', 'mpv\ffprobe.exe', 'mpv\avcodec-62.dll', 'legal\LICENSE.txt', 'legal\NOTICE.txt','legal\THIRD_PARTY_NOTICES.txt', 'legal\SOURCE-OFFER.txt', 'legal\sbom.cdx.json', 'uninstall.exe') {
    Check "file $f" (Test-Path (Join-Path $installDir $f))
  }
  Check 'registered under HKCU (per-user, no admin)' (Test-Path $uninstKey)
  Check 'not registered under HKLM' (-not (Test-Path "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product"))
  if ($manifestPath) {
    $m = Get-Content $manifestPath.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    $bad = @()
    foreach ($f in $m.files | Where-Object { $_.path -match '^(mpv|legal)/' }) {
      $p = Join-Path $installDir ($f.path -replace '/', '\')
      if (-not (Test-Path $p) -or (Get-FileHash -Algorithm SHA256 $p).Hash.ToLowerInvariant() -ne $f.sha256) { $bad += $f.path }
    }
    Check 'installed files match package manifest (sha256)' ($bad.Count -eq 0) ($bad -join ', ')
  }
  $assoc = Compare-Snapshot $before (Snapshot)
  $assocBad = @($assoc | Where-Object { $_ -like 'classes:*' -or $_ -like 'startMenu:*' -or $_ -like 'desktop:*' -or $_ -like 'run:*' })
  Check 'no file associations / shortcuts / autostart created' ($assocBad.Count -eq 0) ($assocBad -join ' | ')

  # ------------------------------------------------------------ E2E on the installed exe
  if (-not $SkipE2E) {
    Write-Host "`n== E2E against the installed exe (minimal PATH)"
    $nodeDir = Split-Path (Get-Command node).Source -Parent
    $oldPath = $env:PATH
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$nodeDir"
    $env:VHO_EXE = $exe.FullName
    $env:VHO_E2E_PORT_MIN = '10900'; $env:VHO_E2E_PORT_MAX = '10999'
    Push-Location $root
    try {
      & node scripts/run-tests.mjs e2e @E2EFiles
      $e2eCode = $LASTEXITCODE
    } finally { Pop-Location; $env:PATH = $oldPath; Remove-Item Env:VHO_EXE }
    Check 'E2E (smoke + engine) on installed exe' ($e2eCode -eq 0) "(exit $e2eCode)"
  }

  # ------------------------------------------------------------ user data + upgrade
  Write-Host "`n== user data written by the installed app"
  Check 'installed app starts with minimal PATH' (LaunchOnce $exe.FullName $dataDir)
  $dataFiles = @(Get-ChildItem $dataDir -Recurse -File | ForEach-Object { $_.FullName.Substring($dataDir.Length + 1) })
  Check 'app created its data (settings/library.db)' ($dataFiles.Count -gt 0) ($dataFiles -join ', ')
  $dataHash = @{}; Get-ChildItem $dataDir -Recurse -File | ForEach-Object { $dataHash[$_.FullName] = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash }

  if ($UpgradeInstaller) {
    Write-Host "`n== upgrade over the existing install"
    $v1 = (Get-ItemProperty $uninstKey).DisplayVersion
    $code = RunInstaller $UpgradeInstaller $installDir
    $v2 = (Get-ItemProperty $uninstKey).DisplayVersion
    Check 'upgrade installer exit code 0' ($code -eq 0) "($code)"
    Check 'version changed' ($v1 -ne $v2) "($v1 -> $v2)"
    $changed = @($dataHash.Keys | Where-Object { -not (Test-Path $_) -or (Get-FileHash -Algorithm SHA256 $_).Hash -ne $dataHash[$_] })
    Check 'upgrade left user data untouched' ($changed.Count -eq 0) ($changed -join ', ')
    $exe = MainExe $installDir
    Check 'upgraded app starts with the existing data' (LaunchOnce $exe.FullName $dataDir)
    Check 'library.db still present after upgraded start' (@(Get-ChildItem $dataDir -Recurse -Filter 'library.db').Count -gt 0)
  }

  # ------------------------------------------------------------ rename rehearsal
  if ($RenamedInstaller) {
    Write-Host "`n== renamed product installed over the old one"
    $renamedDir = Join-Path $WorkRoot 'Yeni Ad Kurulum'
    $code = RunInstaller $RenamedInstaller $renamedDir
    Check 'renamed installer exit code 0' ($code -eq 0) "($code)"
    $hookLog = Join-Path ([IO.Path]::GetTempPath()) 'legacy-install-hook.log'
    if (Test-Path $hookLog) { Write-Host "  hook: $((Get-Content $hookLog -Raw).Trim())"; Remove-Item $hookLog -Force }
    else { Write-Host '  hook: no trace (the old product was not found by the installer hook)' }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Test-Path $uninstKey) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Check 'old product uninstalled by the renamed installer' (-not (Test-Path $uninstKey))
    $oldLeft = @(if (Test-Path $installDir) { Get-ChildItem $installDir -Recurse -Force | ForEach-Object { $_.FullName } })
    Check 'old install folder removed' ($oldLeft.Count -eq 0) ($oldLeft -join ', ')
    Check 'renamed product registered under HKCU' (Test-Path $renamedKey)
    $changed = @($dataHash.Keys | Where-Object { -not (Test-Path $_) -or (Get-FileHash -Algorithm SHA256 $_).Hash -ne $dataHash[$_] })
    Check 'rename left user data untouched' ($changed.Count -eq 0) ($changed -join ', ')
    $exe = MainExe $renamedDir
    Check 'renamed app starts with the existing data' (LaunchOnce $exe.FullName $dataDir)
    # from here on the renamed install is the one to remove
    $installDir = $renamedDir
    $uninstKey = $renamedKey
  }

  # ------------------------------------------------------------ uninstall
  Write-Host "`n== uninstall"
  # every user file present right before uninstalling (later launches may have added backups etc.)
  $beforeUninstall = @(Get-ChildItem $dataDir -Recurse -File | ForEach-Object { $_.FullName.Substring($dataDir.Length + 1) })
  $un = Join-Path $installDir 'uninstall.exe'
  # a silent uninstall aborts while the app is still closing: like a user, try again (max 3 times)
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Start-Process -FilePath $un -ArgumentList '/S' -Wait
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path $uninstKey) -or (Test-Path (Join-Path $installDir 'uninstall.exe'))) {
      if ((Get-Date) -gt $deadline) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path $uninstKey) -or -not (Test-Path $un)) { break }
    Start-Sleep -Seconds 3
  }
  if ($attempt -gt 1) { Write-Host "  uninstall needed $([Math]::Min($attempt, 3)) attempts" }
  Check 'uninstall registry key removed' (-not (Test-Path $uninstKey))
  $left = @(if (Test-Path $installDir) { Get-ChildItem $installDir -Recurse -Force | ForEach-Object { $_.FullName } })
  Check 'install folder removed' ($left.Count -eq 0) ($left -join ', ')
  $lost = @($beforeUninstall | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dataDir $_)) })
  Check 'user data kept after uninstall (default)' ($beforeUninstall.Count -ge $dataFiles.Count -and $lost.Count -eq 0) "before: $($beforeUninstall -join ', '); lost: $($lost -join ', ')"
} finally {
  # ------------------------------------------------------------ test-only leftovers
  Write-Host "`n== cleanup of test-only leftovers"
  foreach ($k in @($uninstKey, "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product", $renamedKey) | Select-Object -Unique) {
    if (Test-Path $k) {
      $u = (Get-ItemProperty $k).UninstallString -replace '"', ''
      if ($u -and (Test-Path $u)) { Start-Process -FilePath $u -ArgumentList '/S' -Wait }
    }
  }
  $pub = 'HKCU:\Software\TurkuazCode'
  foreach ($name in @($Product, $RenamedProduct)) {
    if (Test-Path "$pub\$name") {
      Write-Host "  removing $pub\$name (Tauri keeps it unless 'delete app data' is chosen)"
      Remove-Item -Recurse -Force "$pub\$name"
    }
  }
  if ((Test-Path $pub) -and -not (Get-ChildItem $pub -ErrorAction SilentlyContinue) -and -not (Get-ItemProperty $pub -ErrorAction SilentlyContinue).PSObject.Properties.Where({ $_.Name -notlike 'PS*' })) { Remove-Item -Force $pub }
  foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    foreach ($id in @($Identifier, $RenamedIdentifier)) {
      Get-ChildItem $base -Directory -Filter "$id*" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  removing $($_.FullName)"; Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue
      }
    }
  }
  $after = Snapshot
  $d = Compare-Snapshot $before $after
  Check 'environment snapshot unchanged after the test' ($d.Count -eq 0) ($d -join ' | ')
  if (-not $KeepWorkRoot) { Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue }
}

$failed = @($results | Where-Object { -not $_.ok })
Write-Host "`n== RESULT: $($results.Count - $failed.Count)/$($results.Count) checks ok"
New-Item -ItemType Directory -Force (Join-Path $root 'tests\.results') | Out-Null
# same shape as the other layers (scripts/release-gate.mjs): the commit is the one the installer
# was built from (its package manifest), the artifact is the tested installer itself
$built = if ($manifestPath) { Get-Content $manifestPath.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$summary = [ordered]@{
  layer = 'installer'
  commitFull = if ($built) { $built.sourceCommit } else { $null }
  commit = if ($built) { ([string]$built.sourceCommit).Substring(0, 7) } else { $null }
  dirty = $null
  platform = 'win32-x64'
  full = $true
  identity = 'test'  # always the test identity (see the header); never evidence for the real product id
  installer = [ordered]@{ name = (Split-Path $Installer -Leaf); sha256 = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant() }
  upgrade = [bool]$UpgradeInstaller
  finished = (Get-Date).ToString('o')
  exitCode = if ($failed) { 1 } else { 0 }
  pass = $results.Count - $failed.Count; fail = $failed.Count; skip = 0; todo = 0; cancelled = 0
  checks = @($results)
}
New-Item -ItemType Directory -Force (Join-Path $root 'tests\.results') | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'tests\.results\installer.json'), ($summary | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
if ($failed) { exit 1 }
