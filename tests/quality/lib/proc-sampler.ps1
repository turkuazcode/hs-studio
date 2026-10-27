# Samples the resource use of a whole process tree (vho.exe + its WebView2 / ffmpeg children)
# until -StopFile exists, then writes one JSON object to -OutFile. Read-only: never touches
# a process. GPU memory comes from the Windows "GPU Process Memory" performance counters
# (dedicated = VRAM, shared = system memory used by the GPU; an iGPU mostly uses shared).
param(
    [Parameter(Mandatory)][int]$RootPid,
    [Parameter(Mandatory)][string]$StopFile,
    [Parameter(Mandatory)][string]$OutFile,
    [int]$IntervalMs = 250,
    [int]$GpuEvery = 4
)
$ErrorActionPreference = "SilentlyContinue"

function Get-Tree([int]$root) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime
    $children = @{}
    foreach ($p in $all) { if (-not $children.ContainsKey([int]$p.ParentProcessId)) { $children[[int]$p.ParentProcessId] = @() }; $children[[int]$p.ParentProcessId] += $p }
    $byId = @{}
    foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $tree = @()
    $queue = New-Object System.Collections.Queue
    if ($byId.ContainsKey($root)) { $queue.Enqueue($byId[$root]) }
    while ($queue.Count -gt 0) {
        $p = $queue.Dequeue()
        $tree += $p
        if ($children.ContainsKey([int]$p.ProcessId)) { foreach ($c in $children[[int]$p.ProcessId]) { if ($c.ProcessId -ne $p.ProcessId) { $queue.Enqueue($c) } } }
    }
    return $tree
}

$peakWs = 0; $peakPrivate = 0; $peakDedicated = 0; $peakShared = 0; $peakProcs = 0
$cpuFirst = @{}; $cpuLast = @{}; $names = @{}
$samples = 0; $i = 0
$started = Get-Date
while (-not (Test-Path $StopFile)) {
    $tree = Get-Tree $RootPid
    if ($tree.Count -eq 0) { break }
    $ws = 0; $priv = 0
    foreach ($p in $tree) {
        $ws += [int64]$p.WorkingSetSize
        $priv += [int64]$p.PrivatePageCount
        $cpu = ([int64]$p.KernelModeTime + [int64]$p.UserModeTime) / 1e7
        $id = [int]$p.ProcessId
        if (-not $cpuFirst.ContainsKey($id)) { $cpuFirst[$id] = $cpu }
        $cpuLast[$id] = $cpu
        $names[$id] = $p.Name
    }
    if ($ws -gt $peakWs) { $peakWs = $ws }
    if ($priv -gt $peakPrivate) { $peakPrivate = $priv }
    if ($tree.Count -gt $peakProcs) { $peakProcs = $tree.Count }
    if (($i % $GpuEvery) -eq 0) {
        $ded = 0; $sh = 0
        $pids = $tree | ForEach-Object { [int]$_.ProcessId }
        $c = Get-Counter -Counter "\GPU Process Memory(*)\Dedicated Usage", "\GPU Process Memory(*)\Shared Usage" -ErrorAction SilentlyContinue
        foreach ($s in $c.CounterSamples) {
            if ($s.InstanceName -match "^pid_(\d+)_") {
                if ($pids -contains [int]$Matches[1]) {
                    if ($s.Path -like "*dedicated usage") { $ded += $s.CookedValue } else { $sh += $s.CookedValue }
                }
            }
        }
        if ($ded -gt $peakDedicated) { $peakDedicated = $ded }
        if ($sh -gt $peakShared) { $peakShared = $sh }
    }
    $samples++; $i++
    Start-Sleep -Milliseconds $IntervalMs
}
$cpu = 0
foreach ($k in $cpuLast.Keys) { $cpu += $cpuLast[$k] - $cpuFirst[$k] }
$result = [ordered]@{
    samples = $samples
    seconds = ((Get-Date) - $started).TotalSeconds
    cpuSeconds = $cpu
    peakWorkingSetBytes = $peakWs
    peakPrivateBytes = $peakPrivate
    peakGpuDedicatedBytes = [int64]$peakDedicated
    peakGpuSharedBytes = [int64]$peakShared
    peakProcesses = $peakProcs
    processes = @($names.Values | Sort-Object -Unique)
}
$result | ConvertTo-Json -Compress | Set-Content -Path $OutFile -Encoding utf8
