// Legacy codec path (Windows): WMV9/WMA in ASF -> probe says "needs transcode" -> Media
// Foundation converts to H.264/AAC MP4 -> frames decode in the webview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, fixture } from "./lib/app.mjs";

const V = `document.getElementById("video-element")`;

test("legacy: WMV9 clip is converted and plays", { timeout: 180000, skip: process.platform !== "win32" && "Media Foundation only" }, async (t) => {
  // Fresh copy => new cache key => a real conversion every run; Turkish name + space in the path
  const dir = await mkdtemp(join(tmpdir(), "vho-e2e-legacy-"));
  const input = join(dir, "eski klip ğüşİ.wmv");
  await copyFile(fixture("legacy-wmv9.wmv"), input);
  const app = await launchApp({ args: [input] });
  let converted = null;

  try {
    await t.test("backend probe flags the codecs", async () => {
      const info = await app.eval(`__TAURI__.core.invoke("probe_media", { path: ${JSON.stringify(input)} })`);
      assert.deepEqual(info, { needsTranscode: true, videoCodec: "WMV9", audioCodec: "WMA" });
    });

    await t.test("conversion runs and the result decodes", async () => {
      const s = await app.waitFor(`(() => { const v = ${V}, q = v.getVideoPlaybackQuality();
        return v.currentSrc.includes(".mp4") && v.videoWidth > 0 && q.totalVideoFrames > 5 &&
          { src: v.currentSrc, w: v.videoWidth, h: v.videoHeight, d: v.duration, frames: q.totalVideoFrames }; })()`,
      { timeoutMs: 90000, intervalMs: 250, message: "converted video playing" });
      assert.equal(s.w, 320);
      assert.equal(s.h, 240);
      assert.ok(Math.abs(s.d - 3) < 0.25, `duration ${s.d}`);
      converted = decodeURIComponent(new URL(s.src).pathname.slice(1));
      assert.match(converted, /[\\/]transcode[\\/][0-9a-f]{16}\.mp4$/);
      assert.match(await app.text("#transcode-text"), /Eski codec \(WMV9\)/);
      assert.equal(await app.eval(`document.getElementById("transcode-overlay").classList.contains("active")`), false);
      assert.equal(await app.text("#current-filename"), "eski klip ğüşİ.wmv");
    });

    await t.test("converted file is plain H.264/AAC", async () => {
      const info = await app.eval(`__TAURI__.core.invoke("probe_media", { path: ${JSON.stringify(converted)} })`);
      assert.deepEqual(info, { needsTranscode: false, videoCodec: "H.264", audioCodec: "AAC" });
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
    if (converted) await rm(converted, { force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
