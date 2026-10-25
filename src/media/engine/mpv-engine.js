// ==========================================================================
// libmpv engine: Tauri commands (engine_*) + events (engine://property, engine://event).
// The video is drawn by mpv into a native popup behind the transparent window (ADR 0001);
// this module only keeps a mirror of mpv's state and maps it to the facade's events.
// ==========================================================================

import { normalizeChapters, normalizeTracks, flipFilter } from "./engine.js";

/**
 * deps: { invoke, listen, convertFileSrc, status } — status = engine_status() result.
 */
export function createMpvEngine({ invoke, listen, convertFileSrc, status }) {
  let emit = () => {};
  let active = false;
  // Mirror of mpv state
  let time = 0;
  let duration = NaN;
  let paused = true;
  let ended = false;
  let volume = 100;
  let rate = 1;
  let trackList = { audio: [], sub: [], video: [] };
  let chapterList = [];
  let previewSrc = "";
  let loading = false; // between loadfile and file-loaded: ignore stale props of the old file
  let loadedFile = false;
  let view = {};

  // Tauri runs async commands concurrently: queue property writes and commands so mpv applies
  // them in the order the UI issued them (e.g. three slider changes, setLoop then seek).
  let queue = Promise.resolve();
  const ordered = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const cmd = (args) => ordered(() => invoke("engine_command", { args }));
  const set = (name, value) => ordered(() => invoke("engine_set", { name, value }));
  const get = (name) => invoke("engine_get", { name });
  const quiet = (p) => p.catch((e) => console.warn("[mpv]", e));

  function onProperty({ name, value }) {
    switch (name) {
      case "time-pos":
        if (loading || value === null || value === undefined) return;
        time = value;
        emit("time", time);
        break;
      case "duration":
        if (loading) return;
        duration = value ?? NaN;
        emit("duration", duration);
        break;
      case "pause":
        paused = !!value;
        emit("playstate", !paused && loadedFile);
        break;
      case "eof-reached":
        if (loading || !loadedFile) return;
        if (value && !ended) {
          ended = true;
          emit("ended");
        } else if (!value) {
          ended = false;
        }
        break;
      case "track-list":
        trackList = normalizeTracks(value);
        emit("tracks", trackList);
        break;
      case "chapter-list":
        chapterList = normalizeChapters(value);
        emit("chapters", chapterList);
        break;
      case "chapter":
        emit("chapter", value ?? -1);
        break;
      case "volume":
        // above 100 % mpv stays at 100 and the boost lives in the af chain (limiter)
        if (typeof value === "number" && !(volume > 100 && value === 100)) volume = value;
        emit("volume", volume);
        break;
      case "speed":
        if (typeof value === "number") rate = value;
        emit("speed", rate);
        break;
      case "demuxer-cache-time":
        if (typeof value === "number") emit("buffer", value);
        break;
      case "video-params":
        if (value) emit("video", { width: value.dw ?? value.w, height: value.dh ?? value.h, params: value });
        break;
      default:
        emit(name, value);
    }
  }

  function onEvent(ev) {
    switch (ev.event) {
      case "file-loaded":
        loading = false;
        loadedFile = true;
        ended = false;
        // re-read the values that changed while stale events were ignored
        // "loaded" after the duration is known (resume offer, recent files)
        get("duration")
          .then((d) => { duration = d ?? NaN; emit("duration", duration); })
          .catch(() => {})
          .finally(() => {
            emit("loaded", { kind: "mpv" });
            emit("playstate", !paused);
          });
        break;
      case "end-file":
        if (ev.reason === "error") {
          loading = false;
          emit("error", ev.file_error || "dosya açılamadı");
        }
        break;
      case "playback-restart":
        emit("seeked", time);
        break;
      default:
        break;
    }
  }

  listen("engine://property", (e) => onProperty(e.payload));
  listen("engine://event", (e) => onEvent(e.payload));

  // A page reload (dev tools / tests) must not leave the previous file playing behind the UI
  quiet(cmd(["stop"]));
  quiet(invoke("engine_show", { visible: false }));
  // mirror the state mpv already has (the observers only report changes)
  get("pause").then((v) => { paused = !!v; }).catch(() => {});
  get("volume").then((v) => { if (typeof v === "number") volume = v; }).catch(() => {});
  get("speed").then((v) => { if (typeof v === "number") rate = v; }).catch(() => {});

  const engine = {
    kind: "mpv",
    caps: {
      pip: false, tracks: true, chapters: true, audioDelay: true, eq: true, nativeSubs: true,
      screenshotFile: true, gamma: true, hue: true, hwdec: true, frameBack: true,
    },
    status,
    attach(fn) { emit = fn; },
    activate() { active = true; },
    deactivate() {
      active = false;
      loadedFile = false;
      quiet(cmd(["stop"]));
      return quiet(invoke("engine_show", { visible: false }));
    },
    /** Shows / hides the video surface without unloading (photos keep mpv idle anyway). */
    show(visible) { return quiet(invoke("engine_show", { visible })); },
    get active() { return active; },

    async load(item, { start } = {}) {
      loading = true;
      loadedFile = false;
      ended = false;
      time = 0;
      duration = NaN;
      trackList = { audio: [], sub: [], video: [] };
      chapterList = [];
      emit("tracks", trackList);
      emit("chapters", chapterList);
      previewSrc = item.path ? convertFileSrc(item.path) : item.url ?? "";
      active = true;
      await engine.show(true);
      // no property event arrives when mpv was already unpaused (e.g. after a page reload)
      await set("pause", false).then(() => { paused = false; }).catch(() => {});
      try {
        await ordered(() => invoke("engine_load", { path: item.path ?? item.url, start: start ?? null }));
      } catch (e) {
        loading = false;
        emit("error", String(e));
        throw e;
      }
    },
    play() {
      if (ended) return quiet(cmd(["seek", 0, "absolute"]).then(() => set("pause", false)));
      return quiet(set("pause", false));
    },
    pause() {
      paused = true;
      return quiet(set("pause", true));
    },
    toggle() { return paused ? engine.play() : engine.pause(); },
    seek(t, mode = "absolute") {
      if (mode === "absolute") {
        time = Math.max(0, Math.min(Number.isFinite(duration) ? duration : t, t));
        emit("time", time);
        return quiet(cmd(["seek", time, "absolute+exact"]));
      }
      return quiet(cmd(["seek", t, "relative+exact"]));
    },
    stop() {
      loadedFile = false;
      return quiet(cmd(["stop"]));
    },
    /** Photo shown / playlist cleared: stop and hide the video surface. */
    unload() {
      loadedFile = false;
      quiet(cmd(["stop"]));
      return engine.show(false);
    },
    /** 0-200: mpv's volume is capped at 100 (its curve is cubic: 200 = 8x, clipping); the part
     *  above 100 is applied as a linear gain + limiter in the af chain (audioFilterChain boost). */
    setVolume(v) {
      volume = Math.max(0, Math.min(200, v));
      return quiet(set("volume", Math.min(volume, 100)));
    },
    setRate(r) {
      rate = r;
      return quiet(set("speed", r));
    },
    /** A-B loop natively in mpv (frame accurate). */
    setLoop(a, b) {
      return quiet(Promise.all([
        set("ab-loop-a", a === null || a === undefined ? "no" : a),
        set("ab-loop-b", b === null || b === undefined ? "no" : b),
      ]));
    },
    frameStep(dir) { return quiet(cmd([dir < 0 ? "frame-back-step" : "frame-step"])); },
    tracks: () => trackList,
    selectTrack(type, id) {
      const prop = { audio: "aid", sub: "sid", video: "vid" }[type];
      return set(prop, id === null || id === undefined || id === "no" ? "no" : id);
    },
    /** External subtitle file (SRT/VTT/ASS...) rendered by mpv/libass; selected at once. */
    addSubtitle(path) { return cmd(["sub-add", path, "select"]); },
    chapters: () => chapterList,
    setChapter(i) { return quiet(set("chapter", i)); },
    /** Saves a PNG via mpv (incl. subtitles) and returns { path }. */
    async screenshot(stem) {
      const path = await invoke("engine_screenshot", { stem, withSubs: true });
      return { path };
    },
    setPicture(p) {
      return quiet(Promise.all(Object.entries(p).map(([k, v]) => set(k, v))));
    },
    setAudioFilters(chain) { return set("af", chain); },
    setView(v) {
      const prev = view;
      view = { ...v };
      const jobs = [
        set("video-rotate", ((v.rotate % 360) + 360) % 360),
        set("video-zoom", v.zoom),
        set("video-pan-x", v.panX),
        set("video-pan-y", v.panY),
      ];
      if (flipFilter(prev) !== flipFilter(v)) jobs.push(set("vf", flipFilter(v)));
      return quiet(Promise.all(jobs));
    },
    set,
    get,
    command: cmd,
    get time() { return time; },
    get duration() { return duration; },
    get paused() { return paused; },
    get ended() { return ended; },
    get volume() { return volume; },
    get rate() { return rate; },
    get previewSrc() { return previewSrc; },
    destroy() {},
  };
  return engine;
}
