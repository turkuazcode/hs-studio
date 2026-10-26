// ==========================================================================
// VHO AI Engine: on-demand ONNX models (ONNX Runtime Web, MIT)
//
// - Components (runtime + models) are downloaded by the backend on first use,
//   pinned and SHA-256 verified, then served to the webview via the asset protocol.
// - Inference runs in a Web Worker (ai-worker.js) so the player never freezes.
// - Backends, best first: WebGPU (verified by a real tiny inference on this device, A03)
//   -> WebAssembly on the CPU. Fallback policy (ai-policy.js): smaller tiles only after a
//   memory error, a fresh worker once after a crash / lost device, the next backend after a
//   backend error; a model or input error is not re-run on the CPU. Every step is logged
//   (aiDiagnostics) and the tile size that worked is remembered per device and model.
// ==========================================================================

import { t } from "../core/i18n.js";
import { classifyAiError, createSlot, deviceKey, errorCodeForClass, nextAttempt } from "./ai-policy.js";
import { consentText, toAiError } from "./ai-status.js";
import { PROBE_SHAPE, probeData, probeModel } from "./onnx-tiny.js";

const tauri = globalThis.window?.__TAURI__;

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
export { abortError };

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

// --------------------------------------------------------------------------
// Backends and devices (A03). Override for testing: localStorage["vho.ai.backend"] = "wasm"
// (WebGPU forced off). A backend counts as usable only after a real tiny inference on it
// (probeBackends); the adapter name or reported memory is never taken as proof.
// --------------------------------------------------------------------------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** Fallback / failure log of this session (newest last), for Settings > AI models. */
const diagnostics = [];
let lastRun = null;
function diag(entry) {
  diagnostics.push({ at: Date.now(), ...entry });
  if (diagnostics.length > 50) diagnostics.shift();
  if (entry.outcome !== "ok") console.warn("[AI]", entry);
}
export const aiDiagnostics = () => diagnostics.slice();
/** Last finished run: { op, model, backend, tile, seconds, attempts, inputPixels }. */
export const lastAiRun = () => lastRun;

let gpu = null; // Promise<{ key, label } | null>
function gpuAdapter() {
  if (!gpu) {
    gpu = (async () => {
      if (!navigator.gpu) return null;
      try {
        const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!a || a.isFallbackAdapter) return null;
        const i = a.info || {};
        return { key: deviceKey(i), label: [i.vendor, i.architecture].filter(Boolean).join(" ") };
      } catch {
        return null;
      }
    })();
  }
  return gpu;
}

/** Candidate backends, best first (cheap: no inference). */
export async function detectBackends() {
  if (backendOrder) return backendOrder;
  const order = [];
  if (store.get("vho.ai.backend") !== "wasm" && await gpuAdapter()) order.push("webgpu");
  order.push("wasm");
  backendOrder = order;
  return order;
}

let probed = null;
/**
 * Usable backends, best first: each GPU candidate must run a tiny model (y = x + x) with the
 * right result. Once per session; failures are kept in the diagnostics. WASM is always last.
 */
export function probeBackends(runtime) {
  if (!probed) {
    probed = (async () => {
      const usable = [];
      for (const backend of await detectBackends()) {
        if (backend === "wasm") { usable.push(backend); continue; }
        const { input, expected } = probeData();
        const model = probeModel();
        try {
          const r = await runInWorker({ type: "probe", runtime, backend, model: model.buffer, input: input.buffer, shape: PROBE_SHAPE },
            [model.buffer, input.buffer], () => {}, null);
          if (r.ok) {
            usable.push(backend);
            diag({ op: "probe", backend, outcome: "ok" });
          } else {
            diag({ op: "probe", backend, outcome: "wrong-result", message: `max error ${r.maxError} (expected ${expected[0]})` });
          }
        } catch (e) {
          diag({ op: "probe", backend, outcome: "unavailable", cls: classifyAiError(e), message: String(e?.message ?? e) });
          killWorker();
        }
      }
      return usable;
    })();
  }
  return probed;
}

export async function describeHardware() {
  const order = await detectBackends();
  if (order[0] !== "webgpu") return t("aiRuntime.hwCpu");
  const g = await gpuAdapter();
  return g?.label ? t("aiRuntime.hwGpu", { name: g.label }) : t("aiRuntime.hwGpuGeneric");
}

// --------------------------------------------------------------------------
// Worker
// --------------------------------------------------------------------------

function getWorker() {
  if (!worker) worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
  return worker;
}

