// Real-AI smoke test (Q01): the real, hash-verified photo-x4 model (4xRealWebPhoto v4, DAT-2)
// and the real ONNX Runtime Web build run inside the release app on a tiny synthetic fixture.
//
// Run: npm run test:ai   (layer "ai"; not part of npm test, which stays network-free)
//
// Model cache: the components are downloaded ONCE by the app's own downloader (A01: pinned
// URLs, size + SHA-256 check) into a test-root cache, never into the user's AI cache:
//   VHO_TEST_AI_CACHE (default <repo>/tests/.cache/ai-smoke) / vho-data / ai / <id> / <version>
// That folder is the VHO_DATA_DIR of the test app; everything in it except `ai/` is wiped
// before each run, so settings never leak between runs. A cached component is reused when its
// full SHA-256 matches (ai_verify) and repaired by the app otherwise.
// VHO_AI_OFFLINE=1: never download; the tests are skipped (not passed) when the cache is empty.
// A failed download is reported as an infrastructure failure by its own test.
//
// Checks (see docs/status/test-map.md for the tolerances and why they were chosen):
// output size, finite raw values (worker stats), non-constant output, RGB channel order,
// alpha handling, difference to an independent bilinear upscale and to the committed
// reference output (tests/ai/fixtures/photo-x4-ref.png, WASM backend).
// VHO_AI_UPDATE_REFERENCE=1 rewrites that reference from the WASM run (review the diff!).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, launchApp, removeDir } from "../e2e/lib/app.mjs";
import {
  FIXTURE_REGIONS, bilinearUpscale, compareRgb, decodePng, encodePng, lumaStdDev, makeFixture, regionMean,
} from "./lib/image.mjs";

const COMPONENTS = ["ort-web", "photo-x4"];
const SCALE = 4;
const CACHE_ROOT = process.env.VHO_TEST_AI_CACHE || join(REPO_ROOT, "tests", ".cache", "ai-smoke");
const DATA_DIR = join(CACHE_ROOT, "vho-data");
const FIXTURE_PNG = join(REPO_ROOT, "tests", "ai", "fixtures", "smoke-44x28.png");
const REFERENCE_PNG = join(REPO_ROOT, "tests", "ai", "fixtures", "photo-x4-ref.png");
const OUT_DIR = join(REPO_ROOT, "tests", ".results", "ai");
const OFFLINE = process.env.VHO_AI_OFFLINE === "1";
const UPDATE_REFERENCE = process.env.VHO_AI_UPDATE_REFERENCE === "1";

/**
 * Tolerances (8-bit RGB, 0..255). WASM runs the same ORT build on the CPU: the reference was
 * produced by it, so only float summation-order noise is allowed. WebGPU computes in fp32 with
 * different kernels: small differences everywhere, rare larger ones on hard edges.
 */
const TOL = {
  wasm: { meanAbs: 0.5, p999: 3, maxAbs: 8 },
  // Measured 2026-10-25: tiled 1.18 / 15 / 24, WebGPU (AMD 1 GB iGPU) 0.00 / 0 / 1 — margin for
  // other CPUs/GPUs. The 32 px / 8 px tiling is harsher than the app's (>=48 px, 12 px overlap).
  tiled: { meanAbs: 2.0, p999: 24, maxAbs: 48 },
  webgpu: { meanAbs: 1.0, p999: 8, maxAbs: 32 },
  // Independent sanity: a faithful x4 upscale stays close to a plain bilinear upscale
  bilinearMinPsnr: 22,
  // Raw float output range (model output is RGB 0..1; slight over/undershoot is normal)
  rawMin: -0.25,
  rawMax: 1.25,
};

const log = (...a) => console.log("[ai-smoke]", ...a);
let app = null;
let ready = false; // model + runtime present and hash-verified
let fixture = null;
let wasmOut = null;

before(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  // Fresh settings / library on every run; only the model cache survives
  for (const e of await readdir(DATA_DIR)) {
    if (e.toLowerCase() !== "ai") await removeDir(join(DATA_DIR, e));
  }
  log(`model cache: ${join(DATA_DIR, "ai")}`);
  fixture = decodePng(readFileSync(FIXTURE_PNG));
  app = await launchApp({ dataDir: DATA_DIR });
  log(`app pid ${app.proc.pid}, exe ${app.exe}`);
});

after(async () => {
  await app?.close();
});

const invoke = (cmd, args = {}, timeoutMs = 15000) =>
  app.eval(`__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`, { timeoutMs });

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");

/**
 * Runs the real worker (src/media/ai-worker.js) on the fixture with an explicit backend and
 * tile size. Components are acquired/leased through the app's own engine (ai_acquire).
 */
