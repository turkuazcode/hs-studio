// ==========================================================================
// VHO AI Engine: on-demand ONNX models (ONNX Runtime Web, MIT)
//
// - Components (runtime + models) are downloaded by the backend on first use,
//   pinned and SHA-256 verified, then served to the webview via the asset protocol.
// - Inference runs in a Web Worker (ai-worker.js) so the player never freezes.
// - Backend tiers, best first: WebGPU (any DX12/Vulkan/Metal GPU, incl. 1 GB iGPUs)
//   -> WebAssembly on the CPU. On any failure the engine steps down automatically:
//   smaller tiles first, then the next backend. Speed is secondary to "it always works".
// ==========================================================================

import { t } from "../core/i18n.js";
import { consentText, toAiError } from "./ai-status.js";

const tauri = window.__TAURI__;

/** Models the app knows about. Licenses: see THIRD_PARTY_NOTICES.txt */
export const MODELS = {
  "photo-x4": {
    component: "photo-x4",
    file: "4xRealWebPhoto_v4_fp32_opset17.onnx",
    scale: 4,
    multiple: 16,          // input sides are padded to a multiple of this
    title: "4xRealWebPhoto v4 (DAT-2)",
    credit: "Philip Hofmann — CC-BY-4.0",
  },
};

/** Face restoration: detector + restorer live in one downloadable component. */
export const FACE_MODEL = {
  component: "face-restore",
  detector: "face_detection_yunet_2023mar.onnx",
  restorer: "GFPGANv1.4-w16.onnx",
  title: "GFPGAN v1.4 + YuNet",
  credit: "Tencent ARC (Apache-2.0), Shiqi Yu / OpenCV (MIT)",
};

const RUNTIME = {
  component: "ort-web",
  entry: "ort.webgpu.min.mjs",
  mjs: "ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort-wasm-simd-threaded.asyncify.wasm",
};

// Tile sizes (input pixels) tried per backend, largest first
const TILE_STEPS = { webgpu: [128, 96, 64, 48], wasm: [128, 96, 64] };
const TILE_OVERLAP = 12;

let worker = null;
let backendOrder = null;
const tileStart = {}; // backend -> index into TILE_STEPS that last worked

