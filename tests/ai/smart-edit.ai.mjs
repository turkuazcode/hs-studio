// A06 / Plan 07 smart editing with the REAL models and ONNX Runtime Web (layer "ai": npm run test:ai):
// LaMa (object removal), BiRefNet portrait + general (background), DDColor (colorize, ONNX
// external data). Models come from the shared test cache (see photo-x4.ai.mjs) and are downloaded
// once by the app's own downloader (pinned URL, size + SHA-256; DDColor zip -> two verified files).
//
// Inputs are synthetic images drawn here (no user photos in the repository):
//  - worker on WASM: the Plan 07 recipes on the real models; property checks + committed WASM
//    reference outputs (tests/ai/fixtures/smart-*-ref.png; VHO_AI_UPDATE_REFERENCE=1 rewrites them)
//  - worker on WebGPU (when the probe says it works): close to WASM
//  - queue jobs (ai-inpaint / ai-background / ai-colorize) through the Rust queue, the webview runner
//    and the A04 output: PNG with the right suffix, alpha kept, the source file unchanged
//  - cancel of a running smart job: cancelled, no output
// Colour accuracy is NOT proven here (more saturation is not more correct): Q02 human review.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, launchApp, removeDir } from "../e2e/lib/app.mjs";
import { compareRgb, decodePng, encodePng } from "./lib/image.mjs";
import { meanChroma, rgbToLab } from "../../src/media/smart-edit.js";

const COMPONENTS = ["ort-web", "lama", "birefnet-portrait", "birefnet-general", "ddcolor"];
const CACHE_ROOT = process.env.VHO_TEST_AI_CACHE || join(REPO_ROOT, "tests", ".cache", "ai-smoke");
const DATA_DIR = join(CACHE_ROOT, "vho-data");
const FIXTURES = join(REPO_ROOT, "tests", "ai", "fixtures");
const OUT_DIR = join(REPO_ROOT, "tests", ".results", "ai");
const OFFLINE = process.env.VHO_AI_OFFLINE === "1";
const UPDATE_REFERENCE = process.env.VHO_AI_UPDATE_REFERENCE === "1";

/** WASM vs its own committed reference: float summation-order noise only. WebGPU: other kernels. */
const TOL = { wasm: { meanAbs: 0.5, maxAbs: 8 }, webgpu: { meanAbs: 2.0, maxAbs: 64 } };

const log = (...a) => console.log("[ai-smart]", ...a);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
let app = null;
let ready = false;
let webgpu = false;
const wasm = {};

// ------------------------------------------------------------------ synthetic images

