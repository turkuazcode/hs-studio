// ==========================================================================
// Timeline: progress / buffer bars, time labels, YouTube-style live thumbnail
// preview on hover, click-to-seek, A-B loop (frame accurate in both engines),
// chapter and bookmark markers. Talks only to the engine facade.
// ==========================================================================

import { formatTime } from "../core/format.js";

export const THUMB_THROTTLE_MS = 100;

/** Pointer x -> position in [0, 1] on a bar. */
export const pointerFraction = (clientX, rect) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

/** Percentage of t within duration (CSS width / left). */
export const percentOf = (t, duration) => `${(t / duration) * 100}%`;

/**
 * app: { dom, state, bus, engine }
 */
export function createTimeline(app) {
  const { dom, engine } = app;
  const {
    thumbVideo, thumbCtx, timelineThumbCanvas, timelineContainer, timelineProgress, timelineBuffer,
    timelineTooltip, timelineTooltipTime, timeCurrent, timeTotal, abMarkerA, abMarkerB, abRange, btnAbLoop,
    abLoopLabel, timelineTrack,
  } = dom;

  let loopPointA = null;
  let loopPointB = null;
  let lastThumbSeek = 0;
  let thumbPendingTime = null;
  const markers = { chapter: [], bookmark: [] }; // kind -> [{ time, title }]

  const hasDuration = () => engine.hasDuration();

  // ------------------------------------------------------------------------
  // A-B loop: the engine loops itself (mpv ab-loop-a/b, <video> frame callbacks)
  // ------------------------------------------------------------------------
  function clearAbLoop() {
    const had = loopPointA !== null;
    loopPointA = null;
    loopPointB = null;
    if (had) engine.setLoop(null, null);
    abMarkerA.style.display = "none";
    abMarkerB.style.display = "none";
    abRange.style.display = "none";
    abLoopLabel.textContent = "A-B Döngü";
    btnAbLoop.classList.remove("active");
  }

  btnAbLoop.addEventListener("click", () => {
    if (!hasDuration()) return;
    const d = engine.duration;
    const t = engine.time;
    if (loopPointA === null) {
      loopPointA = t;
      abMarkerA.style.left = percentOf(loopPointA, d);
      abMarkerA.style.display = "block";
      abLoopLabel.textContent = "A: " + formatTime(loopPointA) + " -> B?";
      btnAbLoop.classList.add("active");
    } else if (loopPointB === null) {
      if (t <= loopPointA) return;
      loopPointB = t;
      abMarkerB.style.left = percentOf(loopPointB, d);
      abMarkerB.style.display = "block";

      abRange.style.left = percentOf(loopPointA, d);
      abRange.style.width = percentOf(loopPointB - loopPointA, d);
      abRange.style.display = "block";

      abLoopLabel.textContent = "A-B Döngüde";
      engine.setLoop(loopPointA, loopPointB); // also jumps back to A
      engine.seek(loopPointA);
    } else {
      clearAbLoop();
    }
  });

  // ------------------------------------------------------------------------
  // Time & progress
  // ------------------------------------------------------------------------
  function showTime(t) {
    const d = engine.duration;
    if (Number.isFinite(d) && d > 0) timelineProgress.style.width = percentOf(Math.min(t, d), d);
    timeCurrent.textContent = formatTime(t);
  }

  engine.on("time", (t) => {
    showTime(t);
    app.bus.emit("media:time", { time: t });
  });

  engine.on("duration", (d) => {
    timeTotal.textContent = formatTime(d);
    timeCurrent.textContent = formatTime(engine.time);
    renderMarkers();
  });

  engine.on("buffer", (end) => {
    const d = engine.duration;
    if (Number.isFinite(d) && d > 0) timelineBuffer.style.width = percentOf(Math.min(end, d), d);
  });

  // ------------------------------------------------------------------------
  // Chapter / bookmark markers
  // ------------------------------------------------------------------------
  function renderMarkers() {
    timelineTrack.querySelectorAll(".timeline-marker").forEach((m) => m.remove());
    const d = engine.duration;
    if (!(Number.isFinite(d) && d > 0)) return;
    for (const [kind, list] of Object.entries(markers)) {
      for (const m of list) {
        if (kind === "chapter" && m.time <= 0.05) continue; // the first chapter starts at 0
        const el = document.createElement("div");
        el.className = `timeline-marker ${kind}-marker`;
        el.style.left = percentOf(m.time, d);
        el.title = `${m.title} (${formatTime(m.time)})`;
        timelineTrack.append(el);
      }
    }
  }

  function setMarkers(kind, list) {
    markers[kind] = list.map((m) => ({ time: m.time, title: m.title ?? m.label ?? "" }));
    renderMarkers();
  }

  // ------------------------------------------------------------------------
  // Live thumbnail preview on hover (one seek in flight at a time).
  // libmpv: the preview still decodes in the webview when it can (MP4/WebM);
  // other containers simply show no picture, only the time.
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
  thumbVideo.addEventListener("error", () => {
    thumbCtx.clearRect(0, 0, timelineThumbCanvas.width, timelineThumbCanvas.height);
  });

  timelineContainer.addEventListener("mousemove", (e) => {
    if (!hasDuration()) return;
    const pos = pointerFraction(e.clientX, timelineContainer.getBoundingClientRect());
    const targetTime = pos * engine.duration;
    timelineTooltipTime.textContent = formatTime(targetTime);
    timelineTooltip.style.left = `${pos * 100}%`;

    // Throttle thumbnail seeking to every 100ms
    const now = Date.now();
    if (now - lastThumbSeek > THUMB_THROTTLE_MS) {
      lastThumbSeek = now;
      const src = engine.previewSrc;
      if (src && thumbVideo.src !== src) {
        thumbVideo.src = src;
      }
      try {
        if (src) requestThumb(targetTime);
      } catch (_) {}
    }
  });

  timelineContainer.addEventListener("click", (e) => {
    if (!hasDuration()) return;
    const pos = pointerFraction(e.clientX, timelineContainer.getBoundingClientRect());
    engine.seek(pos * engine.duration);
    timelineProgress.style.width = `${pos * 100}%`;
  });

  return {
    /** New video: no loop, empty bars, zero times, no markers. */
    reset() {
      clearAbLoop();
      markers.chapter = [];
      markers.bookmark = [];
      renderMarkers();
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
    setMarkers,
    get loop() { return { a: loopPointA, b: loopPointB }; },
  };
}
