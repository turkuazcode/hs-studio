// ==========================================================================
// VHO AI Worker: runs ONNX Runtime Web off the UI thread.
// Session creation (shader compilation, graph optimisation) and inference can take
// a long time on weak hardware; doing it here keeps the player responsive.
//
// Messages in:
//   { type: "run", runtime: { entry, mjs, wasm }, model: { url, scale, multiple },
//     backend, tile, overlap, image: { width, height, data: ArrayBuffer } }
// Messages out:
//   { type: "progress", phase: "load" | "run", fraction }
//   { type: "done", width, height, data: ArrayBuffer, stats? }
//   (run: stats = { nonFinite, min, max } of the raw model output before clamping to 0..255,
//    so a NaN/Inf or out-of-range output is visible to callers and the real-model smoke test)
//   { type: "error", message }
//   probe (A03): { type: "probe", runtime, backend, model, input, shape } -> done { ok, maxError }
// ==========================================================================

import { restoreFaces } from "./face-restore.js";
import { fixOutputDimNames } from "./onnx-patch.js";

let ortPromise = null;
const sessions = new Map(); // `${url}|${backend}` -> InferenceSession

/** Frees every session not in `keep` (1 GB GPUs can't hold the upscaler and GFPGAN at once). */
async function releaseExcept(keep) {
  for (const [key, s] of sessions) {
    if (!keep.includes(key)) {
      sessions.delete(key);
      await s.release?.();
    }
  }
}

function loadOrt(runtime) {
  if (!ortPromise) {
    ortPromise = import(runtime.entry).then((ort) => {
      ort.env.wasm.wasmPaths = { mjs: runtime.mjs, wasm: runtime.wasm };
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return ortPromise;
}

// ONNX output dim-name patch (protobuf walker), see onnx-patch.js
export { fixOutputDimNames };

async function getSession(ort, url, backend, scale) {
  const key = `${url}|${backend}`;
  if (!sessions.has(key)) {
    try {
      let model = await (await fetch(url)).arrayBuffer();
      if (scale !== 1) model = fixOutputDimNames(model).bytes;
      sessions.set(key, await ort.InferenceSession.create(model, {
        executionProviders: [backend],
        graphOptimizationLevel: "all",
      }));
    } catch (e) {
      // the engine's error policy (ai-policy.js) tells memory from model problems by the text
      throw new Error(`Failed to load model: ${e?.message || e}`);
    }
  }
  return sessions.get(key);
}

/** RGB float tile (CHW), padded to multiples of `mult` by edge replication. */
function makeTile(src, srcW, x0, y0, tw, th, mult) {
  const pw = Math.ceil(tw / mult) * mult;
  const ph = Math.ceil(th / mult) * mult;
  const plane = pw * ph;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < ph; y++) {
    const sy = y0 + Math.min(y, th - 1);
    for (let x = 0; x < pw; x++) {
      const si = (sy * srcW + x0 + Math.min(x, tw - 1)) * 4;
      const di = y * pw + x;
      data[di] = src[si] / 255;
      data[plane + di] = src[si + 1] / 255;
      data[2 * plane + di] = src[si + 2] / 255;
    }
  }
  return { data, pw, ph };
}

async function runFaces(msg) {
  const { runtime, detector, restorer, backend, image, original, options } = msg;
  postMessage({ type: "progress", phase: "load", fraction: 0 });
  const ort = await loadOrt(runtime);
  await releaseExcept([`${detector}|${backend}`, `${restorer}|${backend}`]);
  const det = await getSession(ort, detector, backend, 1);
  const face = await getSession(ort, restorer, backend, 1);
  const img = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const crop = original
    ? { width: original.width, height: original.height, data: new Uint8ClampedArray(original.data) }
    : null;
  const stats = await restoreFaces(ort, det, face, img, options, (i, n) =>
    postMessage({ type: "progress", phase: "faces", fraction: i / n }), crop);
  postMessage({ type: "done", width: img.width, height: img.height, data: img.data.buffer, stats }, [img.data.buffer]);
}

async function run(msg) {
  const { runtime, model, backend, tile, overlap, image } = msg;
  postMessage({ type: "progress", phase: "load", fraction: 0 });
  const ort = await loadOrt(runtime);
  await releaseExcept([`${model.url}|${backend}`]);
  const session = await getSession(ort, model.url, backend, model.scale);

  const W = image.width, H = image.height, S = model.scale;
  const src = new Uint8ClampedArray(image.data);
  const dst = new Uint8ClampedArray(W * S * H * S * 4);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const step = tile - 2 * overlap;
  const cols = Math.max(1, Math.ceil(W / step));
  const rows = Math.max(1, Math.ceil(H / step));
  let done = 0;
  const stats = { nonFinite: 0, min: Infinity, max: -Infinity };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Core region this tile owns, plus overlap context so seams don't show
      const cx0 = c * step, cy0 = r * step;
      const cx1 = Math.min(W, cx0 + step), cy1 = Math.min(H, cy0 + step);
      const x0 = Math.max(0, cx0 - overlap), y0 = Math.max(0, cy0 - overlap);
      const x1 = Math.min(W, cx1 + overlap), y1 = Math.min(H, cy1 + overlap);

      const t = makeTile(src, W, x0, y0, x1 - x0, y1 - y0, model.multiple);
      const input = new ort.Tensor("float32", t.data, [1, 3, t.ph, t.pw]);
      const result = await session.run({ [inputName]: input });
      const o = result[outputName];
      const od = await o.getData();
      const opw = t.pw * S;
      const oplane = o.dims[2] * o.dims[3];
      for (let i = 0; i < od.length; i++) {
        const v = od[i];
        if (!Number.isFinite(v)) { stats.nonFinite++; continue; }
        if (v < stats.min) stats.min = v;
        if (v > stats.max) stats.max = v;
      }

      for (let y = cy0 * S; y < cy1 * S; y++) {
        const row = (y - y0 * S) * opw - x0 * S;
        for (let x = cx0 * S; x < cx1 * S; x++) {
          const oi = row + x;
          const di = (y * W * S + x) * 4;
          dst[di] = od[oi] * 255;
          dst[di + 1] = od[oplane + oi] * 255;
          dst[di + 2] = od[2 * oplane + oi] * 255;
          dst[di + 3] = 255;
        }
      }
      input.dispose();
      o.dispose();
      postMessage({ type: "progress", phase: "run", fraction: ++done / (rows * cols) });
    }
  }
  postMessage({ type: "done", width: W * S, height: H * S, data: dst.buffer, stats }, [dst.buffer]);
}

