// A03 resource / backend / adapter tests with the REAL photo-x4 model and ONNX Runtime Web
// (layer "ai": npm run test:ai; models from the shared test cache, see photo-x4.ai.mjs):
//  - backend probe = a real tiny inference; WebGPU forced off -> WASM, correct result
//  - small (GPU) memory: simulated out-of-memory above 64 px tiles -> smaller tiles, correct result
//  - damaged model: stops with modelFailed, NOT re-run on the CPU (one attempt)
//  - worker crash: one retry with a fresh worker, correct result
//  - two jobs racing: serialized (one heavy AI job at a time), both correct
//  - queue job end to end: ai-photo-enhance through the Rust queue + webview runner + binary
//    upload -> PNG next to nothing of the user's (AI result folder), equal to the reference
//  - measurement: UI event-loop lag and process memory while AI runs on the CPU (reported)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, launchApp, removeDir } from "../e2e/lib/app.mjs";
import { compareRgb, decodePng } from "./lib/image.mjs";

const CACHE_ROOT = process.env.VHO_TEST_AI_CACHE || join(REPO_ROOT, "tests", ".cache", "ai-smoke");
const DATA_DIR = join(CACHE_ROOT, "vho-data");
const FIXTURE_PNG = join(REPO_ROOT, "tests", "ai", "fixtures", "smoke-44x28.png");
const REFERENCE_PNG = join(REPO_ROOT, "tests", "ai", "fixtures", "photo-x4-ref.png");
const OUT_DIR = join(REPO_ROOT, "tests", ".results", "ai");
// same tolerances as photo-x4.ai.mjs (measured there)
const TOL = { wasm: { meanAbs: 0.5, maxAbs: 8 }, tiled: { meanAbs: 2.0, maxAbs: 48 }, webgpu: { meanAbs: 1.0, maxAbs: 32 } };

const log = (...a) => console.log("[ai-runtime]", ...a);
let app = null;
let ready = false;
let fixture = null;
let reference = null;

before(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  for (const e of await readdir(DATA_DIR)) if (e.toLowerCase() !== "ai") await removeDir(join(DATA_DIR, e));
  fixture = decodePng(readFileSync(FIXTURE_PNG));
  reference = decodePng(readFileSync(REFERENCE_PNG));
  app = await launchApp({ dataDir: DATA_DIR });
  const st = await app.eval(`__TAURI__.core.invoke("ai_status_all", { ids: ["ort-web", "photo-x4"] })`);
  ready = st.every((s) => s.installed);
  if (!ready) log("model cache empty: run photo-x4.ai.mjs first (it downloads once)");
});

after(async () => {
  await app?.close();
});

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");

/** Runs eng.upscaleImage on the fixture in the page; `setup` runs first (faults, overrides). */
async function upscale(setup = "") {
  const res = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    ${setup}
    const bin = atob(${JSON.stringify(b64(fixture.data))});
    const px = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
    try {
      const r = await eng.upscaleImage("photo-x4", new ImageData(px, ${fixture.width}, ${fixture.height}));
      const out = new Uint8Array(r.imageData.data.buffer);
      let s = "";
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { ok: true, backend: r.backend, tile: r.tile, attempts: r.attempts, width: r.imageData.width, height: r.imageData.height, data: btoa(s) };
    } catch (e) {
      return { ok: false, code: e.code, cls: e.cls, attempts: e.attempts, message: String(e.message) };
    } finally {
      delete globalThis.__vhoAiTestFaults;
    }
  })()`, { timeoutMs: 900000 });
  return res.ok ? { ...res, data: new Uint8Array(Buffer.from(res.data, "base64")) } : res;
}

function close(label, out, tol) {
  assert.equal(out.width, fixture.width * 4);
  assert.equal(out.height, fixture.height * 4);
  const d = compareRgb(out, reference);
  log(`${label}: meanAbs ${d.meanAbs.toFixed(3)}, max ${d.maxAbs}`);
  assert.ok(d.meanAbs <= tol.meanAbs && d.maxAbs <= tol.maxAbs, `${label}: meanAbs ${d.meanAbs} max ${d.maxAbs}`);
}

const tolFor = (backend) => (backend === "wasm" ? TOL.wasm : TOL.webgpu);

test("probe: backends verified by a real tiny inference", { timeout: 300000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const r = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const ad = eng.createInferenceAdapter();
    try {
      const order = await ad.probe();
      return { candidates: await eng.detectBackends(), order, diag: eng.aiDiagnostics().filter((d) => d.op === "probe") };
    } finally { ad.release(); }
  })()`, { timeoutMs: 300000 });
  log(`candidates ${r.candidates.join(",")} -> usable ${r.order.join(",")}; probe log ${JSON.stringify(r.diag)}`);
  assert.equal(r.order.at(-1), "wasm");
  for (const b of r.order.filter((x) => x !== "wasm")) assert.ok(r.diag.some((d) => d.backend === b && d.outcome === "ok"), `${b} probed`);
  if (!r.candidates.includes("webgpu")) t.diagnostic("no WebGPU adapter on this machine");
});

