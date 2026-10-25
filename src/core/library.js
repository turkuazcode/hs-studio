// ==========================================================================
// Library store: recent files, resume positions, video bookmarks, favorites.
// In the app the document lives in library.db (SQLite, see library-db.js and
// docs/storage-schema.md; library.json is imported once by the backend). In a browser /
// when the database cannot be opened it is a JSON document (library.json / localStorage).
// Resume positions and bookmarks used to live in localStorage ("vho_file_..." /
// "vho_url_..." / "vho_bm_..." keys); they are moved here once (migrateLegacy) and the old
// keys are removed afterwards.
// ==========================================================================

import { extractLegacyResume } from "./settings-schema.js";
import { memoryAdapter } from "./settings.js";

export const LIBRARY_VERSION = 1;
export const RECENT_MAX = 20;
export const RESUME_MAX = 500;
export const BOOKMARKS_MAX = 500;
const LEGACY_BOOKMARK_PREFIX = "vho_bm_";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Recent entry id: the local path, else the URL. */
export const recentId = (item) => item?.path || item?.url || "";

/** Keeps only well-formed entries (a hand-edited / older file must not break the start screen). */
export function sanitizeRecent(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!isObj(e) || typeof e.id !== "string" || !e.id || seen.has(e.id)) continue;
    if (typeof e.name !== "string") continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      path: typeof e.path === "string" ? e.path : undefined,
      url: typeof e.url === "string" ? e.url : undefined,
      name: e.name,
      type: ["video", "audio", "image"].includes(e.type) ? e.type : "video",
      duration: Number.isFinite(e.duration) ? e.duration : 0,
      resumeKey: typeof e.resumeKey === "string" ? e.resumeKey : "",
      thumb: typeof e.thumb === "string" ? e.thumb : "",
      openedAt: Number.isFinite(e.openedAt) ? e.openedAt : 0,
    });
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/** Moves (or inserts) an entry to the front; keeps at most `max`. Existing fields survive. */
export function addRecent(list, entry, max = RECENT_MAX) {
  const old = list.find((e) => e.id === entry.id);
  const merged = { ...(old ?? {}), ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) };
  return [merged, ...list.filter((e) => e.id !== entry.id)].slice(0, max);
}

export const removeRecent = (list, id) => list.filter((e) => e.id !== id);

export const patchRecent = (list, id, patch) => list.map((e) => (e.id === id ? { ...e, ...patch } : e));

/** Bookmark lists by file key: only finite, non-negative times; at most BOOKMARKS_MAX each. */
export function sanitizeBookmarks(map) {
  if (!isObj(map)) return {};
  const out = {};
  for (const [key, list] of Object.entries(map)) {
    if (!key || !Array.isArray(list)) continue;
    const clean = list
      .filter((b) => isObj(b) && Number.isFinite(b.time) && b.time >= 0)
      .map((b) => ({ time: b.time, label: typeof b.label === "string" ? b.label : "" }))
      .slice(0, BOOKMARKS_MAX);
    if (clean.length) out[key] = clean;
  }
  return out;
}

/** Favorite paths: strings, no duplicates, order kept. */
export const sanitizeFavorites = (list) =>
  Array.isArray(list) ? [...new Set(list.filter((p) => typeof p === "string" && p))] : [];

/** Insertion-ordered map capped at `max` (oldest dropped first). */
export function setResume(map, key, seconds, max = RESUME_MAX) {
  const next = { ...map };
  delete next[key];
  next[key] = seconds;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - max; i++) delete next[keys[i]];
  return next;
}

/**
 * adapter: { load, save } (see settings.js). legacyStorage: window.localStorage (or a fake).
 */