function killWorker() {
  worker?.terminate();
  worker = null;
}

let idleTimer = null;
/** Frees the worker and all its GPU memory (models are reloaded from disk next time). */
export function releaseAi() {
  clearTimeout(idleTimer);
  killWorker();
}

/** Unused sessions are released after a minute without AI work. */
function scheduleIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!slot.waiting) killWorker(); }, 60000);
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
    const onErr = (e) => {
      e.preventDefault?.(); // handled here (fresh worker / next backend), not a page error
      cleanup();
      killWorker();
      reject(new Error(`AI worker crashed: ${e.message || ""}`));
    };
    const onAbort = () => { cleanup(); killWorker(); reject(abortError()); };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    signal?.addEventListener("abort", onAbort);
    w.postMessage(payload, transfer);
  });
}

/** Test-only faults (set by AI-layer tests through the page); `crash` fires once. */
function takeFault() {
  const f = globalThis.__vhoAiTestFaults;
  if (!f) return undefined;
  const out = { ...f };
  if (f.crash) delete f.crash;
  return out;
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

/** Error with .code (job error code), .cls (policy class) and the attempts made. */
function failure(e, cls, attempts, fallbackKey) {
  if (e?.name === "AbortError") return e;
  const err = new Error(e?.message || t(fallbackKey));
  err.cls = cls;
  err.code = errorCodeForClass(cls);
  err.attempts = attempts;
  return err;
}

// --------------------------------------------------------------------------
// Inference adapter (A03): probe() / prepare() / run() / release(). The Web Worker with
// ONNX Runtime Web is the first implementation; photo jobs (and later video) use the same
// lifecycle. One heavy AI job at a time (slot); every fallback is in the diagnostics.
// --------------------------------------------------------------------------

/** One heavy AI job at a time (exports/batches are serialized by the job queue). */
export const slot = createSlot();

const tileKey = (dev, modelId, backend) => `vho.ai.tile.${dev}.${modelId}.${backend}`;

export function createInferenceAdapter() {
  const held = []; // leased components: not removable while the job runs
  let runtime = null;
  let dev = "cpu";

  const startTile = (modelId) => (backend) => {
    const i = Number(store.get(tileKey(backend === "wasm" ? "cpu" : dev, modelId, backend)));
    return Number.isInteger(i) && i >= 0 && i < TILE_STEPS[backend].length ? i : 0;
  };

  return {
    /** Usable backends on this device (real tiny inference), best first. */
    async probe({ onProgress, signal } = {}) {
      runtime ??= await runtimeUrls(held, onProgress, signal);
      dev = (await gpuAdapter())?.key ?? "cpu";
      return probeBackends(runtime);
    },

    /** Downloads (if needed), verifies and leases the runtime + model components. */
    async prepare(componentIds, { onProgress, signal } = {}) {
      const n = componentIds.length + 1;
      runtime ??= await runtimeUrls(held, (f) => onProgress?.(f / n), signal);
      const dirs = {};
      for (const [i, id] of componentIds.entries()) {
        const c = await acquireComponent(id, { onProgress: (f) => onProgress?.((i + 1 + f) / n), signal });
        held.push(c);
        dirs[id] = c.dir;
      }
      return dirs;
    },

    /**
     * recipe: { op: "upscale", modelId, url, scale, multiple } | { op: "faces", detector,
     * restorer, options, original }. input: ImageData.
     */
    async run(input, recipe, onProgress = () => {}, signal = null) {
      const order = await this.probe({ signal });
      const steps = recipe.op === "upscale" ? TILE_STEPS : Object.fromEntries(order.map((b) => [b, [0]]));
      const first = recipe.op === "upscale" ? startTile(recipe.modelId) : () => 0;
      let st = { order, b: 0, ti: first(order[0]), steps, deviceRetries: 0 };
      const attempts = [];
      const started = performance.now();
      let lastError = null;
      let cls = "other";
      while (st) {
        if (signal?.aborted) throw abortError();
        const backend = st.order[st.b];
        const tile = steps[backend][st.ti];
        try {
          const res = await this.attempt(input, recipe, backend, tile, onProgress, signal);
          if (recipe.op === "upscale") store.set(tileKey(backend === "wasm" ? "cpu" : dev, recipe.modelId, backend), String(st.ti));
          const seconds = (performance.now() - started) / 1000;
          attempts.push({ backend, tile, outcome: "ok" });
          lastRun = { op: recipe.op, model: recipe.modelId ?? "face-restore", backend, tile, seconds, attempts, inputPixels: input.width * input.height };
          diag({ op: recipe.op, backend, tile, outcome: "ok", seconds });
          if (recipe.op === "upscale" && seconds > 0) store.set(`vho.ai.rate.${backend === "wasm" ? "cpu" : dev}.${recipe.modelId}`, String(input.width * input.height / seconds));
          return { ...res, backend, tile, seconds, attempts };
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          lastError = e;
          cls = classifyAiError(e);
          attempts.push({ backend, tile, outcome: cls, message: String(e?.message ?? e) });
          diag({ op: recipe.op, backend, tile, outcome: "failed", cls, message: String(e?.message ?? e) });
          killWorker(); // fresh GPU device / memory for the next attempt
          st = nextAttempt(st, cls, first);
        }
      }
      throw failure(lastError, cls, attempts, recipe.op === "faces" ? "aiRuntime.facesFailed" : "aiRuntime.failed");
    },

    /** One try in the worker (input copied: buffers are transferred). */
    async attempt(input, recipe, backend, tile, onProgress, signal) {
      const pixels = input.data.slice().buffer;
      if (recipe.op === "upscale") {
        const res = await runInWorker(
          { type: "run", runtime, backend, tile, overlap: TILE_OVERLAP, fault: takeFault(),
            model: { url: recipe.url, scale: recipe.scale, multiple: recipe.multiple },
            image: { width: input.width, height: input.height, data: pixels } },
          [pixels], onProgress, signal);
        return { imageData: new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), stats: res.stats };
      }
      const o = recipe.original;
      const orig = o ? o.data.slice().buffer : null;
      const res = await runInWorker(
        { type: "faces", runtime, backend, options: recipe.options, detector: recipe.detector, restorer: recipe.restorer, fault: takeFault(),
          image: { width: input.width, height: input.height, data: pixels },
          original: orig ? { width: o.width, height: o.height, data: orig } : null },
        orig ? [pixels, orig] : [pixels], onProgress, signal);
      return { imageData: new ImageData(new Uint8ClampedArray(res.data), res.width, res.height), stats: res.stats };
    },

    /** Leases back; the worker stays for a minute (next job) and is then released. */
    release() {
      for (const c of held.splice(0)) c.release();
      scheduleIdleRelease();
    },
  };
}

