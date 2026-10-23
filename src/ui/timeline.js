// ==========================================================================
// Timeline: progress / buffer bars, time labels, YouTube-style live thumbnail
// preview on hover, click-to-seek and the frame-accurate A-B loop.
// ==========================================================================

import { formatTime } from "../core/format.js";

export const THUMB_THROTTLE_MS = 100;

/** Pointer x -> position in [0, 1] on a bar. */
export const pointerFraction = (clientX, rect) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

/** Percentage of t within duration (CSS width / left). */
export const percentOf = (t, duration) => `${(t / duration) * 100}%`;

/**
 * app: { dom, state, bus }
 */
export function createTimeline(app) {
  const { dom } = app;
  const {
    video, thumbVideo, thumbCtx, timelineThumbCanvas, timelineContainer, timelineProgress, timelineBuffer,
    timelineTooltip, timelineTooltipTime, timeCurrent, timeTotal, abMarkerA, abMarkerB, abRange, btnAbLoop,
    abLoopLabel,
  } = dom;

  let isSeeking = false; // kept from the original controller (never set: clicks seek directly)
  let loopPointA = null;
  let loopPointB = null;
  let abLoopGen = 0;
  let lastThumbSeek = 0;
  let thumbPendingTime = null;

  const hasDuration = () => Number.isFinite(video.duration) && !!video.duration;

  // ------------------------------------------------------------------------
  // A-B loop (timeupdate only fires ~4 Hz and overshoots B by up to 250 ms,
  // so a requestVideoFrameCallback chain checks every frame)
  // ------------------------------------------------------------------------
  function checkAbLoop() {
    if (loopPointA !== null && loopPointB !== null && video.currentTime >= loopPointB) {
      video.currentTime = loopPointA;
    }
  }

  function armAbLoop() {
    if (!video.requestVideoFrameCallback || loopPointB === null) return;
    const gen = ++abLoopGen;
    const tick = () => {
      if (gen !== abLoopGen || loopPointB === null) return;
      checkAbLoop();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  function clearAbLoop() {
    loopPointA = null;
    loopPointB = null;
    abLoopGen++;
    abMarkerA.style.display = "none";
    abMarkerB.style.display = "none";
    abRange.style.display = "none";
    abLoopLabel.textContent = "A-B Döngü";
    btnAbLoop.classList.remove("active");
  }

  btnAbLoop.addEventListener("click", () => {
    if (!hasDuration()) return;
    if (loopPointA === null) {
      loopPointA = video.currentTime;
      abMarkerA.style.left = percentOf(loopPointA, video.duration);
      abMarkerA.style.display = "block";
      abLoopLabel.textContent = "A: " + formatTime(loopPointA) + " -> B?";
      btnAbLoop.classList.add("active");
    } else if (loopPointB === null) {
      if (video.currentTime <= loopPointA) return;
      loopPointB = video.currentTime;
      abMarkerB.style.left = percentOf(loopPointB, video.duration);
      abMarkerB.style.display = "block";

      abRange.style.left = percentOf(loopPointA, video.duration);
      abRange.style.width = percentOf(loopPointB - loopPointA, video.duration);
      abRange.style.display = "block";

      abLoopLabel.textContent = "A-B Döngüde";
      video.currentTime = loopPointA;
      armAbLoop();
    } else {
      clearAbLoop();
    }
  });

  // ------------------------------------------------------------------------
  // Time & progress
  // ------------------------------------------------------------------------
  video.addEventListener("timeupdate", () => {
    checkAbLoop();
    if (!isSeeking) {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        timelineProgress.style.width = percentOf(video.currentTime, video.duration);
      }
      timeCurrent.textContent = formatTime(video.currentTime);
    }
    app.bus.emit("media:time", { time: video.currentTime });
  });

  video.addEventListener("loadedmetadata", () => {
    timeTotal.textContent = formatTime(video.duration);
    timeCurrent.textContent = formatTime(video.currentTime);
  });

  video.addEventListener("progress", () => {
    if (video.buffered.length > 0 && Number.isFinite(video.duration) && video.duration > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      timelineBuffer.style.width = percentOf(bufferedEnd, video.duration);
    }
  });

  // ------------------------------------------------------------------------
  // Live thumbnail preview on hover (one seek in flight at a time)
  // ------------------------------------------------------------------------
  function requestThumb(t) {
    if (thumbVideo.seeking) {
      thumbPendingTime = t;
      return;
    }
    if (typeof thumbVideo.fastSeek === "function") thumbVideo.fastSeek(t);
    else thumbVideo.currentTime = t;
  }

  thumbVideo.addEventListener("seeked", () => {
    if (thumbVideo.videoWidth) {
      thumbCtx.drawImage(thumbVideo, 0, 0, timelineThumbCanvas.width, timelineThumbCanvas.height);
    }
    if (thumbPendingTime !== null) {
      const t = thumbPendingTime;
      thumbPendingTime = null;
      requestThumb(t);
    }
  });

  timelineContainer.addEventListener("mousemove", (e) => {
    if (!hasDuration()) return;
    const pos = pointerFraction(e.clientX, timelineContainer.getBoundingClientRect());
    const targetTime = pos * video.duration;
    timelineTooltipTime.textContent = formatTime(targetTime);
    timelineTooltip.style.left = `${pos * 100}%`;

    // Throttle thumbnail seeking to every 100ms
    const now = Date.now();
    if (now - lastThumbSeek > THUMB_THROTTLE_MS) {
      lastThumbSeek = now;
      if (video.currentSrc && thumbVideo.src !== video.currentSrc) {
        thumbVideo.src = video.currentSrc;
      }
      try {
        requestThumb(targetTime);
      } catch (_) {}
    }
  });

  timelineContainer.addEventListener("click", (e) => {
    if (!hasDuration()) return;
    const pos = pointerFraction(e.clientX, timelineContainer.getBoundingClientRect());
    video.currentTime = pos * video.duration;
    timelineProgress.style.width = `${pos * 100}%`;
  });

  return {
    /** New video: no loop, empty bars, zero times. */
    reset() {
      clearAbLoop();
      timelineProgress.style.width = "0%";
      timelineBuffer.style.width = "0%";
      timeCurrent.textContent = timeTotal.textContent = "00:00";
    },
    /** Video unloaded: drop the pending preview seek and the stale preview frame. */
    clearThumb() {
      thumbPendingTime = null;
      thumbCtx.clearRect(0, 0, timelineThumbCanvas.width, timelineThumbCanvas.height);
    },
    clearAbLoop,
    get loop() { return { a: loopPointA, b: loopPointB }; },
  };
}
