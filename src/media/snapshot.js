// ==========================================================================
// Snapshot / screenshot capture (video frame, rotated photo, or the
// enhanced GPU frame when the enhancer is active) and file downloads.
// ==========================================================================

import { safeFileName, timeForFileName } from "../core/format.js";
import { t } from "../core/i18n.js";

/** Canvas size for a photo rotated by a multiple of 90°. */
export const rotatedCanvasSize = (w, h, rotation) =>
  rotation % 180 !== 0 ? { width: h, height: w } : { width: w, height: h };

/**
 * app: { dom, state, bus, engine, toast, flashScreen, filters, photo }  (resolved lazily)
 */
export function createSnapshot(app) {
  const { dom, state } = app;
  const { imageElement, currentFilename, btnSnapshot } = dom;

  /** Triggers a browser download; false (with a toast) when there is nothing to save. */
  function downloadBlob(blob, filename) {
    if (!blob) {
      app.toast(t("ui.snapshot.noImage"));
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
      app.toast(t("ui.snapshot.cors"));
    }
  }

  async function captureSnapshot() {
    const safeName = safeFileName(currentFilename.textContent || "VHO");
    const mediaType = state.get("currentMediaType");
    const enhancer = app.filters.enhancer;

    // What you see is what you save: grab the enhanced GPU frame when it's active
    if (enhancer?.active) {
      app.flashScreen();
      const suffix = mediaType === "video" ? timeForFileName(app.engine.time) : "enhanced";
      if (downloadBlob(await enhancer.snapshot(), `${safeName}_${suffix}.png`)) {
        app.toast(t("ui.snapshot.filteredFrame"));
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
      downloadCanvas(canvas, `${safeName}_enhanced.png`, t("ui.snapshot.photoSaved"));
      return;
    }

    if (mediaType !== "video") return;
    const name = `${safeName}_${timeForFileName(app.engine.time)}`;
    try {
      const shot = await app.engine.screenshot(name);
      app.flashScreen();
      if (shot.path) {
        // libmpv writes the PNG itself (Pictures\VHO), subtitles included
        app.toast(t("ui.snapshot.savedFile", { name: shot.path.split(/[\\/]/).pop() }));
        app.bus.emit("snapshot:saved", { path: shot.path });
      } else if (downloadBlob(shot.blob, `${name}.png`)) {
        app.toast(t("ui.snapshot.saved"));
      }
    } catch (e) {
      if (e?.message === "no frame") return;
      console.warn("Snapshot:", e);
      app.toast(app.engine.kind === "mpv"
        ? t("ui.snapshot.failed", { error: e?.message ?? e })
        : t("ui.snapshot.cors"));

    }
  }

  btnSnapshot.addEventListener("click", captureSnapshot);

  return { capture: captureSnapshot, downloadBlob };
}
