// Plan 07 smart editing recipes (A06): mask / crop geometry, paste mask, matting alpha
// post-processing and backgrounds, Lab conversions with known values, DDColor merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLORIZE_SIZE, LAMA_SIZE, MATTING_SIZE, blurChannel, colorizeInput, composeBackground, dilate, featherMask, isColorizeCandidate,
  labToRgb, lamaCrop, lamaInputs, lamaPaste, maskBBox, mattingAlpha, mattingInput, meanChroma, mergeColorize, rasterizeStrokes,
  resizeBilinear, rgbToLab, softChroma,
} from "../../src/media/smart-edit.js";

const solid = (w, h, rgb) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) d.set([...rgb, 255], p * 4);
  return d;
};

test("smart edit: bilinear resize keeps constants and averages", () => {
  const src = Float32Array.from([0, 10, 20, 30]); // 2x2, 1 channel
  assert.deepEqual([...resizeBilinear(Float32Array.from([5, 5, 5, 5]), 2, 2, 1, 7, 3)], Array(21).fill(5));
  const up = resizeBilinear(src, 2, 2, 1, 4, 4);
  assert.equal(up[0], 0);
  assert.equal(up[15], 30);
  assert.ok(up[5] > 0 && up[5] < 30);
  const down = resizeBilinear(src, 2, 2, 1, 1, 1);
  assert.equal(down[0], 15);
});

test("LaMa: strokes -> mask, eraser, bbox, square 2.2x crop inside the photo", () => {
  const w = 100, h = 60;
  const mask = rasterizeStrokes([{ points: [[0.2, 0.5], [0.4, 0.5]], radius: 0.05 }], w, h);
  const box = maskBBox(mask, w, h);
  assert.ok(box.x0 >= 16 && box.x0 <= 18 && box.x1 >= 42 && box.x1 <= 44, JSON.stringify(box));
  assert.ok(box.y0 >= 26 && box.y1 <= 34);
  assert.equal(mask[30 * w + 30], 255, "inside the stroke");
  assert.equal(mask[5 * w + 90], 0, "outside");
  const erased = rasterizeStrokes([{ points: [[0.2, 0.5], [0.4, 0.5]], radius: 0.05 }, { points: [[0.3, 0.5]], radius: 0.2, erase: true }], w, h);
  assert.equal(erased[30 * w + 30], 0, "eraser wins");
  assert.equal(maskBBox(new Uint8Array(4), 2, 2), null);
  // big photo: 2.2x the mask side, square, shifted inside at the edge
  const c = lamaCrop({ x0: 1900, y0: 10, x1: 2000, y1: 60 }, 2000, 1500);
  assert.equal(c.w, c.h);
  assert.equal(c.w, LAMA_SIZE, "at least the model size when the photo allows");
  assert.equal(c.x + c.w, 2000, "kept inside (right edge)");
  assert.equal(c.y, 0, "kept inside (top edge)");
  const large = lamaCrop({ x0: 0, y0: 0, x1: 800, y1: 400 }, 3000, 2000);
  assert.equal(large.w, Math.ceil(800 * 2.2));
  // small photo: the largest square that fits, around the mask
  assert.deepEqual(lamaCrop({ x0: 10, y0: 10, x1: 20, y1: 20 }, 100, 60), { x: 0, y: 0, w: 60, h: 60 });
  assert.deepEqual(lamaCrop({ x0: 80, y0: 10, x1: 90, y1: 20 }, 100, 60), { x: 40, y: 0, w: 60, h: 60 });
});

