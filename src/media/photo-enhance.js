// ==========================================================================
// A05 "Enhance photo" (faithful, classical, no AI model): panel controller.
// The work runs in Rust as the queued job "photo-enhance" (src-tauri/src/photo/enhance.rs);
// the original is never changed, the result is a separate file (Save = copy next to the photo).
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { convertFileSrc, invoke } from "../core/tauri.js";
import { jobProgress } from "../core/jobs.js";

/** Panel defaults (= settings defaults, "recommended settings"). */
export const ENHANCE_DEFAULTS = Object.freeze({ sharpness: 40, shadow: 33, scale: 2, grain: false });

/** Slider values (0..100) -> Rust parameters (photo::enhance::EnhanceParams). */
export function enhanceParams({ sharpness, shadow, scale, grain }) {
  const clamp = (v) => Math.min(100, Math.max(0, Number(v) || 0));
  return {
    scale: [1, 2, 4].includes(Number(scale)) ? Number(scale) : 2,
    sharpness: Math.round((1 + (clamp(sharpness) / 100) * 1.5) * 1000) / 1000, // 1 = unchanged .. 2.5
    shadow: Math.round((clamp(shadow) / 100) * 0.6 * 1000) / 1000, // 0 = off .. 0.6
    denoise: 1,
    grain: !!grain,
  };
}

/** Word for a slider value: off / light / medium / strong. */
export function levelKey(v) {
  const n = Number(v) || 0;
  if (n <= 0) return "photoEnhance.level.off";
  if (n < 34) return "photoEnhance.level.low";
  if (n < 67) return "photoEnhance.level.mid";
  return "photoEnhance.level.high";
}

/** JPEG stays JPEG (a 4x PNG of a photo is huge); everything else PNG (alpha kept). */
export function outputFormat(path) {
  return /\.(jpe?g|jfif)$/i.test(path ?? "") ? "jpeg" : "png";
}

