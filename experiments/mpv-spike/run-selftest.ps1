<#
  Runs the spike's automated self-test for one media file and samples CPU/GPU of the whole
  process tree (mpv-spike.exe + its WebView2 processes) once per second.

  .\run-selftest.ps1 -File media\h264-1080p.mp4 -Dll lib\lgpl\libmpv-2.dll -Label lgpl-h264
  Optional: -BrowserArgs "--disable-gpu-compositing"  -MpvOpt "hwdec=no","vo=gpu"
  Output: results\<Label>.log.jsonl (app steps) and results\<Label>.samples.csv (+ summary on stdout)
#>
param(
  [Parameter(Mandatory)] [string]$File,
  [Parameter(Mandatory)] [string]$Dll,
  [Parameter(Mandatory)] [string]$Label,
  [string]$BrowserArgs = '',
  [string]$Mode = '',
  [string[]]$MpvOpt = @(),
  [int]$TimeoutSec = 120,
  [string]$Exe = "$PSScriptRoot\src-tauri\target\release\mpv-spike.exe"
)
$ErrorActionPreference = 'Stop'
$res = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Force $res | Out-Null
$log = Join-Path $res "$Label.log.jsonl"
$csv = Join-Path $res "$Label.samples.csv"

$a = @('--dll', (Resolve-Path $Dll).Path, '--selftest', $log)
if ($Mode) { $a += @('--mode', $Mode) }
if ($BrowserArgs) { $a += @('--browser-args', "`"$BrowserArgs`"") }
foreach ($o in $MpvOpt) { $a += @('--mpv-opt', $o) }
$target = if (Test-Path -LiteralPath $File) { (Resolve-Path -LiteralPath $File).Path } else { $File }  # URLs like av://lavfi:...
$a += "`"$target`""
$p = Start-Process -FilePath $Exe -ArgumentList $a -PassThru
$rootPid = $p.Id
Write-Host "started mpv-spike pid=$rootPid"

function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $ids = @($root); $added = $true
  while ($added) {
    $added = $false
    foreach ($x in $all) { if ($ids -contains $x.ParentProcessId -and $ids -notcontains $x.ProcessId) { $ids += [int]$x.ProcessId; $added = $true } }
  }
  $ids
}

$rows = @()
$prevCpu = @{}; $t0 = Get-Date
while (-not $p.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  $tree = Get-Tree $rootPid
  $gpu = @{}
  try {
    # per-PID wildcard is ~5x faster than '(*)' and avoids invalid-sample errors from unrelated processes
    $paths = $tree | ForEach-Object { "\GPU Engine(pid_$($_)_*)\Utilization Percentage" }
    $samples = (Get-Counter $paths -ErrorAction SilentlyContinue).CounterSamples
    foreach ($s in $samples) {
      if ($s.InstanceName -match '^pid_(\d+)_.*engtype_(.+)$') {
        $procId = [int]$Matches[1]; $eng = $Matches[2]
        if ($tree -contains $procId) {
          $who = if ($procId -eq $rootPid) { 'app' } else { 'webview' }
          $k = "$who-$eng"; $gpu[$k] = [double]($gpu[$k]) + $s.CookedValue
        }
      }
    }
  } catch {}
  $cpuApp = 0.0; $cpuWv = 0.0
  foreach ($id in $tree) {
    try { $pp = Get-Process -Id $id -ErrorAction Stop } catch { continue }
    $ms = $pp.TotalProcessorTime.TotalMilliseconds
    if ($prevCpu.ContainsKey($id)) { if ($id -eq $rootPid) { $cpuApp += $ms - $prevCpu[$id] } else { $cpuWv += $ms - $prevCpu[$id] } }
    $prevCpu[$id] = $ms
  }
  $now = Get-Date
  if ($script:lastT) {
    $dt = ($now - $script:lastT).TotalMilliseconds
    $cores = [Environment]::ProcessorCount
    $row = [ordered]@{ t = [math]::Round(($now - $t0).TotalSeconds, 1); cpu_app = [math]::Round($cpuApp / $dt * 100 / $cores, 2); cpu_webview = [math]::Round($cpuWv / $dt * 100 / $cores, 2) }
    foreach ($k in 'app-3D', 'app-VideoDecode', 'webview-3D', 'webview-VideoDecode') { $row[$k] = [math]::Round([double]$gpu[$k], 1) }
    $rows += [pscustomobject]$row
  }
  $script:lastT = $now
  Start-Sleep -Milliseconds 300
}
if (-not $p.HasExited) { Write-Warning "timeout, stopping pid $rootPid"; Stop-Process -Id $rootPid }
$rows | Export-Csv -NoTypeInformation -Path $csv
# BMP captures -> half-size PNG (small enough to commit as evidence)
Add-Type -AssemblyName System.Drawing
Get-ChildItem (Join-Path $res 'captures') -Filter "$Label-*.bmp" -ErrorAction SilentlyContinue | ForEach-Object {
  $b = [System.Drawing.Image]::FromFile($_.FullName)
  $s = New-Object System.Drawing.Bitmap $b, ([int]($b.Width / 2)), ([int]($b.Height / 2))
  $s.Save(($_.FullName -replace '\.bmp$', '.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose(); $s.Dispose(); Remove-Item -LiteralPath $_.FullName
}
$steady = $rows | Where-Object { $_.t -ge 6 }
"exit=$($p.ExitCode) samples=$($rows.Count)"
foreach ($c in 'cpu_app', 'cpu_webview', 'app-3D', 'app-VideoDecode', 'webview-3D', 'webview-VideoDecode') {
  $m = $steady | Measure-Object -Property $c -Average -Maximum
  '{0,-20} avg {1,6:N1}  max {2,6:N1}' -f $c, $m.Average, $m.Maximum
}
Get-Content $log