test("WebGPU forced off: WASM backend, result equals the reference", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  // a fresh page: the backend order is decided once per session
  await app.eval(`localStorage.setItem("vho.ai.backend", "wasm"), location.reload(), true`);
  await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 20000 });
  try {
    const out = await upscale();
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.backend, "wasm");
    close("forced wasm", out, TOL.wasm);
  } finally {
    await app.eval(`localStorage.removeItem("vho.ai.backend"), location.reload(), true`);
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 20000 });
  }
});

test("small memory: out-of-memory above 64 px tiles -> smaller tiles, correct result", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const out = await upscale(`globalThis.__vhoAiTestFaults = { oomAboveTile: 64 };
    for (const k of Object.keys(localStorage)) if (k.startsWith("vho.ai.tile.")) localStorage.removeItem(k);`);
  assert.ok(out.ok, JSON.stringify(out));
  log(`attempts ${JSON.stringify(out.attempts.map((a) => `${a.backend}/${a.tile}:${a.outcome}`))}`);
  assert.ok(out.tile <= 64, `ran with tile ${out.tile}`);
  assert.ok(out.attempts.filter((a) => a.outcome === "memory").length >= 2, "stepped down through the memory errors");
  assert.ok(out.attempts.every((a) => a.outcome === "memory" || a.outcome === "ok"), "only memory errors before success");
  close(`small tiles (${out.backend}/${out.tile})`, out, TOL.tiled);
  // the working tile is remembered for this device + model
  const remembered = await app.eval(`Object.keys(localStorage).filter((k) => k.startsWith("vho.ai.tile."))`);
  assert.ok(remembered.length >= 1);
});

test("damaged model: modelFailed, not re-run on the CPU", { timeout: 300000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const out = await upscale(`
    const rt = await eng.acquireComponent("ort-web");
    const bad = __TAURI__.core.convertFileSrc(rt.dir + (rt.dir.includes("\\\\") ? "\\\\" : "/") + "ort-wasm-simd-threaded.asyncify.mjs");
    rt.release();
    globalThis.__vhoAiTestFaults = { badModel: bad };`);
  assert.equal(out.ok, false);
  log(`damaged model: ${out.code} / ${out.cls}: ${out.message.slice(0, 120)}`);
  assert.equal(out.code, "modelFailed");
  assert.equal(out.attempts.length, 1, `one attempt only: ${JSON.stringify(out.attempts)}`);
});

test("worker crash: one retry with a fresh worker, correct result", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const out = await upscale(`globalThis.__vhoAiTestFaults = { crash: true };`);
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.attempts.map((a) => a.outcome), ["device", "ok"]);
  assert.equal(out.attempts[0].backend, out.attempts[1].backend, "same backend again");
  close(`after crash (${out.backend})`, out, out.tile === 128 ? tolFor(out.backend) : TOL.tiled);
});

