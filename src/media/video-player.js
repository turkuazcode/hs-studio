// ==========================================================================
// Video player: loading through the engine facade (libmpv or HTML5 <video>),
// resume position, play/pause state, seeking, speed, aspect ratio, PiP,
// frame stepping, engine-dependent UI (transparent window for libmpv).
// ==========================================================================

import { formatTime } from "../core/format.js";
import { t } from "../core/i18n.js";
import { aspectProps } from "./engine/engine.js";
import { itemSize } from "./classify.js";
import { hasSecret, redactUrl, streamTitle } from "./net-logic.js";

export { MEDIA_ERR_TEXT } from "./engine/html5-engine.js";

export const ASPECT_CLASSES = ["aspect-16-9", "aspect-21-9", "aspect-4-3", "aspect-fill"];

/** Key of the resume position (app.resume store; localStorage in older builds). A URL with a
 *  password / token is stored without the secret (L04). */
export const resumeKey = (item) =>
  item.url ? "vho_url_" + (hasSecret(item.url) ? redactUrl(item.url) : item.url) : `vho_file_${item.name || "Online Video"}_${itemSize(item)}`;

/** Offer to resume only after 8 s and not within the last 15 s. */
export const shouldOfferResume = (savedTime, duration) =>
  savedTime > 8 && Number.isFinite(duration) && savedTime < (duration - 15);

/** Seek target that respects live streams / unknown duration. */
export function clampSeek(current, delta, duration) {
  const t = current + delta;
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, t)) : Math.max(0, t);
}

/**
 * app: { dom, state, bus, engine, toast, flashScreen, triggerRipple, hud, filters, photo, subtitles,
 *        timeline, loader, playlist, audio, sleep }  (resolved lazily)
 */
