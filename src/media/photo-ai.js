// ==========================================================================
// "Enhance photo with AI" (S04 naming): neural network 4x upscaler + optional face
// restore, models downloaded on first use. Thin UI controller over ai-engine.js.
// ==========================================================================

import { upscaleImage, restoreFacesInImage, downloadConsentText, describeHardware, releaseAi, MODELS, FACE_MODEL } from "./ai-engine.js";
import { i18n, t } from "../core/i18n.js";
import { convertFileSrc, invoke } from "../core/tauri.js";
import { photoEnhanceRequest } from "./ai-jobs.js";
import { etaSeconds, memoryBudget, planInput } from "./ai-policy.js";
import { safeFileName } from "../core/format.js";

export const DEEP_MAX_OUTPUT_PIXELS = 40e6; // keeps memory sane for already-large photos

/** Input size so that the 4x output stays under maxOutputPixels (never upscales the input). */
export function deepInputSize(w, h, maxOutputPixels = DEEP_MAX_OUTPUT_PIXELS) {
  const k = Math.min(1, Math.sqrt(maxOutputPixels / (w * h * 16)));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * app: { dom, state, bus, toast, snapshot }  (resolved lazily)
 */
export function createPhotoAi(app) {
  const { dom, state } = app;
  const {
    btnDeepEnhance, deepProgress, deepProgressBar, deepStatus, deepResultActions, btnDeepCompare, btnDeepSave,
    checkDeepFaces, imageElement, currentFilename,
  } = dom;
  const loadGen = () => state.get("loadGen");

  let deepJob = null;    // AbortController of the running job
  let deepResult = null; // { url, blob, originalSrc, showingEnhanced }
  let statusText = null; // () => current status text (re-rendered on language change)

  const setStatus = (fn) => { statusText = fn; deepStatus.textContent = fn(); };
  const idleStatus = () => setStatus(() => t("enhance.deepIdle"));
  const renderButton = () => { btnDeepEnhance.textContent = t(deepJob ? "enhance.deepCancel" : "enhance.deepButton"); };
  i18n.onChange(() => {
    renderButton();
    if (statusText) deepStatus.textContent = statusText();
    if (deepResult) btnDeepCompare.textContent = t(deepResult.showingEnhanced ? "enhance.showOriginal" : "enhance.showEnhanced");
  });

  function resetDeepEnhance() {
    // a queued AI job keeps running for its output file (jobs panel); only the view detaches
    if (!deepJob?.queued) deepJob?.abort();
    deepJob = null;
    if (deepResult?.url.startsWith("blob:")) URL.revokeObjectURL(deepResult.url);
    deepResult = null;
    deepProgress.hidden = true;
    deepResultActions.hidden = true;
    idleStatus();
    renderButton();
  }

  function setDeepProgress(key, vars, fraction) {
    deepProgress.hidden = false;
    deepProgressBar.style.width = `${Math.round(fraction * 100)}%`;
    setStatus(() => t(key, vars));
  }

  /** Reads the original photo pixels at the planned input size (planInput, confirmed by the user). */
  function readOriginalPixels({ width: w, height: h }) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imageElement, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  async function deepEnhancePhoto() {
    if (deepJob) { // the button doubles as "cancel" while running
      deepJob.abort();
      return;
    }
    if (!invoke) {
      app.toast(t("enhance.deepDesktopOnly"));
      return;
    }
    if (state.get("currentMediaType") !== "image" || !imageElement.naturalWidth) {
      app.toast(t("enhance.deepOpenPhoto"));
      return;
    }
    if (state.get("isTaintedSource")) {
      app.toast(t("enhance.deepCors"));
      return;
    }
    if (deepResult) { // already done for this photo: just show it
      showDeepVariant(true);
      return;
    }

    const withFaces = checkDeepFaces.checked;
    const components = withFaces ? ["photo-x4", FACE_MODEL.component] : ["photo-x4"];
    const path = currentPath();
    // First use: size, author and license of each missing component (from the manifest)
    let consent;
    try {
      consent = await downloadConsentText(...components);
    } catch (e) {
      deepStatus.textContent = `⚠️ ${e?.message || e}`;
      return;
    }
    if (consent && !window.confirm(consent)) return;
    // Local photo: a persistent AI job (A03; one heavy job at a time, survives a restart, the
    // result is a PNG file). Remote / unsaved images keep the in-memory path below.
    if (path && app.jobs && app.aiJobs && app.jobs.available !== false) {
      await deepQueued(path, withFaces);
      return;
    }
    await deepDirect(withFaces);
  }

  const currentPath = () => state.get("playlist")?.[state.get("currentPlaylistIndex")]?.path ?? null;

  /** Done text of a finished run (sizes, time, backend, faces, model credits). */
  function doneStatus({ from, to, seconds, backend, faceNote = () => "" }, withFaces) {
    const vars = { from, to, sec: Math.round(seconds) };
    const credits = `${MODELS["photo-x4"].title}, ${MODELS["photo-x4"].credit}` +
      (withFaces ? `; ${FACE_MODEL.title}, ${FACE_MODEL.credit}` : "");
    const where = t(backend === "webgpu" ? "enhance.onGpu" : "enhance.onCpu");
    setStatus(() => `${t("enhance.deepDone", { ...vars, where })}${faceNote()} ${t("enhance.deepModel", { credits })}`);
  }

  async function deepQueued(path, withFaces) {
    const nw = imageElement.naturalWidth;
    const nh = imageElement.naturalHeight;
    // memory budget from output size + copies; a reduced job is never run silently
    const plan = planInput(nw, nh, 4, { budget: memoryBudget(navigator.deviceMemory) });
    if (plan.downscaled && !window.confirm(t("enhance.deepTooLarge", {
      w: nw, h: nh, iw: plan.width, ih: plan.height, ow: plan.outWidth, oh: plan.outHeight,
    }))) return;

    const gen = loadGen();
    const hw = await describeHardware();
    const originalSrc = imageElement.currentSrc;
    const startedAt = performance.now();
    let jobId = null;
    let cancelRequested = false;
    const handle = {
      queued: true,
      abort() {
        cancelRequested = true;
        if (jobId) app.jobs.cancel(jobId).catch(() => {});
      },
    };
    deepJob = handle;
    renderButton();
    deepResultActions.hidden = true;
    let result = null;
    let runStarted = null;
    const unsub = app.aiJobs.subscribe((r) => {
      if (r.jobId !== jobId || gen !== loadGen()) return;
      if (r.type === "result") result = r;
      if (r.type !== "progress") return;
      if (r.phase === "download") setDeepProgress("enhance.deepDownloading", { pct: Math.round(r.raw * 100) }, r.raw);
      else if (r.phase === "load") setDeepProgress("enhance.deepLoading", { hw }, 0);
      else if (r.fraction != null) {
        runStarted ??= performance.now();
        const eta = etaSeconds({ fraction: r.fraction, elapsed: (performance.now() - runStarted) / 1000 });
        setDeepProgress(eta != null ? "enhance.deepRunningEta" : "enhance.deepRunning",
          { pct: Math.round(r.fraction * 100), hw, eta }, r.fraction);
      }
    });
    try {
      const final = await app.jobs.run("ai-photo-enhance",
        photoEnhanceRequest({
          path, faces: withFaces, inputWidth: plan.width, inputHeight: plan.height,
          // A04: EXIF/GPS policy of the result (Settings > AI models)
          output: { metadata: app.settings?.get?.("ai.output.metadata") ?? "keep" },
        }), {
          onSubmitted: (snap) => {
            jobId = snap.id;
            if (cancelRequested) app.jobs.cancel(snap.id).catch(() => {});
          },
          onUpdate: (job) => {
            if (job.state === "queued" && gen === loadGen()) setDeepProgress("enhance.deepQueued", null, 0);
          },
        });
      if (gen !== loadGen()) return; // another photo: the result stays in the jobs panel
      deepProgress.hidden = true;
      const output = result?.output ?? final.result?.results?.[0]?.output;
      if (final.state === "completed" && output) {
        const url = convertFileSrc(output);
        deepResult = { url, path: output, jobId, blob: null, originalSrc, showingEnhanced: false };
        const info = result?.info;
        const faces = info?.faces;
        const faceNote = !withFaces || !faces ? () => ""
          : faces.failed ? () => " " + t("enhance.facesFailed")
          : faces.found ? () => " " + t("enhance.facesDone", { restored: faces.restored, found: faces.found })
          : () => " " + t("enhance.facesNone");
        doneStatus({
          from: info ? `${info.from[0]}×${info.from[1]}` : `${plan.width}×${plan.height}`,
          to: info ? `${info.to[0]}×${info.to[1]}` : `${plan.outWidth}×${plan.outHeight}`,
          seconds: (performance.now() - startedAt) / 1000, backend: info?.backend, faceNote,
        }, withFaces);
        deepResultActions.hidden = false;
        showDeepVariant(true);
        app.toast(t("enhance.deepToast"));
      } else if (final.state === "cancelled") {
        setStatus(() => t("enhance.deepCancelled"));
      } else if (final.state === "paused" || final.state === "interrupted") {
        setStatus(() => t("enhance.deepPaused"));
      } else {
        const code = final.result?.results?.[0]?.errorCode ?? final.errorCode ?? "failed";
        const key = `jobs.error.${code}`;
        const error = t(key) !== key ? t(key) : final.errorDetail || t("jobs.error.failed");
        setStatus(() => t("enhance.deepFailed", { error }));
      }
    } catch (e) {
      if (gen !== loadGen()) return;
      deepProgress.hidden = true;
      setStatus(() => t("enhance.deepFailed", { error: e?.message || String(e) }));
    } finally {
      unsub();
      if (deepJob === handle) deepJob = null;
      if (gen === loadGen()) renderButton();
    }
  }

  /** In-memory path (no file on disk): the result is only shown and saved by "Save". */
  async function deepDirect(withFaces) {
    const nw = imageElement.naturalWidth;
    const nh = imageElement.naturalHeight;
    const plan = planInput(nw, nh, 4, { budget: memoryBudget(navigator.deviceMemory) });
    if (plan.downscaled && !window.confirm(t("enhance.deepTooLarge", {
      w: nw, h: nh, iw: plan.width, ih: plan.height, ow: plan.outWidth, oh: plan.outHeight,
    }))) return;
    const gen = loadGen();
    const job = new AbortController();
    deepJob = job;
    renderButton();
    deepResultActions.hidden = true;
    const hw = await describeHardware();
    const originalSrc = imageElement.currentSrc;
    const startedAt = performance.now();

    try {
      const pixels = readOriginalPixels(plan);
      const res = await upscaleImage("photo-x4", pixels, {
        signal: job.signal,
        onProgress: (phase, f) => {
          if (phase === "download") setDeepProgress("enhance.deepDownloading", { pct: Math.round(f * 100) }, f);
          else if (phase === "load") setDeepProgress("enhance.deepLoading", { hw }, 0);
          else setDeepProgress("enhance.deepRunning", { pct: Math.round(f * 100), hw }, f);
        },
      });
      if (gen !== loadGen()) return;

      let finalImage = res.imageData;
      let faceNote = () => "";
      if (withFaces) {
        try {
          const fr = await restoreFacesInImage(res.imageData, {
            strength: 1,
            srcScale: res.imageData.width / pixels.width,
          }, {
            signal: job.signal,
            original: pixels, // faces are cropped from the original, see face-restore.js
            onProgress: (phase, f) => {
              if (phase === "download") setDeepProgress("enhance.faceDownloading", { pct: Math.round(f * 100) }, f);
              else if (phase === "load") setDeepProgress("enhance.faceSearching", null, 0);
              else setDeepProgress("enhance.faceRunning", { pct: Math.round(f * 100) }, f);
            },
          });
          if (gen !== loadGen()) return;
          finalImage = fr.imageData;
          const { restored, found } = fr.stats;
          faceNote = () => " " + (found ? t("enhance.facesDone", { restored, found }) : t("enhance.facesNone"));
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          console.error("[AI] faces", e);
          faceNote = () => " " + t("enhance.facesFailed");
        }
      }

      const c = document.createElement("canvas");
      c.width = finalImage.width;
      c.height = finalImage.height;
      c.getContext("2d").putImageData(finalImage, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      if (gen !== loadGen()) return;

      deepResult = { url: URL.createObjectURL(blob), blob, originalSrc, showingEnhanced: false };
      const vars = {
        from: `${pixels.width}×${pixels.height}`, to: `${c.width}×${c.height}`,
        sec: Math.round((performance.now() - startedAt) / 1000),
      };
      const backendKey = res.backend === "webgpu" ? "enhance.onGpu" : "enhance.onCpu";
      const credits = `${MODELS["photo-x4"].title}, ${MODELS["photo-x4"].credit}` +
        (withFaces ? `; ${FACE_MODEL.title}, ${FACE_MODEL.credit}` : "");
      setStatus(() => `${t("enhance.deepDone", { ...vars, where: t(backendKey) })}${faceNote()} ` +
        `${t("enhance.deepModel", { credits })}`);
      deepProgress.hidden = true;
      deepResultActions.hidden = false;
      showDeepVariant(true);
      app.toast(t("enhance.deepToast"));
    } catch (e) {
      if (gen !== loadGen()) return;
      deepProgress.hidden = true;
      if (e?.name === "AbortError") {
        setStatus(() => t("enhance.deepCancelled"));
      } else {
        console.error("[AI] deep enhance", e);
        const msg = e?.message || String(e);
        setStatus(() => t("enhance.deepFailed", { error: msg }));
      }
    } finally {
      releaseAi(); // give the GPU memory back to the player
      if (deepJob === job) deepJob = null;
      if (gen === loadGen()) renderButton();
    }
  }

  function showDeepVariant(enhanced) {
    if (!deepResult) return;
    deepResult.showingEnhanced = enhanced;
    imageElement.src = enhanced ? deepResult.url : deepResult.originalSrc;
    btnDeepCompare.textContent = t(enhanced ? "enhance.showOriginal" : "enhance.showEnhanced");
  }

  // Every new media load drops the previous result / running job
  app.bus.on("media:loading", resetDeepEnhance);

  btnDeepEnhance?.addEventListener("click", deepEnhancePhoto);
  btnDeepCompare?.addEventListener("click", () => showDeepVariant(!deepResult?.showingEnhanced));
  btnDeepSave?.addEventListener("click", async () => {
    if (!deepResult) return;
    const base = safeFileName((currentFilename.textContent || "VHO").replace(/\.[^.]+$/, ""));
    // queued job: a copy of the result file (EXIF/alpha kept) next to the photo, never
    // overwriting; the file comes from the queue's own record
    if (deepResult.jobId) {
      try {
        const saved = await invoke("jobs_output_copy", { id: deepResult.jobId, idx: 0 });
        btnDeepSave.dataset.saved = saved;
        app.toast(t("enhance.deepSavedTo", { name: saved.split(/[\\/]/).pop() }));
      } catch (e) {
        const key = `jobs.error.${e?.code}`;
        app.toast(t("enhance.deepFailed", { error: t(key) !== key ? t(key) : e?.message ?? String(e) }));
      }
      return;
    }
    if (app.snapshot.downloadBlob(deepResult.blob, `${base}_AI_4x.png`)) app.toast(t("enhance.deepSaved"));
  });

  idleStatus();
  renderButton();
  return { enhance: deepEnhancePhoto, reset: resetDeepEnhance };

}
