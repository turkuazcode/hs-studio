// ==========================================================================
// Picture pipeline: WebGL2 GPU enhancer (CAS sharpening + upscale + A/B split)
// or the CSS filter fallback (brightness / contrast / saturation).
// ==========================================================================

import { createGpuEnhancer } from "./gpu-enhancer.js";
import { pictureProps } from "./engine/engine.js";

/** Sharpness level (0-3) -> enhancer shader parameters. */
export function enhancerLevels(level) {
  return {
    sharp: [0, 0.55, 0.8, 1.0][level] ?? 0.8,
    denoise: [0, 0.1, 0.18, 0.22][level] ?? 0.18,
    detail: [0, 0.5, 0.9, 1.3][level] ?? 0.9,
  };
}

/** CSS filter string used when the GPU path is off or unavailable. */
export function cssFilterString({ brightness: b, contrast: c, saturate: s, aiEnabled, sharpLevel, contrastBoost }) {
  let filterStr = `brightness(${b}%)`;
  if (aiEnabled) {
    // CSS fallback (no WebGL2 / CORS-tainted source): contrast & saturation boost only
    const effectiveC = Math.min(200, c + contrastBoost + (sharpLevel * 6));
    const effectiveS = Math.min(250, s + (sharpLevel * 3));
    filterStr += ` contrast(${effectiveC}%) saturate(${effectiveS}%)`;
  } else {
    filterStr += ` contrast(${c}%) saturate(${s}%)`;
  }
  return filterStr;
}

/**
 * app: { dom, state, toast, photo }  (photo is resolved lazily)
 */
export function createVisualFilters(app) {
  const { dom, state } = app;
  const {
    video, imageElement, imageContainer, gpuCanvas, sliderBrightness, sliderContrast, sliderSaturate,
    valBrightness, valContrast, valSaturate, sliderGamma, sliderHue, valGamma, valHue,
  } = dom;

  let enhancer = null;
  try {
    enhancer = createGpuEnhancer(gpuCanvas);
  } catch (e) {
    console.warn("WebGL2 enhancer unavailable:", e);
  }

  function currentVisualSource() {
    const mediaType = state.get("currentMediaType");
    if (mediaType === "image" && imageElement.getAttribute("src")) return imageElement;
    if (mediaType === "video" && video.getAttribute("src")) return video;
    return null;
  }

  /** With the enhancer on, small photos are upscaled to fill the screen (that's the point of super-resolution). */
  function fitImageForEnhancer(on) {
    const nw = imageElement.naturalWidth, nh = imageElement.naturalHeight;
    const s = on && nw && nh ? Math.min(imageContainer.clientWidth / nw, imageContainer.clientHeight / nh) : 0;
    if (s > 1) {
      imageElement.style.width = `${Math.floor(nw * s)}px`;
      imageElement.style.height = `${Math.floor(nh * s)}px`;
    } else {
      imageElement.style.width = imageElement.style.height = "";
    }
  }

  function disableEnhancerVisuals() {
    fitImageForEnhancer(false);
    enhancer?.stop();
    gpuCanvas.style.transform = "none";
    gpuCanvas.style.transition = "none";
    video.classList.remove("enhancer-source-hidden");
    imageElement.classList.remove("enhancer-source-hidden");
  }

  function applyVideoFilters() {
    const b = parseInt(sliderBrightness.value, 10);
    const c = parseInt(sliderContrast.value, 10);
    const s = parseInt(sliderSaturate.value, 10);
    valBrightness.textContent = `${b}%`;
    valContrast.textContent = `${c}%`;
    valSaturate.textContent = `${s}%`;

    const aiEnabled = state.get("isAiRestoreEnabled");
    const sharpLevel = state.get("aiSharpLevel");
    const contrastBoost = state.get("aiContrastBoost");
    const gamma = parseInt(sliderGamma?.value ?? "0", 10);
    const hue = parseInt(sliderHue?.value ?? "0", 10);
    if (valGamma) valGamma.textContent = String(gamma);
    if (valHue) valHue.textContent = String(hue);

    // libmpv draws the video itself: the colour controls become mpv properties
    // (brightness/contrast/saturation/gamma/hue); the AI "restoration" adds its contrast/
    // saturation boost there (no WebGL access to mpv's frames).
    if (app.engine?.kind === "mpv" && state.get("currentMediaType") === "video") {
      disableEnhancerVisuals();
      video.style.filter = "";
      const boost = aiEnabled ? contrastBoost + sharpLevel * 6 : 0;
      app.engine.setPicture(pictureProps({
        brightness: b, contrast: c, saturate: aiEnabled ? s + sharpLevel * 3 : s, gamma, hue, contrastBoost: boost,
      }));
      return;
    }

    const src = currentVisualSource();
    const useGpu = aiEnabled && enhancer && src && !state.get("enhancerBlocked") && !state.get("isTaintedSource");

    if (useGpu) {
      video.style.filter = imageElement.style.filter = "none"; // drop the CSS filter cost
      if (src === imageElement) fitImageForEnhancer(true);
      src.classList.add("enhancer-source-hidden");
      (src === video ? imageElement : video).classList.remove("enhancer-source-hidden");
      enhancer.set({
        ...enhancerLevels(sharpLevel),
        split: state.get("isSplitViewActive") ? 0.5 : 0,
        bcs: [b / 100, (c + contrastBoost) / 100, s / 100],
        base: [b / 100, c / 100, s / 100],
        box: src === imageElement
          ? () => [imageElement.offsetWidth, imageElement.offsetHeight]
          : state.get("currentAspect") === "contain" ? null : () => [video.offsetWidth, video.offsetHeight],
      });
      if (!enhancer.active || enhancer.source !== src) enhancer.start(src);
      if (src === imageElement) {
        app.photo.updateTransform();
      } else {
        gpuCanvas.style.transform = "none";
      }
      return;
    }

    disableEnhancerVisuals();
    const filterStr = cssFilterString({ brightness: b, contrast: c, saturate: s, aiEnabled, sharpLevel, contrastBoost });
    video.style.filter = filterStr;
    imageElement.style.filter = filterStr;
  }

  /** A freshly loaded frame/photo: restart the GPU pass on the new source. */
  function refreshAfterLoad() {
    if (state.get("isAiRestoreEnabled")) {
      enhancer?.stop();
      applyVideoFilters();
    }
  }

  gpuCanvas.addEventListener("enhancer-error", () => {
    state.set("enhancerBlocked", true);
    disableEnhancerVisuals();
    applyVideoFilters();
    app.toast("⚠️ Bu kaynakta GPU netleştirme kullanılamıyor (CORS). CSS moduna geçildi.");
  });

  return {
    apply: applyVideoFilters,
    disable: disableEnhancerVisuals,
    refreshAfterLoad,
    /** The WebGL2 enhancer, or null without WebGL2. */
    get enhancer() { return enhancer; },
    destroy: () => enhancer?.destroy(),
  };
}