function image(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...fn(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** Smooth sky-like gradient with a red disc in the middle (the object to remove). */
const DISC = { cx: 80, cy: 60, r: 14 };
const sceneBackground = (x, y) => [90 + y, 130 + (x >> 2), 200 - (y >> 1)];
const removeScene = () => image(160, 120, (x, y) =>
  (x - DISC.cx) ** 2 + (y - DISC.cy) ** 2 <= DISC.r ** 2 ? [220, 30, 30] : sceneBackground(x, y));

/** A simple head-and-shoulders figure on a plain light background. */
const PERSON = {
  inside: (x, y) => ((x - 80) / 26) ** 2 + ((y - 72) / 32) ** 2 <= 1 // head
    || (y >= 100 && y < 122 && Math.abs(x - 80) <= 10) // neck
    || (y >= 118 && Math.abs(x - 80) <= 30 + (y - 118) * 0.9), // shoulders / torso
};
const portrait = () => image(160, 200, (x, y) => {
  if (((x - 80) / 28) ** 2 + ((y - 56) / 22) ** 2 <= 1 && y < 60) return [50, 35, 25]; // hair
  if (((x - 80) / 26) ** 2 + ((y - 72) / 32) ** 2 <= 1) return [222, 176, 146]; // face
  if (y >= 100 && y < 122 && Math.abs(x - 80) <= 10) return [205, 160, 130]; // neck
  if (y >= 118 && Math.abs(x - 80) <= 30 + (y - 118) * 0.9) return [45, 70, 140]; // shirt
  return [214, 220, 214 - (y >> 4)]; // studio background
});

/** Grey landscape: bright sky, darker textured ground, a tree. */
const grayScene = () => image(128, 96, (x, y) => {
  let v;
  if ((x - 90) ** 2 + (y - 38) ** 2 <= 15 ** 2) v = 70; // crown
  else if (x >= 87 && x <= 93 && y >= 50 && y < 70) v = 50; // trunk
  else if (y < 56) v = 205 - y; // sky
  else v = 95 + ((x * 7 + y * 13) % 17); // ground
  return [v, v, v];
});

// ------------------------------------------------------------------ app helpers

before(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  for (const e of await readdir(DATA_DIR)) if (e.toLowerCase() !== "ai") await removeDir(join(DATA_DIR, e));
  app = await launchApp({ dataDir: DATA_DIR });
  log(`app pid ${app.proc.pid}, model cache ${join(DATA_DIR, "ai")}`);
});

after(async () => {
  await app?.close();
});

const invoke = (cmd, args = {}, timeoutMs = 15000) =>
  app.eval(`__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`, { timeoutMs });

/** The real worker (src/media/ai-worker.js) on one image with an explicit backend. */
async function runSmart(backend, model, img, params = {}) {
  const res = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const m = eng.SMART_MODELS[${JSON.stringify(model)}];
    const rt = await eng.acquireComponent("ort-web");
    const mc = await eng.acquireComponent(m.component);
    try {
      const url = (dir, f) => __TAURI__.core.convertFileSrc(dir + (dir.includes("\\\\") ? "\\\\" : "/") + f);
      const runtime = { entry: url(rt.dir, "ort.webgpu.min.mjs"), mjs: url(rt.dir, "ort-wasm-simd-threaded.asyncify.mjs"),
        wasm: url(rt.dir, "ort-wasm-simd-threaded.asyncify.wasm") };
      const files = { url: url(mc.dir, m.file) };
      if (m.data) files.externalData = [{ path: m.data, data: url(mc.dir, m.data) }];
      const bin = atob(${JSON.stringify(b64(img.data))});
      const px = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
      const w = new Worker(new URL("/media/ai-worker.js", location.href), { type: "module" });
      const started = performance.now();
      try {
        const done = await new Promise((resolve, reject) => {
          w.onmessage = (e) => {
            if (e.data.type === "done") resolve(e.data);
            else if (e.data.type === "error") reject(new Error(e.data.message));
          };
          w.onerror = (e) => reject(new Error("worker crashed: " + (e.message || e)));
          w.postMessage({ type: "smart", runtime, backend: ${JSON.stringify(backend)}, op: m.op ?? ${JSON.stringify(model)},
            model: files, params: ${JSON.stringify(params)},
            image: { width: ${img.width}, height: ${img.height}, data: px.buffer } }, [px.buffer]);
        });
        const out = new Uint8Array(done.data);
        let s = "";
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return { ok: true, width: done.width, height: done.height, seconds: (performance.now() - started) / 1000, data: btoa(s) };
      } catch (e) {
        return { ok: false, message: String(e.message) };
      } finally {
        w.terminate();
      }
    } finally {
      rt.release();
      mc.release();
    }
  })()`, { timeoutMs: 900000 });
  if (!res.ok) throw new Error(`${model} on ${backend}: ${res.message}`);
  return { ...res, data: new Uint8Array(Buffer.from(res.data, "base64")) };
}

/** Compares a WASM result with its committed reference (or rewrites it). */
function checkReference(name, out) {
  const ref = join(FIXTURES, `smart-${name}-ref.png`);
  writeFileSync(join(OUT_DIR, `smart-${name}-wasm.png`), encodePng(out));
  if (UPDATE_REFERENCE) {
    writeFileSync(ref, encodePng(out));
    log(`reference rewritten: ${ref}`);
  }
  assert.ok(existsSync(ref), `no committed reference ${ref} (run once with VHO_AI_UPDATE_REFERENCE=1 and review)`);
  const d = compareRgba(out, decodePng(readFileSync(ref)));
  log(`${name} wasm vs reference: meanAbs ${d.meanAbs.toFixed(3)}, max ${d.maxAbs}`);
  assert.ok(d.meanAbs <= TOL.wasm.meanAbs && d.maxAbs <= TOL.wasm.maxAbs, `${name}: ${JSON.stringify(d)}`);
}

/** RGB difference plus the alpha channel. */
function compareRgba(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const rgb = compareRgb(a, b);
  let maxA = 0;
  for (let i = 3; i < a.data.length; i += 4) maxA = Math.max(maxA, Math.abs(a.data[i] - b.data[i]));
  return { meanAbs: rgb.meanAbs, maxAbs: Math.max(rgb.maxAbs, maxA) };
}

const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

function meanIn(img, pred) {
  const sum = [0, 0, 0, 0];
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!pred(x, y)) continue;
    px(img, x, y).forEach((v, c) => { sum[c] += v; });
    n++;
  }
  return sum.map((v) => v / n);
}

const STROKES = [{ points: [[DISC.cx / 160, DISC.cy / 120]], radius: (DISC.r + 3) / 120 }];

function checkRemoved(label, src, out) {
  assert.equal(out.width, src.width);
  assert.equal(out.height, src.height);
  // the disc is gone: its area is close to the surrounding gradient, no red left
  const inDisc = (x, y) => (x - DISC.cx) ** 2 + (y - DISC.cy) ** 2 <= (DISC.r - 1) ** 2;
  const got = meanIn(out, inDisc);
  const want = meanIn({ ...src, data: image(160, 120, sceneBackground).data }, inDisc);
  log(`${label}: disc area mean ${got.slice(0, 3).map(Math.round)} (background ${want.slice(0, 3).map(Math.round)})`);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c]) < 30, `${label}: channel ${c} ${got[c]} vs ${want[c]}`);
  // far from the mask the photo is untouched (pasted only inside the feathered mask)
  for (const [x, y] of [[5, 5], [150, 110], [20, 100], [140, 15]]) assert.deepEqual(px(out, x, y), px(src, x, y), `${label}: pixel ${x},${y} changed`);
}

function checkCutout(label, src, out) {
  assert.equal(out.width, src.width);
  assert.equal(out.height, src.height);
  const bgAlpha = meanIn(out, (x, y) => !PERSON.inside(x, y) && (x < 20 || x > 140 || y < 30))[3];
  const fgAlpha = meanIn(out, (x, y) => ((x - 80) / 18) ** 2 + ((y - 74) / 22) ** 2 <= 1 || (y > 150 && Math.abs(x - 80) <= 25))[3];
  log(`${label}: background alpha ${bgAlpha.toFixed(1)}, subject alpha ${fgAlpha.toFixed(1)}`);
  assert.ok(bgAlpha < 40, `${label}: background not removed (alpha ${bgAlpha})`);
  assert.ok(fgAlpha > 200, `${label}: subject not kept (alpha ${fgAlpha})`);
  // RGB untouched in transparent mode (only alpha is new)
  for (const [x, y] of [[80, 74], [80, 170]]) assert.deepEqual(px(out, x, y).slice(0, 3), px(src, x, y).slice(0, 3));
}

function checkColorized(label, src, out) {
  assert.equal(out.width, src.width);
  assert.equal(out.height, src.height);
  // lightness comes from the original (Plan 07 / DDColor pipeline): only ab is new
  let maxDl = 0;
  for (let i = 0; i < src.data.length; i += 4) {
    const L0 = rgbToLab(src.data[i], src.data[i + 1], src.data[i + 2])[0];
    const L1 = rgbToLab(out.data[i], out.data[i + 1], out.data[i + 2])[0];
    maxDl = Math.max(maxDl, Math.abs(L1 - L0));
    assert.equal(out.data[i + 3], 255, "alpha kept");
  }
  const chroma = meanChroma(out.data, 1);
  log(`${label}: mean chroma ${chroma.toFixed(1)} (input ${meanChroma(src.data, 1).toFixed(1)}), max |dL| ${maxDl.toFixed(2)}`);
  assert.ok(chroma > 3, `${label}: no colour added (${chroma})`);
  assert.ok(maxDl < 3, `${label}: lightness changed by ${maxDl}`);
}

// ------------------------------------------------------------------ tests

test("model cache: LaMa, BiRefNet portrait + general, DDColor (zip -> 2 files) present and SHA-256 verified", { timeout: 3600000 }, async () => {
  for (const st of await invoke("ai_status_all", { ids: COMPONENTS })) {
    let cur = st;
    if (cur.installed) cur = await invoke("ai_verify", { id: st.id }, 600000);
    if (cur.state !== "ready") {
      if (OFFLINE) throw new Error(`VHO_AI_OFFLINE=1 but ${st.id} is ${cur.state}`);
      const t0 = Date.now();
      try {
        cur = await invoke("ai_install", { id: st.id, requestId: `ai-smart-${st.id}` }, 3600000);
      } catch (e) {
        throw new Error(`INFRA: download of ${st.id} failed (infrastructure, not a model/inference result): ${e.message}`);
      }
      log(`${st.id}: downloaded ${st.downloadBytes} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      cur = await invoke("ai_verify", { id: st.id }, 600000);
    }
    assert.equal(cur.state, "ready", `${st.id} not verified: ${JSON.stringify(cur.badFiles)}`);
  }
  const dd = (await invoke("ai_status_all", { ids: ["ddcolor"] }))[0];
  assert.ok(existsSync(join(dd.dir, "ddcolor.onnx")) && existsSync(join(dd.dir, "ddcolor.data")), "DDColor files extracted");
  assert.ok(!(await readdir(dd.dir)).some((f) => f.endsWith(".zip")), "zip removed after extraction");
  ready = true;
  const order = await app.eval(`import(new URL("/media/ai-engine.js", location.href).href).then((e) => e.detectBackends())`, { timeoutMs: 120000 });
  webgpu = order.includes("webgpu");
  log(`backends: ${order.join(", ")}`);
});

