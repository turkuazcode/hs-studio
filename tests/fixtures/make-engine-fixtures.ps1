<#
  Synthetic media for the libmpv engine tests, made with the LGPL FFmpeg of
  third_party/mpv/build-windows.sh (H.264/HEVC via the Windows Media Foundation encoders,
  because an LGPL FFmpeg has no x264/x265). Nothing comes from user media.

    powershell -File tests\fixtures\make-engine-fixtures.ps1 [-Prefix <...\_build\prefix>]

  engine-multitrack.mkv  320x240 H.264, 6 s, 2 audio (tur 440 Hz / eng 880 Hz),
                         2 subtitles (tur ASS / eng SRT), 3 chapters (0, 2, 4 s)
  engine-hevc.mp4        640x360 HEVC, 2 s, AAC
#>
param([string]$Prefix = $(if ($env:VHO_MPV_PREFIX) { $env:VHO_MPV_PREFIX } else { "$PSScriptRoot\..\..\third_party\mpv\_build\prefix" }))
$ErrorActionPreference = 'Continue'  # ffmpeg logs to stderr; exit codes are checked
$ff = Join-Path $Prefix 'bin\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "LGPL ffmpeg.exe not found under $Prefix (build third_party/mpv first or pass -Prefix)" }
$env:Path = (Join-Path $Prefix 'bin') + ';C:\msys64\ucrt64\bin;' + $env:Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) "vho-engine-fixtures"
New-Item -ItemType Directory -Force $tmp | Out-Null
function Write-NoBom([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text) }

Write-NoBom "$tmp\eng.srt" "1`r`n00:00:00,300 --> 00:00:05,900`r`nEnglish subtitle track (SRT)`r`n"
Write-NoBom "$tmp\tur.ass" @"
[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 240

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,18,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,12,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.30,0:00:05.90,Default,,0,0,0,,Türkçe altyazı (ASS) ğüşıöç

"@
$ch = ";FFMETADATA1`n"
foreach ($i in 0..2) { $ch += "[CHAPTER]`nTIMEBASE=1/1000`nSTART=$($i*2000)`nEND=$(($i+1)*2000)`ntitle=Bölüm $($i+1)`n" }
Write-NoBom "$tmp\chapters.txt" $ch

Push-Location $PSScriptRoot
try {
  & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=320x240:rate=15' `
    -f lavfi -i 'sine=frequency=440:sample_rate=48000' -f lavfi -i 'sine=frequency=880:sample_rate=48000' `
    -i "$tmp\tur.ass" -i "$tmp\eng.srt" -i "$tmp\chapters.txt" -t 6 `
    -map 0:v -map 1:a -map 2:a -map 3:s -map 4:s -map_metadata 5 -map_chapters 5 `
    -c:v h264_mf -b:v 200k -pix_fmt nv12 -c:a aac -b:a 32k -ac 1 -c:s:0 ass -c:s:1 srt `
    -metadata:s:a:0 language=tur -metadata:s:a:0 title='Türkçe 440Hz' `
    -metadata:s:a:1 language=eng -metadata:s:a:1 title='English 880Hz' `
    -metadata:s:s:0 language=tur -metadata:s:s:0 title='Türkçe ASS' `
    -metadata:s:s:1 language=eng -metadata:s:s:1 title='English SRT' `
    engine-multitrack.mkv
  if ($LASTEXITCODE) { throw 'multitrack failed' }

  & $ff -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=640x360:rate=15' -f lavfi -i 'sine=frequency=330:sample_rate=48000' -t 2 `
    -c:v hevc_mf -hw_encoding 1 -b:v 200k -pix_fmt nv12 -tag:v hvc1 -c:a aac -b:a 32k -ac 1 engine-hevc.mp4
  if ($LASTEXITCODE) { Write-Warning 'hevc_mf failed (no Media Foundation HEVC encoder?)' }
  Get-ChildItem engine-* | Select-Object Name, Length
} finally { Pop-Location; Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
