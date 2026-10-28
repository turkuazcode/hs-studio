// Faithful video enhance in the real app (model-free, LGPL ffmpeg filters): "Enhance video…" in
// the video ⋯ menu opens the dialog with the recommended settings; Reset works; the 10 s
// side-by-side preview is rendered by the queued "video-enhance" job and plays in the dialog;
// "Process all" writes <name>_enhanced.mkv next to the source with the audio kept; cancel stops
// the job without leaving a file; the original never changes. The clip is generated (lavfi).
// Audit D07: a preview made with older settings is labelled out of date; fast setting changes end
// in the last choice; the field-order question preselects the file's flag; HDR is refused before
// any job; an app killed mid-run leaves no result and the job restarts from the beginning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

const FFMPEG = ["", "mpv", join("resources", "mpv")]
  .map((sub) => join(dirname(defaultExe()), sub, "ffmpeg.exe"))
  .find((p) => existsSync(p)) ?? join(dirname(defaultExe()), "ffmpeg.exe");
const FFPROBE = join(dirname(FFMPEG), "ffprobe.exe");
const skip = existsSync(FFMPEG) ? false : "ffmpeg.exe not staged next to the app (npm run stage:mpv)";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const ff = (args) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dirname(FFMPEG), stdio: "pipe", timeout: 120000 });
const probe = (p) => JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", p], { cwd: dirname(FFPROBE), encoding: "utf8" }));