test("LaMa on WASM: the object is filled with its surroundings, the rest is untouched, reference", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const src = removeScene();
  const out = await runSmart("wasm", "inpaint", src, { strokes: STROKES });
  log(`lama wasm: ${out.seconds.toFixed(1)} s`);
  checkRemoved("lama wasm", src, out);
  checkReference("inpaint", out);
  wasm.inpaint = out;
});

test("BiRefNet portrait on WASM: background transparent, subject kept, reference", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const src = portrait();
  const out = await runSmart("wasm", "matting", src, { mode: "transparent" });
  log(`birefnet portrait wasm: ${out.seconds.toFixed(1)} s`);
  checkCutout("birefnet portrait wasm", src, out);
  checkReference("matting", out);
  wasm.matting = out;
});

test("BiRefNet general (objects) on WASM: runs and separates the figure", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const src = portrait();
  const out = await runSmart("wasm", "matting-general", src, { mode: "transparent" });
  log(`birefnet general wasm: ${out.seconds.toFixed(1)} s`);
  checkCutout("birefnet general wasm", src, out);
});

test("DDColor on WASM (ONNX external data): colour added, lightness kept, reference", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const src = grayScene();
  const out = await runSmart("wasm", "colorize", src);
  log(`ddcolor wasm: ${out.seconds.toFixed(1)} s`);
  checkColorized("ddcolor wasm", src, out);
  checkReference("colorize", out);
  wasm.colorize = out;
});