/** Measured speed of a model on this device (input pixels / s), or null. */
export async function measuredRate(modelId, backend) {
  const dev = backend === "wasm" ? "cpu" : (await gpuAdapter())?.key ?? "cpu";
  const r = Number(store.get(`vho.ai.rate.${dev}.${modelId}`));
  return r > 0 ? r : null;
}

/**
 * Detects and restores faces (GFPGAN) in an already upscaled image, off the UI thread.
 * options: { strength, srcScale } — see face-restore.js. Returns { imageData, backend, stats }.
 * onProgress(phase, fraction): phase = "download" | "load" | "faces"
 */
export async function restoreFacesInImage(source, options, { onProgress, signal, original = null } = {}) {
  const release = await slot.acquire();
  const ad = createInferenceAdapter();
  try {
    const dirs = await ad.prepare([FACE_MODEL.component], { onProgress: (f) => onProgress?.("download", f), signal });
    const dir = dirs[FACE_MODEL.component];
    return await ad.run(source, {
      op: "faces", options, original,
      detector: assetUrl(joinPath(dir, FACE_MODEL.detector)),
      restorer: assetUrl(joinPath(dir, FACE_MODEL.restorer)),
    }, (phase, f) => onProgress?.(phase, f), signal);
  } finally {
    ad.release();
    release();
  }
}

/**
 * Runs a restoration/upscale model over an image, tile by tile, off the UI thread.
 * source: ImageData. Returns { imageData, backend, tile, seconds, stats, attempts }
 * (stats: { nonFinite, min, max } of the raw model output, see ai-worker.js).
 * onProgress(phase, fraction): phase = "download" | "load" | "run"
 */
export async function upscaleImage(modelId, source, { onProgress, signal } = {}) {
  const m = MODELS[modelId];
  const release = await slot.acquire();
  const ad = createInferenceAdapter();
  try {
    const dirs = await ad.prepare([m.component], { onProgress: (f) => onProgress?.("download", f), signal });
    return await ad.run(source, {
      op: "upscale", modelId, url: assetUrl(joinPath(dirs[m.component], m.file)), scale: m.scale, multiple: m.multiple,
    }, (phase, f) => onProgress?.(phase, f), signal);
  } finally {
    ad.release();
    release();
  }
}
