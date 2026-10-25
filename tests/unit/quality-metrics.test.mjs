// Q02: quality metrics and the quality-set manifest (network-free; no ffmpeg, no app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorfulness, crop, gmsd, noiseSigma, psnr, sharpness, ssim, videoMetrics } from "../quality/lib/metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Deterministic pseudo-random (mulberry32). */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    data.set([r, g, b, 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const scene = image(64, 64, (x, y) => [x * 4, y * 4, ((x >> 3) + (y >> 3)) & 1 ? 200 : 40]);
const noisy = (img, sigma, seed = 1) => {
  const r = rng(seed);
  const data = img.data.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(255, Math.round(v + sigma * gauss(r))))));
  return { ...img, data };
};

test("PSNR / SSIM / GMSD: identical images are perfect, noise lowers the score monotonically", () => {
  assert.equal(psnr(scene, scene), 99);
  assert.ok(Math.abs(ssim(scene, scene) - 1) < 1e-9);
  assert.ok(gmsd(scene, scene) < 1e-9);
  const a = noisy(scene, 5), b = noisy(scene, 20);
  assert.ok(psnr(scene, a) > psnr(scene, b));
  assert.ok(ssim(scene, a) > ssim(scene, b));
  assert.ok(gmsd(scene, a) < gmsd(scene, b));
  // PSNR of additive Gaussian noise σ=5 ≈ 20·log10(255/5) = 34.2 dB
  assert.ok(Math.abs(psnr(scene, a) - 34.2) < 0.6, `psnr ${psnr(scene, a)}`);
  assert.throws(() => psnr(scene, crop(scene, { x: 0, y: 0, w: 0.5, h: 0.5 })), /size/);
});

test("no-reference: sharpness, noise σ estimate and colourfulness behave as defined", () => {
  const flat = image(64, 64, () => [128, 128, 128]);
  const checker = image(64, 64, (x, y) => ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0]));
  assert.equal(sharpness(flat), 0);
  assert.ok(sharpness(checker) > sharpness(scene));
  assert.ok(noiseSigma(flat) < 1e-9);
  const n = noiseSigma(noisy(flat, 8, 3));
  // independent noise per channel: luma σ = 8 * sqrt(0.299² + 0.587² + 0.114²) ≈ 5.35
  assert.ok(Math.abs(n - 5.35) < 0.5, `Immerkær estimate ${n} for luma σ≈5.35`);
  assert.ok(colorfulness(flat) < 1e-9);
  assert.ok(colorfulness(image(8, 8, (x) => (x & 1 ? [255, 0, 0] : [0, 0, 255]))) > 50);
});

test("crop: fractional region, pixel-exact copy", () => {
  const c = crop(scene, { x: 0.25, y: 0.5, w: 0.25, h: 0.25 });
  assert.equal(c.width, 16);
  assert.equal(c.height, 16);
  assert.deepEqual([...c.data.subarray(0, 4)], [...scene.data.subarray((32 * 64 + 16) * 4, (32 * 64 + 16) * 4 + 4)]);
});

test("video metrics: temporal error is 0 for an exact copy and grows with flicker", () => {
  const frames = Array.from({ length: 6 }, (_, k) => image(32, 32, (x, y) => [(x + k * 3) * 6, y * 6, 90]).data);
  const ref = { width: 32, height: 32, frames };
  const same = videoMetrics(ref, ref, { ssimStride: 1 });
  assert.equal(same.frames, 6);
  assert.equal(same.temporalError, 0);
  assert.equal(same.psnr, 99);
  const flicker = { ...ref, frames: frames.map((f, k) => f.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + (k % 2) * 12)))) };
  const m = videoMetrics(flicker, ref, { ssimStride: 1 });
  assert.ok(m.temporalError > 8 && m.temporalError < 13, `temporal error ${m.temporalError}`);
});

test("quality manifest: provenance, licence, splits and minimum sizes", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "tests/quality/manifest.json"), "utf8"));
  for (const [id, s] of Object.entries(m.sources)) {
    assert.match(s.url, /^https:\/\/upload\.wikimedia\.org\//, id);
    assert.match(s.sha256, /^[0-9a-f]{64}$/, id);
    assert.ok(s.bytes > 0 && s.page && s.author && s.date, id);
    assert.match(s.license, /^Public domain/, `${id}: only public-domain sources in the shared set`);
  }
  const ids = [...m.photos, ...m.clips, ...m.structural].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.ok(m.photos.length >= 12 && m.clips.length >= 6);
  for (const p of [...m.photos, ...m.clips]) {
    assert.ok(["dev", "eval"].includes(p.split), `${p.id}: split`);
    assert.ok(["controlled", "real-old", "synthetic"].includes(p.origin), `${p.id}: origin`);
    assert.ok(p.categories?.length, `${p.id}: categories`);
    const refs = p.source ? [p.source] : [...(p.graph ?? "").matchAll(/\[S:([a-z0-9]+)\]/g)].map((x) => x[1]);
    for (const r of refs) assert.ok(m.sources[r], `${p.id}: unknown source ${r}`);
    for (const r of p.roi ?? []) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, `${p.id}: roi in range`);
  }
  for (const cat of ["face", "text", "low-light", "blur", "jpeg-blocks", "texture", "alpha", "scratch", "small-face", "high-resolution", "real-old"]) {
    assert.ok(m.photos.some((p) => p.categories.includes(cat)), `photo category ${cat}`);
  }
  for (const cat of ["camera-motion", "fast-motion", "scene-cut", "low-light", "face", "text"]) {
    assert.ok(m.clips.some((c) => c.categories.includes(cat)), `clip category ${cat}`);
  }
  assert.ok(m.photos.some((p) => p.split === "dev") && m.photos.some((p) => p.split === "eval"));
});

test("set lock covers every built sample", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "tests/quality/manifest.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "tests/quality/set-lock.json"), "utf8"));
  assert.match(lock.ffmpeg, /^ffmpeg version /);
  for (const p of m.photos) assert.ok(lock.files[`${p.id}/input.png`], `${p.id} input`);
  for (const c of m.clips) assert.ok(lock.files[`${c.id}/ref.mkv`] && lock.files[`${c.id}/input.mkv`], c.id);
  for (const s of m.structural) assert.ok(Object.keys(lock.files).some((k) => k.startsWith(`${s.id}/`)), s.id);
});
