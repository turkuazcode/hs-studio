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
//   { type: "done", width, height, data: ArrayBuffer }
//   { type: "error", message }
// ==========================================================================

import { restoreFaces } from "./face-restore.js";

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

// ---- Minimal protobuf walker (ONNX ModelProto) ----
function readVarint(b, i) {
  let v = 0, shift = 0, byte;
  do {
    byte = b[i++];
    v += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [v, i];
}

/** Yields { field, start, end } for the length-delimited fields of a message in b[start, end). */
function* lenFields(b, start, end) {
  let i = start;
  while (i < end) {
    let key;
    [key, i] = readVarint(b, i);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) [, i] = readVarint(b, i);
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      let len;
      [len, i] = readVarint(b, i);
      yield { field, start: i, end: i + len };
      i += len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

const child = (b, msg, field) => [...lenFields(b, msg.start, msg.end)].filter((f) => f.field === field);

/**
 * Some exported upscalers declare the output as [batch, 3, "height", "width"], reusing the
 * input's symbolic names although the output is N× larger. The CPU backend ignores this,
 * but the WebGPU backend plans buffers from it and fails ("Shape mismatch attempting to
 * re-use buffer"). Renames the output's spatial dim names in place (same byte length, so
 * the file layout is unchanged). Only metadata changes; weights and computation do not.
 */
function fixOutputDimNames(bytes) {
  const b = new Uint8Array(bytes);
  let patched = 0;
  for (const graph of child(b, { start: 0, end: b.length }, 7)) {           // ModelProto.graph
    for (const out of child(b, graph, 12)) {                                // GraphProto.output
      for (const type of child(b, out, 2))                                  // ValueInfoProto.type
        for (const tensor of child(b, type, 1))                             // TypeProto.tensor_type
          for (const shape of child(b, tensor, 2))                          // Tensor.shape
            child(b, shape, 1).slice(2).forEach((dim) => {                  // dims H, W
              for (const p of child(b, dim, 2)) {                           // Dimension.dim_param
                b[p.start] = 0x6f; // first letter -> "o": "height" -> "oeight"
                patched++;
              }
            });
    }
  }
  return { bytes: b, patched };
}

async function getSession(ort, url, backend, scale) {
  const key = `${url}|${backend}`;
  if (!sessions.has(key)) {
    let model = await (await fetch(url)).arrayBuffer();
    if (scale !== 1) model = fixOutputDimNames(model).bytes;
    sessions.set(key, await ort.InferenceSession.create(model, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    }));
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
  postMessage({ type: "done", width: W * S, height: H * S, data: dst.buffer }, [dst.buffer]);
}

self.onmessage = (e) => {
  const job = e.data?.type === "run" ? run : e.data?.type === "faces" ? runFaces : null;
  if (!job) return;
  job(e.data).catch((err) => {
    // A failed session (e.g. GPU out of memory) must not be reused
    sessions.clear();
    postMessage({ type: "error", message: String(err?.message || err) });
  });
};
