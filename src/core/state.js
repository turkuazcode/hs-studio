// ==========================================================================
// Small reactive store: the only place for state shared between modules.
// Module-private details (timers, Web Audio nodes, zoom/pan...) stay inside
// their own module closures; anything another module reads or writes lives here.
// ==========================================================================

/** Creates a store with get/set/update/subscribe. Subscribers run synchronously on change. */
export function createStore(initial = {}) {
  const data = { ...initial };
  const subs = new Map(); // key -> Set<fn(value, old)>

  const notify = (key, value, old) => {
    for (const fn of subs.get(key) ?? []) fn(value, old);
    for (const fn of subs.get("*") ?? []) fn(key, value, old);
  };

  return {
    get: (key) => data[key],
    set(key, value) {
      const old = data[key];
      if (Object.is(old, value)) return value;
      data[key] = value;
      notify(key, value, old);
      return value;
    },
    /** set(key, fn(current)) */
    update(key, fn) {
      return this.set(key, fn(data[key]));
    },
    /** Subscribe to one key, or "*" for every change (fn(key, value, old)). Returns unsubscribe. */
    subscribe(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => subs.get(key)?.delete(fn);
    },
    snapshot: () => ({ ...data }),
  };
}

/** Application state shared across modules (initial values match the original main.js). */
export const INITIAL_STATE = Object.freeze({
  // Playback
  isPlaying: false,
  currentMediaType: "none", // "video" | "image" | "none"
  loadGen: 0,               // bumps on every media load; async work from older loads is ignored
  isTaintedSource: false,   // cross-origin source without CORS: no Web Audio / WebGL access
  currentFileKey: "",       // localStorage key of the resume position ("" for photos)
  currentAspect: "contain",

  // Playlist ({ name, isImage } + one of file / path / url)
  playlist: [],
  currentPlaylistIndex: -1,
  isSlideshowActive: false,

  // Visual restoration (GPU enhancer / CSS fallback)
  isAiRestoreEnabled: false,
  isSplitViewActive: false,
  aiSharpLevel: 2,
  aiContrastBoost: 8,
  enhancerBlocked: false,
});

export function createAppState() {
  // Arrays are copied so a fresh store never shares the frozen template's array
  return createStore({ ...INITIAL_STATE, playlist: [] });
}