function joinPath(dir, name) {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

const assetUrl = (path) => tauri.core.convertFileSrc(path);

// --------------------------------------------------------------------------
// Component management (backend: src-tauri/src/ai). Errors arrive as { code, detail };
// they become Error objects with .code and an i18n message (aiModels.errors.<code>).
// --------------------------------------------------------------------------

/** Backend error -> Error { code, detail, message (localized) }; "cancelled" is an AbortError. */
export const aiError = (e) => toAiError(e, t);

const call = (cmd, args) => tauri.core.invoke(cmd, args).catch((e) => { throw aiError(e); });
const abortError = () => new DOMException(t("aiModels.errors.cancelled"), "AbortError");

let requestSeq = 0;
const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${++requestSeq}`;

export const componentStatus = (id) => call("ai_status", { id });
/** Statuses of the given components (all components of the manifest without ids). */
export const componentStatuses = (ids) => call("ai_status_all", ids ? { ids } : {});
export const verifyComponent = (id) => call("ai_verify", { id });
export const removeComponent = (id) => call("ai_remove", { id });

/**
 * Downloads / repairs a component. Only this request's progress events are followed (a
 * cancelled earlier request never moves this bar). signal.abort() cancels this request;
 * the shared download stops once no request follows it any more.
 * onProgress(fraction, phase): phase = "verify" | "download" | "extract".
 */
export async function installComponent(id, { onProgress, signal } = {}) {
  if (signal?.aborted) throw abortError();
  const requestId = newRequestId();
  let pending = true;
  let unlisten = null;
  const onAbort = async () => {
    // The request may not be registered yet: retry briefly until the backend knows it
    for (let i = 0; pending && i < 50; i++) {
      if (await call("ai_cancel_download", { requestId }).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  try {
    unlisten = await tauri.event.listen("ai-download", (e) => {
      const p = e.payload;
      if (p.id === id && p.requests?.includes(requestId) && p.total > 0) onProgress?.(Math.min(1, p.done / p.total), p.phase);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    return await call("ai_install", { id, requestId });
  } finally {
    pending = false;
    signal?.removeEventListener("abort", onAbort);
    unlisten?.();
  }
}

/**
 * Makes a component usable for one job: downloads it if needed, then the backend verifies
 * it (full SHA-256 on first use in this session) and leases it, so it cannot be removed while
 * the job runs. A file damaged since the last check is repaired once. Call release() after.
 */
export async function acquireComponent(id, { onProgress, signal } = {}) {
  const st = await componentStatus(id);
  if (!st.installed) await installComponent(id, { onProgress, signal });
  let res;
  try {
    res = await call("ai_acquire", { id });
  } catch (e) {
    if (e.code !== "checksum" && e.code !== "not-installed") throw e;
    await installComponent(id, { onProgress, signal });
    res = await call("ai_acquire", { id });
  }
  if (signal?.aborted) {
    call("ai_release", { lease: res.lease }).catch(() => {});
    throw abortError();
  }
  let released = false;
  return {
    dir: res.status.dir,
    status: res.status,
    release() {
      if (released) return;
      released = true;
      call("ai_release", { lease: res.lease }).catch(() => {});
    },
  };
}

/** Compatibility: ensures the component is on disk and verified; returns its directory. */
export async function ensureComponent(id, onProgress) {
  const c = await acquireComponent(id, { onProgress });
  c.release();
  return c.dir;
}

/** Bytes that still need downloading before the given components can run (0 if ready). */
export async function pendingDownloadBytes(...componentIds) {
  const list = await componentStatuses([RUNTIME.component, ...componentIds]);
  return list.reduce((sum, st) => sum + (st.installed ? 0 : st.downloadBytes), 0);
}

/**
 * First-use consent text: size, title, author and license of every component that still has
 * to be downloaded (from the manifest), or null when everything is already on disk.
 */
export async function downloadConsentText(...componentIds) {
  return consentText(await componentStatuses([RUNTIME.component, ...componentIds]), t);
}

/** Hardware tier detection. Override for testing: localStorage["vho.ai.backend"] = "wasm". */
export async function detectBackends() {
  if (backendOrder) return backendOrder;
  let forced = null;
  try { forced = localStorage.getItem("vho.ai.backend"); } catch (_) {}
  const order = [];
  if (forced !== "wasm" && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter && !adapter.isFallbackAdapter) order.push("webgpu");
    } catch (_) {}
  }
  order.push("wasm");
  backendOrder = order;
  return order;
}

export async function describeHardware() {
  const order = await detectBackends();
  if (order[0] !== "webgpu") return "İşlemci (WebAssembly)";
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const i = a.info || {};
    return `Ekran kartı (WebGPU: ${[i.vendor, i.architecture].filter(Boolean).join(" ") || "GPU"})`;
  } catch (_) {
    return "Ekran kartı (WebGPU)";
  }
}

function getWorker() {
  if (!worker) worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
  return worker;
}

function killWorker() {
  worker?.terminate();
  worker = null;
}

/** Frees the worker and all its GPU memory (models are reloaded from disk next time). */
export function releaseAi() {
  killWorker();
}

/** One attempt on one backend/tile size, executed in the worker. */
function runInWorker(payload, transfer, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const cleanup = () => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      signal?.removeEventListener("abort", onAbort);
    };
    const onMsg = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.phase, m.fraction);
      else if (m.type === "done") { cleanup(); resolve(m); }
      else if (m.type === "error") { cleanup(); reject(new Error(m.message)); }
    };
    const onErr = (e) => { cleanup(); killWorker(); reject(new Error(e.message || "AI işçisi çöktü")); };
    const onAbort = () => { cleanup(); killWorker(); reject(new DOMException("İptal edildi", "AbortError")); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort);
    w.postMessage(payload, transfer);
  });
}

/** Acquires the inference runtime (lease pushed to `held`) and returns its file URLs. */
async function runtimeUrls(held, onProgress, signal) {
  const rt = await acquireComponent(RUNTIME.component, { onProgress, signal });
  held.push(rt);
  return {
    entry: assetUrl(joinPath(rt.dir, RUNTIME.entry)),
    // Full per-file URLs: asset URLs encode the whole Windows path as one segment,
    // so a directory prefix would not resolve relative file names correctly.
    mjs: assetUrl(joinPath(rt.dir, RUNTIME.mjs)),
    wasm: assetUrl(joinPath(rt.dir, RUNTIME.wasm)),
  };
}

/**
 * Detects and restores faces (GFPGAN) in an already upscaled image, off the UI thread.
 * options: { strength, srcScale } — see face-restore.js. Returns { imageData, backend, stats }.
 * onProgress(phase, fraction): phase = "download" | "load" | "faces"
 */
export async function restoreFacesInImage(source, options, opts = {}) {
  const held = []; // leased components: not removable while the job runs
  try {
    return await restoreFacesWith(held, source, options, opts);
  } finally {
    for (const c of held) c.release();
  }
}

async function restoreFacesWith(held, source, options, { onProgress, signal, original = null }) {
  const report = (phase, f) => onProgress?.(phase, f);
  const runtime = await runtimeUrls(held, (f) => report("download", f * 0.15), signal);
  const face = await acquireComponent(FACE_MODEL.component, { onProgress: (f) => report("download", 0.15 + f * 0.85), signal });
  held.push(face);
  const dir = face.dir;
  const order = await detectBackends();
  let lastError = null;
  for (const backend of order) {
    if (signal?.aborted) throw new DOMException("İptal edildi", "AbortError");
    try {
      const pixels = source.data.slice().buffer;
      const orig = original ? original.data.slice().buffer : null;
      const res = await runInWorker(
        { type: "faces", runtime, backend, options,
          detector: assetUrl(joinPath(dir, FACE_MODEL.detector)),
          restorer: assetUrl(joinPath(dir, FACE_MODEL.restorer)),
          image: { width: source.width, height: source.height, data: pixels },
          original: orig ? { width: original.width, height: original.height, data: orig } : null },
        orig ? [pixels, orig] : [pixels], report, signal);
      return { imageData: new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), backend, stats: res.stats };
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      lastError = e;
      console.warn(`[AI] faces on ${backend} failed, stepping down:`, e);
      killWorker();
    }
  }
  throw lastError ?? new Error("Yüz iyileştirme çalıştırılamadı");
}

/**
 * Runs a restoration/upscale model over an image, tile by tile, off the UI thread.
 * source: ImageData. Returns { imageData, backend, tile, seconds }.
 * onProgress(phase, fraction): phase = "download" | "load" | "run"
 */
export async function upscaleImage(modelId, source, opts = {}) {
  const held = []; // leased components: not removable while the job runs
  try {
    return await upscaleWith(held, modelId, source, opts);
  } finally {
    for (const c of held) c.release();
  }
}

async function upscaleWith(held, modelId, source, { onProgress, signal }) {
  const m = MODELS[modelId];
  const report = (phase, f) => onProgress?.(phase, f);
  const runtime = await runtimeUrls(held, (f) => report("download", f * 0.4), signal);
  const mc = await acquireComponent(m.component, { onProgress: (f) => report("download", 0.4 + f * 0.6), signal });
  held.push(mc);
  const modelDir = mc.dir;
  const model = { url: assetUrl(joinPath(modelDir, m.file)), scale: m.scale, multiple: m.multiple };
  const order = await detectBackends();
  const started = performance.now();
  let lastError = null;

  for (const backend of order) {
    const steps = TILE_STEPS[backend];
    for (let si = tileStart[backend] ?? 0; si < steps.length; si++) {
      if (signal?.aborted) throw new DOMException("İptal edildi", "AbortError");
      try {
        const pixels = source.data.slice().buffer; // a copy per attempt: buffers are transferred
        const res = await runInWorker(
          { type: "run", runtime, model, backend, tile: steps[si], overlap: TILE_OVERLAP,
            image: { width: source.width, height: source.height, data: pixels } },
          [pixels],
          report,
          signal,
        );
        tileStart[backend] = si;
        return {
          imageData: new ImageData(new Uint8ClampedArray(res.data), res.width, res.height),
          backend,
          tile: steps[si],
          seconds: (performance.now() - started) / 1000,
        };
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        lastError = e;
        console.warn(`[AI] ${backend} tile ${steps[si]} failed, stepping down:`, e);
        killWorker(); // fresh GPU device / memory for the next attempt
      }
    }
  }
  throw lastError ?? new Error("Yapay zeka modeli çalıştırılamadı");
}