export function createPhotoEnhance(app) {
  const $ = (id) => document.getElementById(id);
  const sharp = $("pe-sharp");
  const shadow = $("pe-shadow");
  const scale = $("pe-scale");
  const grain = $("pe-grain");
  const btnApply = $("btn-pe-apply");
  const btnReset = $("btn-pe-reset");
  const progress = $("pe-progress");
  const bar = $("pe-progress-bar");
  const status = $("pe-status");
  const resultBox = $("pe-result");
  const btnCompare = $("btn-pe-compare");
  const btnSave = $("btn-pe-save");
  const img = app.dom?.imageElement ?? $("image-element");
  if (!sharp || !btnApply) return null;

  const settings = app.settings;
  const get = (k) => settings?.get?.(`photoEnhance.${k}`) ?? ENHANCE_DEFAULTS[k];
  const put = (k, v) => settings?.set?.(`photoEnhance.${k}`, v);
  const currentPath = () => app.state.get("playlist")?.[app.state.get("currentPlaylistIndex")]?.path ?? null;

  let running = null; // { jobId, cancel }
  let result = null; // { jobId, url, originalSrc, showingEnhanced }
  let statusFn = () => t("photoEnhance.status.idle");
  const setStatus = (fn) => { statusFn = fn; status.textContent = fn(); };

  function renderValues() {
    $("pe-val-sharp").textContent = t(levelKey(sharp.value));
    $("pe-val-shadow").textContent = t(levelKey(shadow.value));
    btnApply.textContent = t(running ? "common.cancel" : "photoEnhance.apply");
    if (result) btnCompare.textContent = t(result.showingEnhanced ? "enhance.showOriginal" : "enhance.showEnhanced");
    status.textContent = statusFn();
  }

  function load() {
    sharp.value = get("sharpness");
    shadow.value = get("shadow");
    scale.value = String(get("scale"));
    grain.checked = !!get("grain");
    renderValues();
  }

  sharp.addEventListener("input", () => { put("sharpness", Number(sharp.value)); renderValues(); });
  shadow.addEventListener("input", () => { put("shadow", Number(shadow.value)); renderValues(); });
  scale.addEventListener("change", () => put("scale", Number(scale.value)));
  grain.addEventListener("change", () => put("grain", grain.checked));
  btnReset.addEventListener("click", () => {
    settings?.reset?.(["photoEnhance.sharpness", "photoEnhance.shadow", "photoEnhance.scale", "photoEnhance.grain"]);
    load();
  });

  function show(enhanced) {
    if (!result) return;
    result.showingEnhanced = enhanced;
    img.src = enhanced ? result.url : result.originalSrc;
    renderValues();
  }

  function reset() {
    if (running) running.cancel();
    result = null;
    progress.hidden = true;
    resultBox.hidden = true;
    setStatus(() => t("photoEnhance.status.idle"));
    renderValues();
  }

  async function apply() {
    if (running) { running.cancel(); return; }
    if (!invoke || !app.jobs || app.jobs.available === false) { app.toast(t("photoEnhance.status.desktopOnly")); return; }
    const path = currentPath();
    if (app.state.get("currentMediaType") !== "image" || !path) { app.toast(t("photoEnhance.status.openPhoto")); return; }
    if (result?.showingEnhanced) show(false);
    const gen = app.state.get("loadGen");
    const originalSrc = img.currentSrc || img.src;
    const from = `${img.naturalWidth}×${img.naturalHeight}`;
    const started = performance.now();
    let jobId = null;
    let cancelRequested = false;
    running = { cancel() { cancelRequested = true; if (jobId) app.jobs.cancel(jobId).catch(() => {}); } };
    resultBox.hidden = true;
    progress.hidden = false;
    bar.style.width = "0%";
    setStatus(() => t("photoEnhance.status.queued"));
    renderValues();
    try {
      const request = {
        input: path,
        params: enhanceParams({ sharpness: sharp.value, shadow: shadow.value, scale: scale.value, grain: grain.checked }),
        output: {
          suffix: "_enhanced",
          format: outputFormat(path),
          quality: 95,
          metadata: settings?.get?.("ai.output.metadata") ?? "keep",
        },
      };
      const final = await app.jobs.run("photo-enhance", request, {
        onSubmitted: (snap) => { jobId = snap.id; if (cancelRequested) app.jobs.cancel(snap.id).catch(() => {}); },
        onUpdate: (job) => {
          if (gen !== app.state.get("loadGen")) return;
          const f = jobProgress(job);
          if (job.state === "running" && f != null) {
            bar.style.width = `${Math.round(f * 100)}%`;
            setStatus(() => t("photoEnhance.status.running", { pct: Math.round(f * 100) }));
          }
        },
      });
      if (gen !== app.state.get("loadGen")) return; // another photo: the result stays in the jobs panel
      progress.hidden = true;
      const output = final.result?.results?.[0]?.output;
      if (final.state === "completed" && output) {
        result = { jobId, url: convertFileSrc(output), originalSrc, showingEnhanced: false };
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        resultBox.hidden = false;
        show(true);
        const to = () => (img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : "");
        img.addEventListener("load", () => setStatus(() => t("photoEnhance.status.done", { from, to: to(), seconds })), { once: true });
        setStatus(() => t("photoEnhance.status.done", { from, to: to(), seconds }));
      } else if (final.state === "cancelled") {
        setStatus(() => t("photoEnhance.status.cancelled"));
      } else {
        const code = final.result?.results?.[0]?.errorCode ?? final.errorCode ?? "failed";
        const key = `jobs.error.${code}`;
        const error = t(key) !== key ? t(key) : final.errorDetail || t("jobs.error.failed");
        setStatus(() => t("photoEnhance.status.failed", { error }));
      }
    } catch (e) {
      if (gen !== app.state.get("loadGen")) return;
      progress.hidden = true;
      setStatus(() => t("photoEnhance.status.failed", { error: e?.message || String(e) }));
    } finally {
      running = null;
      renderValues();
    }
  }

  btnApply.addEventListener("click", apply);
  btnCompare.addEventListener("click", () => show(!result?.showingEnhanced));
  btnSave.addEventListener("click", async () => {
    if (!result?.jobId) return;
    try {
      const saved = await invoke("jobs_output_copy", { id: result.jobId, idx: 0 });
      btnSave.dataset.saved = saved;
      app.toast(t("photoEnhance.status.saved", { name: saved.split(/[\\/]/).pop() }));
    } catch (e) {
      const key = `jobs.error.${e?.code}`;
      app.toast(t("photoEnhance.status.failed", { error: t(key) !== key ? t(key) : e?.message ?? String(e) }));
    }
  });

  app.bus?.on?.("media:loading", reset);
  i18n.onChange(renderValues);
  settings?.ready?.then?.(load);
  load();
  setStatus(() => t("photoEnhance.status.idle"));
  return { apply, reset, load };
}
