// ==========================================================================
// Photo studio: image loading, zoom / pan / rotate, slideshow, info card.
// ==========================================================================

import { extOf, isRemoteUrl, itemSize, needsDecode } from "./classify.js";
import { formatFileSize, aspectRatioText } from "../core/format.js";
import { convertFileSrc, invoke } from "../core/tauri.js";

export const SLIDESHOW_INTERVAL_MS = 3500;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10.0;

/** Next zoom level: clamped to [0.1, 10] and snapped to 1.0 when close (except factor 1). */
export function nextZoom(current, factor) {
  let z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current * factor));
  if (Math.abs(z - 1.0) < 0.04 && factor !== 1.0) z = 1.0;
  return z;
}

/** Rotation in 90° steps, always in [0, 360). */
export const rotateBy = (rotation, delta) => (rotation + delta + 360) % 360;

/** Zoom badge text: "Fit" near 100 %, otherwise a percentage. */
export const zoomLabel = (zoom) => Math.abs(zoom - 1) < 0.05 ? "Fit" : `${Math.round(zoom * 100)}%`;

/**
 * app: { dom, state, bus, toast, filters, loader, video, playlist, hud }  (resolved lazily)
 */
export function createPhotoViewer(app) {
  const { dom, state } = app;
  const {
    imageContainer, imageElement, gpuCanvas, photoZoomLevel, photoHud, photoCounterBadge, btnFloatingPrev,
    btnFloatingNext, iconSlideshowPlay, iconSlideshowPause, infoRes, infoSize, infoFormat, infoRatio,
    video, controlsHud, timelineContainer, subtitleText, dropZone, currentFilename,
    btnPhotoZoomIn, btnPhotoZoomOut, btnPhotoZoomReset, btnPhotoRotateLeft, btnPhotoRotateRight, btnPhotoInfo,
    photoInfoCard, btnPhotoSlideshow, btnPhotoPrev, btnPhotoNext,
  } = dom;

  let photoZoom = 1.0;
  let photoPanX = 0;
  let photoPanY = 0;
  let photoRotation = 0;
  let isPanningPhoto = false;
  let panStartX = 0;
  let panStartY = 0;
  let slideshowTimer = null;

  /** Scale that keeps a 90°/270° rotated image inside the container. */
  function getRotationFitScale() {
    if (photoRotation % 180 === 0 || !imageElement.naturalWidth) return 1;
    const c = imageContainer.getBoundingClientRect();
    const w = imageElement.offsetWidth, h = imageElement.offsetHeight; // pre-rotation render size
    if (!w || !h) return 1;
    return Math.min(c.width / h, c.height / w, 1);
  }

  function updateImageTransform(withTransition = false) {
    if (!imageElement) return;
    const fit = getRotationFitScale();
    const transition = withTransition ? "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)" : "none";
    const transform = `translate(${photoPanX}px, ${photoPanY}px) scale(${photoZoom * fit}) rotate(${photoRotation}deg)`;
    imageElement.style.transition = transition;
    imageElement.style.transform = transform;
    // The GPU canvas mirrors the image so zoom/pan/rotate keep working while enhanced
    const enhancer = app.filters.enhancer;
    if (enhancer?.active && enhancer.source === imageElement) {
      gpuCanvas.style.transition = transition;
      gpuCanvas.style.transform = transform;
    }
    if (photoZoomLevel) {
      photoZoomLevel.textContent = zoomLabel(photoZoom);
    }
  }

  function resetPhotoTransform() {
    photoZoom = 1.0;
    photoPanX = 0;
    photoPanY = 0;
    photoRotation = 0;
    updateImageTransform(true);
  }

  function zoomPhoto(factor, clientX, clientY) {
    const prevZoom = photoZoom;
    const z = nextZoom(photoZoom, factor);

    if (clientX !== undefined && clientY !== undefined && imageContainer) {
      const rect = imageContainer.getBoundingClientRect();
      const originX = clientX - (rect.left + rect.width / 2);
      const originY = clientY - (rect.top + rect.height / 2);
      photoPanX = originX - (originX - photoPanX) * (z / prevZoom);
      photoPanY = originY - (originY - photoPanY) * (z / prevZoom);
    }

    photoZoom = z;
    if (photoZoom <= 1.0) {
      photoPanX = 0;
      photoPanY = 0;
    }
    updateImageTransform(false);
  }

  function rotate(delta) {
    photoRotation = rotateBy(photoRotation, delta);
    updateImageTransform(true);
    app.toast(delta < 0 ? `Sola Döndürüldü (${photoRotation}°)` : `Sağa Döndürüldü (${photoRotation}°)`);
  }

  // Slideshow: a setTimeout chain that only counts once the current image has loaded
  function scheduleNextSlide() {
    clearTimeout(slideshowTimer);
    if (!state.get("isSlideshowActive") || state.get("playlist").length < 2) return;
    slideshowTimer = setTimeout(() => app.playlist.navigate(1), SLIDESHOW_INTERVAL_MS);
  }

  function toggleSlideshow(forceState, { silent = false } = {}) {
    const next = typeof forceState === "boolean" ? forceState : !state.get("isSlideshowActive");
    if (next && state.get("playlist").length < 2) {
      if (!silent) app.toast("Slayt gösterisi için listede en az 2 medya olmalı");
      return;
    }
    state.set("isSlideshowActive", next);
    if (iconSlideshowPlay) iconSlideshowPlay.style.display = next ? "none" : "inline-block";
    if (iconSlideshowPause) iconSlideshowPause.style.display = next ? "inline-block" : "none";
    if (next) {
      scheduleNextSlide();
      if (!silent) app.toast("Slayt Gösterisi Başlatıldı (3.5 sn)");
    } else {
      clearTimeout(slideshowTimer);
      slideshowTimer = null;
      if (!silent) app.toast("Slayt Gösterisi Duraklatıldı");
    }
  }

  function updatePhotoCounter() {
    if (!photoCounterBadge) return;
    const playlist = state.get("playlist");
    const index = state.get("currentPlaylistIndex");
    const showNav = state.get("currentMediaType") === "image" && playlist.length > 1;
    if (playlist.length > 0 && index >= 0) {
      photoCounterBadge.textContent = `${index + 1} / ${playlist.length}`;
    } else {
      photoCounterBadge.textContent = "1 / 1";
    }
    if (btnFloatingPrev) btnFloatingPrev.style.display = showNav ? "flex" : "none";
    if (btnFloatingNext) btnFloatingNext.style.display = showNav ? "flex" : "none";
  }

  function unloadImageElement() {
    imageElement.onload = imageElement.onerror = null;
    imageElement.removeAttribute("src");
  }

  /** Hides the photo UI when a video takes over. */
  function hidePhotoUi() {
    imageContainer.style.display = "none";
    photoHud.style.display = "none";
    if (btnFloatingPrev) btnFloatingPrev.style.display = "none";
    if (btnFloatingNext) btnFloatingNext.style.display = "none";
    if (photoInfoCard) photoInfoCard.style.display = "none";
  }

  // Load Image File / Source
  function loadImageSource(item) {
    state.update("loadGen", (g) => g + 1);
    state.set("currentMediaType", "image");
    app.video.unloadElements();
    app.filters.disable();
    state.set("enhancerBlocked", false);
    state.set("isTaintedSource", false);
    state.set("currentFileKey", "");
    video.style.display = "none";
    controlsHud.style.display = "none";
    timelineContainer.style.display = "none";
    subtitleText.textContent = "";

    imageContainer.style.display = "flex";
    photoHud.style.display = "flex";
    dropZone.classList.remove("visible");

    const src = app.loader.resolveSource(item);
    const name = item.name || "Fotoğraf";
    const fileSizeStr = formatFileSize(itemSize(item));

    currentFilename.textContent = name;

    // Remote images: ask for CORS so the GPU enhancer and snapshots keep working
    if (isRemoteUrl(src)) imageElement.crossOrigin = "anonymous";
    else imageElement.removeAttribute("crossorigin");
    let retriedWithoutCors = false;

    imageElement.onload = () => {
      const w = imageElement.naturalWidth;
      const h = imageElement.naturalHeight;
      if (infoRes) infoRes.textContent = `${w} × ${h}`;
      if (infoSize) infoSize.textContent = fileSizeStr;
      if (infoFormat) infoFormat.textContent = extOf(name).toUpperCase() || "IMG";
      if (infoRatio) infoRatio.textContent = aspectRatioText(w, h);
      updateImageTransform();
      app.filters.refreshAfterLoad();
      scheduleNextSlide();
      app.bus.emit("media:loaded", { kind: "image" });
    };

    imageElement.onerror = () => {
      if (imageElement.crossOrigin && !retriedWithoutCors) {
        // Server does not send CORS headers: show the image anyway, without GPU access
        retriedWithoutCors = true;
        state.set("isTaintedSource", true);
        imageElement.removeAttribute("crossorigin");
        imageElement.src = src;
        return;
      }
      app.toast(`⚠️ "${name}" açılamadı. Bu görsel formatı (TIFF/HEIC vb.) desteklenmiyor veya dosya bozuk.`);
      scheduleNextSlide();
    };

    if (item.path && !item.playPath && needsDecode(name) && invoke) {
      // HEIC / RAW / TIFF...: the backend makes a displayable copy once (cached)
      const gen = state.get("loadGen");
      imageElement.removeAttribute("src");
      invoke("photo_decode", { path: item.path }).then((r) => {
        if (state.get("loadGen") !== gen) return;
        item.playPath = r.path;
        imageElement.src = convertFileSrc(r.path);
      }).catch((e) => {
        if (state.get("loadGen") !== gen) return;
        app.toast(`⚠️ "${name}" açılamadı: ${String(e).replace(/^\[[a-z-]+\]\s*/, "")}`);
        scheduleNextSlide();
      });
    } else {
      imageElement.src = src;
    }
    resetPhotoTransform();
    app.filters.apply();
    updatePhotoCounter();
    app.hud.poke();
  }

  // Photo HUD controls
  btnPhotoZoomIn?.addEventListener("click", () => zoomPhoto(1.25));
  btnPhotoZoomOut?.addEventListener("click", () => zoomPhoto(0.8));
  btnPhotoZoomReset?.addEventListener("click", () => resetPhotoTransform());
  btnPhotoRotateLeft?.addEventListener("click", () => rotate(-90));
  btnPhotoRotateRight?.addEventListener("click", () => rotate(90));

  btnPhotoInfo?.addEventListener("click", () => {
    if (!photoInfoCard) return;
    const isShowing = photoInfoCard.style.display !== "none";
    photoInfoCard.style.display = isShowing ? "none" : "flex";
  });

  btnPhotoSlideshow?.addEventListener("click", () => toggleSlideshow());
  btnPhotoPrev?.addEventListener("click", () => app.playlist.navigate(-1));
  btnPhotoNext?.addEventListener("click", () => app.playlist.navigate(1));
  btnFloatingPrev?.addEventListener("click", () => app.playlist.navigate(-1));
  btnFloatingNext?.addEventListener("click", () => app.playlist.navigate(1));

  // Keep rotated photos fitted when the window is resized
  window.addEventListener("resize", () => {
    if (state.get("currentMediaType") !== "image") return;
    if (app.filters.enhancer?.active) app.filters.apply(); // re-fit the upscaled photo
    updateImageTransform();
  });

  // Photo wheel zoom & drag-pan interactions
  imageContainer?.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    zoomPhoto(factor, e.clientX, e.clientY);
  }, { passive: false });

  imageContainer?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (photoZoom > 1.01) {
      isPanningPhoto = true;
      panStartX = e.clientX - photoPanX;
      panStartY = e.clientY - photoPanY;
      imageContainer.classList.add("panning");
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!isPanningPhoto) return;
    photoPanX = e.clientX - panStartX;
    photoPanY = e.clientY - panStartY;
    updateImageTransform(false);
  });

  window.addEventListener("mouseup", () => {
    if (isPanningPhoto) {
      isPanningPhoto = false;
      imageContainer.classList.remove("panning");
    }
  });

  imageContainer?.addEventListener("dblclick", (e) => {
    if (photoZoom > 1.05) {
      resetPhotoTransform();
    } else {
      zoomPhoto(2.5, e.clientX, e.clientY);
    }
  });

  return {
    load: loadImageSource,
    unload: unloadImageElement,
    hideUi: hidePhotoUi,
    updateTransform: updateImageTransform,
    resetTransform: resetPhotoTransform,
    zoom: zoomPhoto,
    toggleSlideshow,
    updateCounter: updatePhotoCounter,
    get rotation() { return photoRotation; },
    get zoomLevel() { return photoZoom; },
  };
}
