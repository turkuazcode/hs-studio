// ==========================================================================
// Deep AI photo restoration (neural network, downloaded on first use).
// Thin UI controller over ai-engine.js (4x upscaler + optional face restore).
// ==========================================================================

import { upscaleImage, restoreFacesInImage, pendingDownloadBytes, describeHardware, releaseAi, MODELS, FACE_MODEL } from "./ai-engine.js";
import { invoke } from "../core/tauri.js";
import { safeFileName } from "../core/format.js";

export const DEEP_MAX_OUTPUT_PIXELS = 40e6; // keeps memory sane for already-large photos
const DEEP_BUTTON_TEXT = "✨ Fotoğrafı İyileştir (4x, E)";

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
  const DEEP_IDLE_TEXT = deepStatus.textContent;
  const loadGen = () => state.get("loadGen");

  let deepJob = null;    // AbortController of the running job
  let deepResult = null; // { url, blob, originalSrc, showingEnhanced }

  function resetDeepEnhance() {
    deepJob?.abort();
    deepJob = null;
    if (deepResult) URL.revokeObjectURL(deepResult.url);
    deepResult = null;
    deepProgress.hidden = true;
    deepResultActions.hidden = true;
    deepStatus.textContent = DEEP_IDLE_TEXT;
    btnDeepEnhance.textContent = DEEP_BUTTON_TEXT;
  }

  function setDeepProgress(text, fraction) {
    deepProgress.hidden = false;
    deepProgressBar.style.width = `${Math.round(fraction * 100)}%`;
    deepStatus.textContent = text;
  }

  /** Reads the original photo pixels, shrinking huge photos so the 4x output stays reasonable. */
  function readOriginalPixels() {
    const { width: w, height: h } = deepInputSize(imageElement.naturalWidth, imageElement.naturalHeight);
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
      app.toast("Yapay zeka iyileştirme yalnızca masaüstü uygulamasında kullanılabilir");
      return;
    }
    if (state.get("currentMediaType") !== "image" || !imageElement.naturalWidth) {
      app.toast("Önce bir fotoğraf açın");
      return;
    }
    if (state.get("isTaintedSource")) {
      app.toast("⚠️ Bu uzak görsel CORS izni vermediği için işlenemiyor");
      return;
    }
    if (deepResult) { // already done for this photo: just show it
      showDeepVariant(true);
      return;
    }

    const withFaces = checkDeepFaces.checked;
    const components = withFaces ? ["photo-x4", FACE_MODEL.component] : ["photo-x4"];
    const pending = await pendingDownloadBytes(...components);
    if (pending > 0) {
      const mb = Math.round(pending / 1048576);
      const ok = window.confirm(
        `İlk kullanım: yaklaşık ${mb} MB yapay zeka bileşeni indirilecek ve bilgisayarınızda saklanacak.\n\n` +
        `• ONNX Runtime Web — Microsoft, MIT Lisansı\n` +
        `• ${MODELS["photo-x4"].title} — ${MODELS["photo-x4"].credit}\n` +
        (withFaces ? `• ${FACE_MODEL.title} — ${FACE_MODEL.credit}\n` : "") +
        `\nDevam edilsin mi?`);
      if (!ok) return;
    }

    const gen = loadGen();
    const job = new AbortController();
    deepJob = job;
    btnDeepEnhance.textContent = "■ İptal Et";
    deepResultActions.hidden = true;
    const hw = await describeHardware();
    const originalSrc = imageElement.currentSrc;
    const startedAt = performance.now();

    try {
      const pixels = readOriginalPixels();
      const res = await upscaleImage("photo-x4", pixels, {
        signal: job.signal,
        onProgress: (phase, f) => {
          if (phase === "download") setDeepProgress(`Bileşen indiriliyor… %${Math.round(f * 100)}`, f);
          else if (phase === "load") setDeepProgress(`Model hazırlanıyor… (${hw})`, 0);
          else setDeepProgress(`İyileştiriliyor… %${Math.round(f * 100)} — ${hw}`, f);
        },
      });
      if (gen !== loadGen()) return;

      let finalImage = res.imageData;
      let faceNote = "";
      if (withFaces) {
        try {
          const fr = await restoreFacesInImage(res.imageData, {
            strength: 1,
            srcScale: res.imageData.width / pixels.width,
          }, {
            signal: job.signal,
            original: pixels, // faces are cropped from the original, see face-restore.js
            onProgress: (phase, f) => {
              if (phase === "download") setDeepProgress(`Yüz modeli indiriliyor… %${Math.round(f * 100)}`, f);
              else if (phase === "load") setDeepProgress("Yüzler aranıyor…", 0);
              else setDeepProgress(`Yüzler iyileştiriliyor… %${Math.round(f * 100)}`, f);
            },
          });
          if (gen !== loadGen()) return;
          finalImage = fr.imageData;
          faceNote = fr.stats.found ? ` ${fr.stats.restored}/${fr.stats.found} yüz iyileştirildi.` : " Yüz bulunamadı.";
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          console.error("[AI] faces", e);
          faceNote = " (Yüz iyileştirme başarısız oldu, yalnızca büyütme uygulandı.)";
        }
      }

      const c = document.createElement("canvas");
      c.width = finalImage.width;
      c.height = finalImage.height;
      c.getContext("2d").putImageData(finalImage, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      if (gen !== loadGen()) return;

      deepResult = { url: URL.createObjectURL(blob), blob, originalSrc, showingEnhanced: false };
      const where = res.backend === "webgpu" ? "ekran kartı" : "işlemci";
      deepStatus.textContent = `Tamamlandı: ${pixels.width}×${pixels.height} → ${c.width}×${c.height}, ` +
        `${Math.round((performance.now() - startedAt) / 1000)} sn (${where}).${faceNote} ` +
        `Model: ${MODELS["photo-x4"].title}, ${MODELS["photo-x4"].credit}` +
        (withFaces ? `; ${FACE_MODEL.title}, ${FACE_MODEL.credit}.` : ".");
      deepProgress.hidden = true;
      deepResultActions.hidden = false;
      showDeepVariant(true);
      app.toast("✨ Fotoğraf yapay zeka ile iyileştirildi");
    } catch (e) {
      if (gen !== loadGen()) return;
      deepProgress.hidden = true;
      if (e?.name === "AbortError") {
        deepStatus.textContent = "İptal edildi.";
      } else {
        console.error("[AI] deep enhance", e);
        deepStatus.textContent = `⚠️ İyileştirme başarısız: ${e?.message || e}`;
      }
    } finally {
      releaseAi(); // give the GPU memory back to the player
      if (deepJob === job) deepJob = null;
      if (gen === loadGen()) btnDeepEnhance.textContent = DEEP_BUTTON_TEXT;
    }
  }

  function showDeepVariant(enhanced) {
    if (!deepResult) return;
    deepResult.showingEnhanced = enhanced;
    imageElement.src = enhanced ? deepResult.url : deepResult.originalSrc;
    btnDeepCompare.textContent = enhanced ? "Orijinali Göster" : "İyileştirileni Göster";
  }

  // Every new media load drops the previous result / running job
  app.bus.on("media:loading", resetDeepEnhance);

  btnDeepEnhance?.addEventListener("click", deepEnhancePhoto);
  btnDeepCompare?.addEventListener("click", () => showDeepVariant(!deepResult?.showingEnhanced));
  btnDeepSave?.addEventListener("click", () => {
    if (!deepResult) return;
    const base = safeFileName((currentFilename.textContent || "VHO").replace(/\.[^.]+$/, ""));
    if (app.snapshot.downloadBlob(deepResult.blob, `${base}_AI_4x.png`)) app.toast("İyileştirilmiş fotoğraf kaydedildi");
  });

  return { enhance: deepEnhancePhoto, reset: resetDeepEnhance };
}
