// Clipboard contention (flaky actions.e2e clipboard subtests): another process holding the
// Windows clipboard open (OpenClipboard) makes every copy/paste fail. The app retries with
// backoff (~3.1 s, src-tauri/src/actions/clipboard.rs) and, when the holder does not let go,
// fails with a coded error that names the holding executable.
// A helper PowerShell process takes the clipboard with its own window, like a clipboard
// manager would. The user's clipboard text is saved before and restored after the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { launchApp } from "./lib/app.mjs";

const skip = process.platform === "win32" ? false : "Windows clipboard API";

/** Starts a process that holds the clipboard for `ms`; resolves once it has it. */
function holdClipboard(ms) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace W -Name C -MemberDefinition '[DllImport("user32.dll")] public static extern bool OpenClipboard(System.IntPtr h); [DllImport("user32.dll")] public static extern bool CloseClipboard();'
$f = New-Object System.Windows.Forms.Form
$ok = $false
for ($i = 0; $i -lt 200 -and -not $ok; $i++) { $ok = [W.C]::OpenClipboard($f.Handle); if (-not $ok) { Start-Sleep -Milliseconds 20 } }
if (-not $ok) { Write-Output "FAILED"; exit 1 }
Write-Output "HELD"
Start-Sleep -Milliseconds ${ms}
[void][W.C]::CloseClipboard()
Write-Output "RELEASED"`;
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise((r) => ps.once("exit", r));
  const held = new Promise((resolve, reject) => {
    let out = "";
    ps.stdout.on("data", (d) => {
      out += d;
      if (out.includes("HELD")) resolve();
      if (out.includes("FAILED")) reject(new Error("helper could not open the clipboard"));
    });
    ps.once("exit", (c) => { if (!out.includes("HELD")) reject(new Error(`helper exited ${c}`)); });
  });
  return { held, exited, kill: () => ps.kill() }; // our own child only
}

test("clipboard: copy waits out a busy clipboard; a long hold gives a coded error naming the holder", { timeout: 90000, skip }, async (t) => {
  const app = await launchApp();
  const inv = (cmd, args = {}) => `__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
  const saved = await app.eval(inv("clipboard_read_text")).catch(() => null);
  try {
    await t.test("held for 1.2 s: copy succeeds after the holder lets go", async () => {
      const h = holdClipboard(1200);
      await h.held;
      const started = Date.now();
      await app.eval(`${inv("clipboard_copy_text", { text: "vho-contention-short" })}.then(() => true)`, { timeoutMs: 15000 });
      const waited = Date.now() - started;
      await h.exited;
      assert.equal(await app.eval(inv("clipboard_read_text")), "vho-contention-short");
      t.diagnostic(`copy completed after ${waited} ms of contention`);
      assert.ok(waited >= 500, `copy returned after ${waited} ms although the clipboard was held`);
    });

    await t.test("held for 8 s: coded [clipboard-busy] error naming the holder, then works again", async () => {
      const h = holdClipboard(8000);
      await h.held;
      const started = Date.now();
      const err = await app.eval(`${inv("clipboard_copy_text", { text: "vho-contention-long" })}.then(() => "no error", (e) => String(e))`, { timeoutMs: 15000 });
      const waited = Date.now() - started;
      assert.match(err, /^\[clipboard-busy\]/, err);
      assert.match(err, /powershell\.exe/i, `holder named: ${err}`);
      assert.ok(waited >= 2500 && waited < 6000, `gave up after ${waited} ms (budget ~3.1 s)`);
      await h.exited;
      await app.eval(`${inv("clipboard_copy_text", { text: "vho-contention-after" })}.then(() => true)`);
      assert.equal(await app.eval(inv("clipboard_read_text")), "vho-contention-after");
    });
  } finally {
    if (typeof saved === "string") await app.eval(inv("clipboard_copy_text", { text: saved })).catch(() => {});
    await app.close();
  }
});