test("two jobs racing: one heavy AI job at a time, both correct", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const r = await app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const bin = atob(${JSON.stringify(b64(fixture.data))});
    const make = () => { const px = new Uint8ClampedArray(bin.length); for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i); return new ImageData(px, ${fixture.width}, ${fixture.height}); };
    const spans = [];
    const one = async (name) => {
      const r = await eng.upscaleImage("photo-x4", make(), { onProgress: (p) => { if (p === "load") spans.push(name + ":start"); } });
      spans.push(name + ":end");
      const out = new Uint8Array(r.imageData.data.buffer);
      let s = ""; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { backend: r.backend, tile: r.tile, data: btoa(s) };
    };
    const [a, b] = await Promise.all([one("a"), one("b")]);
    return { a, b, spans };
  })()`, { timeoutMs: 900000 });
  log(`race spans ${r.spans.join(" ")}`);
  assert.ok(r.spans.indexOf("a:end") < r.spans.lastIndexOf("b:start"), `serialized: ${r.spans.join(" ")}`);
  for (const x of [r.a, r.b]) {
    const out = { width: fixture.width * 4, height: fixture.height * 4, data: new Uint8Array(Buffer.from(x.data, "base64")) };
    close(`race ${x.backend}/${x.tile}`, out, x.tile === 128 ? tolFor(x.backend) : TOL.tiled);
  }
});

test("queue job: ai-photo-enhance through the Rust queue and the webview runner", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  const src = join(DATA_DIR, "job-fixture.png");
  writeFileSync(src, readFileSync(FIXTURE_PNG));
  const snap = await app.eval(`__TAURI__.core.invoke("jobs_submit", { job: { kind: "ai-photo-enhance", request: {
    input: ${JSON.stringify(src)}, components: ["ort-web", "photo-x4"], model: "photo-x4", faces: false,
    inputWidth: ${fixture.width}, inputHeight: ${fixture.height} } } })`);
  await app.waitFor(`__TAURI__.core.invoke("jobs_get", { id: ${JSON.stringify(snap.id)} }).then((d) => ["completed", "failed", "cancelled"].includes(d.job.state))`,
    { timeoutMs: 600000, message: "AI job finished" });
  const d = await app.eval(`__TAURI__.core.invoke("jobs_get", { id: ${JSON.stringify(snap.id)} })`);
  assert.equal(d.job.state, "completed", JSON.stringify(d));
  const outPath = d.items[0].outputPath;
  assert.ok(outPath.includes("ai-results") && outPath.endsWith("job-fixture_restored.png"), outPath);
  const out = decodePng(readFileSync(outPath));
  const backend = await app.eval(`import(new URL("/media/ai-engine.js", location.href).href).then((e) => e.lastAiRun())`);
  log(`queue job ran on ${backend.backend}/${backend.tile} in ${backend.seconds.toFixed(1)} s -> ${outPath}`);
  close("queue job PNG", out, backend.tile === 128 ? tolFor(backend.backend) : TOL.tiled);
  // the backend's own panel/jobs list knows it
  assert.ok((await app.eval(`__TAURI__.core.invoke("jobs_list")`)).some((j) => j.id === snap.id && j.kind === "ai-photo-enhance"));
});

/** Working set of our vho.exe + its WebView2 processes (MB). */
function processMemoryMb() {
  const ps = `
    $ids = @(${app.proc.pid})
    $all = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${app.userData.replace(/'/g, "''")}*' }
    $sum = (Get-Process -Id ${app.proc.pid}).WorkingSet64
    foreach ($p in $all) { $sum += (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 }
    [math]::Round($sum / 1MB)`;
  return Number(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60000 }).trim());
}

test("measurement: UI responsiveness and memory while AI runs on the CPU", { timeout: 900000 }, async (t) => {
  if (!ready) return t.skip("blocked: model cache empty");
  // CPU backend for this measurement (the backend order is decided once per page session)
  await app.eval(`localStorage.setItem("vho.ai.backend", "wasm"), location.reload(), true`);
  await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 20000 });
  const idleMb = processMemoryMb();
  // event-loop lag of the page (16 ms timer) while a WASM run of a 4x bigger input happens
  const pending = app.eval(`(async () => {
    const eng = await import(new URL("/media/ai-engine.js", location.href).href);
    const w = 88, h = 56, px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = (i * 7) % 255; px[i + 1] = (i * 13) % 255; px[i + 2] = (i * 3) % 255; px[i + 3] = 255; }
    const lags = [];
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); lags.push(now - last - 16); last = now; }, 16);
    const t0 = performance.now();
    try {
      const r = await eng.upscaleImage("photo-x4", new ImageData(px, w, h));
      return { seconds: (performance.now() - t0) / 1000, backend: r.backend, lags };
    } finally {
      clearInterval(timer);
      localStorage.removeItem("vho.ai.backend");
    }
  })()`, { timeoutMs: 900000 });
  await new Promise((r) => setTimeout(r, 1500));
  const busyMb = processMemoryMb();
  const r = await pending;
  await app.eval(`location.reload(), true`);
  await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 20000 });
  const lags = r.lags.sort((a, b) => a - b);
  const p95 = lags[Math.floor(lags.length * 0.95)] ?? 0;
  const max = lags.at(-1) ?? 0;
  const result = { idleMb, busyMb, seconds: r.seconds, backend: r.backend, lagP95Ms: Math.round(p95), lagMaxMs: Math.round(max), samples: lags.length };
  log(`measurement ${JSON.stringify(result)}`);
  writeFileSync(join(OUT_DIR, "ai-runtime-measurement.json"), JSON.stringify(result, null, 2));
  assert.equal(r.backend, "wasm");
  t.diagnostic(`idle ${idleMb} MB, during AI ${busyMb} MB; UI lag p95 ${result.lagP95Ms} ms, max ${result.lagMaxMs} ms (${r.backend}, ${r.seconds.toFixed(1)} s)`);
  // inference is off the UI thread: the page keeps answering
  assert.ok(p95 < 250, `UI event loop p95 lag ${p95} ms while AI runs`);
});

test("no uncaught page errors during the A03 run", async (t) => {
  if (!app) return t.skip("app not started");
  assert.deepEqual(await app.errors(), []);
});
