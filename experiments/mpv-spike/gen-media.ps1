<#
  Generates synthetic test media with the LGPL FFmpeg built by third_party/mpv/build-windows.sh.
  H.264/HEVC are encoded with Windows Media Foundation encoders (h264_mf / hevc_mf) because an
  LGPL FFmpeg has no x264/x265. Nothing here comes from user media.

  .\gen-media.ps1     -> media\h264-1080p.mp4, media\hevc-4k.mkv, media\multitrack.mkv
#>
param([string]$Prefix = "$PSScriptRoot\..\..\third_party\mpv\_build\prefix")
$ErrorActionPreference = 'Stop'
$ff = Join-Path $Prefix 'bin\ffmpeg.exe'
$env:Path = (Join-Path $Prefix 'bin') + ';C:\msys64\ucrt64\bin;' + $env:Path
$m = Join-Path $PSScriptRoot 'media'
New-Item -ItemType Directory -Force $m | Out-Null
function Write-NoBom([string]$name, [string]$text) { [IO.File]::WriteAllText((Join-Path $m $name), $text) }
Push-Location $m
try {
  $src1080 = 'testsrc2=size=1920x1080:rate=30,noise=alls=12:allf=t'
  & $ff -hide_banner -y -f lavfi -i $src1080 -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 40 `
    -c:v h264_mf -b:v 8M -pix_fmt nv12 -c:a aac -b:a 160k -movflags +faststart h264-1080p.mp4
  if ($LASTEXITCODE) { throw 'h264 failed' }

  & $ff -hide_banner -y -f lavfi -i 'testsrc2=size=3840x2160:rate=30,noise=alls=12:allf=t' -f lavfi -i 'sine=frequency=330:sample_rate=48000' -t 30 `
    -c:v hevc_mf -b:v 20M -pix_fmt nv12 -c:a aac -b:a 160k hevc-4k.mkv
  if ($LASTEXITCODE) { throw 'hevc failed' }

  # --- multitrack: 2 audio (tur/eng), 2 subtitles (tur ASS, eng SRT), 3 chapters
  Write-NoBom 'sub-eng.srt' "1`r`n00:00:00,500 --> 00:00:59,000`r`nEnglish subtitle track (SRT)`r`n"
  Write-NoBom 'sub-tur.ass' @"
[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,20,20,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:59.00,Default,,0,0,0,,Türkçe altyazı (ASS, sarı) — ğüşıöç

"@
  $ch = ";FFMETADATA1`n"
  foreach ($i in 0..2) { $ch += "[CHAPTER]`nTIMEBASE=1/1000`nSTART=$($i*20000)`nEND=$(($i+1)*20000)`ntitle=Bölüm $($i+1)`n" }
  Write-NoBom 'chapters.txt' $ch

  & $ff -hide_banner -y -f lavfi -i 'testsrc2=size=1280x720:rate=30' `
    -f lavfi -i 'sine=frequency=440:sample_rate=48000' -f lavfi -i 'sine=frequency=880:sample_rate=48000' `
    -i sub-tur.ass -i sub-eng.srt -i chapters.txt -t 60 `
    -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s -map_metadata 5 -map_chapters 5 `
    -c:v h264_mf -b:v 3M -pix_fmt nv12 -c:a aac -b:a 128k -c:s:0 ass -c:s:1 srt `
    -metadata:s:a:0 language=tur -metadata:s:a:0 title='Türkçe 440Hz' `
    -metadata:s:a:1 language=eng -metadata:s:a:1 title='English 880Hz' `
    -metadata:s:s:0 language=tur -metadata:s:s:0 title='Türkçe ASS' `
    -metadata:s:s:1 language=eng -metadata:s:s:1 title='English SRT' `
    multitrack.mkv
  if ($LASTEXITCODE) { throw 'multitrack failed' }
  Get-ChildItem *.mp4, *.mkv | Select-Object Name, Length
} finally { Pop-Location }
