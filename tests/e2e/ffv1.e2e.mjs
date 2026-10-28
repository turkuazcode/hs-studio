// Regression (alpha check 2026-10-28): an FFV1 MKV froze the whole app. libmpv's hwdec=auto-safe
// picked FFmpeg 8's Vulkan compute decoder (ffv1-vulkan-copy) and the GPU stalled, taking the
// WebView with it. FFV1 (and the other Vulkan-only decoders) are now decoded in software
// (engine::HWDEC_CODECS). Both entry points: start file and opened while the app runs. The page
// must keep answering quickly the whole time. Clips are generated (lavfi), nothing personal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, launchApp, mpvStaged } from "./lib/app.mjs";

const FFMPEG = join(dirname(defaultExe()), "ffmpeg.exe");
const skip = !mpvStaged() ? "libmpv DLLs not staged next to the app (npm run stage:mpv)"
  : !existsSync(FFMPEG) ? "ffmpeg.exe not staged next to the app" : false;
const E = "window.__vhoEngine";

/** The page answers within `ms` (a frozen WebView times the evaluation out). */
async function responsive(app, ms = 1500) {
  const t0 = Date.now();
  await app.eval("1 + 1", { timeoutMs: ms });
  return Date.now() - t0;
}

async function playsWhileResponsive(app, name) {
  await app.waitFor(`${E}.kind === "mpv" && Math.abs((${E}.duration ?? 0) - 4) < 0.2 && document.getElementById("current-filename").textContent === ${JSON.stringify(name)}`,
    { timeoutMs: 15000, message: `${name} loaded` });
  for (let i = 0; i < 6; i++) {
    assert.ok(await responsive(app) < 1500, "the page keeps answering");
    await new Promise((r) => setTimeout(r, 300));
  }
  await app.waitFor(`${E}.time > 1.5`, { timeoutMs: 10000, message: `${name} plays` });
  const hw = await app.eval(`__TAURI__.core.invoke("engine_get", { name: "hwdec-current" })`);
  assert.ok(["no", "", null].includes(hw), `software decoding for FFV1 (hwdec-current ${hw})`);
}

test("FFV1 MKV: plays in software, the app keeps answering (start file and opened later)", { timeout: 180000, skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-ffv1-"));
  const make = (name, fmt) => {
    const p = join(dir, name);
    execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=25,format=${fmt}`, "-t", "4", "-c:v", "ffv1", p]);
    return p;
  };
  const sdr8 = make("arsiv 8bit.mkv", "yuv420p");
  const ten = make("arsiv 10bit.mkv", "yuv420p10le");
  try {
    let app = await launchApp({ args: [sdr8] });
    try {
      await t.test("as the start file", () => playsWhileResponsive(app, "arsiv 8bit.mkv"));
      await t.test("opened while the app runs (10-bit)", async () => {
        await app.eval(`${E}.openPaths([${JSON.stringify(ten)}]).then(() => true)`);
        await playsWhileResponsive(app, "arsiv 10bit.mkv");
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