async function runWorker(backend, tile, overlap) {
  const res = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const rt = await eng.acquireComponent("ort-web");
    const mc = await eng.acquireComponent("photo-x4");
    try {
      const url = (dir, f) => __TAURI__.core.convertFileSrc(dir + (dir.includes("\\\\") ? "\\\\" : "/") + f);
      const runtime = { entry: url(rt.dir, "ort.webgpu.min.mjs"), mjs: url(rt.dir, "ort-wasm-simd-threaded.asyncify.mjs"),
        wasm: url(rt.dir, "ort-wasm-simd-threaded.asyncify.wasm") };
      const model = { url: url(mc.dir, eng.MODELS["photo-x4"].file), scale: eng.MODELS["photo-x4"].scale,
        multiple: eng.MODELS["photo-x4"].multiple };
      const bin = atob(${JSON.stringify(b64(fixture.data))});
      const px = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      const w = new Worker(new URL("/media/ai-worker.js", location.href), { type: "module" });
      const started = performance.now();
      const done = await new Promise((resolve, reject) => {
        w.onmessage = (e) => {
          if (e.data.type === "done") resolve(e.data);
          else if (e.data.type === "error") reject(new Error(e.data.message));
        };
        w.onerror = (e) => reject(new Error("worker crashed: " + (e.message || e)));
        w.postMessage({ type: "run", runtime, model, backend: ${JSON.stringify(backend)}, tile: ${tile}, overlap: ${overlap},
          image: { width: ${fixture.width}, height: ${fixture.height}, data: px.buffer } }, [px.buffer]);
      });
      const seconds = (performance.now() - started) / 1000;
      w.terminate();
      const out = new Uint8Array(done.data);
      let s = "";
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { width: done.width, height: done.height, stats: done.stats, seconds, data: btoa(s) };
    } finally {
      rt.release();
      mc.release();
    }
  })()`, { timeoutMs: 600000 });
  return { ...res, data: new Uint8Array(Buffer.from(res.data, "base64")) };
}

function checkOutput(label, out) {
  // Size: exactly x4 of the (unpadded) input
  assert.equal(out.width, fixture.width * SCALE, `${label}: width`);
  assert.equal(out.height, fixture.height * SCALE, `${label}: height`);
  assert.equal(out.data.length, out.width * out.height * 4, `${label}: buffer size`);
  // Finite raw values in a sane range (clamping to bytes would hide NaN as 0)
  if (out.stats) {
    assert.equal(out.stats.nonFinite, 0, `${label}: NaN/Inf in raw model output`);
    assert.ok(out.stats.min >= TOL.rawMin && out.stats.max <= TOL.rawMax,
      `${label}: raw output range ${out.stats.min}..${out.stats.max} outside ${TOL.rawMin}..${TOL.rawMax}`);
  }
  // Not empty / constant
  const sd = lumaStdDev(out);
  assert.ok(sd > 20, `${label}: output looks constant (luma std dev ${sd.toFixed(2)})`);
  // Channel order: each saturated stripe keeps its dominant channel
  for (const [name, ch] of [["red", 0], ["green", 1], ["blue", 2]]) {
    const m = regionMean(out, FIXTURE_REGIONS[name], SCALE);
    const others = [0, 1, 2].filter((c) => c !== ch).map((c) => m[c]);
    assert.ok(m[ch] > Math.max(...others) + 100,
      `${label}: ${name} stripe lost its channel (mean RGB ${m.map((v) => v.toFixed(0)).join(",")})`);
  }
  // Alpha: the worker returns an opaque image (alpha is restored/composited by the caller;
  // keeping it is A04's job). Transparent input pixels must still give defined RGB.
  for (let i = 3; i < out.data.length; i += 4) {
    if (out.data[i] !== 255) assert.fail(`${label}: alpha ${out.data[i]} at pixel ${(i - 3) / 4} (expected opaque output)`);
  }
  const t = regionMean(out, FIXTURE_REGIONS.transparent, SCALE, 1);
  const inT = regionMean(fixture, FIXTURE_REGIONS.transparent, 1, 1);
  assert.ok(t.every((v, c) => Math.abs(v - inT[c]) < 40),
    `${label}: RGB under alpha 0 not preserved (in ${inT.map(Math.round)}, out ${t.map(Math.round)})`);
  // Independent baseline
  const bl = compareRgb(out, bilinearUpscale(fixture, SCALE));
  assert.ok(bl.psnr >= TOL.bilinearMinPsnr, `${label}: PSNR vs bilinear ${bl.psnr.toFixed(2)} dB < ${TOL.bilinearMinPsnr}`);
  return { psnrBilinear: bl.psnr };
}

function withinTolerance(label, diff, tol) {
  const msg = `${label}: meanAbs ${diff.meanAbs.toFixed(3)} (≤${tol.meanAbs}), p99.9 ${diff.p999} (≤${tol.p999}), max ${diff.maxAbs} (≤${tol.maxAbs})`;
  log(msg);
  assert.ok(diff.meanAbs <= tol.meanAbs && diff.p999 <= tol.p999 && diff.maxAbs <= tol.maxAbs, msg);
}

test("model cache: real photo-x4 + ONNX Runtime Web present and SHA-256 verified (download once)", { timeout: 1800000 }, async () => {
  const initial = await invoke("ai_status_all", { ids: COMPONENTS });
  for (const st of initial) log(`${st.id} ${st.version}: ${st.state}, ${st.totalBytes} bytes, dir ${st.dir}`);
  const missing = initial.filter((st) => !st.installed);
  if (missing.length && OFFLINE) {
    throw new Error(`VHO_AI_OFFLINE=1 but the model cache is empty (${missing.map((s) => s.id).join(", ")})`);
  }
  for (const st of initial) {
    let cur = st;
    if (cur.installed) {
      const t0 = Date.now();
      cur = await invoke("ai_verify", { id: st.id }, 600000);
      log(`${st.id}: cache hit, full SHA-256 in ${Date.now() - t0} ms -> ${cur.state}`);
    }
    if (cur.state !== "ready") {
      if (OFFLINE) throw new Error(`${st.id}: cached files are ${cur.state} and VHO_AI_OFFLINE=1`);
      const t0 = Date.now();
      try {
        cur = await invoke("ai_install", { id: st.id, requestId: `ai-smoke-${st.id}` }, 1800000);
      } catch (e) {
        throw new Error(`INFRA: download of ${st.id} failed (infrastructure, not a model/inference result): ${e.message}`);
      }
      const s = (Date.now() - t0) / 1000;
      log(`${st.id}: downloaded ${st.downloadBytes} bytes in ${s.toFixed(1)} s (${(st.downloadBytes / 1048576 / Math.max(s, 0.001)).toFixed(1)} MB/s)`);
      cur = await invoke("ai_verify", { id: st.id }, 600000);
    }
    assert.equal(cur.state, "ready", `${st.id} not verified: ${JSON.stringify(cur.badFiles)}`);
  }
  ready = true;
});

test("committed fixture is the generated synthetic image", () => {
  const gen = makeFixture();
  assert.equal(fixture.width, gen.width);
  assert.equal(fixture.height, gen.height);
  assert.deepEqual(Buffer.from(fixture.data), Buffer.from(gen.data));
});

test("photo-x4 on WASM (single tile): size, finite, non-constant, channel order, alpha, reference", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified (see the model cache test)");
  const out = await runWorker("wasm", 128, 12);
  log(`wasm: ${out.width}x${out.height} in ${out.seconds.toFixed(1)} s, raw ${out.stats.min.toFixed(4)}..${out.stats.max.toFixed(4)}`);
  writeFileSync(join(OUT_DIR, "photo-x4-wasm.png"), encodePng(out));
  const { psnrBilinear } = checkOutput("wasm", out);
  log(`wasm: PSNR vs bilinear ${psnrBilinear.toFixed(2)} dB`);
  wasmOut = out;
  if (UPDATE_REFERENCE) {
    writeFileSync(REFERENCE_PNG, encodePng(out));
    log(`reference rewritten: ${REFERENCE_PNG}`);
  }
  assert.ok(existsSync(REFERENCE_PNG), "no committed reference (run once with VHO_AI_UPDATE_REFERENCE=1 and review)");
  withinTolerance("wasm vs reference", compareRgb(out, decodePng(readFileSync(REFERENCE_PNG))), TOL.wasm);
});

test("photo-x4 on WASM (32 px tiles, 8 px overlap): seams stay within tolerance of the single tile", { timeout: 900000 }, async (t) => {
  if (!ready || !wasmOut) return t.skip("blocked: needs the single-tile WASM result");
  const out = await runWorker("wasm", 32, 8);
  log(`wasm tiled: ${out.seconds.toFixed(1)} s`);
  writeFileSync(join(OUT_DIR, "photo-x4-wasm-tiled.png"), encodePng(out));
  checkOutput("wasm tiled", out);
  withinTolerance("tiled vs single tile", compareRgb(out, wasmOut), TOL.tiled);
});

test("photo-x4 through the app API (upscaleImage, default backend order WebGPU -> WASM)", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified (see the model cache test)");
  const res = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const order = await eng.detectBackends();
    const bin = atob(${JSON.stringify(b64(fixture.data))});
    const px = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
    const r = await eng.upscaleImage("photo-x4", new ImageData(px, ${fixture.width}, ${fixture.height}));
    eng.releaseAi();
    const out = new Uint8Array(r.imageData.data.buffer);
    let s = "";
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return { order, backend: r.backend, tile: r.tile, seconds: r.seconds, stats: r.stats,
      width: r.imageData.width, height: r.imageData.height, data: btoa(s) };
  })()`, { timeoutMs: 900000 });
  const out = { ...res, data: new Uint8Array(Buffer.from(res.data, "base64")) };
  log(`api: backends ${res.order.join(" -> ")}, ran on ${res.backend} (tile ${res.tile}) in ${res.seconds.toFixed(1)} s`);
  writeFileSync(join(OUT_DIR, `photo-x4-api-${res.backend}.png`), encodePng(out));
  checkOutput(`api/${res.backend}`, out);
  const ref = decodePng(readFileSync(REFERENCE_PNG));
  withinTolerance(`api/${res.backend} vs reference`, compareRgb(out, ref), res.backend === "wasm" ? TOL.wasm : TOL.webgpu);
  if (!res.order.includes("webgpu")) t.diagnostic("WebGPU adapter not available: only the WASM backend was exercised");
});

test("no uncaught page errors during the AI smoke run", async (t) => {
  if (!app) return t.skip("app not started");
  assert.deepEqual(await app.errors(), []);
});