export function createVideoPlayer(app) {
  const { dom, state, engine } = app;
  const {
    video, thumbVideo, controlsHud, timelineContainer, currentFilename, dropZone, iconPlay, iconPause,
    resumeToast, resumeTimeText, btnResumeYes, btnResumeNo, btnSkipBack, btnSkipFwd, btnPip, btnAspectRatio,
    aspectMenu, aspectLabel, btnSpeed, speedMenu, speedLabel, subtitlesMenu, btnPlayPause, mpvSurface,
  } = dom;

  let resumePendingTime = 0;
  let resumeToastTimer = 0;
  let resumeChecked = false;

  /** libmpv draws behind the transparent page: make the page see-through while it shows video. */
  function syncEngineUi() {
    const mpvVideo = engine.kind === "mpv" && state.get("currentMediaType") === "video";
    document.documentElement.classList.toggle("engine-mpv-video", mpvVideo);
    document.documentElement.dataset.engine = engine.kind;
    if (btnPip) btnPip.hidden = !engine.caps.pip;
    if (mpvSurface) mpvSurface.hidden = !mpvVideo;
    app.bus.emit("engine:changed", { kind: engine.kind });
  }

  /** Releases the decoders (photo shown, playlist cleared) without error handlers firing. */
  function unloadVideoElements() {
    engine.unload();
    thumbVideo.removeAttribute("src");
    thumbVideo.load();
    app.timeline.clearThumb();
    syncEngineUi();
  }

  // ------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------
  function loadVideoSource(item) {
    const gen = state.update("loadGen", (g) => g + 1);
    state.set("currentMediaType", "video");
    if (state.get("isSlideshowActive")) app.photo.toggleSlideshow(false, { silent: true });
    app.photo.unload();
    thumbVideo.removeAttribute("src");
    thumbVideo.load();
    app.timeline.clearThumb();
    app.filters.disable();
    state.set("enhancerBlocked", false);
    app.photo.hideUi();

    controlsHud.style.display = "flex";
    timelineContainer.style.display = "flex";

    const name = item.name || t("ui.video.onlineName");
    streamItem = item.url && !item.path ? { name } : null;
    state.set("currentFileKey", resumeKey(item));

    resumePendingTime = 0;
    resumeChecked = false;
    clearTimeout(resumeToastTimer);
    resumeToast.classList.remove("show");

    delete currentFilename.dataset.i18n; // a file name, not a translatable text
    currentFilename.textContent = name;
    dropZone.classList.remove("visible");
    app.subtitles.resetForNewMedia();
    app.timeline.reset();
    app.photo.updateCounter();
    setPlayState(false);

    const loading = engine.load(item, { gen });
    syncEngineUi();
    app.filters.apply();
    app.view?.reapply();
    app.audioFx?.reapply();
    applyAspect(state.get("currentAspect"));
    app.audio.reapply();
    loading?.catch?.((e) => {
      if (gen !== state.get("loadGen")) return;
      console.warn("engine load", e);
      app.toast(t("ui.video.openFailed", { error: e?.message ?? e }));
    });
  }

  /** The engine already plays `item` (gapless switch, Plan 13/L03): UI and resume key only. */
  function adoptSource(item) {
    state.update("loadGen", (g) => g + 1);
    state.set("currentFileKey", resumeKey(item));
    resumePendingTime = 0;
    resumeChecked = false;
    clearTimeout(resumeToastTimer);
    resumeToast.classList.remove("show");
    delete currentFilename.dataset.i18n;
    currentFilename.textContent = item.name || t("ui.video.onlineName");
    app.subtitles.resetForNewMedia();
    app.timeline.reset();
    app.photo.updateCounter();
  }

  // Internet radio (L04): mpv reports the ICY title ("Artist - Song") of the stream
  let streamItem = null;
  engine.on("metadata/by-key/icy-title", (title) => {
    if (!streamItem || state.get("currentMediaType") !== "video") return;
    currentFilename.textContent = streamTitle(streamItem.name, title);
    currentFilename.dataset.streamTitle = title ?? "";
  });

  engine.on("loaded", () => {
    app.filters.refreshAfterLoad();
    app.bus.emit("media:loaded", { kind: "video" });
    checkResumePlayback();
  });

  engine.on("error", (msg) => {
    if (engine.kind !== "mpv") return; // the HTML5 engine toasts its own diagnostics
    app.toast(t("ui.video.openFailed", { error: msg }));
    setPlayState(false);
  });

  // ------------------------------------------------------------------------
  // Resume position (app.resume: library store, see core/library.js)
  // ------------------------------------------------------------------------
  function checkResumePlayback() {
    if (resumeChecked) return;
    resumeChecked = true;
    const saved = app.resume.get(state.get("currentFileKey"));
    if (!saved) return;
    const savedTime = parseFloat(saved);
    if (shouldOfferResume(savedTime, engine.duration)) {
      resumePendingTime = savedTime;
      resumeTimeText.textContent = t("ui.resume.at", { time: formatTime(savedTime) });
      resumeToast.classList.add("show");
      clearTimeout(resumeToastTimer);
      resumeToastTimer = setTimeout(() => resumeToast.classList.remove("show"), 8000);
    }
  }

  btnResumeYes.addEventListener("click", () => {
    if (resumePendingTime) {
      engine.seek(resumePendingTime);
      resumePendingTime = 0;
    }
    resumeToast.classList.remove("show");
  });

  btnResumeNo.addEventListener("click", () => {
    app.resume.remove(state.get("currentFileKey"));
    resumePendingTime = 0;
    resumeToast.classList.remove("show");
  });

  // Save progress regularly
  setInterval(() => {
    const key = state.get("currentFileKey");
    if (key && state.get("currentMediaType") === "video" && engine.time > 5 && !engine.paused) {
      app.resume.set(key, engine.time);
    }
  }, 3000);

  // ------------------------------------------------------------------------
  // Play / pause (UI state follows the engine's own events)
  // ------------------------------------------------------------------------
  const hasMedia = () => state.get("currentMediaType") === "video" && !dropZone.classList.contains("visible");

  function togglePlay() {
    if (!hasMedia()) return;
    if (engine.paused || engine.ended) {
      engine.play();
      app.triggerRipple("play");
    } else {
      engine.pause();
      app.triggerRipple("pause");
    }
  }

  function setPlayState(playing) {
    state.set("isPlaying", playing);
    document.body.classList.toggle("is-playing", playing);
    if (playing) {
      iconPlay.style.display = "none";
      iconPause.style.display = "block";
      app.hud.poke();
    } else {
      iconPlay.style.display = "block";
      iconPause.style.display = "none";
      app.hud.show();
    }
  }

  engine.on("playstate", (playing) => setPlayState(playing));

  // Video end -> sleep timer check or playlist auto advance
  engine.on("ended", () => {
    app.resume.remove(state.get("currentFileKey"));
    if (app.sleep.isVideoEndArmed) {
      app.sleep.trigger();
      return;
    }
    if (!app.playlist.playNextOnEnd()) {
      setPlayState(false);
      app.hud.show();
    }
  });

  function seekBy(delta) {
    if (!hasMedia()) return;
    engine.seek(clampSeek(engine.time, delta, engine.duration));
  }

  /** "." / ",": one frame forward / back (pauses). */
  function frameStep(dir) {
    if (!hasMedia()) return;
    engine.frameStep(dir);
    app.hud.poke();
  }

  btnSkipBack.addEventListener("click", () => seekBy(-10));
  btnSkipFwd.addEventListener("click", () => seekBy(10));

  // Picture in Picture (PiP): only the HTML5 engine has a <video> element to detach
  btnPip.addEventListener("click", async () => {
    if (!engine.caps.pip) {
      app.toast(t("ui.video.pipHtml5Only"));

      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && state.get("currentMediaType") === "video") {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.warn("PiP not supported or failed", err);
    }
  });

  // Aspect ratio menu
  function applyAspect(aspect) {
    video.classList.remove(...ASPECT_CLASSES);
    if (engine.kind === "mpv") {
      for (const [k, v] of Object.entries(aspectProps(aspect))) engine.set(k, v).catch(() => {});
    } else if (aspect !== "contain") {
      video.classList.add(`aspect-${aspect}`);
    }
  }

  btnAspectRatio.addEventListener("click", (e) => {
    e.stopPropagation();
    app.playbackMenus?.closeAll?.(aspectMenu);
    aspectMenu.classList.toggle("show");
    speedMenu.classList.remove("show");
  });

  document.querySelectorAll("#aspect-menu .dropdown-item[data-aspect]").forEach((item) => {
    item.addEventListener("click", () => {
      const aspect = state.set("currentAspect", item.dataset.aspect);
      applyAspect(aspect);
      aspectLabel.textContent = item.textContent.split(" ")[0];
      document.querySelectorAll("#aspect-menu .dropdown-item[data-aspect]").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      aspectMenu.classList.remove("show");
      app.filters.apply(); // the GPU enhancer follows the forced aspect box
    });
  });

  // Speed selector
  btnSpeed.addEventListener("click", (e) => {
    e.stopPropagation();
    app.playbackMenus?.closeAll?.(speedMenu);
    speedMenu.classList.toggle("show");
    aspectMenu.classList.remove("show");
  });

  document.querySelectorAll("#speed-menu .dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      const spd = parseFloat(item.dataset.speed);
      engine.setRate(spd);
      speedLabel.textContent = `${spd}x`;
      document.querySelectorAll("#speed-menu .dropdown-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      speedMenu.classList.remove("show");
    });
  });

  // Any click elsewhere closes the dropdown menus
  document.addEventListener("click", () => {
    speedMenu.classList.remove("show");
    aspectMenu.classList.remove("show");
    if (subtitlesMenu) subtitlesMenu.classList.remove("show");
    app.playbackMenus?.closeAll?.();
  });

  // Click / double click on the picture (the <video> element, or the transparent surface
  // above the libmpv window), play button
  for (const target of [video, mpvSurface].filter(Boolean)) {
    target.addEventListener("click", togglePlay);
    target.addEventListener("dblclick", () => app.fullscreen.toggle());
  }
  btnPlayPause.addEventListener("click", togglePlay);

  syncEngineUi();

  return {
    load: loadVideoSource,
    adopt: adoptSource,
    unloadElements: unloadVideoElements,
    cancelTranscode: () => app.engines.html5.cancelTranscode(),
    startPlayback: () => engine.play(),
    togglePlay,
    seekBy,
    frameStep,
    syncEngineUi,
    clickPip: () => btnPip.click(),
  };
}
