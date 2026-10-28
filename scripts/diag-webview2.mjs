// Diagnostics for the CI E2E failure "no CDP page on port …" (diag-webview2.yml).
// Starts the release exe once with the E2E environment (tests/e2e/lib/app.mjs appEnv) and records
// what happens for 60 s: CDP endpoint answers, process tree (msedgewebview2?), listening ports,
// the app's stdout/stderr, desktop screenshots and the WebView2 profile's logs / crash dumps.
//
// Usage: node scripts/diag-webview2.mjs <out dir> <label> [extra browser args]
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { appEnv, defaultExe, findFreePort } from "../tests/e2e/lib/app.mjs";
import { sleep } from "../tests/e2e/lib/cdp.mjs";

const [outRoot, label, extraArgs = ""] = process.argv.slice(2);
if (!outRoot || !label) throw new Error("usage: diag-webview2.mjs <out dir> <label> [extra browser args]");
const out = join(outRoot, label);
await mkdir(out, { recursive: true });

const log = createWriteStream(join(out, "timeline.txt"));
const t0 = performance.now();
const note = (...a) => {
  const line = `[${((performance.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${a.join(" ")}`;
  console.log(line);
  log.write(line + "\n");
};

const powershell = (script, env = {}) => {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000,
  });
  return (r.stdout || "") + (r.stderr || "") + (r.error ? `\n${r.error.message}` : "");
};

const SCREENSHOT = `
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($env:DIAG_PNG, [System.Drawing.Imaging.ImageFormat]::Png)
  "screenshot $($b.Width)x$($b.Height)"`;

// Our process tree plus every WebView2 / WER process on the machine (with command lines)
const snapshot = (pid) => powershell(`
  $all = Get-CimInstance Win32_Process
  $tree = @(${pid}); do { $n = $tree.Count; $tree = @($tree + ($all | Where-Object { $tree -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($tree.Count -gt $n)
  "== processes (tree of ${pid}, msedgewebview2, WerFault)"
  $all | Where-Object { $tree -contains $_.ProcessId -or $_.Name -match 'msedgewebview2|WerFault' } |
    Format-List ProcessId, ParentProcessId, SessionId, Name, CommandLine | Out-String -Width 4096
  "== main process"
  Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Format-List Id, Responding, MainWindowTitle, MainWindowHandle, SessionId | Out-String
  "== listening ports of the tree"
  Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $tree -contains $_.OwningProcess } |
    Format-Table LocalAddress, LocalPort, OwningProcess | Out-String`);

const port = await findFreePort();
const userData = await mkdtemp(join(tmpdir(), "vho-diag-"));
const dataDir = join(userData, "vho-data");
await mkdir(dataDir, { recursive: true });
const env = { ...appEnv({ port, userData, dataDir }), RUST_BACKTRACE: "1" };
if (extraArgs) env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS += ` ${extraArgs}`;
const exe = defaultExe();
await writeFile(join(out, "launch.json"), JSON.stringify({ exe, port, userData, env: Object.fromEntries(
  Object.entries(env).filter(([k]) => /^(VHO_|WEBVIEW2_|RUST_)/.test(k))) }, null, 2));

const proc = spawn(exe, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
proc.stdout.pipe(createWriteStream(join(out, "app-stdout.txt")));
proc.stderr.pipe(createWriteStream(join(out, "app-stderr.txt")));
let exitCode = null;
proc.once("exit", (code, signal) => { exitCode = code ?? signal; note(`app exited: ${exitCode}`); });
note(`spawned pid ${proc.pid}, CDP port ${port}, exe ${exe}`);

let page = null;
let lastAnswer = "";
for (let s = 1; s <= 60 && exitCode === null && !page; s++) {
  await sleep(1000);
  let answer;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
    const targets = await res.json();
    answer = `HTTP ${res.status}: ${targets.map((t) => `${t.type} ${t.url}`).join(" | ") || "no targets"}`;
    page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
  } catch (e) {
    answer = `${e.message}${e.cause ? ` (${e.cause.code ?? e.cause.message})` : ""}`;
  }
  if (answer !== lastAnswer) note(`CDP /json: ${answer}`);
  lastAnswer = answer;
  if ([5, 20].includes(s)) {
    await writeFile(join(out, `processes-${s}s.txt`), snapshot(proc.pid));
    note(powershell(SCREENSHOT, { DIAG_PNG: join(out, `desktop-${s}s.png`) }).trim());
  }
}
note(page ? `CDP page found: ${page.url}` : "no CDP page");
await writeFile(join(out, "processes-final.txt"), snapshot(proc.pid));
note(powershell(SCREENSHOT, { DIAG_PNG: join(out, "desktop-final.png") }).trim());
try {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  await writeFile(join(out, "cdp-version.json"), await v.text());
} catch {}

if (exitCode === null) {
  note(powershell(`taskkill /T /F /PID ${proc.pid}`).trim());
  await sleep(2000);
}

// WebView2 profile: file list + logs, crash dumps and settings files (small ones only)
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([relative(userData, p), statSync(p).size]);
  }
};
try { walk(userData); } catch (e) { note(`profile walk: ${e.message}`); }
await writeFile(join(out, "profile-files.txt"), files.map(([p, n]) => `${String(n).padStart(10)}  ${p}`).join("\n"));
for (const [p, n] of files) {
  if (n < 5_000_000 && /(\.log|\.dmp|\.txt|\.json|Local State|Preferences)$/i.test(p)) {
    const dst = join(out, "profile", p);
    await mkdir(join(dst, ".."), { recursive: true });
    await copyFile(join(userData, p), dst).catch(() => {});
  }
}
note("done");
log.end();
