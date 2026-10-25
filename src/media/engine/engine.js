// ==========================================================================
// Playback engine facade (Plan 02 §2, ADR 0001).
//
// The UI (video player, timeline, HUD, A-B loop, resume, sleep timer, subtitles,
// snapshot, playlist) talks ONLY to this facade. Behind it sits one of two engines:
//   - mpv-engine.js    libmpv through Tauri commands/events (primary)
//   - html5-engine.js  the <video> element (+ Media Foundation transcode) (fallback)
// The facade picks the engine per item (libmpv needs a real path or URL; a browser
// File object can only play in <video>) and forwards events only from the active one.
//
// Contract of an engine implementation (both engines, the unit-tested fake too):
//   kind, caps, attach(emit), activate(), deactivate(),
//   load(item, ctx) -> Promise, unload(), play(), pause(), toggle(), seek(t, mode), stop(),
//   setVolume(0..200), setRate(r), setLoop(a, b), frameStep(dir),
//   tracks() -> {audio, sub, video}, selectTrack(type, id), addSubtitle(path),
//   chapters() -> [{index, time, title}], setChapter(i), screenshot(stem) -> Promise,
//   setPicture(p), setAudioFilters(chain), setView(v), set(name, value), get(name),
//   getters: time, duration, paused, ended, volume, rate, previewSrc
// Events: loaded, time, duration, playstate, ended, error, tracks, chapters,
//         chapter, buffer, seeked, video, volume, speed
// ==========================================================================

import { isAudioOnlyName } from "../classify.js";

export const ENGINE_EVENTS = Object.freeze([
  "loaded", "time", "duration", "playstate", "ended", "error", "tracks", "chapters",
  "chapter", "buffer", "seeked", "video", "volume", "speed",
]);

/** Methods every engine implements (checked by the facade and the contract tests). */
export const ENGINE_METHODS = Object.freeze([
  "attach", "activate", "deactivate", "load", "unload", "play", "pause", "toggle", "seek", "stop",
  "setVolume", "setRate", "setLoop", "frameStep", "tracks", "selectTrack", "addSubtitle",
  "chapters", "setChapter", "screenshot", "setPicture", "setAudioFilters", "setView", "set", "get",
]);

// --------------------------------------------------------------------------
// Pure helpers (unit tested)
// --------------------------------------------------------------------------

const LANG_NAMES = {
  tur: "Türkçe", tr: "Türkçe", eng: "English", en: "English", deu: "Deutsch", ger: "Deutsch", de: "Deutsch",
  fra: "Français", fre: "Français", fr: "Français", spa: "Español", es: "Español", ita: "Italiano", it: "Italiano",
  rus: "Русский", ru: "Русский", jpn: "日本語", ja: "日本語", ara: "العربية", ar: "العربية",
};

/** "tur" -> "Türkçe"; unknown codes are upper-cased; "" for none. */
export const languageName = (code) => (code ? LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase() : "");

/** mpv track-list -> { audio, sub, video } with normalized entries. */
export function normalizeTracks(list) {
  const out = { audio: [], sub: [], video: [] };
  for (const t of Array.isArray(list) ? list : []) {
    if (!out[t.type]) continue;
    out[t.type].push({
      id: t.id,
      type: t.type,
      lang: t.lang ?? "",
      title: t.title ?? "",
      codec: t.codec ?? "",
      selected: !!t.selected,
      external: !!t.external,
      default: !!t.default,
      channels: t["demux-channel-count"] ?? null,
      label: trackLabel(t),
    });
  }
  return out;
}

/** Menu text: title, else language name, else "Kanal <id>"; codec/language appended. */
export function trackLabel(t) {
  const name = t.title || languageName(t.lang) || `Kanal ${t.id}`;
  const extra = [t.title && t.lang ? t.lang : "", t.codec ? String(t.codec).toUpperCase() : "", t.external ? "harici" : ""]
    .filter(Boolean).join(", ");
  return extra ? `${name} (${extra})` : name;
}

/** mpv chapter-list -> [{ index, time, title }] (titles default to "Bölüm n"). */
export function normalizeChapters(list) {
  return (Array.isArray(list) ? list : [])
    .map((c, index) => ({ index, time: Number(c.time) || 0, title: c.title || `Bölüm ${index + 1}` }))
    .sort((a, b) => a.time - b.time);
}

/** Index of the chapter playing at t (-1 before the first one). */
export function chapterAt(chapters, t) {
  let idx = -1;
  for (const c of chapters) if (t + 0.001 >= c.time) idx = c.index;
  return idx;
}

/** ISO centre frequencies of the 10-band equalizer (Hz). */
export const EQ_BANDS = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

