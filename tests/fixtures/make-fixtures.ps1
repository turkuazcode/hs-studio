# Regenerates every test fixture in this folder (Windows only; all content is synthetic).
#   sample-h264.mp4 / legacy-wmv9.wmv : Media Foundation encoders via tests/fixtures/gen (Rust, `windows` crate)
#   photo-a.jpg / photo-b.png         : System.Drawing
#   sample.srt / sample.vtt / sample-1254.srt : make-subtitles.mjs (Node)
# Usage:  powershell -ExecutionPolicy Bypass -File tests\fixtures\make-fixtures.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# 1) Subtitles (UTF-8 SRT/VTT and a Windows-1254 SRT)
node (Join-Path $here 'make-subtitles.mjs')
if ($LASTEXITCODE -ne 0) { throw 'make-subtitles.mjs failed' }

# 2) Video clips
$gen = Join-Path $here 'gen'
cargo build --release --manifest-path (Join-Path $gen 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw 'fixture generator build failed' }
& (Join-Path $gen 'target\release\vho-fixture-gen.exe') $here
if ($LASTEXITCODE -ne 0) { throw 'fixture generator failed' }

# 3) Photos: two different sizes / formats so EXIF-free decoding, info card and navigation can be checked
Add-Type -AssemblyName System.Drawing
function New-TestImage([string]$Path, [int]$W, [int]$H, [string]$Label, [System.Drawing.Color]$From, [System.Drawing.Color]$To, $Format) {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $From, $To, 45.0
  $g.FillRectangle($grad, $rect)
  # Orientation markers: red square top-left, blue circle bottom-right (rotation is visible)
  $g.FillRectangle([System.Drawing.Brushes]::Red, 10, 10, [int]($W / 8), [int]($W / 8))
  $g.FillEllipse([System.Drawing.Brushes]::Blue, $W - [int]($W / 6) - 10, $H - [int]($W / 6) - 10, [int]($W / 6), [int]($W / 6))
  $font = New-Object System.Drawing.Font 'Arial', ([single]($H / 10)), ([System.Drawing.FontStyle]::Bold)
  $g.DrawString($Label, $font, [System.Drawing.Brushes]::White, [single]($W / 5), [single]($H / 2.5))
  $g.Dispose()
  if ($Format -eq [System.Drawing.Imaging.ImageFormat]::Jpeg) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
    $bmp.Save($Path, $codec, $params)
  } else {
    $bmp.Save($Path, $Format)
  }
  $bmp.Dispose()
  "$Path ($((Get-Item $Path).Length) bytes)"
}
New-TestImage (Join-Path $here 'photo-a.jpg') 640 480 'VHO A' ([System.Drawing.Color]::DarkSlateBlue) ([System.Drawing.Color]::Orange) ([System.Drawing.Imaging.ImageFormat]::Jpeg)
New-TestImage (Join-Path $here 'photo-b.png') 400 300 'VHO B' ([System.Drawing.Color]::SeaGreen) ([System.Drawing.Color]::Black) ([System.Drawing.Imaging.ImageFormat]::Png)

$total = (Get-ChildItem $here -File | Where-Object { $_.Extension -in '.mp4', '.wmv', '.jpg', '.png', '.srt', '.vtt' } | Measure-Object Length -Sum).Sum
"fixtures total: $total bytes"
if ($total -gt 2MB) { throw 'fixtures exceed 2 MB' }