test("WebGPU: the same three models close to WASM", { timeout: 1800000 }, async (t) => {
  if (!ready || !webgpu) return t.skip(ready ? "WebGPU not available on this machine (probe)" : "blocked: model cache not verified");
  const cases = [["inpaint", removeScene(), { strokes: STROKES }], ["matting", portrait(), { mode: "transparent" }], ["colorize", grayScene(), {}]];
  for (const [model, src, params] of cases) {
    if (!wasm[model]) continue;
    let out;
    try {
      out = await runSmart("webgpu", model, src, params);
    } catch (e) {
      // a GPU that is too small is a measured limit (the engine falls back to WASM), not a pass
      if (/memory|allocat|device/i.test(e.message)) {
        log(`${model} webgpu: ${e.message} -> the app falls back to WASM`);
        continue;
      }
      throw e;
    }
    writeFileSync(join(OUT_DIR, `smart-${model}-webgpu.png`), encodePng(out));
    const d = compareRgba(out, wasm[model]);
    log(`${model} webgpu ${out.seconds.toFixed(1)} s, vs wasm meanAbs ${d.meanAbs.toFixed(3)}, max ${d.maxAbs}`);
    assert.ok(d.meanAbs <= TOL.webgpu.meanAbs && d.maxAbs <= TOL.webgpu.maxAbs, `${model} webgpu vs wasm ${JSON.stringify(d)}`);
  }
});

