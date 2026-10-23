// ==========================================================================
// Video player: loading, codec diagnostics, legacy-codec conversion,
// resume position, play/pause state, seeking, speed, aspect ratio, PiP.
// ==========================================================================

import { invoke, listen } from "../core/tauri.js";
import { formatTime } from "../core/format.js";
import { isAudioOnlyName, isRemoteUrl, itemSize } from "./classify.js";

export const MEDIA_ERR_TEXT = {
  1: "Yükleme iptal edildi.",
  2: "Ağ hatası: kaynak indirilemedi.",
  3: "Çözme hatası: dosya bozuk ya da codec (HEVC/AV1) donanımca desteklenmiyor.",
  4: "Format desteklenmiyor (konteyner/codec). MP4 (H.264/AAC) veya WebM (VP9/Opus) önerilir.",
};

export const ASPECT_CLASSES = ["aspect-16-9", "aspect-21-9", "aspect-4-3", "aspect-fill"];

/** localStorage key of the resume position. */
export const resumeKey = (item) =>
  item.url ? "vho_url_" + item.url : `vho_file_${item.name || "Online Video"}_${itemSize(item)}`;

/** Offer to resume only after 8 s and not within the last 15 s. */
export const shouldOfferResume = (savedTime, duration) =>
  savedTime > 8 && Number.isFinite(duration) && savedTime < (duration - 15);

/** Seek target that respects live streams / unknown duration. */
export function clampSeek(current, delta, duration) {
  const t = current + delta;
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, t)) : Math.max(0, t);
}

/**
 * app: { dom, state, bus, toast, flashScreen, triggerRipple, hud, filters, photo, subtitles,
 *        timeline, loader, playlist, audio, sleep }  (resolved lazily)
 */
