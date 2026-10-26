<#
  Prepares a CLEANED COPY of the git history for the first public push (R01, owner approval
  2026-10-25; docs/release/history-cleanup.md). Run it only once, right before the first push,
  after every agent branch has been merged into main.

  It NEVER modifies the repository it is started from: it makes a fresh `git clone --mirror`
  into a new temporary folder and rewrites only that copy. Default is a DRY RUN (report only).

    # 1) dry run: what would change (no clone is rewritten)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-public-history.ps1

    # 2) apply to a throwaway mirror (needs git-filter-repo, see below)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-public-history.ps1 -Apply `
      -NewEmail "<id>+<user>@users.noreply.github.com" -NewName "Halil SARITAŞ" `
      -FilterRepo C:\build\tools\filter-repo\Scripts\git-filter-repo.exe

  What the rewrite does (in the mirror only):
    - removes tests/fixtures/gen/target/ (build output committed once in 329d31d, ~70 MiB)
    - removes experiments/mpv-spike/results/captures/ (screenshots that show the local user path
      in the spike's file field); keep them with -KeepCaptures
    - replaces the local Windows user-profile path (Users\<LocalUser>, Users/<LocalUser>, also
      JSON-escaped) with Users\user in every file of every commit (spike logs)
    - optionally rewrites every author/committer e-mail (and name) via a mailmap (-NewEmail)
    - keeps only -Branches (default: main) and all tags, unless -AllBranches
  Then it re-runs scripts/scan-history.mjs on the result and prints a before/after report.

  git-filter-repo (MIT, https://github.com/newren/git-filter-repo) is required for -Apply. Do not
  install it system-wide; a removable dev-local venv is enough:
    python -m venv C:\build\tools\filter-repo
    C:\build\tools\filter-repo\Scripts\python.exe -m pip install git-filter-repo==2.47.0
  and pass -FilterRepo C:\build\tools\filter-repo\Scripts\git-filter-repo.exe (or have
  `git filter-repo` on PATH). Remove the folder afterwards.
#>
param(
  [string]$Source,
  [string]$WorkDir,
  [string]$FilterRepo,
  [string]$NewEmail,
  [string]$NewName,
  [string]$LocalUser = $env:USERNAME,
  [string[]]$Branches = @('main'),
  [switch]$AllBranches,
  [switch]$KeepCaptures,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # git prints UTF-8 names (e.g. "Ş")
$scriptRoot = Split-Path $PSScriptRoot -Parent
if (-not $Source) { $Source = $scriptRoot }
$Source = (Resolve-Path $Source).Path
$scanner = Join-Path $scriptRoot 'scripts\scan-history.mjs'
if (-not $LocalUser) { throw 'LocalUser is empty: pass -LocalUser <windows account name>' }
if ($NewName -and -not $NewEmail) { throw '-NewName needs -NewEmail' }

function Invoke-Git { param([string[]]$GitArgs)
  $out = & git @GitArgs
  if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed ($LASTEXITCODE)" }
  return $out
}

$removePaths = @('tests/fixtures/gen/target/')
if (-not $KeepCaptures) { $removePaths += 'experiments/mpv-spike/results/captures/' }
$userRx = [regex]::Escape($LocalUser)
# filter-repo --replace-text expressions (Python regex on bytes; \1 keeps the separator)
$expressions = @("regex:(?i)Users([\\/]+)$userRx(?![A-Za-z0-9_.-])==>Users\1user")

if (-not $WorkDir) { $WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("hs-studio-public-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
if ((Test-Path $WorkDir) -and (Get-ChildItem $WorkDir -Force | Select-Object -First 1)) { throw "WorkDir '$WorkDir' is not empty" }
New-Item -ItemType Directory -Force $WorkDir | Out-Null
$WorkDir = (Resolve-Path $WorkDir).Path
if ($WorkDir.StartsWith($Source, [StringComparison]::OrdinalIgnoreCase)) { throw 'WorkDir must be outside the source repository' }

Write-Host "== Source repository (read-only): $Source"
Write-Host "== Work folder: $WorkDir"
Write-Host "== Mode: $(if ($Apply) { 'APPLY (rewrites the mirror copy only)' } else { 'DRY RUN' })"

# ---------------------------------------------------------------- before
$unmerged = Invoke-Git @('-C', $Source, 'branch', '--no-merged', $Branches[0], '--format=%(refname:short)')
if ($unmerged) { Write-Warning "branches not merged into $($Branches[0]) (their work is NOT in the public copy unless -AllBranches): $($unmerged -join ', ')" }
$beforeJson = Join-Path $WorkDir 'scan-before.json'
& node $scanner --repo $Source --json $beforeJson | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'history scan (before) failed' }
$before = Get-Content $beforeJson -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host "`n== Paths removed from every commit"
$allPaths = Invoke-Git @('-C', $Source, 'log', '--all', '--format=', '--name-only') | Where-Object { $_ } | Sort-Object -Unique
foreach ($p in $removePaths) {
  $hits = @($allPaths | Where-Object { $_.StartsWith($p) })
  Write-Host ("  {0,-45} {1} file(s) in history" -f $p, $hits.Count)
}
Write-Host "`n== Text replaced in every commit"
Write-Host "  $($expressions -join "`n  ")"
$hitSet = @{}
$prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
foreach ($c in (Invoke-Git @('-C', $Source, 'rev-list', '--all'))) {
  # git grep exits 1 when nothing matches; binary files are reported as "Binary file ... matches"
  foreach ($l in (& git -C $Source grep -l -i -I -E "Users[\\/]+$LocalUser([^A-Za-z0-9_.-]|$)" $c 2>$null)) {
    $hitSet[($l -replace "^${c}:", '')] = $true
  }
}
$ErrorActionPreference = $prevEap
$pathHits = @($hitSet.Keys | Sort-Object)
Write-Host "  text files containing the path in at least one commit: $($pathHits.Count)"
$pathHits | ForEach-Object { Write-Host "    $_" }

$identities = @(Invoke-Git @('-C', $Source, 'log', '--all', '--format=%an <%ae>%n%cn <%ce>') | Where-Object { $_ } | Sort-Object -Unique)
Write-Host "`n== Commit identities"
$identities | ForEach-Object { Write-Host "  $_" }
if ($NewEmail) {
  $mailmap = Join-Path $WorkDir 'mailmap.txt'
  # "<new> <old>" matches every commit with the old e-mail, whatever the name spelling
  $lines = @($identities | ForEach-Object { if ($_ -match '<([^>]+)>$') { $Matches[1] } } | Sort-Object -Unique | ForEach-Object {
    if ($NewName) { "$NewName <$NewEmail> <$_>" } else { "<$NewEmail> <$_>" }
  })
  [IO.File]::WriteAllLines($mailmap, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
  Write-Host "  -> rewritten to: $(if ($NewName) { $NewName } else { '<same name>' }) <$NewEmail>"
} else {
  Write-Host '  -> unchanged (pass -NewEmail to rewrite)'
}
Write-Host "`n== Refs kept: $(if ($AllBranches) { 'all branches + tags' } else { ($Branches -join ', ') + ' + tags' })"

if (-not $Apply) {
  Write-Host "`nDRY RUN: nothing was rewritten. Re-run with -Apply (and -NewEmail if wanted)."
  return
}

# ---------------------------------------------------------------- apply (mirror only)
if (-not $FilterRepo) {
  & git filter-repo --version *> $null
  if ($LASTEXITCODE -eq 0) { $frCmd = @('git', 'filter-repo') } else { throw 'git-filter-repo not found: pass -FilterRepo <path to git-filter-repo(.exe)> (see the header of this script)' }
} else { $frCmd = @($FilterRepo) }

$mirror = Join-Path $WorkDir 'repo.git'
Invoke-Git @('clone', '--quiet', '--mirror', '--no-local', $Source, $mirror) | Out-Null
if (-not $AllBranches) {
  foreach ($ref in (Invoke-Git @('-C', $mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads/'))) {
    $name = $ref -replace '^refs/heads/', ''
    if ($Branches -notcontains $name) { Invoke-Git @('-C', $mirror, 'update-ref', '-d', $ref) | Out-Null }
  }
}
Invoke-Git @('-C', $mirror, 'symbolic-ref', 'HEAD', "refs/heads/$($Branches[0])") | Out-Null
$exprFile = Join-Path $WorkDir 'replace-text.txt'
[IO.File]::WriteAllLines($exprFile, [string[]]$expressions, (New-Object Text.UTF8Encoding $false))
$frArgs = @('--force', '--invert-paths')
foreach ($p in $removePaths) { $frArgs += @('--path', $p) }
$frArgs += @('--replace-text', $exprFile)
if ($NewEmail) { $frArgs += @('--mailmap', $mailmap) }
Push-Location $mirror
try {
  # --force: the mirror is a throwaway clone made a moment ago by this script
  $exe = $frCmd[0]; $rest = @($frCmd | Select-Object -Skip 1) + $frArgs
  & $exe @rest
  if ($LASTEXITCODE -ne 0) { throw "git-filter-repo failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Invoke-Git @('-C', $mirror, 'reflog', 'expire', '--expire=now', '--all') | Out-Null
Invoke-Git @('-C', $mirror, 'gc', '--quiet', '--prune=now', '--aggressive') | Out-Null

# ---------------------------------------------------------------- after + report
$afterJson = Join-Path $WorkDir 'scan-after.json'
& node $scanner --repo $mirror --json $afterJson | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'history scan (after) failed' }
$after = Get-Content $afterJson -Raw -Encoding UTF8 | ConvertFrom-Json
function UserHits($scan) {
  $n = 0
  foreach ($p in $scan.personal.PSObject.Properties) { if ($p.Name -match "(?i)path: .*Users[\\/]+$userRx\b") { $n += $p.Value.count } }
  return $n
}
function PackMiB($repo) {
  $size = (Invoke-Git @('-C', $repo, 'count-objects', '-v') | Where-Object { $_ -like 'size-pack:*' }) -replace '\D', ''
  return [math]::Round([int64]$size / 1024, 1)
}
$rows = @(
  @('refs', $before.refs, $after.refs),
  @('commits', $before.commits, $after.commits),
  @('blobs', $before.blobs, $after.blobs),
  @('blobs >= 1 MiB', $before.large.Count, $after.large.Count),
  @('media files', $before.media.Count, $after.media.Count),
  @('binary/archive files', $before.binary.Count, $after.binary.Count),
  @('secret pattern hits', $before.secrets.Count, $after.secrets.Count),
  @("local user path ($LocalUser) hits", (UserHits $before), (UserHits $after)),
  @('commit identities', $before.identities.Count, $after.identities.Count),
  @('pack size (MiB)', (PackMiB $Source), (PackMiB $mirror))
)
Write-Host "`n== Before / after"
Write-Host ('  {0,-34} {1,10} {2,10}' -f 'check', 'before', 'after')
foreach ($r in $rows) { Write-Host ('  {0,-34} {1,10} {2,10}' -f $r[0], $r[1], $r[2]) }
Write-Host '  identities after:'
$after.identities | ForEach-Object { Write-Host "    $_" }
$fail = @()
if ((UserHits $after) -gt 0) { $fail += 'local user path still present' }
if ($after.secrets.Count -gt 0) { $fail += 'secret pattern hits' }
if (@($after.large | Where-Object { $_.paths -match '^tests/fixtures/gen/target/' }).Count -gt 0) { $fail += 'build output still present' }
if ($fail) { Write-Warning "NOT clean: $($fail -join '; ')"; exit 1 }

Write-Host "`nCleaned mirror: $mirror"
Write-Host 'Next (manual, see docs/release/history-cleanup.md):'
Write-Host "  git clone $mirror <check-dir>; cd <check-dir>; npm ci; npm test"
Write-Host "  git -C $mirror push <new-public-remote-url> --all ; git -C $mirror push <url> --tags"
Write-Host '  Then work only from a fresh clone of the public repository (old local branches carry the old history).'