/** Submits a smart job built by the app's own request helper and waits for its end. */
async function smartJob(op, file, params, extra = {}) {
  const snap = await app.eval(`(async () => {
    const j = await import(new URL("/media/ai-jobs.js", location.href).href);
    const request = j.smartEditRequest(${JSON.stringify({ op, path: file, params, ...extra })});
    return __TAURI__.core.invoke("jobs_submit", { job: { kind: j.smartKindOf(${JSON.stringify(op)}), request } });
  })()`);
  return snap;
}

const waitJob = async (id) => {
  await app.waitFor(`__TAURI__.core.invoke("jobs_get", { id: ${JSON.stringify(id)} }).then((d) => ["completed", "failed", "cancelled"].includes(d.job.state))`,
    { timeoutMs: 900000, message: "smart job finished" });
  return app.eval(`__TAURI__.core.invoke("jobs_get", { id: ${JSON.stringify(id)} })`);
};

test("queue jobs: remove / background colour / colorize write PNGs with the right suffix, sources unchanged", { timeout: 2700000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const cases = [
    ["inpaint", "remove-src.png", removeScene(), { strokes: STROKES }, "_removed", checkRemoved],
    ["matting", "portrait-src.png", portrait(), { mode: "color", color: [255, 255, 255] }, "_background", null],
    ["colorize", "gray-src.png", grayScene(), {}, "_colorized", checkColorized],
  ];
  for (const [op, name, img, params, suffix, check] of cases) {
    const file = join(DATA_DIR, name);
    writeFileSync(file, encodePng(img));
    const before = sha(file);
    const snap = await smartJob(op, file, params, { inputWidth: img.width, inputHeight: img.height });
    const d = await waitJob(snap.id);
    assert.equal(d.job.state, "completed", JSON.stringify(d));
    const outPath = d.items[0].outputPath;
    assert.ok(outPath.endsWith(name.replace(".png", `${suffix}.png`)), outPath);
    assert.equal(sha(file), before, `${op}: source changed`);
    const out = decodePng(readFileSync(outPath));
    const run = await app.eval(`import(new URL("/media/ai-engine.js", location.href).href).then((e) => e.lastAiRun())`);
    log(`${op} queue job on ${run.backend} in ${run.seconds.toFixed(1)} s -> ${outPath}`);
    if (check) check(`${op} queue`, img, out);
    if (op === "matting") {
      // white background, still opaque, subject kept
      const corner = meanIn(out, (x, y) => x < 12 && y < 12);
      assert.ok(corner.slice(0, 3).every((v) => v > 240) && corner[3] === 255, `white background ${corner}`);
      assert.deepEqual(px(out, 80, 74).slice(0, 3), px(img, 80, 74).slice(0, 3), "face kept");
    }
  }
});

test("queue job: a cutout keeps transparency through the A04 output", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const file = join(DATA_DIR, "cutout-src.png");
  const img = portrait();
  writeFileSync(file, encodePng(img));
  const d = await waitJob((await smartJob("matting", file, { mode: "transparent" }, { inputWidth: img.width, inputHeight: img.height })).id);
  assert.equal(d.job.state, "completed", JSON.stringify(d));
  assert.ok(d.items[0].outputPath.endsWith("cutout-src_cutout.png"));
  checkCutout("cutout queue", img, decodePng(readFileSync(d.items[0].outputPath)));
});

test("cancel: a running smart job stops without an output file", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache not verified");
  const file = join(DATA_DIR, "cancel-src.png");
  const img = portrait();
  writeFileSync(file, encodePng(img));
  const snap = await smartJob("matting", file, { mode: "transparent" }, { inputWidth: img.width, inputHeight: img.height });
  await app.waitFor(`__TAURI__.core.invoke("jobs_get", { id: ${JSON.stringify(snap.id)} }).then((d) => d.job.state === "running")`,
    { timeoutMs: 120000, message: "smart job running" });
  await invoke("jobs_cancel", { id: snap.id });
  const d = await waitJob(snap.id);
  assert.equal(d.job.state, "cancelled", JSON.stringify(d.job));
  assert.ok(!d.items[0].outputPath, `no output: ${d.items[0].outputPath}`);
  assert.ok(!existsSync(file.replace(".png", "_cutout.png")));
});