export function createLibrary({ adapter = memoryAdapter(), legacyStorage = null, saveDelayMs = 800 } = {}) {
  let data = {
    version: LIBRARY_VERSION, recent: [], resume: {}, bookmarks: {}, favorites: [],
    legacyMigrated: false, legacyBookmarksMigrated: false,
  };
  const subs = new Set();
  const favSubs = new Set();
  let saveTimer = 0;
  let pendingSave = null;

  function writeNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    pendingSave = adapter.save(JSON.parse(JSON.stringify(data))).catch((e) => console.error("[library] save failed", e));
    return pendingSave;
  }
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, saveDelayMs);
  };
  const notify = () => {
    for (const fn of subs) {
      try { fn(data.recent.slice()); } catch (e) { console.error("[library] subscriber", e); }
    }
  };

  const notifyFavorites = () => {
    for (const fn of favSubs) {
      try { fn(data.favorites.slice()); } catch (e) { console.error("[library] subscriber", e); }
    }
  };

  /** One-time move of localStorage bookmarks ("vho_bm_<file key>"). Store lists win. */
  async function migrateLegacyBookmarks() {
    if (data.legacyBookmarksMigrated || !legacyStorage) return 0;
    const keys = [];
    const found = {};
    try {
      const n = legacyStorage.length ?? 0;
      for (let i = 0; i < n; i++) {
        const key = legacyStorage.key(i);
        if (typeof key !== "string" || !key.startsWith(LEGACY_BOOKMARK_PREFIX)) continue;
        keys.push(key);
        try { found[key.slice(LEGACY_BOOKMARK_PREFIX.length)] = JSON.parse(legacyStorage.getItem(key)); } catch { /* skip */ }
      }
    } catch (e) {
      console.warn("[library] legacy bookmarks read failed", e);
      return 0;
    }
    const clean = sanitizeBookmarks(found);
    const bookmarks = { ...data.bookmarks };
    for (const [k, list] of Object.entries(clean)) if (!(k in bookmarks)) bookmarks[k] = list;
    data = { ...data, bookmarks, legacyBookmarksMigrated: true };
    await writeNow();
    for (const k of keys) {
      try { legacyStorage.removeItem(k); } catch { /* ignore */ }
    }
    return Object.keys(clean).length;
  }

  /** One-time move of localStorage resume positions. Store values win over legacy ones. */
  async function migrateLegacy() {
    if (data.legacyMigrated || !legacyStorage) return 0;
    let found;
    try {
      found = extractLegacyResume(legacyStorage);
    } catch (e) {
      console.warn("[library] legacy resume read failed", e);
      return 0;
    }
    let resume = data.resume;
    for (const [k, t] of Object.entries(found.positions)) if (!(k in resume)) resume = setResume(resume, k, t);
    data = { ...data, resume, legacyMigrated: true };
    await writeNow();
    // Only after the store write: remove the old keys
    for (const k of found.keys) {
      try { legacyStorage.removeItem(k); } catch { /* ignore */ }
    }
    return Object.keys(found.positions).length;
  }

  const ready = (async () => {
    let raw, failed = false;
    try {
      raw = await adapter.load();
    } catch (e) {
      failed = true;
      console.error("[library] load failed", e);
    }
    if (isObj(raw)) {
      data = {
        version: LIBRARY_VERSION,
        recent: sanitizeRecent(raw.recent),
        resume: isObj(raw.resume)
          ? Object.fromEntries(Object.entries(raw.resume).filter(([, t]) => Number.isFinite(t) && t > 0))
          : {},
        bookmarks: sanitizeBookmarks(raw.bookmarks),
        favorites: sanitizeFavorites(raw.favorites),
        legacyMigrated: raw.legacyMigrated === true,
        legacyBookmarksMigrated: raw.legacyBookmarksMigrated === true,
      };
    }
    if (!failed) {
      await migrateLegacy();
      await migrateLegacyBookmarks();
    }
    notify();
    notifyFavorites();
  })();

  const resume = {
    /** Seconds or null. */
    get: (key) => (key && Number.isFinite(data.resume[key]) ? data.resume[key] : null),
    set(key, seconds) {
      const t = Number(seconds);
      if (!key || !Number.isFinite(t) || t <= 0) return;
      data.resume = setResume(data.resume, key, Math.round(t * 10) / 10);
      scheduleSave();
    },
    remove(key) {
      if (!key || !(key in data.resume)) return;
      data.resume = { ...data.resume };
      delete data.resume[key];
      scheduleSave();
    },
  };

  const change = (recent) => {
    data.recent = recent;
    scheduleSave();
    notify();
  };

  /** Video bookmarks per file key (the player's resume key). */
  const bookmarks = {
    get: (key) => (key && Array.isArray(data.bookmarks[key]) ? data.bookmarks[key].map((b) => ({ ...b })) : []),
    set(key, list) {
      if (!key) return;
      const clean = sanitizeBookmarks({ [key]: list })[key];
      data.bookmarks = { ...data.bookmarks };
      if (clean) data.bookmarks[key] = clean;
      else delete data.bookmarks[key];
      scheduleSave();
    },
  };

  const setFavorites = (list) => {
    data.favorites = sanitizeFavorites(list);
    scheduleSave();
    notifyFavorites();
  };
  /** Favorite files (paths), in the order they were added. */
  const favorites = {
    list: () => data.favorites.slice(),
    has: (path) => !!path && data.favorites.includes(path),
    set: setFavorites,
    /** Returns true when `path` is a favorite afterwards. */
    toggle(path) {
      if (!path) return false;
      const on = !data.favorites.includes(path);
      setFavorites(on ? [...data.favorites, path] : data.favorites.filter((p) => p !== path));
      return on;
    },
    clear: () => setFavorites([]),
    subscribe(fn) { favSubs.add(fn); return () => favSubs.delete(fn); },
  };

  return {
    ready,
    resume,
    bookmarks,
    favorites,
    /** Storage backend report (library-db.js adapters), e.g. { backend: "sqlite", report }. */
    get status() { return adapter.status ?? null; },
    recent: {
      list: () => data.recent.slice(),
      add: (entry) => change(addRecent(data.recent, entry)),
      update: (id, patch) => data.recent.some((e) => e.id === id) && change(patchRecent(data.recent, id, patch)),
      remove: (id) => change(removeRecent(data.recent, id)),
      clear: () => change([]),
      subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    },
    flush: () => (saveTimer ? writeNow() : pendingSave ?? Promise.resolve()),
    snapshot: () => JSON.parse(JSON.stringify(data)),
  };
}
