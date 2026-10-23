// ==========================================================================
// Snapshot / screenshot capture (video frame, rotated photo, or the
// enhanced GPU frame when the enhancer is active) and file downloads.
// ==========================================================================

import { safeFileName, timeForFileName } from "../core/format.js";

/** Canvas size for a photo rotated by a multiple of 90°. */
export const rotatedCanvasSize = (w, h, rotation) =>
  rotation % 180 !== 0 ? { width: h, height: w } : { width: w, height: h };

/**
 * app: { dom, state, toast, flashScreen, filters, photo }  (resolved lazily)
 */
export function createSnapshot(app) {
  const { dom, state } = app;
  const { video, imageElement, currentFilename, btnSnapshot } = dom;

  /** Triggers a browser download; false (with a toast) when there is nothing to save. */
  function downloadBlob(blob, filename) {
    if (!blob) {
      app.toast("⚠️ Görüntü oluşturulamadı");
      return false;
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function downloadCanvas(canvas, filename, successMsg) {
    try {
      canvas.toBlob((blob) => {
        if (downloadBlob(blob, filename)) app.toast(successMsg);
      }, "image/png");
    } catch (e) {
      console.warn("Snapshot:", e);
      app.toast("⚠️ Uzak kaynaktan ekran görüntüsü alınamıyor (CORS)");
    }
  }

  async function captureSnapshot() {
    const safeName = safeFileName(currentFilename.textContent || "VHO");
    const mediaType = state.get("currentMediaType");
    const enhancer = app.filters.enhancer;

    // What you see is what you save: grab the enhanced GPU frame when it's active
    if (enhancer?.active) {
      app.flashScreen();
      const suffix = mediaType === "video" ? timeForFileName(video.currentTime) : "enhanced";
      if (downloadBlob(await enhancer.snapshot(), `${safeName}_${suffix}.png`)) {
        app.toast("Geliştirilmiş kare kaydedildi!");
      }
      return;
    }

    if (mediaType === "image" && imageElement.naturalWidth) {
      app.flashScreen();
      const w = imageElement.naturalWidth;
      const h = imageElement.naturalHeight;
      const rotation = app.photo.rotation;
      const canvas = document.createElement("canvas");
      Object.assign(canvas, rotatedCanvasSize(w, h, rotation));
      const ctx = canvas.getContext("2d");
      if (imageElement.style.filter) ctx.filter = imageElement.style.filter;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(imageElement, -w / 2, -h / 2, w, h);
      downloadCanvas(canvas, `${safeName}_enhanced.png`, "Geliştirilmiş fotoğraf kaydedildi!");
      return;
    }

    if (mediaType !== "video" || !video.videoWidth || !video.videoHeight) return;
    app.flashScreen();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (video.style.filter) ctx.filter = video.style.filter;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    downloadCanvas(canvas, `${safeName}_${timeForFileName(video.currentTime)}.png`, "Ekran görüntüsü kaydedildi!");
  }

  btnSnapshot.addEventListener("click", captureSnapshot);

  return { capture: captureSnapshot, downloadBlob };
}
