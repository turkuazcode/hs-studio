// README screenshots (docs/screenshots/*.png), reproducible:
//
//   node scripts/screenshots.mjs            (release binary + staged ffmpeg, like the E2E layer)
//
// Media: only public-domain images of the Q02 quality set (NASA, Library of Congress, pre-1930
// scans; tests/quality/manifest.json, downloaded once into tests/.cache/quality/src by
// `npm run test:quality`) and clips/sounds generated here from them. Nothing personal.
// The app runs isolated (temporary data folder). Video/photo shots use the HTML5 engine: libmpv
// draws video in its own native surface, which a page capture cannot see; the interface is the
// same. The photo folder is shown through a temporary `subst` drive (no local user name).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTML5_ENGINE, defaultExe, launchApp } from "../tests/e2e/lib/app.mjs";
import { sleep } from "../tests/e2e/lib/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "tests", ".cache", "quality", "src");
const OUT = join(ROOT, "docs", "screenshots");
const FFMPEG = join(dirname(defaultExe()), "ffmpeg.exe");
const W = 1440, H = 900;
const J = JSON.stringify;

if (!existsSync(join(SRC, "Earth-moon.jpg"))) throw new Error(`public-domain set missing in ${SRC}: run npm run test:quality once`);
const ff = (args) => execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "pipe" });
const work = mkdtempSync(join(tmpdir(), "hs-shots-"));
mkdirSync(OUT, { recursive: true });

// media: a folder of public-domain photos, a slow pan over Earthrise (H.264, plays in WebView2),
// (music mode is not captured: its layout follows the native window and the libmpv surface, which a
// page capture does not reproduce faithfully)
const photos = join(work, "Kamu malı arşiv");
mkdirSync(photos);
for (const f of ["Earth-moon.jpg", "Aldrin_Apollo_11_original.jpg", "Lange-MigrantMother02.jpg", "Abraham_Lincoln_O-77_matte_collodion_print.jpg",
  "Frederick_Douglass_(circa_1879).jpg", "Katherine_Johnson_1983.jpg", "Ellen_Ochoa.jpg", "Kalpana_Chawla,_NASA_photo_portrait_in_orange_suit.jpg", "NYTimes-Page1-11-11-1918.jpg"]) {
  copyFileSync(join(SRC, f), join(photos, f));
}
const clip = join(work, "Apollo 8 - Earthrise.mp4");
ff(["-loop", "1", "-i", join(SRC, "Earth-moon.jpg"), "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
  "-filter_complex", "[0:v]scale=3840:-2,zoompan=z='1.15-0.0015*on':x='iw/2-(iw/zoom/2)+on*2':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=25,format=yuv420p[v]",
  "-map", "[v]", "-map", "1:a", "-t", "20", "-c:v", "h264_mf", "-rate_control", "quality", "-quality", "80", "-c:a", "aac", "-shortest", clip]);

async function shot(app, name) {
  await sleep(600);
  const r = await app.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  ${name}.png`);
}

async function open(args = [], env = HTML5_ENGINE, emulate = true) {
  const app = await launchApp({ args, env });
  if (emulate) await app.cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000 });
  return app;
}
const poke = (app) => app.eval(`document.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 700, clientY: 500 })), true`);

try {
  let app = await open();
  try {
    await shot(app, "01-baslangic");
  } finally { await app.close(); }

  app = await open([clip]);
  try {
    await app.waitFor(`(window.__vhoEngine?.duration ?? 0) > 10`, { timeoutMs: 20000 });
    await app.waitFor(`window.__vhoEngine.time > 4`, { timeoutMs: 20000 });
    await poke(app);
    await shot(app, "02-video");
    await app.click("#ma-more");
    await app.click(`#media-actions-menu [data-menu-id="enhanceVideo"]`);
    await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "ready"`, { timeoutMs: 60000 });
    await app.click("#vho-venh-preview");
    await app.waitFor(`document.getElementById("vho-venh")?.dataset.state === "previewed"`, { timeoutMs: 120000 });
    await app.waitFor(`document.getElementById("vho-venh-video").readyState >= 2`, { timeoutMs: 15000 });
    await sleep(1500);
    await shot(app, "05-video-iyilestirme");
  } finally { await app.close(); }

  app = await open([join(photos, "Lange-MigrantMother02.jpg")]);
  try {
    await app.waitFor(`document.getElementById("image-element").complete && document.getElementById("image-element").naturalWidth > 0`, { timeoutMs: 15000 });
    await app.click("#btn-toggle-ai-restore");
    await shot(app, "03-fotograf-iyilestirme");
  } finally { await app.close(); }

  // a neutral drive letter for the folder, so no local user name appears in the address bar
  const drive = ["H:", "S:", "T:", "U:"].find((d) => !existsSync(`${d}/`));
  execFileSync("subst", [drive, work]);
  const shown = `${drive}\\Kamu malı arşiv`;
  app = await open();
  try {
    await app.click("#btn-app-menu");
    await app.click(`#app-menu [data-menu-id="photo-studio"]`);
    await app.eval(`(() => { document.getElementById("ps-path-edit").click(); const i = document.getElementById("ps-path"); i.value = ${J(shown)}; i.form.requestSubmit(); return true; })()`);
    await app.waitFor(`document.getElementById("ps-grid").dataset.loading === "0" && document.getElementById("ps-grid").dataset.total === "9"`, { timeoutMs: 30000 });
    await app.waitFor(`[...document.querySelectorAll("#ps-grid .ps-cell img")].filter((i) => i.complete && i.naturalWidth).length >= 9`, { timeoutMs: 30000 }).catch(() => {});
    await shot(app, "04-foto-studyo");
  } finally {
    await app.close();
    execFileSync("subst", [drive, "/D"]);
  }

} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`screenshots in ${OUT}`);
