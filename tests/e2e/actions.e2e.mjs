// Media actions (Plan 06 §6): per-media toolbars, clipboard (path / file / image / text),
// rename, delete to the recycle bin (+ playlist), lossless cut (duration), extract audio
// (audio only), convert 720p (resolution), tag edit (re-read), lyrics, ReplayGain, OCR on a
// generated image, and OS actions logged but NOT applied (VHO_DISABLE_SYSTEM_CHANGES=1).
//
// SAFETY: every file touched here is a copy inside a fresh temp folder created by the test.
// The recycle bin entry the delete test creates is purged again (only that one item).
// The user's clipboard text is saved before and restored after the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, fixture, launchApp } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

// Same lookup locations as the backend (actions/ffmpeg.rs): next to the exe, exe\mpv\, resources\mpv\.
const FFMPEG = ["", "mpv", join("resources", "mpv")]
  .map((sub) => join(dirname(defaultExe()), sub, "ffmpeg.exe"))
  .find((p) => existsSync(p)) ?? join(dirname(defaultExe()), "ffmpeg.exe");
const skipFfmpeg = existsSync(FFMPEG) ? false : "ffmpeg.exe not staged next to vho.exe (npm run stage:mpv)";
const tag = Math.random().toString(36).slice(2, 8);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "vho-e2e-actions-"));
}

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dirname(FFMPEG), stdio: "pipe", timeout: 60000 });
}

/** Recycle bin entries whose original location is `dir` and name starts with `stem`; purge = delete them for good. */
function recycleBin(dir, stem, purge = false) {
  const ps = `
    $ErrorActionPreference = 'SilentlyContinue'
    $rb = (New-Object -ComObject Shell.Application).NameSpace(10)
    $n = 0
    foreach ($it in @($rb.Items())) {
      $orig = $rb.GetDetailsOf($it, 1)
      if ($orig -eq '${dir.replace(/'/g, "''")}' -and $it.Name -like '${stem}*') {
        $n++
        if (${purge ? "$true" : "$false"}) {
          $p = $it.Path
          $i = Join-Path (Split-Path $p -Parent) ('$I' + (Split-Path $p -Leaf).Substring(2))
          Remove-Item -LiteralPath $p -Force -Recurse
          Remove-Item -LiteralPath $i -Force
        }
      }
    }
    $n`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000 }).trim() || 0);
}