export function createVideoPlayer(app) {
  const { dom, state } = app;
  const {
    video, thumbVideo, controlsHud, timelineContainer, currentFilename, dropZone, iconPlay, iconPause,
    resumeToast, resumeTimeText, btnResumeYes, btnResumeNo, transcodeOverlay, transcodeText, transcodeBar,
    btnSkipBack, btnSkipFwd, btnPip, btnAspectRatio, aspectMenu, aspectLabel, btnSpeed, speedMenu, speedLabel,
    subtitlesMenu, btnPlayPause,
  } = dom;
  const loadGen = () => state.get("loadGen");

  let resumePendingTime = 0;
  let resumeToastTimer = 0;
  let transcodingPath = null; // file currently being converted by the backend

  /** Releases the video + thumbnail decoders without triggering error handlers. */
  function unloadVideoElements() {
    video.onerror = null;
    video.onloadeddata = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    thumbVideo.removeAttribute("src");
    thumbVideo.load();
    app.timeline.clearThumb();
  }

  // ------------------------------------------------------------------------
  // Legacy codec conversion (MPEG-4 Part 2, H.263, WMV, AVI...) via the backend
  // ------------------------------------------------------------------------
  function showTranscode(text, progress) {
    transcodeOverlay.classList.add("active");
    transcodeText.textContent = text;
    transcodeBar.style.width = `${Math.round(progress * 100)}%`;
  }

  function hideTranscode() {
    transcodeOverlay.classList.remove("active");
  }

  function cancelTranscode() {
    if (!transcodingPath) return;
    transcodingPath = null;
    hideTranscode();
    invoke?.("cancel_transcode").catch(() => {});
  }

  listen("transcode-progress", (e) => {
    if (e.payload.path === transcodingPath) {
      transcodeBar.style.width = `${Math.round(e.payload.progress * 100)}%`;
    }
  });

  function transcodeAndPlay(item, gen, codec) {
    unloadVideoElements();
    transcodingPath = item.path;
    showTranscode(`Eski codec${codec ? ` (${codec})` : ""} uyumlu formata dönüştürülüyor… İlk açılışta bir kez yapılır.`, 0);
    invoke("transcode_media", { path: item.path })
      .then((out) => {
        if (gen !== loadGen()) return;
        transcodingPath = null;
        hideTranscode();
        item.playPath = out;
        playVideoItem(item, gen);
      })
      .catch((err) => {
        if (gen !== loadGen() || err === "cancelled") return;
        transcodingPath = null;
        hideTranscode();
        console.warn("transcode_media", err);
        app.toast(`⚠️ Video dönüştürülemedi: ${err}`);
      });
    return true;
  }

  // ------------------------------------------------------------------------
  // Codec & format diagnostics
  // ------------------------------------------------------------------------
  /** True when audio is advancing but not a single video frame was decoded. */
  function noVideoFramesDecoded() {
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
    const bytes = video.webkitVideoDecodedByteCount;
    return (frames === undefined || frames === 0) && (bytes === undefined || bytes === 0);
  }

  /**
   * onUnsupported(): called when the webview can't show the picture (unsupported
   * codec/container). Returns true if it handled it (e.g. started a conversion).
   */
  function attachVideoDiagnostics(name, gen, { retryWithoutCors, onUnsupported } = {}) {
    const audioOnly = isAudioOnlyName(name);
    let handled = false;
    const unsupported = () => {
      if (handled) return true;
      handled = !!onUnsupported?.();
      return handled;
    };

    video.onerror = () => {
      const code = video.error?.code ?? 0;
      console.warn("MediaError", code, video.error?.message);
      if (retryWithoutCors?.()) return;
      if ((code === 3 || code === 4) && unsupported()) return;
      app.toast(`⚠️ ${MEDIA_ERR_TEXT[code] || "Bilinmeyen medya hatası."}`);
      setPlayState(false);
    };

    video.onloadeddata = () => {
      app.filters.refreshAfterLoad();
      app.bus.emit("media:loaded", { kind: "video" });
      // 1) No picture: unsupported video codec (MPEG-4 Part 2, H.263...) or missing HEVC extension
      if (video.videoWidth === 0 && !audioOnly) {
        if (!unsupported()) {
          app.toast("⚠️ Video akışı çözülemedi (yalnızca ses). HEVC için Microsoft 'HEVC Video Extensions' gerekebilir.");
        }
        return;
      }
      // Some codecs report a frame size yet never produce frames: verify after playback starts
      setTimeout(() => {
        if (gen === loadGen() && !audioOnly && video.currentTime > 0.5 && noVideoFramesDecoded()) {
          if (!unsupported()) app.toast("⚠️ Video karesi çözülemedi; yalnızca ses oynatılıyor.");
        }
      }, 1500);
      // 2) No sound: unsupported audio codec such as AC3/DTS (Chromium-only counters)
      setTimeout(() => {
        if (gen === loadGen() && !video.paused && video.currentTime > 1.5 &&
            "webkitAudioDecodedByteCount" in video &&
            video.webkitAudioDecodedByteCount === 0 &&
            video.webkitVideoDecodedByteCount > 0) {
          app.toast("🔇 Ses izi çözülemedi (AC3/DTS/E-AC3 desteklenmiyor olabilir).");
        }
      }, 2500);
    };
  }

  function startPlayback() {
    video.play().then(() => checkResumePlayback()).catch((err) => {
      if (err.name !== "AbortError") console.warn("play()", err);
      setPlayState(false);
    });
  }

  // ------------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------------
  function loadVideoSource(item) {
    const gen = state.update("loadGen", (g) => g + 1);
    state.set("currentMediaType", "video");
    if (state.get("isSlideshowActive")) app.photo.toggleSlideshow(false, { silent: true });
    app.photo.unload();
    unloadVideoElements();
    app.filters.disable();
    state.set("enhancerBlocked", false);
    app.photo.hideUi();

    video.style.display = "block";
    controlsHud.style.display = "flex";
    timelineContainer.style.display = "flex";

    const name = item.name || "Online Video";
    state.set("currentFileKey", resumeKey(item));

    resumePendingTime = 0;
    clearTimeout(resumeToastTimer);
    resumeToast.classList.remove("show");

    currentFilename.textContent = name;
    dropZone.classList.remove("visible");
    app.subtitles.resetForNewMedia();
    app.timeline.reset();
    app.photo.updateCounter();

    // Local files: ask the backend whether the webview can decode the codecs at all.
    // Legacy codecs (e.g. MPEG-4 Part 2 from old phones) would otherwise play sound only.
    if (item.path && invoke && !item.playPath && !item.probed) {
      invoke("probe_media", { path: item.path })
        .then((info) => {
          if (gen !== loadGen()) return;
          item.probed = true;
          if (info.needsTranscode) transcodeAndPlay(item, gen, info.videoCodec);
          else playVideoItem(item, gen);
        })
        .catch((err) => {
          console.warn("probe_media", err);
          if (gen !== loadGen()) return;
          item.probed = true;
          playVideoItem(item, gen);
        });
      return;
    }
    playVideoItem(item, gen);
  }

  function playVideoItem(item, gen) {
    const name = item.name || "Online Video";
    const src = app.loader.resolveSource(item);

    // Remote media: request CORS so Web Audio / WebGL can read it. If the server
    // refuses, retry once without CORS and run without boost/enhancer.
    // (Local files come from http://asset.localhost, which sends CORS headers.)
    let retryWithoutCors = null;
    state.set("isTaintedSource", false);
    if (isRemoteUrl(src)) {
      video.crossOrigin = "anonymous";
      let retried = false;
      retryWithoutCors = () => {
        if (retried) return false;
        retried = true;
        state.set("isTaintedSource", true);
        video.removeAttribute("crossorigin");
        video.src = src;
        video.load();
        startPlayback();
        if (app.audio.isRouted) {
          app.toast("⚠️ Sunucu CORS izni vermiyor: ses işleme açık olduğundan ses gelmeyebilir. Uygulamayı yeniden başlatıp bu linki ses güçlendirici kullanmadan açın.");
        }
        return true;
      };
    } else {
      video.removeAttribute("crossorigin");
    }

    const canConvert = !!(item.path && invoke && !item.playPath);
    attachVideoDiagnostics(name, gen, {
      retryWithoutCors,
      onUnsupported: () => canConvert && transcodeAndPlay(item, gen),
    });
    video.src = src;
    video.load();
    app.filters.apply();
    startPlayback();
  }

  // ------------------------------------------------------------------------
  // Resume position (localStorage)
  // ------------------------------------------------------------------------
  function checkResumePlayback() {
    const saved = localStorage.getItem(state.get("currentFileKey"));
    if (!saved) return;
    const savedTime = parseFloat(saved);
    if (shouldOfferResume(savedTime, video.duration)) {
      resumePendingTime = savedTime;
      resumeTimeText.textContent = `${formatTime(savedTime)} süresinde kalmıştınız`;
      resumeToast.classList.add("show");
      clearTimeout(resumeToastTimer);
      resumeToastTimer = setTimeout(() => resumeToast.classList.remove("show"), 8000);
    }
  }

  btnResumeYes.addEventListener("click", () => {
    if (resumePendingTime) {
      video.currentTime = resumePendingTime;
      resumePendingTime = 0;
    }
    resumeToast.classList.remove("show");
  });

  btnResumeNo.addEventListener("click", () => {
    localStorage.removeItem(state.get("currentFileKey"));
    resumePendingTime = 0;
    resumeToast.classList.remove("show");
  });

  // Save progress regularly
  setInterval(() => {
    const key = state.get("currentFileKey");
    if (key && state.get("currentMediaType") === "video" && video.currentTime > 5 && !video.paused) {
      localStorage.setItem(key, video.currentTime);
    }
  }, 3000);

  // ------------------------------------------------------------------------
  // Play / pause (UI state follows the media element's own events)
  // ------------------------------------------------------------------------
  function togglePlay() {
    if (state.get("currentMediaType") !== "video" || !video.src || dropZone.classList.contains("visible")) return;
    if (video.paused) {
      video.play().catch((err) => {
        if (err.name !== "AbortError") console.warn("play()", err);
      });
      app.triggerRipple("play");
    } else {
      video.pause();
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

  video.addEventListener("playing", () => setPlayState(true));
  video.addEventListener("pause", () => setPlayState(false));
  video.addEventListener("emptied", () => setPlayState(false));

  // Video end -> sleep timer check or playlist auto advance
  video.addEventListener("ended", () => {
    localStorage.removeItem(state.get("currentFileKey"));
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
    video.currentTime = clampSeek(video.currentTime, delta, video.duration);
  }

  btnSkipBack.addEventListener("click", () => seekBy(-10));
  btnSkipFwd.addEventListener("click", () => seekBy(10));

  // Picture in Picture (PiP)
  btnPip.addEventListener("click", async () => {
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
  btnAspectRatio.addEventListener("click", (e) => {
    e.stopPropagation();
    aspectMenu.classList.toggle("show");
    speedMenu.classList.remove("show");
  });

  document.querySelectorAll("#aspect-menu .dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      const aspect = state.set("currentAspect", item.dataset.aspect);
      video.classList.remove(...ASPECT_CLASSES);
      if (aspect !== "contain") {
        video.classList.add(`aspect-${aspect}`);
      }
      aspectLabel.textContent = item.textContent.split(" ")[0];
      document.querySelectorAll("#aspect-menu .dropdown-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      aspectMenu.classList.remove("show");
      app.filters.apply(); // the GPU enhancer follows the forced aspect box
    });
  });

  // Speed selector
  btnSpeed.addEventListener("click", (e) => {
    e.stopPropagation();
    speedMenu.classList.toggle("show");
    aspectMenu.classList.remove("show");
  });

  document.querySelectorAll("#speed-menu .dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      const spd = parseFloat(item.dataset.speed);
      video.playbackRate = spd;
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
  });

  // Click / double click on the video, play button
  video.addEventListener("click", togglePlay);
  video.addEventListener("dblclick", () => app.fullscreen.toggle());
  btnPlayPause.addEventListener("click", togglePlay);

  return {
    load: loadVideoSource,
    unloadElements: unloadVideoElements,
    cancelTranscode,
    startPlayback,
    togglePlay,
    seekBy,
    clickPip: () => btnPip.click(),
  };
}
