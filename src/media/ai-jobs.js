// ==========================================================================
// Webview runner of AI queue jobs (Plan 11/A03). AI inference lives in a Web Worker, so the
// Rust job queue hands AI jobs to this page (external adapter, src-tauri/src/jobs/external.rs):
//   "job-run"  { jobId, attemptId, kind, request, items }  -> run the items here
//   "job-stop" { jobId, attemptId }                         -> abort the worker
// Results go back as raw RGBA over binary IPC (jobs_ext_output); the backend writes the PNG
// with the queue's reservation / temp dir / no-overwrite placement.
//
// Request of "ai-photo-enhance" (schema 1):
//   { input, components: ["ort-web", "photo-x4", ("face-restore")], model: "photo-x4",
//     faces: bool, inputWidth, inputHeight, output?: { dir, suffix } }
// inputWidth/Height are fixed when the job is submitted (planInput), so a continued job
// repeats exactly the same recipe.
//
// While a video/music plays, a running AI job is paused (setting ai.pauseDuringPlayback) and
// continued (validated) when playback stops.
// ==========================================================================

import { FACE_MODEL, MODELS, releaseAi, restoreFacesInImage, upscaleImage } from "./ai-engine.js";
import { classifyAiError, errorCodeForClass } from "./ai-policy.js";

export const AI_JOB_KINDS = Object.freeze(["ai-photo-enhance"]);

/** Request of a photo enhancement job (pure; unit tested). */
export function photoEnhanceRequest({ path, faces = false, inputWidth, inputHeight, output } = {}) {
  const components = ["ort-web", MODELS["photo-x4"].component, ...(faces ? [FACE_MODEL.component] : [])];
  const req = { input: path, components, model: "photo-x4", faces: !!faces, inputWidth, inputHeight };
  if (output) req.output = output;
  return req;
}

/** Overall fraction of an enhancement from the engine's phase progress. */
export function enhanceFraction(phase, f, faces) {
  const run = faces ? 0.8 : 1;
  if (phase === "download" || phase === "load") return 0;
  if (phase === "run") return f * run;
  if (phase === "faces") return run + f * (1 - run);
  return null;
}

/** Decodes a local photo (HEIC/RAW through the backend's display copy) at the given size. */
async function loadPixels(invoke, convertFileSrc, path, width, height) {
  const d = await invoke("photo_decode", { path, maxSize: null });
  const img = new Image();
  img.decoding = "async";
  img.src = convertFileSrc(d.path);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = width || img.naturalWidth;
  c.height = height || img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function createAiJobRunner(app, { invoke, listen, convertFileSrc }) {
  const runs = new Map(); // jobId -> { attemptId, ctrl, kind }
  const subs = new Set();
  const pausedByPlayback = new Set();

  const notify = (r) => {
    for (const fn of subs) {
      try { fn(r); } catch (e) { console.error("[ai-jobs]", e); }
    }
  };

  async function enhance(item, request, signal, report) {
    const pixels = await loadPixels(invoke, convertFileSrc, item.path, request.inputWidth, request.inputHeight);
    const faces = !!request.faces;
    const up = await upscaleImage(request.model ?? "photo-x4", pixels, {
      signal,
      onProgress: (phase, f) => report(phase, enhanceFraction(phase, f, faces), f),
    });
    let imageData = up.imageData;
    let faceStats = null;
    if (faces) {
      try {
        const fr = await restoreFacesInImage(up.imageData, { strength: 1, srcScale: up.imageData.width / pixels.width }, {
          signal, original: pixels, onProgress: (phase, f) => report(phase === "faces" ? "faces" : phase, enhanceFraction("faces", phase === "faces" ? f : 0, true), f),
        });
        imageData = fr.imageData;
        faceStats = fr.stats;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        faceStats = { failed: true, message: String(e?.message ?? e) };
      }
    }
    return { imageData, info: { from: [pixels.width, pixels.height], to: [imageData.width, imageData.height], backend: up.backend, tile: up.tile, seconds: up.seconds, attempts: up.attempts, faces: faceStats } };
  }

  async function execute({ jobId, attemptId, kind, request, items }) {
    if (runs.has(jobId)) return;
    const ctrl = new AbortController();
    runs.set(jobId, { attemptId, ctrl, kind });
    const ids = { jobId, attemptId };
    let last = 0;
    const report = (phase, fraction, raw) => {
      notify({ ...ids, type: "progress", phase, fraction, raw });
      const now = performance.now();
      if (fraction == null || (now - last < 250 && fraction < 1)) return;
      last = now;
      invoke("jobs_ext_progress", { ...ids, fraction }).catch(() => {});
    };
    try {
      for (const item of items) {
        if (ctrl.signal.aborted) break;
        try {
          await invoke("jobs_ext_begin", { ...ids, idx: item.idx });
        } catch {
          break; // stopping / stale attempt
        }
        try {
          const { imageData, info } = await enhance(item, request, ctrl.signal, report);
          const body = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
          const output = await invoke("jobs_ext_output", body, {
            headers: { "x-job-id": jobId, "x-attempt-id": attemptId, "x-idx": String(item.idx), "x-width": String(imageData.width), "x-height": String(imageData.height) },
          });
          notify({ ...ids, type: "result", idx: item.idx, input: item.path, output, imageData, info });
        } catch (e) {
          if (e?.name === "AbortError") break;
          const cls = e?.cls ?? classifyAiError(e);
          const code = e?.code && typeof e.code === "string" && e.code !== "failed" ? e.code : errorCodeForClass(cls);
          await invoke("jobs_ext_fail", { ...ids, idx: item.idx, code, detail: String(e?.message ?? e) }).catch(() => {});
          notify({ ...ids, type: "error", idx: item.idx, error: e, code });
        }
      }
    } finally {
      runs.delete(jobId);
      if (!runs.size) releaseAi(); // GPU memory back to the player
      await invoke("jobs_ext_done", ids).catch(() => {});
      notify({ ...ids, type: "done" });
    }
  }

  // ---- pause while a video / music plays (Settings > AI models) ----
  const pauseEnabled = () => app.settings?.get?.("ai.pauseDuringPlayback") !== false;
  app.state?.subscribe?.("isPlaying", (playing) => {
    const media = app.state.get("currentMediaType");
    if (playing && media !== "image" && pauseEnabled()) {
      for (const id of runs.keys()) {
        pausedByPlayback.add(id);
        app.jobs?.pause(id).catch(() => pausedByPlayback.delete(id));
      }
    } else if (!playing && pausedByPlayback.size) {
      for (const id of [...pausedByPlayback]) {
        pausedByPlayback.delete(id);
        app.jobs?.resume(id, "continue").catch(() => {});
      }
    }
  });

  async function start() {
    if (!invoke || !listen) return;
    await Promise.all([
      listen("job-run", (e) => { if (AI_JOB_KINDS.includes(e.payload?.kind)) execute(e.payload); }),
      listen("job-stop", (e) => {
        const r = runs.get(e.payload?.jobId);
        if (r && r.attemptId === e.payload.attemptId) r.ctrl.abort();
      }),
    ]);
    await invoke("jobs_runner_ready", { kinds: AI_JOB_KINDS });
  }

  return {
    start,
    /** fn({ type: "progress" | "result" | "error" | "done", jobId, ... }) */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    get running() { return [...runs.keys()]; },
  };
}