/**
 * Backend probe (A03): a real tiny inference (y = x + x) on the requested backend.
 * { type: "probe", runtime, backend, model: ArrayBuffer, input: ArrayBuffer, shape } ->
 * done { ok, maxError }. The session is released right away.
 */
async function probe(msg) {
  const ort = await loadOrt(msg.runtime);
  await releaseExcept([]);
  const session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: [msg.backend] });
  try {
    const input = new Float32Array(msg.input);
    const res = await session.run({ x: new ort.Tensor("float32", input, msg.shape) });
    const out = await res.y.getData();
    let maxError = 0;
    for (let i = 0; i < input.length; i++) maxError = Math.max(maxError, Math.abs(out[i] - 2 * input[i]));
    postMessage({ type: "done", ok: maxError < 1e-3, maxError });
  } finally {
    await session.release?.();
  }
}

/**
 * Test-only fault injection (A03 tests; the engine passes `fault` only when the page sets
 * globalThis.__vhoAiTestFaults): simulated out-of-memory above a tile size, a crash of this
 * worker, a damaged model file.
 */
function injectFault(msg) {
  const f = msg.fault;
  if (!f) return;
  if (f.oomAboveTile && msg.tile > f.oomAboveTile) throw new Error(`Failed to allocate GPU buffer: out of memory (test fault, tile ${msg.tile})`);
  if (f.crash) setTimeout(() => { throw new Error("AI worker crashed (test fault)"); }, 0);
}

self.onmessage = (e) => {
  if (e.data?.fault) {
    try {
      injectFault(e.data);
    } catch (err) {
      postMessage({ type: "error", message: String(err.message) });
      return;
    }
    if (e.data.fault.crash) return; // the worker dies before answering
    if (e.data.fault.badModel && e.data.model) e.data.model = { ...e.data.model, url: e.data.fault.badModel };
  }
  const job = e.data?.type === "run" ? run : e.data?.type === "faces" ? runFaces : e.data?.type === "probe" ? probe : null;
  if (!job) return;
  job(e.data).catch((err) => {
    // A failed session (e.g. GPU out of memory) must not be reused
    sessions.clear();
    postMessage({ type: "error", message: String(err?.message || err) });
  });
};