test("video enhance: recommended settings, reset, side-by-side preview, full result, cancel", { timeout: 300000, skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-venh-"));
  const clip = join(dir, "eski video.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25,scale=640:360", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "40", "-map", "0", "-map", "1", "-c:v", "mpeg4", "-q:v", "10", "-c:a", "aac", "-b:a", "96k", clip]);
  const before = sha(clip);
  const app = await launchApp({ args: [clip] });
  const state = () => app.eval(`document.getElementById("vho-venh")?.dataset.state ?? ""`);
  try {
    await app.waitFor(`(window.__vhoEngine?.duration ?? 0) > 30`, { timeoutMs: 20000, message: "video loaded" });

    await t.test("⋯ menu offers it for video; dialog opens with the recommended settings", async () => {
      await app.click("#ma-more");
      await app.waitFor(`!!document.querySelector('#media-actions-menu [data-menu-id="enhanceVideo"]')`, { timeoutMs: 3000, message: "item in ⋯" });
      await app.click(`#media-actions-menu [data-menu-id="enhanceVideo"]`);
      await app.waitFor(`!!document.getElementById("vho-venh") && document.getElementById("vho-venh").dataset.state !== "planning"`, { timeoutMs: 60000, message: "plan done" });
      assert.equal(await state(), "ready", await app.text("#vho-venh .vho-act-status"));
      assert.equal(await app.eval(`document.getElementById("vho-venh-denoise").value`), "light");
      assert.equal(await app.eval(`document.getElementById("vho-venh-sharpen").value`), "light");
      assert.equal(await app.eval(`document.getElementById("vho-venh-upscale").value`), "no");
      assert.equal(await app.eval(`document.querySelector("#vho-venh [role=dialog]") !== null`), true);
      assert.match(await app.text("#vho-venh .vho-act-status"), /640×360/);
    });

    await t.test("reset to defaults after a change", async () => {
      await app.eval(`(() => { const s = document.getElementById("vho-venh-denoise"); s.value = "medium"; s.dispatchEvent(new Event("change")); return true; })()`);
      await app.click("#vho-venh-reset");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000 });
      assert.equal(await app.eval(`document.getElementById("vho-venh-denoise").value`), "light");
    });

    await t.test("10 s side-by-side preview plays in the dialog", async () => {
      await app.click("#vho-venh-preview");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "previewed"`, { timeoutMs: 90000, message: "preview rendered" });
      await app.waitFor(`(() => { const v = document.getElementById("vho-venh-video"); return !v.hidden && v.readyState >= 2 && v.videoWidth === 640; })()`, { timeoutMs: 15000, message: "preview plays" });
      const d = await app.eval(`document.getElementById("vho-venh-video").duration`);
      assert.ok(Math.abs(d - 10) < 0.5, `preview ${d} s`);
      assert.equal(await app.eval(`!document.getElementById("vho-venh-caption").hidden`), true);
      assert.equal(sha(clip), before, "original unchanged");
    });

    await t.test("a setting change marks the preview as made with the previous settings", async () => {
      const set = (id, v) => app.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); return true; })()`);
      assert.equal(await app.eval(`document.getElementById("vho-venh").dataset.preview`), "current");
      await set("vho-venh-denoise", "medium");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000 });
      assert.equal(await app.eval(`document.getElementById("vho-venh").dataset.preview`), "stale");
      assert.match(await app.text("#vho-venh-caption"), /önceki ayarlarla|previous settings/);
      await set("vho-venh-denoise", "light");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000 });
      assert.equal(await app.eval(`document.getElementById("vho-venh").dataset.preview`), "current", "same settings as the preview again");
    });

    await t.test("fast setting changes: the dialog ends in the last choice", async () => {
      // three plans in flight at once; whichever answers last, the status shows the last choice
      await app.eval(`(() => { const s = document.getElementById("vho-venh-upscale");
        for (const v of ["x2", "no", "x2"]) { s.value = v; s.dispatchEvent(new Event("change")); } return true; })()`);
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 30000 });
      await sleep(1500); // let every earlier answer arrive
      assert.match(await app.text("#vho-venh .vho-act-status"), /1280×720/);
      await app.eval(`(() => { const s = document.getElementById("vho-venh-upscale"); s.value = "no"; s.dispatchEvent(new Event("change")); return true; })()`);
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready" && /640×360/.test(document.querySelector("#vho-venh .vho-act-status").textContent)`, { timeoutMs: 30000 });
    });

    await t.test("process all: <name>_enhanced.mkv next to the source, audio kept, original unchanged", async () => {
      await app.click("#vho-venh-full");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "done"`, { timeoutMs: 180000, message: "full result" });
      const out = await app.eval(`document.getElementById("vho-venh").dataset.output`);
      assert.equal(dirname(out).toLowerCase(), dir.toLowerCase());
      assert.match(out, /eski video_enhanced\.mkv$/);
      const info = probe(out);
      const v = info.streams.find((s) => s.codec_type === "video");
      assert.deepEqual([v.width, v.height], [640, 360]);
      assert.equal(info.streams.filter((s) => s.codec_type === "audio").length, 1, "audio copied");
      assert.ok(Math.abs(Number(info.format.duration) - 40) < 0.5, `duration ${info.format.duration}`);
      assert.equal(sha(clip), before, "original unchanged");
    });

    await t.test("cancel a running full job: no new file", async () => {
      const filesBefore = readdirSync(dir).sort();
      await app.eval(`(() => { const s = document.getElementById("vho-venh-upscale"); s.value = "x2"; s.dispatchEvent(new Event("change")); return true; })()`);
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000 });
      await app.click("#vho-venh-full");
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "running"`, { timeoutMs: 10000 });
      await app.click("#vho-venh-stop");
      await app.waitFor(`["cancelled", "done"].includes(document.getElementById("vho-venh")?.dataset.state)`, { timeoutMs: 60000, message: "stopped" });
      assert.equal(await state(), "cancelled");
      assert.deepEqual(readdirSync(dir).sort(), filesBefore, "no new file");
      assert.equal(sha(clip), before);
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const openDialog = async (app) => {
  await app.click("#ma-more");
  await app.waitFor(`!!document.querySelector('#media-actions-menu [data-menu-id="enhanceVideo"]')`, { timeoutMs: 3000, message: "item in ⋯" });
  await app.click(`#media-actions-menu [data-menu-id="enhanceVideo"]`);
  await app.waitFor(`!!document.getElementById("vho-venh") && document.getElementById("vho-venh").dataset.state !== "planning"`, { timeoutMs: 60000, message: "plan done" });
};
const inv = (cmd, args = {}) => `__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;

test("video enhance: field-order question, HDR refused, killed mid-run leaves no result", { timeout: 600000, skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-venh2-"));
  const dataDir = await makeDataDir();
  // interlaced content whose flag says progressive: the probe cannot decide (conflict)
  const lying = join(dir, "geçmeli.mkv");
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x120:rate=50,weave=first_field=top,setfield=prog", "-t", "4", "-c:v", "mpeg4", "-q:v", "3", lying]);
  // HDR10-tagged (PQ, BT.2020). MPEG-4 8-bit: the transfer tag alone must block it. (FFV1 is not
  // used here: opening any FFV1 MKV currently freezes the page, a separate open issue —
  // docs/status/2026-10-28-windows-alfa-durumu.md.) The 10-bit PQ case is covered in Rust.
  const hdr = join(dir, "hdr.mkv");
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25,scale=320:240,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv",
    "-t", "3", "-c:v", "mpeg4", "-q:v", "3", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", hdr]);
  const long = join(dir, "uzun video.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25,scale=640:360,noise=alls=20:allf=t", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "30", "-map", "0", "-map", "1", "-c:v", "mpeg4", "-q:v", "8", "-c:a", "aac", long]);
  const hashes = Object.fromEntries([lying, hdr, long].map((p) => [p, sha(p)]));
  const state = (app) => app.eval(`document.getElementById("vho-venh")?.dataset.state ?? ""`);
  const status = (app) => app.text("#vho-venh .vho-act-status");
  const loaded = (app) => app.waitFor(`(window.__vhoEngine?.duration ?? 0) > 2`, { timeoutMs: 20000, message: "video loaded" });
  try {
    let app = await launchApp({ args: [lying], dataDir });
    try {
      await loaded(app);
      await t.test("undecided field order: asked, the file's own flag preselected, a choice unblocks", async () => {
        await openDialog(app);
        assert.equal(await state(app), "blocked", await status(app));
        assert.equal(await app.eval(`document.getElementById("vho-venh-field").closest("[hidden]") === null`), true, "question shown");
        assert.equal(await app.eval(`document.getElementById("vho-venh-field").value`), "progressive", "the flag, not a guess");
        assert.match(await status(app), /alan sırasını seçin|choose the field order/);
        await app.eval(`(() => { const s = document.getElementById("vho-venh-field"); s.value = "tff"; s.dispatchEvent(new Event("change")); return true; })()`);
        await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 30000, message: "ready after the choice" });
        assert.match(await status(app), /320×240/);
      });
    } finally {
      await app.close();
    }

    app = await launchApp({ args: [hdr], dataDir });
    try {
      await loaded(app);
      await t.test("HDR source: refused with the reason, no job is started; the SDR 8-bit limit is stated", async () => {
        await openDialog(app);
        assert.equal(await state(app), "blocked");
        assert.match(await status(app), /HDR/);
        assert.match(await app.text("#vho-venh .vho-venh-note"), /SDR, 8/);
        await app.click("#vho-venh-preview");
        await sleep(1000);
        assert.equal(await state(app), "blocked");
        const jobs = await app.eval(inv("jobs_list"));
        assert.equal(jobs.filter((j) => j.kind === "video-enhance").length, 0, "no job submitted");
      });
    } finally {
      await app.close();
    }

    app = await launchApp({ args: [long], dataDir });
    let id;
    try {
      await loaded(app);
      await t.test("app killed during the full run: no result, no partial file under the final name", async () => {
        await openDialog(app);
        await app.eval(`(() => { const s = document.getElementById("vho-venh-upscale"); s.value = "x2"; s.dispatchEvent(new Event("change")); return true; })()`);
        await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000 });
        await app.click("#vho-venh-full");
        await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "running" && /[1-9]/.test(document.querySelector("#vho-venh .vho-act-status").textContent)`,
          { timeoutMs: 60000, message: "running with progress" });
        id = (await app.eval(inv("jobs_list"))).find((j) => j.kind === "video-enhance")?.id;
        assert.ok(id, "job id");
        app.cdp.close();
        const exited = new Promise((res) => (app.proc.exitCode !== null ? res() : app.proc.once("exit", res)));
        process.kill(app.proc.pid); // our own test process only: no graceful exit
        await exited;
        await sleep(800);
        const names = readdirSync(dir);
        assert.ok(!names.some((n) => /_enhanced/.test(n)), `no result under its final name: ${names}`);
      });
    } finally {
      if (app.proc.exitCode === null) await app.close();
      else rmSync(app.userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 });
    }

    app = await launchApp({ dataDir });
    try {
      await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000 });
      await t.test("after restart: interrupted, temp files removed, nothing resumes by itself", async () => {
        const job = (await app.eval(inv("jobs_list"))).find((j) => j.id === id);
        assert.equal(job.state, "interrupted");
        await sleep(1500);
        assert.equal((await app.eval(inv("jobs_get", { id }))).job.state, "interrupted", "no automatic resume");
        assert.deepEqual(readdirSync(dir).sort(), ["geçmeli.mkv", "hdr.mkv", "uzun video.mp4"], "no partial or temp file left");
      });
      await t.test("continue runs the file again from the beginning and gives a complete result", async () => {
        await app.eval(inv("jobs_resume", { id, mode: "continue" }));
        await app.waitFor(`${inv("jobs_get", { id })}.then((d) => ["completed", "failed"].includes(d.job.state))`, { timeoutMs: 240000, message: "job finished" });
        const d = await app.eval(inv("jobs_get", { id }));
        assert.equal(d.job.state, "completed", JSON.stringify(d.job));
        assert.equal(d.job.attempts, 2);
        const out = join(dir, "uzun video_enhanced.mkv");
        const info = probe(out);
        assert.ok(Math.abs(Number(info.format.duration) - 30) < 0.5, `duration ${info.format.duration}`);
        assert.equal(info.streams.filter((s) => s.codec_type === "audio").length, 1);
      });
      await t.test("originals unchanged", async () => {
        for (const [p, h] of Object.entries(hashes)) assert.equal(sha(p), h, p);
      });
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
