// A04 in the real webview, no model needed: the pixels an AI job reads from a photo
// (src/media/ai-jobs.js loadPixels) are upright for EXIF orientation 1-8 (applied exactly
// once), converted from an embedded ICC profile to sRGB, and keep their alpha.
// Sources are generated copies in a temp folder; their hashes are checked after the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTML5_ENGINE, fixture, launchApp } from "./lib/app.mjs";
import { exifTiff, jpegWithExif } from "./lib/photo-fixtures.mjs";
import { encodePng } from "../ai/lib/image.mjs";
import { pngWithIcc, wideGamutProfile } from "../lib/icc.mjs";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** In the page: loadPixels(path) -> { width, height, data (base64) }. */
const load = (app, path) => app.eval(`(async () => {
  const m = await import(new URL("/media/ai-jobs.js", location.href).href);
  const img = await m.loadPixels(__TAURI__.core.invoke, __TAURI__.core.convertFileSrc, ${JSON.stringify(path)});
  const u8 = new Uint8Array(img.data.buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { width: img.width, height: img.height, data: btoa(s) };
})()`, { timeoutMs: 30000 }).then((r) => ({ ...r, data: Buffer.from(r.data, "base64") }));

/** Display pixel (x, y) of an image stored as `s` (Ws x Hs) with EXIF orientation `o`. */
function storedCoord(o, x, y, ws, hs) {
  switch (o) {
    case 2: return [ws - 1 - x, y];
    case 3: return [ws - 1 - x, hs - 1 - y];
    case 4: return [x, hs - 1 - y];
    case 5: return [y, x];
    case 6: return [y, hs - 1 - x];
    case 7: return [ws - 1 - y, hs - 1 - x];
    case 8: return [ws - 1 - y, x];
    default: return [x, y];
  }
}

test("AI input pixels: orientation 1-8 applied once, ICC converted, alpha kept", { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-aiout-"));
  const app = await launchApp({ env: HTML5_ENGINE });
  const hashes = new Map();
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
    const base = readFileSync(fixture("photo-a.jpg"));

    await t.test("EXIF orientation 1-8 -> upright pixels", async () => {
      const files = [];
      for (let o = 1; o <= 8; o++) {
        const p = join(dir, `orient-${o}.jpg`);
        writeFileSync(p, jpegWithExif(base, exifTiff({ orientation: o })));
        hashes.set(p, sha(p));
        files.push(p);
      }
      const ref = await load(app, files[0]);
      assert.deepEqual([ref.width, ref.height], [640, 480]);
      for (let o = 2; o <= 8; o++) {
        const img = await load(app, files[o - 1]);
        const swapped = o >= 5;
        assert.deepEqual([img.width, img.height], swapped ? [480, 640] : [640, 480], `orientation ${o}: size`);
        let diff = 0, n = 0;
        for (let y = 3; y < img.height; y += 37) {
          for (let x = 5; x < img.width; x += 41) {
            const [sx, sy] = storedCoord(o, x, y, 640, 480);
            const a = (y * img.width + x) * 4, b = (sy * 640 + sx) * 4;
            for (let c = 0; c < 3; c++) diff += Math.abs(img.data[a + c] - ref.data[b + c]);
            n += 3;
          }
        }
        assert.ok(diff / n < 2, `orientation ${o}: pixels not where EXIF puts them (mean diff ${(diff / n).toFixed(2)})`);
      }
    });

    await t.test("embedded wide-gamut ICC profile -> converted to sRGB (not passed through)", async () => {
      const w = 32, h = 16, data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) data.set(i % 3 === 0 ? [230, 30, 40, 255] : i % 3 === 1 ? [30, 200, 60, 255] : [40, 50, 220, 255], i * 4);
      const png = encodePng({ width: w, height: h, data });
      const plain = join(dir, "plain.png");
      const tagged = join(dir, "wide-gamut.png");
      writeFileSync(plain, png);
      writeFileSync(tagged, pngWithIcc(png, wideGamutProfile()));
      hashes.set(tagged, sha(tagged));
      const a = await load(app, plain);
      const b = await load(app, tagged);
      let diff = 0;
      for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) diff += Math.abs(a.data[i + c] - b.data[i + c]);
      const mean = diff / (w * h * 3);
      t.diagnostic(`wide gamut vs untagged: mean RGB difference ${mean.toFixed(1)}`);
      assert.ok(mean > 8, `the profile was ignored (mean difference ${mean.toFixed(2)})`);
      // the untagged file is taken as sRGB: unchanged values
      assert.deepEqual([...a.data.subarray(0, 4)], [230, 30, 40, 255]);
    });

    await t.test("transparency survives the read (alpha 0 and 128)", async () => {
      const w = 8, h = 4, data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) data.set([200, 100, 50, i % w === 7 ? 0 : i === 0 ? 128 : 255], i * 4);
      const p = join(dir, "alpha.png");
      writeFileSync(p, encodePng({ width: w, height: h, data }));
      const img = await load(app, p);
      assert.equal(img.data[3], 128);
      assert.equal(img.data[(0 * w + 7) * 4 + 3], 0);
      assert.equal(img.data[(1 * w + 3) * 4 + 3], 255);
      assert.deepEqual([...img.data.subarray((1 * w + 3) * 4, (1 * w + 3) * 4 + 3)], [200, 100, 50]);
    });

    for (const [p, h] of hashes) assert.equal(sha(p), h, `source unchanged: ${p}`);
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