/** PNG with known text (System.Drawing), for OCR. */
function textImage(path, text) {
  const ps = `
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 1400, 360
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $font = New-Object System.Drawing.Font('Arial', 64, [System.Drawing.FontStyle]::Bold)
    $g.DrawString('${text}', $font, [System.Drawing.Brushes]::Black, 40, 120)
    $bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 60000 });
}

const inv = (cmd, args = {}) => `__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;

/** Common helpers bound to one app. */
function helpers(app) {
  const A = "window.__vhoActions";
  return {
    run: (id) => app.eval(`(${A}.run(${JSON.stringify(id)}), true)`),
    invoke: (cmd, args) => app.eval(inv(cmd, args)),
    toolbar: () => app.eval(`[...document.querySelectorAll("#media-actions button")].filter((b) => b.offsetParent !== null).map((b) => b.id)`),
    moreMenu: async () => {
      await app.click("#ma-more");
      await app.waitFor(`!document.getElementById("media-actions-menu").hidden`, { timeoutMs: 3000 });
      const ids = await app.eval(`[...document.querySelectorAll("#media-actions-menu [data-menu-id]")].map((b) => b.dataset.menuId)`);
      await app.eval(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
      return ids;
    },
    /** Waits for the export dialog to finish; returns the output path. */
    jobOutput: async (timeoutMs = 90000) => {
      await app.waitFor(`["done", "error"].includes(document.querySelector("#vho-job")?.dataset.state)`, { timeoutMs, message: "export job" });
      const state = await app.eval(`document.querySelector("#vho-job").dataset.state`);
      const err = await app.eval(`document.querySelector("#vho-job").dataset.error ?? ""`);
      assert.equal(state, "done", err);
      const out = await app.eval(`document.querySelector("#vho-job").dataset.output`);
      await app.click("#vho-job-close");
      return out;
    },
    systemLog: () => app.eval(inv("actions_system_log")),
    kind: () => app.eval(`${A}.current().kind`),
  };
}

let savedClipboard = null;
async function saveClipboard(app) {
  savedClipboard = await app.eval(inv("clipboard_read_text")).catch(() => null);
}
async function restoreClipboard(app) {
  if (typeof savedClipboard === "string") await app.eval(inv("clipboard_copy_text", { text: savedClipboard })).catch(() => {});
}

test("actions: video (toolbar, clipboard, cut, extract audio, convert 720p, rename, delete, OS actions)", { timeout: 360000, skip: skipFfmpeg }, async (t) => {
  const dir = tempDir();
  const video = join(dir, `vho-e2e-video-${tag}.mp4`);
  const victim = join(dir, `vho-e2e-sil-${tag}.mp4`);
  const hd = join(dir, `vho-e2e-hd-${tag}.mp4`);
  copyFileSync(fixture("sample-h264.mp4"), video);
  copyFileSync(fixture("sample-h264.mp4"), victim);
  // 1280x960 source for the 720p preset (LGPL ffmpeg: native mpeg4 + aac)
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=1280x960:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", "-shortest", hd]);
  const app = await launchApp({ args: [video, victim] });
  const x = helpers(app);
  const E = "window.__vhoEngine";
  try {
    await saveClipboard(app);
    await app.waitFor(`${E}.duration > 2.5 && window.__vhoActions.current().kind === "video"`, { timeoutMs: 20000, message: "video loaded" });

    await t.test("video toolbar: cut, save frame, convert, share, ⋯ (no photo / music buttons)", async () => {
      await app.waitFor(`!document.getElementById("media-actions").hidden`, { timeoutMs: 5000 });
      assert.deepEqual(await x.toolbar(), ["ma-cutVideo", "ma-saveFrame", "ma-convertMedia", "ma-shareFile", "ma-more"]);
      const ids = await x.moreMenu();
      for (const id of ["openWith", "showInFolder", "copyFrame", "copyFile", "copyPath", "gif", "clip", "extractAudio", "rotateVideo",
        "embedSubtitle", "extractSubtitle", "contactSheet", "miniPlayer", "alwaysOnTop", "renameFile", "deleteFile", "properties", "settings"]) {
        assert.ok(ids.includes(id), `${id} in ⋯ (${ids})`);
      }
      for (const id of ["printPhoto", "ocr", "tagEditor", "setWallpaper"]) assert.ok(!ids.includes(id), `${id} not for video`);
      // right-click menu carries the file actions too
      await app.eval(`document.getElementById("viewport").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })), true`);
      const ctx = await app.eval(`[...document.querySelectorAll("#context-menu [role=menuitem]")].map((b) => b.dataset.menuId)`);
      for (const id of ["copyPath", "shareFile", "renameFile", "deleteFile", "properties"]) assert.ok(ctx.includes(id), `${id} in context menu`);
      await app.key("Escape");
    });

    await t.test("copy path / copy file -> clipboard content", async () => {
      await x.run("copyPath");
      await app.waitFor(`${inv("clipboard_read_text")}.then((s) => s === ${JSON.stringify(video)})`, { timeoutMs: 5000, message: "path on clipboard" });
      await x.run("copyFile");
      await app.waitFor(`${inv("clipboard_read_files")}.then((f) => f.length === 1 && f[0].toLowerCase() === ${JSON.stringify(video.toLowerCase())})`, { timeoutMs: 5000, message: "file on clipboard" });
    });

    await t.test("lossless cut 0.5 s - 2.5 s -> output duration ±1 s", async () => {
      await app.click("#ma-cutVideo");
      await app.waitFor(`!!document.getElementById("vho-range-start")`, { timeoutMs: 3000 });
      await app.eval(`(() => { const s = document.getElementById("vho-range-start"), e = document.getElementById("vho-range-end");
        s.value = "0:00.5"; e.value = "0:02.5"; s.dispatchEvent(new Event("input")); return true; })()`);
      assert.equal(await app.eval(`document.getElementById("vho-range-precise").checked`), false);
      await app.click("#vho-range-ok");
      const out = await x.jobOutput();
      assert.ok(out.endsWith("_kesit.mp4"), out);
      assert.equal(dirname(out), dir);
      const info = await x.invoke("media_probe", { path: out });
      assert.ok(Math.abs(info.duration - 2) <= 1, `duration ${info.duration}`);
      assert.ok(info.video && info.audio.length === 1);
    });

    await t.test("extract audio (original stream) -> audio only", async () => {
      await x.run("extractAudio");
      await app.waitFor(`!!document.getElementById("vho-extract-audio-copy")`, { timeoutMs: 3000 });
      assert.equal(await app.eval(`document.getElementById("vho-extract-audio-copy").checked`), true);
      await app.click("#vho-extract-audio-ok");
      const out = await x.jobOutput();
      assert.ok(out.endsWith("_ses.m4a"), out);
      const info = await x.invoke("media_probe", { path: out });
      assert.equal(info.video, null);
      assert.equal(info.audio.length, 1);
      assert.equal(info.audio[0].codec, "aac");
    });

    await t.test("convert 720p (H.264 via the platform encoder) -> 960x720", async () => {
      await app.eval(`${E}.openPaths(${JSON.stringify([hd])}), true`);
      await app.waitFor(`document.getElementById("current-filename").textContent === ${JSON.stringify(`vho-e2e-hd-${tag}.mp4`)} && ${E}.duration > 2`, { timeoutMs: 20000 });
      await app.click("#ma-convertMedia");
      await app.waitFor(`!!document.getElementById("vho-convert-720p")`, { timeoutMs: 3000 });
      for (const p of ["whatsapp", "email", "1080p", "audio"]) assert.ok(await app.eval(`!!document.getElementById("vho-convert-${p}")`), p);
      await app.click("#vho-convert-720p");
      await app.click("#vho-convert-ok");
      const out = await x.jobOutput(120000);
      assert.ok(out.endsWith("_720p.mp4"), out);
      const info = await x.invoke("media_probe", { path: out });
      assert.equal(info.video.codec, "h264");
      assert.deepEqual([info.video.width, info.video.height], [960, 720]);
      assert.ok(info.audio[0]?.codec === "aac");
    });

    await t.test("GIF, permanent rotate (lossless), contact sheet, copy frame (on the 1280x960 video)", async () => {
      await x.run("gif");
      await app.waitFor(`!!document.getElementById("vho-gif-width")`, { timeoutMs: 3000 });
      await app.eval(`(() => { const s = document.getElementById("vho-range-start"), e = document.getElementById("vho-range-end");
        s.value = "0:00.5"; e.value = "0:02.0"; s.dispatchEvent(new Event("input")); return true; })()`);
      await app.click("#vho-range-ok");
      const gif = await x.jobOutput();
      const gi = await x.invoke("media_probe", { path: gif });
      assert.equal(gi.video.codec, "gif");
      assert.equal(gi.video.width, 480); // the 1280x960 source is current; smaller sources are never upscaled

      await x.run("rotateVideo");
      await app.waitFor(`!!document.getElementById("vho-rotate-90")`, { timeoutMs: 3000 });
      await app.click("#vho-rotate-90");
      await app.click("#vho-rotate-ok");
      const rot = await x.jobOutput();
      const ri = await x.invoke("media_probe", { path: rot });
      assert.equal(ri.video.rotation, -90);
      assert.equal(ri.video.codec, "mpeg4", "streams copied");

      await x.run("contactSheet");
      await app.waitFor(`!!document.getElementById("vho-sheet-3x3")`, { timeoutMs: 3000 });
      await app.click("#vho-sheet-3x3");
      await app.click("#vho-sheet-ok");
      const sheet = await x.jobOutput();
      assert.ok(sheet.endsWith("_kontak.png"), sheet);
      const si = await x.invoke("media_probe", { path: sheet });
      assert.ok(si.video.width >= 960, `sheet width ${si.video.width}`);

      await x.run("copyFrame");
      await app.waitFor(`${inv("clipboard_image_size")}.then((s) => s && s[0] === 1280 && s[1] === 960)`, { timeoutMs: 8000, message: "frame on clipboard" });
    });

    await t.test("subtitles: embed SRT into MKV, export it again (backend jobs)", async () => {
      const mkv = await app.eval(`${inv("media_job", { job: { input: video, kind: "embedSubtitle", subtitle: fixture("sample.srt") } })}.then((r) => r.output)`);
      assert.ok(mkv.endsWith("_altyazili.mkv"), mkv);
      const mi = await x.invoke("media_probe", { path: mkv });
      assert.equal(mi.subtitles.length, 1);
      assert.equal(mi.subtitles[0].codec, "subrip");
      const srt = await app.eval(`${inv("media_job", { job: { input: mkv, kind: "extractSubtitle", stream: 0, format: "srt" } })}.then((r) => r.output)`);
      assert.ok(srt.endsWith(".srt"), srt);
      assert.match(readFileSync(srt, "utf8"), /-->/);
    });

    await t.test("cancel a running export: no partial file left", async () => {
      const long = join(dir, `vho-e2e-uzun-${tag}.mp4`);
      ffmpeg(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=90", "-c:v", "mpeg4", "-q:v", "8", long]);
      const job = app.eval(`${inv("media_job", { job: { jobId: "e2e-cancel", input: long, kind: "convert", preset: "1080p" } })}.then(() => "done", (e) => String(e))`, { timeoutMs: 60000 });
      await sleep(700);
      assert.equal(await x.invoke("media_job_cancel", { jobId: "e2e-cancel" }), true);
      assert.match(await job, /^\[cancelled\]/);
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes("vho-part") || f.includes("uzun") && f.includes("_1080p")), []);
    });

    await t.test("favorite, always on top, mini player", async () => {
      await x.run("favorite");
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent.includes("favorilere eklendi")`, { timeoutMs: 3000 });
      await x.run("favorite");
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent.includes("çıkarıldı")`, { timeoutMs: 3000 });
      await x.run("alwaysOnTop");
      await app.waitFor(`window.__vhoActions.onTop === true && document.documentElement.classList.contains("always-on-top")`, { timeoutMs: 3000 });
      await x.run("alwaysOnTop");
      await app.waitFor(`window.__vhoActions.onTop === false`, { timeoutMs: 3000 });
      const before = await app.eval(`innerWidth`);
      await x.run("miniPlayer");
      await app.waitFor(`window.__vhoActions.mini && document.documentElement.classList.contains("mini-player") && innerWidth < 600`, { timeoutMs: 5000, message: "mini player" });
      assert.equal(await app.eval(`getComputedStyle(document.getElementById("media-actions")).display`), "none");
      await x.run("miniPlayer");
      await app.waitFor(`!window.__vhoActions.mini && innerWidth >= ${Math.min(before, 640)}`, { timeoutMs: 5000, message: "restored" });
      assert.equal(await app.eval(`window.__vhoActions.onTop`), false);
    });

    await t.test("OS actions are logged but not applied (VHO_DISABLE_SYSTEM_CHANGES)", async () => {
      for (const id of ["shareFile", "openWith", "showInFolder"]) await x.run(id);
      await app.waitFor(`${inv("actions_system_log")}.then((l) => ["share", "open-with", "reveal"].every((a) => l.some((e) => e.action === a)))`, { timeoutMs: 5000 });
      const log = await x.systemLog();
      assert.ok(log.length >= 3 && log.every((e) => e.applied === false), JSON.stringify(log));
      assert.equal((await x.invoke("actions_capabilities")).systemChangesDisabled, true);
    });

    await t.test("rename (F2 dialog): conflict check, then file + playlist + title updated", async () => {
      await app.eval(`window.__vhoActions && (document.querySelector('#playlist-items li[data-idx="0"]').click(), true)`);
      await app.waitFor(`document.getElementById("current-filename").textContent === ${JSON.stringify(`vho-e2e-video-${tag}.mp4`)} && ${E}.duration > 2`, { timeoutMs: 15000 });
      await x.run("renameFile");
      await app.waitFor(`document.getElementById("vho-rename-input")?.selectionEnd > 0`, { timeoutMs: 3000 });
      const sel = await app.eval(`(() => { const i = document.getElementById("vho-rename-input"); return [i.selectionStart, i.selectionEnd]; })()`);
      assert.deepEqual(sel, [0, `vho-e2e-video-${tag}`.length], "stem selected");
      // invalid name -> error, dialog stays
      await app.eval(`(() => { const i = document.getElementById("vho-rename-input"); i.value = "kötü:ad.mp4"; return true; })()`);
      await app.click("#vho-rename-ok");
      assert.match(await app.text("#vho-rename .vho-act-status"), /karakter/);
      // existing name -> backend conflict
      await app.eval(`(() => { const i = document.getElementById("vho-rename-input"); i.value = ${JSON.stringify(`vho-e2e-sil-${tag}.mp4`)}; return true; })()`);
      await app.click("#vho-rename-ok");
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent.includes("zaten var")`, { timeoutMs: 8000, message: "conflict toast" });
      assert.ok(existsSync(video));
      await app.waitFor(`${E}.duration > 2`, { timeoutMs: 15000 });
      // real rename
      const newName = `vho-e2e-yeni ad-${tag}.mp4`;
      await x.run("renameFile");
      await app.waitFor(`!!document.getElementById("vho-rename-input")`, { timeoutMs: 3000 });
      await app.eval(`(() => { const i = document.getElementById("vho-rename-input"); i.value = ${JSON.stringify(newName)}; return true; })()`);
      await app.click("#vho-rename-ok");
      await app.waitFor(`document.getElementById("current-filename").textContent === ${JSON.stringify(newName)}`, { timeoutMs: 10000, message: "title renamed" });
      assert.ok(existsSync(join(dir, newName)) && !existsSync(video));
      assert.equal(await app.eval(`window.__vhoActions.current().item.path`), join(dir, newName));
      await app.waitFor(`${E}.duration > 2`, { timeoutMs: 15000, message: "reloaded after rename" });
    });

    await t.test("properties dialog", async () => {
      await x.run("properties");
      await app.waitFor(`!!document.getElementById("vho-properties")`, { timeoutMs: 8000 });
      const text = await app.text("#vho-properties");
      assert.match(text, /Süre/);
      assert.match(text, /H264/);
      await app.click("#vho-properties-close");
    });

    await t.test("delete -> confirm -> recycle bin, removed from the playlist", async () => {
      const count = await app.eval(`window.__vhoEngine && document.querySelectorAll("#playlist-items li[data-idx]").length`);
      await app.eval(`document.querySelector('#playlist-items li[data-idx="1"]').click(), true`);
      await app.waitFor(`document.getElementById("current-filename").textContent === ${JSON.stringify(`vho-e2e-sil-${tag}.mp4`)} && ${E}.duration > 2`, { timeoutMs: 15000 });
      await x.run("deleteFile");
      await app.waitFor(`!!document.getElementById("vho-delete-ok")`, { timeoutMs: 3000 });
      assert.match(await app.text("#vho-delete"), /Geri Dönüşüm/);
      await app.click("#vho-delete-ok");
      await app.waitFor(`document.querySelectorAll("#playlist-items li[data-idx]").length === ${count - 1}`, { timeoutMs: 15000, message: "playlist shrank" });
      assert.equal(existsSync(victim), false, "file gone");
      assert.ok(!(await app.eval(`[...document.querySelectorAll("#playlist-items .item-name")].some((n) => n.textContent.includes("vho-e2e-sil-"))`)));
      assert.equal(recycleBin(dir, `vho-e2e-sil-${tag}`), 1, "in the recycle bin");
      assert.equal(recycleBin(dir, `vho-e2e-sil-${tag}`, true), 1, "purged");
      assert.equal(recycleBin(dir, `vho-e2e-sil-${tag}`), 0);
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await restoreClipboard(app);
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("actions: photo (toolbar, copy image, print preview, wallpaper, OCR)", { timeout: 180000 }, async (t) => {
  const dir = tempDir();
  const photo = join(dir, `vho-e2e-foto-${tag}.jpg`);
  const ocrPng = join(dir, `vho-e2e-ocr-${tag}.png`);
  copyFileSync(fixture("photo-a.jpg"), photo);
  textImage(ocrPng, "VHO METIN TANIMA 2026");
  const app = await launchApp({ args: [photo, ocrPng] });
  const x = helpers(app);
  const IMG = `document.getElementById("image-element")`;
  try {
    await saveClipboard(app);
    await app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 640 && window.__vhoActions.current().kind === "photo"`, { timeoutMs: 10000 });

    await t.test("photo toolbar: edit, delete, print, share, ⋯", async () => {
      await app.waitFor(`!document.getElementById("media-actions").hidden`, { timeoutMs: 5000 });
      assert.deepEqual(await x.toolbar(), ["ma-editPhoto", "ma-deleteFile", "ma-printPhoto", "ma-shareFile", "ma-more"]);
      const ids = await x.moreMenu();
      for (const id of ["copyImage", "copyPath", "ocr", "setWallpaper", "setLockScreen", "renameFile", "properties"]) assert.ok(ids.includes(id), id);
      for (const id of ["gif", "cutVideo", "tagEditor", "miniPlayer"]) assert.ok(!ids.includes(id), `${id} not for photos`);
    });

    await t.test("copy image (with the viewer rotation) -> clipboard bitmap", async () => {
      await x.run("copyImage");
      await app.waitFor(`${inv("clipboard_image_size")}.then((s) => s && s[0] === 640 && s[1] === 480)`, { timeoutMs: 8000, message: "640x480 on clipboard" });
      await app.key("KeyR"); // rotate right in the viewer
      await x.run("copyImage");
      await app.waitFor(`${inv("clipboard_image_size")}.then((s) => s && s[0] === 480 && s[1] === 640)`, { timeoutMs: 8000, message: "rotated copy" });
      await app.key("KeyR", { shiftKey: true });
    });

    await t.test("print preview -> print gated (logged, no dialog)", async () => {
      await app.click("#ma-printPhoto");
      await app.waitFor(`!!document.querySelector("#vho-print-preview img")`, { timeoutMs: 3000 });
      assert.equal(await app.eval(`document.getElementById("vho-print-orientation").value`), "landscape");
      await app.eval(`(() => { const s = document.getElementById("vho-print-fit"); s.value = "fill"; s.dispatchEvent(new Event("change")); return true; })()`);
      await app.click("#vho-print-ok");
      await app.waitFor(`${inv("actions_system_log")}.then((l) => l.some((e) => e.action === "print" && e.applied === false))`, { timeoutMs: 5000 });
      assert.equal(await app.eval(`!!document.getElementById("vho-print-root")`), false, "no print page created");
    });

    await t.test("desktop background / lock screen: logged, not applied", async () => {
      await x.run("setWallpaper");
      await x.run("setLockScreen");
      await app.waitFor(`${inv("actions_system_log")}.then((l) => ["wallpaper", "lock-screen"].every((a) => l.some((e) => e.action === a && e.applied === false)))`, { timeoutMs: 5000 });
    });

    await t.test("OCR on a generated image with known text", async (tt) => {
      const langs = await x.invoke("ocr_languages");
      if (!langs.length) {
        tt.skip("no Windows OCR language installed");
        return;
      }
      await app.click("#btn-photo-next");
      await app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 1400`, { timeoutMs: 8000 });
      await x.run("ocr");
      await app.waitFor(`!!document.getElementById("vho-ocr-layer")`, { timeoutMs: 30000, message: "OCR layer" });
      // the Turkish recognizer writes the dotted capital İ
      const text = (await app.eval(`document.getElementById("vho-ocr-layer").textContent`)).toUpperCase().replace(/İ/g, "I").replace(/\s+/g, " ");
      for (const w of ["VHO", "METIN", "TANIMA", "2026"]) assert.ok(text.includes(w), `"${w}" in "${text}" (languages: ${langs})`);
      await app.click("#vho-ocr-copy");
      await app.waitFor(`${inv("clipboard_read_text")}.then((s) => s.toUpperCase().includes("TANIMA"))`, { timeoutMs: 5000 });
      await app.click("#vho-ocr-close");
      assert.equal(await app.eval(`!!document.getElementById("vho-ocr-layer")`), false);
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await restoreClipboard(app);
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("actions: music (toolbar, tag edit, lyrics, ReplayGain, ringtone)", { timeout: 240000, skip: skipFfmpeg }, async (t) => {
  const dir = tempDir();
  const song = join(dir, `vho-e2e-sarki-${tag}.mp3`);
  // 8 s MP3 (Media Foundation encoder of the LGPL build) + a synced .lrc next to it
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-ac", "2", "-ar", "44100", "-c:a", "mp3_mf", "-b:a", "128k", song]);
  writeFileSync(join(dir, `vho-e2e-sarki-${tag}.lrc`), "[ti:Deneme]\n[00:00.00]Birinci satır\n[00:01.50]İkinci satır\n[00:30.00]Son satır\n");
  const app = await launchApp({ args: [song] });
  const x = helpers(app);
  const E = "window.__vhoEngine";
  try {
    await app.waitFor(`${E}.duration > 7 && window.__vhoActions.current().kind === "music"`, { timeoutMs: 20000, message: "song loaded" });

    await t.test("music toolbar: tags, lyrics, share, ⋯", async () => {
      await app.waitFor(`!document.getElementById("media-actions").hidden`, { timeoutMs: 5000 });
      assert.deepEqual(await x.toolbar(), ["ma-tagEditor", "ma-lyrics", "ma-shareFile", "ma-more"]);
      const ids = await x.moreMenu();
      for (const id of ["convertMedia", "ringtone", "replayGain", "miniPlayer", "renameFile", "deleteFile"]) assert.ok(ids.includes(id), id);
      for (const id of ["gif", "printPhoto", "copyFrame"]) assert.ok(!ids.includes(id), `${id} not for music`);
    });

    await t.test("lyrics: .lrc panel follows playback", async () => {
      await app.click("#ma-lyrics");
      await app.waitFor(`document.querySelectorAll("#vho-lyrics .vho-lyric-line").length === 3`, { timeoutMs: 5000 });
      assert.equal(await app.eval(`document.getElementById("vho-lyrics").dataset.source`), "lrc");
      assert.ok(await app.eval(`document.getElementById("vho-lyrics").classList.contains("is-synced")`));
      await app.eval(`${E}.paused && document.getElementById("btn-play-pause").click(), true`);
      await app.waitFor(`Number(document.getElementById("vho-lyrics").dataset.current) === 1`, { timeoutMs: 8000, message: "second line highlighted" });
      await app.click("#ma-lyrics");
      assert.equal(await app.eval(`!!document.getElementById("vho-lyrics")`), false);
    });

    await t.test("tag edit -> re-read equals (file released while writing)", async () => {
      await app.click("#ma-tagEditor");
      await app.waitFor(`!!document.getElementById("vho-tag-title")`, { timeoutMs: 5000 });
      await app.eval(`(() => {
        const set = (id, v) => { document.getElementById(id).value = v; };
        set("vho-tag-title", "Deneme Başlık Ğüşİöç"); set("vho-tag-artist", "VHO Sanatçı"); set("vho-tag-album", "Albüm");
        set("vho-tag-year", "2024"); set("vho-tag-genre", "Türkü"); set("vho-tag-track", "3");
        set("vho-tag-lyrics", "Gömülü söz");
        return true; })()`);
      await app.click("#vho-tags-ok");
      await app.waitFor(`!document.getElementById("vho-tags")`, { timeoutMs: 15000, message: "tag dialog closed" });
      const tg = await x.invoke("tags_read", { path: song });
      assert.equal(tg.title, "Deneme Başlık Ğüşİöç");
      assert.equal(tg.artist, "VHO Sanatçı");
      assert.equal(tg.album, "Albüm");
      assert.equal(tg.year, 2024);
      assert.equal(tg.genre, "Türkü");
      assert.equal(tg.track, 3);
      assert.equal(tg.lyrics, "Gömülü söz");
      await app.waitFor(`${E}.duration > 7`, { timeoutMs: 15000, message: "song reloaded" });
    });

    await t.test("ReplayGain: measured and written to the tags", async () => {
      await x.run("replayGain");
      await app.waitFor(`document.getElementById("vho-replaygain")?.dataset.gain !== undefined`, { timeoutMs: 30000 });
      await app.click("#vho-replaygain-close");
      const tg = await x.invoke("tags_read", { path: song });
      assert.match(tg.replaygainTrackGain, /^-?\d+\.\d\d dB$/);
      assert.match(tg.replaygainTrackPeak, /^\d\.\d{6}$/);
      await app.waitFor(`${E}.duration > 7`, { timeoutMs: 15000 });
    });

    await t.test("ringtone / excerpt 1 s - 4 s (M4R)", async () => {
      await x.run("ringtone");
      await app.waitFor(`!!document.getElementById("vho-seg-format")`, { timeoutMs: 3000 });
      await app.eval(`(() => { const s = document.getElementById("vho-range-start"), e = document.getElementById("vho-range-end"), f = document.getElementById("vho-seg-format");
        s.value = "1"; e.value = "4"; f.value = "m4r"; s.dispatchEvent(new Event("input")); return true; })()`);
      await app.click("#vho-range-ok");
      const out = await x.jobOutput();
      assert.ok(out.endsWith(".m4r"), out);
      const info = await x.invoke("media_probe", { path: out });
      assert.ok(Math.abs(info.duration - 3) < 0.5, `duration ${info.duration}`);
      assert.equal(info.audio[0].codec, "aac");
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
    await sleep(200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