test("LaMa: model inputs and the paste touches only the (grown, softened) mask", () => {
  const W = 64, H = 64;
  const rgba = solid(W, H, [200, 100, 50]);
  const mask = new Uint8Array(W * H);
  for (let y = 28; y < 36; y++) for (let x = 28; x < 36; x++) mask[y * W + x] = 255;
  const crop = { x: 0, y: 0, w: 64, h: 64 };
  const { image, mask: m } = lamaInputs(rgba, mask, W, crop);
  assert.equal(image.length, 3 * LAMA_SIZE * LAMA_SIZE);
  assert.ok(Math.abs(image[0] - 200 / 255) < 1e-6 && Math.abs(image[LAMA_SIZE * LAMA_SIZE] - 100 / 255) < 1e-6, "planar RGB 0..1");
  assert.ok(m.every((v) => v === 0 || v === 1));
  assert.equal(m[(256 * LAMA_SIZE) + 256], 1, "mask centre");
  assert.equal(m[0], 0);
  // the "model" paints everything blue: only the masked area (+ feather) changes
  const plane = LAMA_SIZE * LAMA_SIZE;
  const out = new Float32Array(3 * plane);
  out.fill(255, 2 * plane);
  const res = lamaPaste(rgba, W, H, mask, crop, out);
  const px = (x, y) => [...res.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
  assert.deepEqual(px(31, 31), [0, 0, 255, 255], "painted area fully replaced");
  assert.deepEqual(px(2, 2), [200, 100, 50, 255], "far away untouched");
  const edge = px(36 + 8, 31);
  assert.ok(edge[2] > 0 && edge[2] < 255, `soft edge inside the 9 px growth: ${edge}`);
  assert.deepEqual(px(36 + 16, 31), [200, 100, 50, 255], "beyond growth + softening untouched");
  const f = featherMask(mask, W, H);
  assert.equal(f[31 * W + 31], 1);
  assert.equal(dilate(mask, W, H, 2)[27 * W + 27], 1);
  assert.equal(blurChannel(Float32Array.from([1, 1, 1, 1]), 2, 2, 3)[0], 1, "blur keeps constants");
});

test("BiRefNet: normalization, sigmoid + refine, transparent / colour / blur backgrounds", () => {
  const W = 8, H = 4;
  const rgba = solid(W, H, [255, 128, 0]);
  const t = mattingInput(rgba, W, H);
  assert.equal(t.length, 3 * MATTING_SIZE * MATTING_SIZE);
  assert.ok(Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-5);
  // logits: left half strongly foreground, right half strongly background, a soft middle
  const size = 4;
  const logits = Float32Array.from({ length: size * size }, (_, i) => ((i % size) < 2 ? 8 : (i % size) === 2 ? 0 : -8));
  const alpha = mattingAlpha(logits, W, H, size);
  assert.equal(alpha[0], 255, ">= 0.98 -> fully opaque");
  assert.equal(alpha[W - 1], 0, "<= 0.02 -> fully transparent");
  assert.ok(alpha.some((a) => a > 0 && a < 255), "soft edge kept");
  const cut = composeBackground(rgba, W, H, alpha, { mode: "transparent" });
  assert.equal(cut[3], 255);
  assert.equal(cut[(W - 1) * 4 + 3], 0);
  assert.deepEqual([...cut.slice(0, 3)], [255, 128, 0], "colour of the subject untouched");
  const white = composeBackground(rgba, W, H, alpha, { mode: "color", color: [0, 0, 255] });
  assert.deepEqual([...white.slice((W - 1) * 4, (W - 1) * 4 + 4)], [0, 0, 255, 255], "background replaced");
  assert.deepEqual([...white.slice(0, 4)], [255, 128, 0, 255]);
  const blurred = composeBackground(rgba, W, H, alpha, { mode: "blur", blur: 2 });
  assert.equal(blurred[3], 255, "blur keeps the photo opaque");
});

test("Lab: known values and round trip", () => {
  const near = (a, b, tol, msg) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tol), `${msg}: ${a} vs ${b}`);
  near(rgbToLab(255, 255, 255), [100, 0, 0], 0.01, "white");
  near(rgbToLab(0, 0, 0), [0, 0, 0], 0.01, "black");
  near(rgbToLab(255, 0, 0), [53.24, 80.09, 67.2], 0.05, "sRGB red");
  near(rgbToLab(0, 0, 255), [32.3, 79.19, -107.86], 0.05, "sRGB blue");
  near(rgbToLab(128, 128, 128), [53.59, 0, 0], 0.02, "grey");
  for (const c of [[12, 200, 80], [250, 250, 10], [90, 40, 160], [0, 0, 0], [255, 255, 255]]) near(labToRgb(...rgbToLab(...c)), c, 1, "round trip");
});

test("DDColor merge: L from the original, ab upscaled and softened, alpha kept", () => {
  const W = 6, H = 4;
  const rgba = solid(W, H, [120, 120, 120]);
  rgba[3] = 77;
  assert.ok(isColorizeCandidate(rgba), "grey photo is a candidate");
  assert.equal(isColorizeCandidate(solid(W, H, [220, 40, 40])), false, "colour photo is not");
  const plane = COLORIZE_SIZE * COLORIZE_SIZE;
  const ab = new Float32Array(2 * plane);
  ab.fill(30, 0, plane); // a = +30 (reddish)
  ab.fill(20, plane);    // b = +20
  const out = mergeColorize(rgba, W, H, ab);
  const [L, a, b] = rgbToLab(out[4], out[5], out[6]);
  const [L0] = rgbToLab(120, 120, 120);
  assert.ok(Math.abs(L - L0) < 1.5, `lightness kept: ${L} vs ${L0}`);
  assert.ok(Math.abs(a - 30) < 2.5 && Math.abs(b - 20) < 2.5, `ab applied: ${a}, ${b}`);
  assert.equal(out[3], 77, "alpha kept");
  assert.ok(meanChroma(out) > 20);
  assert.equal(softChroma(30), 30);
  assert.equal(softChroma(85), 65, "strong chroma compressed");
  assert.equal(colorizeInput(rgba, W, H).length, 3 * plane);
});

test("float16 conversion for fp16-input models", async () => {
  const { toHalf, fromHalf, toHalfArray, fromHalfArray } = await import("../../src/media/smart-edit.js");
  for (const v of [0, 1, -2, 0.5, 65504, 1e-4, -0.333]) assert.ok(Math.abs(fromHalf(toHalf(v)) - v) <= Math.abs(v) * 1e-3 + 1e-7, String(v));
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(fromHalf(0x7c00), Infinity);
  assert.deepEqual([...fromHalfArray(toHalfArray([0.25, 3]))], [0.25, 3]);
});
