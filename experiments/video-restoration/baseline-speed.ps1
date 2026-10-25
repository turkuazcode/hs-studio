<#
  V02 preparation, candidate 1 (plain scaling + traditional cleanup): CPU speed of the
  ffmpeg filter chains the V01 recipe emits, on a GENERATED 10 s PAL-like interlaced clip
  (720x576, SAR 16:15, 25i; ffmpeg lavfi, nothing personal). Output goes to null (no encode).

    powershell -NoProfile -ExecutionPolicy Bypass -File ..\with-lock.ps1 -Name e7 `
      -Command "powershell -NoProfile -ExecutionPolicy Bypass -File experiments\video-restoration\baseline-speed.ps1"

  Prints one line per chain: wall seconds, frames, fps. Threads limited (-threads 2,
  -filter_threads 2) to stay friendly to a shared machine.
#>
param([string]$Ffmpeg = (Join-Path $PSScriptRoot '..\..\src-tauri\target\release\ffmpeg.exe'))
$ErrorActionPreference = 'Stop'
$ff = (Resolve-Path $Ffmpeg).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("vho-v02-baseline-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $tmp | Out-Null
try {
  $src = Join-Path $tmp 'pal-i.mkv'
  & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=720x288:rate=50,weave=first_field=top,setsar=16/15' `
    -t 10 -c:v ffv1 $src
  $base = 'bwdif=mode=send_field:parity=tff:deint=all'
  $tail = 'scale=960:720:flags=lanczos,setsar=1,colorspace=ispace=bt470bg:iprimaries=bt470bg:itrc=smpte170m:irange=tv:space=bt709:primaries=bt709:trc=bt709:range=tv:format=yuv420p,format=yuv420p'
  $chains = [ordered]@{
    'deint+scale'            = "$base,$tail"
    'deint+atadenoise+scale' = "$base,atadenoise,$tail"
    'deint+fftdnoiz+scale'   = "$base,fftdnoiz=sigma=6,$tail"
    'deint+nlmeans+scale'    = "$base,nlmeans=s=3:p=7:r=15,$tail"
  }
  foreach ($k in $chains.Keys) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $log = & $ff -hide_banner -nostdin -threads 2 -filter_threads 2 -i $src -vf $chains[$k] -f null - 2>&1 | Out-String
    $sw.Stop()
    $frames = if ($log -match 'frame=\s*(\d+)') { [int]($log | Select-String 'frame=\s*(\d+)' -AllMatches).Matches[-1].Groups[1].Value } else { 0 }
    '{0,-24} {1,6:N1} s  {2,4} frames  {3,6:N1} fps' -f $k, $sw.Elapsed.TotalSeconds, $frames, ($frames / $sw.Elapsed.TotalSeconds)
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
