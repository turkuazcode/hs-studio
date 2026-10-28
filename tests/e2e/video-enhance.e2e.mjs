// Faithful video enhance in the real app (model-free, LGPL ffmpeg filters): "Enhance video…" in
// the video ⋯ menu opens the dialog with the recommended settings; Reset works; the 10 s
// side-by-side preview is rendered by the queued "video-enhance" job and plays in the dialog;
// "Process all" writes <name>_enhanced.mkv next to the source with the audio kept; cancel stops
// the job without leaving a file; the original never changes. The clip is generated (lavfi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, launchApp } from "./lib/app.mjs";

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
  ff(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25,noise=alls=20:allf=t+u", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
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
      await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 20000, message: "plan ready" });
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
