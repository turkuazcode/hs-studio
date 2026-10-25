// ==========================================================================
// HTML5 engine (fallback): the <video> element of the webview, plus the legacy
// codec path (backend probe + Media Foundation transcode to H.264/AAC), codec
// diagnostics and the CORS retry for remote media. Used when libmpv is not
// available and for browser File objects (no filesystem path for libmpv).
// ==========================================================================

import { cssViewTransform } from "./engine.js";
import { isAudioOnlyName, isRemoteUrl } from "../classify.js";
import { t } from "../../core/i18n.js";

/** MediaError code -> message in the current UI language. */
export const MEDIA_ERR_TEXT = {
  get 1() { return t("ui.mediaErr.aborted"); },
  get 2() { return t("ui.mediaErr.network"); },
  get 3() { return t("ui.mediaErr.decode"); },
  get 4() { return t("ui.mediaErr.format"); },
};

/** Assumed frame duration for frame stepping when the stream does not tell (30 fps). */
export const FRAME_STEP_S = 1 / 30;

/**
 * deps: { app, invoke, listen }  — app gives dom, state, toast, filters, loader, audio (lazily)
 */
export function createHtml5Engine({ app, invoke, listen }) {
  const { dom, state } = app;
  const { video, transcodeOverlay, transcodeText, transcodeBar } = dom;
  let emit = () => {};
  let transcodingPath = null; // file currently being converted by the backend
  let loopA = null;
  let loopB = null;
  let loopGen = 0;
  let volume = 100;
  const loadGen = () => state.get("loadGen");

  // ------------------------------------------------------------------------
  // Media element -> engine events
  // ------------------------------------------------------------------------
  video.addEventListener("timeupdate", () => {
    checkLoop();
    emit("time", video.currentTime);
  });
  const onDuration = () => emit("duration", video.duration);
  video.addEventListener("loadedmetadata", onDuration);
  video.addEventListener("durationchange", onDuration);
  video.addEventListener("playing", () => emit("playstate", true));
  video.addEventListener("pause", () => emit("playstate", false));
  video.addEventListener("emptied", () => emit("playstate", false));
  video.addEventListener("ended", () => emit("ended"));
  video.addEventListener("seeked", () => emit("seeked", video.currentTime));
  video.addEventListener("progress", () => {
    if (video.buffered.length > 0) emit("buffer", video.buffered.end(video.buffered.length - 1));
  });
  video.addEventListener("loadedmetadata", () => emit("video", { width: video.videoWidth, height: video.videoHeight }));

  // ------------------------------------------------------------------------
  // A-B loop (timeupdate fires ~4 Hz and overshoots B by up to 250 ms, so a
  // requestVideoFrameCallback chain checks every frame)
  // ------------------------------------------------------------------------
  function checkLoop() {
    if (loopA !== null && loopB !== null && video.currentTime >= loopB) video.currentTime = loopA;
  }

  function armLoop() {
    if (!video.requestVideoFrameCallback || loopB === null) return;
    const gen = ++loopGen;
    const tick = () => {
      if (gen !== loopGen || loopB === null) return;
      checkLoop();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  // ------------------------------------------------------------------------
  // Legacy codec conversion (MPEG-4 Part 2, H.263, WMV, AVI...) via the backend
  // ------------------------------------------------------------------------
  function showTranscode(text, progress) {
    transcodeOverlay.classList.add("active");
    transcodeText.textContent = text;
    transcodeBar.style.width = `${Math.round(progress * 100)}%`;
  }

  const hideTranscode = () => transcodeOverlay.classList.remove("active");

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
    unloadElement();
    transcodingPath = item.path;
    showTranscode(t(codec ? "ui.mediaErr.transcodingCodec" : "ui.mediaErr.transcoding", { codec }), 0);
    invoke("transcode_media", { path: item.path })
      .then((out) => {
        if (gen !== loadGen()) return;
        transcodingPath = null;
        hideTranscode();
        item.playPath = out;
        playItem(item, gen);
      })
      .catch((err) => {
        if (gen !== loadGen() || err === "cancelled") return;
        transcodingPath = null;
        hideTranscode();
        console.warn("transcode_media", err);
        app.toast(t("ui.mediaErr.transcodeFailed", { error: err }));
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

  function attachDiagnostics(name, gen, { retryWithoutCors, onUnsupported } = {}) {
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
      app.toast(`⚠️ ${MEDIA_ERR_TEXT[code] || t("ui.mediaErr.unknown")}`);
      emit("playstate", false);
    };

    video.onloadeddata = () => {
      emit("loaded", { kind: "html5" });
      // 1) No picture: unsupported video codec (MPEG-4 Part 2, H.263...) or missing HEVC extension
      if (video.videoWidth === 0 && !audioOnly) {
        if (!unsupported()) {
          app.toast(t("ui.mediaErr.noVideoHevc"));
        }
        return;
      }
      // Some codecs report a frame size yet never produce frames: verify after playback starts
      setTimeout(() => {
        if (gen === loadGen() && !audioOnly && video.currentTime > 0.5 && noVideoFramesDecoded()) {
          if (!unsupported()) app.toast(t("ui.mediaErr.noVideoFrame"));
        }
      }, 1500);
      // 2) No sound: unsupported audio codec such as AC3/DTS (Chromium-only counters)
      setTimeout(() => {
        if (gen === loadGen() && !video.paused && video.currentTime > 1.5 &&
            "webkitAudioDecodedByteCount" in video &&
            video.webkitAudioDecodedByteCount === 0 &&
            video.webkitVideoDecodedByteCount > 0) {
          app.toast(t("ui.mediaErr.noAudio"));
        }
      }, 2500);
    };
  }

  function startPlayback() {
    return video.play().catch((err) => {
      if (err.name !== "AbortError") console.warn("play()", err);
      emit("playstate", false);
    });
  }

  function playItem(item, gen) {
    const name = item.name || t("ui.video.onlineName");
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
          app.toast(t("ui.mediaErr.corsAudio"));

        }
        return true;
      };
    } else {
      video.removeAttribute("crossorigin");
    }

    const canConvert = !!(item.path && invoke && !item.playPath);
    attachDiagnostics(name, gen, {
      retryWithoutCors,
      onUnsupported: () => canConvert && transcodeAndPlay(item, gen),
    });
    video.src = src;
    video.load();
    app.filters.apply();
    startPlayback();
  }

  /** Releases the decoder without triggering error handlers. */
  function unloadElement() {
    video.onerror = null;
    video.onloadeddata = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  const engine = {
    kind: "html5",
    caps: {
      pip: true, tracks: false, chapters: false, audioDelay: false, eq: false, nativeSubs: false,
      screenshotFile: false, gamma: false, hue: false, hwdec: false, frameBack: true,
    },
    attach(fn) { emit = fn; },
    activate() { video.style.display = "block"; },
    deactivate() {
      cancelTranscode();
      unloadElement();
      video.style.display = "none";
    },
    /**
     * ctx.gen: the load generation (async probe/transcode of older loads is ignored).
     * Local files: ask the backend whether the webview can decode the codecs at all;
     * legacy codecs would otherwise play sound only.
     */
    load(item, { gen = loadGen() } = {}) {
      cancelTranscode();
      unloadElement();
      engine.setLoop(null, null);
      video.style.display = "block";
      if (item.path && invoke && !item.playPath && !item.probed) {
        return invoke("probe_media", { path: item.path })
          .then((info) => {
            if (gen !== loadGen()) return;
            item.probed = true;
            if (info.needsTranscode) transcodeAndPlay(item, gen, info.videoCodec);
            else playItem(item, gen);
          })
          .catch((err) => {
            console.warn("probe_media", err);
            if (gen !== loadGen()) return;
            item.probed = true;
            playItem(item, gen);
          });
      }
      playItem(item, gen);
      return Promise.resolve();
    },
    unload() {
      cancelTranscode();
      unloadElement();
    },
    play: startPlayback,
    pause() { video.pause(); },
    toggle() { return video.paused ? startPlayback() : video.pause(); },
    seek(t, mode = "absolute") {
      const target = mode === "absolute" ? t : video.currentTime + t;
      const d = video.duration;
      video.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(d, target)) : Math.max(0, target);
    },
    stop() { video.pause(); },
    /** 0..200: element volume up to 100 %, the Web Audio booster above. */
    setVolume(v) {
      volume = Math.max(0, Math.min(200, v));
      video.volume = Math.min(volume, 100) / 100;
      app.audio.applyGain(volume);
    },
    setRate(r) { video.playbackRate = r; },
    setLoop(a, b) {
      loopA = a ?? null;
      loopB = b ?? null;
      loopGen++;
      if (loopA !== null && loopB !== null) {
        video.currentTime = loopA;
        armLoop();
      }
    },
    frameStep(dir) {
      video.pause();
      engine.seek(dir < 0 ? -FRAME_STEP_S : FRAME_STEP_S, "relative");
    },
    tracks: () => ({ audio: [], sub: [], video: [] }),
    selectTrack: () => Promise.resolve(),
    addSubtitle: () => Promise.reject(new Error("html5 engine: subtitles are rendered by the app")),
    chapters: () => [],
    setChapter() {},
    /** PNG of the current frame as displayed (CSS colour filter applied). */
    screenshot() {
      return new Promise((resolve, reject) => {
        if (!video.videoWidth || !video.videoHeight) return reject(new Error("no frame"));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (video.style.filter) ctx.filter = video.style.filter;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          canvas.toBlob((blob) => resolve({ blob }), "image/png");
        } catch (e) {
          reject(e); // CORS-tainted remote source
        }
      });
    },
    setPicture() {}, // CSS filters / GPU enhancer: media/visual-filters.js
    setAudioFilters: () => Promise.resolve(),
    setView(v) { video.style.transform = cssViewTransform(v); },
    set: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    cancelTranscode,
    get element() { return video; },
    get time() { return video.currentTime; },
    get duration() { return video.duration; },
    get paused() { return video.paused; },
    get ended() { return video.ended; },
    get volume() { return volume; },
    get rate() { return video.playbackRate; },
    get previewSrc() { return video.currentSrc; },
    destroy() {},
  };
  return engine;
}
