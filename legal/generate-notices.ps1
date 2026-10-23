# Builds src/legal/THIRD_PARTY_NOTICES.txt (shown in the app's "Lisanslar" window)
# from legal/NOTICES_HEADER.txt + the Rust crate licenses found by cargo-about.
# Run after changing Rust dependencies:  powershell -File legal\generate-notices.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tmp = Join-Path $env:TEMP "vho-crate-licenses.txt"
Push-Location "$root\src-tauri"
try {
  cargo about generate --fail -o $tmp about.hbs
  if ($LASTEXITCODE -ne 0) { throw "cargo about failed" }
} finally { Pop-Location }
$crates = Get-Content $tmp -Raw -Encoding UTF8
$out = "$root\src\legal\THIRD_PARTY_NOTICES.txt"
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
$text = (Get-Content "$PSScriptRoot\NOTICES_HEADER.txt" -Raw -Encoding UTF8) + ($crates -join "`n")
[IO.File]::WriteAllText($out, $text, (New-Object Text.UTF8Encoding $false))
"wrote $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