export const EQ_PRESETS = Object.freeze({
  flat:      { label: "Düz",            gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass:      { label: "Bas Güçlendir",  gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble:    { label: "Tiz Güçlendir",  gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  vocal:     { label: "Konuşma/Vokal",  gains: [-3, -2, -1, 0, 2, 4, 4, 3, 1, 0] },
  rock:      { label: "Rock",           gains: [5, 4, 2, 0, -1, -1, 1, 3, 4, 5] },
  pop:       { label: "Pop",            gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  classical: { label: "Klasik",         gains: [3, 2, 1, 0, 0, 0, -1, 1, 2, 3] },
  cinema:    { label: "Sinema",         gains: [4, 3, 1, 0, -1, 0, 1, 2, 3, 2] },
  night:     { label: "Gece (yumuşak)", gains: [-4, -3, -1, 0, 1, 2, 2, 0, -2, -3] },
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Peak limit of the booster/limiter stage: -1 dBFS (0.891 linear), both engines. */
export const LIMITER_CEILING = 0.891;

/** Limiter stage of the libmpv chain (lavfi alimiter, LGPL libavfilter; auto-level off). */
export const LAVFI_LIMITER = `alimiter=limit=${LIMITER_CEILING}:attack=5:release=50:level=0`;

/**
 * libavfilter chain for mpv's `af` property ("" = no filters).
 * eq: 10 gains in dB; normalize: dynamic loudness normalisation;
 * restore: the audio filter switches { denoise, voice, compressor } mapped to lavfi filters
 * (plain DSP, not a neural network);
 * boost: linear gain above 100 % volume (mpv's own volume stays <= 100 because its curve is
 * cubic: 200 % would be 8x and clip). Whenever a stage can raise the level (boost, a positive
 * EQ band, the +5.5 dB voice band) a limiter ends the chain so the output never hard-clips.
 */
export function audioFilterChain({ eq = [], normalize = false, restore = null, boost = 1 } = {}) {
  const parts = [];
  let raises = false;
  if (restore?.denoise) parts.push("highpass=f=90", "lowpass=f=7500");
  if (restore?.voice) {
    parts.push("equalizer=f=2400:t=q:w=1.1:g=5.5");
    raises = true;
  }
  EQ_BANDS.forEach((f, i) => {
    const g = clamp(Math.round((Number(eq[i]) || 0) * 10) / 10, -12, 12);
    if (g !== 0) parts.push(`equalizer=f=${f}:t=o:w=1:g=${g}`);
    if (g > 0) raises = true;
  });
  if (restore?.compressor) parts.push("acompressor=threshold=0.063:ratio=4:attack=3:release=250:knee=4");
  if (normalize) parts.push("dynaudnorm=f=250:g=15:p=0.9");
  const gain = clamp(Number(boost) || 1, 1, 4);
  if (gain > 1) {
    parts.push(`volume=${gain.toFixed(3)}`);
    raises = true;
  }
  if (raises) parts.push(LAVFI_LIMITER);
  return parts.length ? `lavfi=[${parts.join(",")}]` : "";
}

/**
 * Effects-panel sliders -> mpv picture properties (-100..100).
 * brightness/contrast/saturate are percentages (100 = neutral) like the CSS path.
 */
export function pictureProps({ brightness = 100, contrast = 100, saturate = 100, gamma = 0, hue = 0, contrastBoost = 0 }) {
  return {
    brightness: clamp(Math.round(brightness - 100), -100, 100),
    contrast: clamp(Math.round(contrast + contrastBoost - 100), -100, 100),
    saturation: clamp(Math.round(saturate - 100), -100, 100),
    gamma: clamp(Math.round(gamma), -100, 100),
    hue: clamp(Math.round(hue), -100, 100),
  };
}

/** Aspect menu value -> mpv properties. */
export function aspectProps(aspect) {
  const map = { "16-9": "16:9", "21-9": "2.33:1", "4-3": "4:3" };
  return {
    "video-aspect-override": map[aspect] ?? "no",
    keepaspect: aspect !== "fill",
  };
}

/** Default view (rotation, flips, zoom/pan). */
export const DEFAULT_VIEW = Object.freeze({ rotate: 0, hflip: false, vflip: false, zoom: 0, panX: 0, panY: 0 });

/** mpv `vf` value for the flip switches ("" = none). */
export const flipFilter = ({ hflip, vflip }) => [hflip && "hflip", vflip && "vflip"].filter(Boolean).join(",");

/** Ctrl+wheel: zoom (log2 units like mpv's video-zoom) changes by `step` per notch, 0..3. */
export const nextZoom = (zoom, deltaY, step = 0.1) => clamp(Math.round((zoom + (deltaY < 0 ? step : -step)) * 100) / 100, 0, 3);

/** CSS transform equivalent of a view (HTML5 engine). */
export function cssViewTransform({ rotate = 0, hflip, vflip, zoom = 0, panX = 0, panY = 0 }) {
  const s = 2 ** zoom;
  const parts = [];
  if (panX || panY) parts.push(`translate(${(panX * 100).toFixed(2)}%, ${(panY * 100).toFixed(2)}%)`);
  if (s !== 1) parts.push(`scale(${s.toFixed(3)})`);
  if (rotate) parts.push(`rotate(${rotate}deg)`);
  if (hflip || vflip) parts.push(`scale(${hflip ? -1 : 1}, ${vflip ? -1 : 1})`);
  return parts.join(" ") || "none";
}

/**
 * mpv `sub-margin-y` (scaled pixels of a 720 px high window) that keeps subtitles above the
 * HUD while it is visible.
 */
export function subMarginFor(hudVisible, hudHeightPx, windowHeightPx, base = 22) {
  if (!hudVisible || !hudHeightPx || !windowHeightPx) return base;
  return Math.round(base + (hudHeightPx * 720) / windowHeightPx);
}

/** Bookmark list helpers (per file, sorted, no near-duplicates). */
export function addBookmark(list, time, label = "") {
  const t = Math.max(0, Math.round(time * 10) / 10);
  if (list.some((b) => Math.abs(b.time - t) < 0.5)) return list;
  return [...list, { time: t, label }].sort((a, b) => a.time - b.time);
}

export const removeBookmark = (list, index) => list.filter((_, i) => i !== index);

/** Audio-only layout: by name, or libmpv found no real video track (cover art does not count). */
export const isAudioOnlyMedia = (name, tracks) =>
  isAudioOnlyName(name ?? "") ||
  (!!tracks && tracks.audio.length > 0 && !tracks.video.some((t) => !["mjpeg", "png"].includes(t.codec)));

/** Engine choice for an item: libmpv for real paths and URLs, <video> for browser File objects. */
export function engineKindFor(item, mpvAvailable) {
  if (!mpvAvailable) return "html5";
  return item?.path || item?.url ? "mpv" : "html5";
}

// --------------------------------------------------------------------------
// Facade
// --------------------------------------------------------------------------

/**
 * impls: { html5, mpv? } engine implementations.
 * Returns the facade the whole UI uses (app.engine).
 */
export function createEngineFacade(impls) {
  const listeners = new Map(); // event -> Set<fn>
  if (!impls.html5) throw new Error("the html5 engine is required (fallback)");
  let current = impls.html5;
  for (const [kind, impl] of Object.entries(impls)) {
    if (!impl) continue;
    const missing = ENGINE_METHODS.filter((m) => typeof impl[m] !== "function");
    if (missing.length) throw new Error(`${kind} engine misses ${missing.join(", ")}`);
    impl.attach((event, payload) => {
      if (current !== impl) return; // only the active engine reaches the UI
      for (const fn of listeners.get(event) ?? []) {
        try {
          fn(payload);
        } catch (e) {
          console.error(`engine ${event} handler`, e);
        }
      }
    });
  }

  const call = (name) => (...args) => current[name](...args);

  const facade = {
    /** Active engine: "mpv" | "html5". */
    get kind() { return current.kind; },
    get caps() { return current.caps; },
    get mpvAvailable() { return !!impls.mpv; },
    get impl() { return current; },
    /** Switches the active engine (the previous one is stopped/hidden). */
    use(kind) {
      const next = impls[kind] ?? impls.html5;
      if (next === current) return current;
      current.deactivate();
      current = next;
      current.activate();
      return current;
    },
    /** Picks the engine for an item, then loads it. */
    load(item, ctx = {}) {
      facade.use(engineKindFor(item, !!impls.mpv));
      return current.load(item, ctx);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    get time() { return current.time; },
    get duration() { return current.duration; },
    get paused() { return current.paused; },
    get ended() { return current.ended; },
    get volume() { return current.volume; },
    get rate() { return current.rate; },
    get previewSrc() { return current.previewSrc; },
    hasDuration() {
      const d = current.duration;
      return Number.isFinite(d) && d > 0;
    },
    destroy() {
      for (const impl of Object.values(impls)) impl?.destroy?.();
      listeners.clear();
    },
  };
  for (const m of ENGINE_METHODS) {
    if (!["attach", "activate", "deactivate", "load"].includes(m)) facade[m] = call(m);
  }
  return facade;
}
