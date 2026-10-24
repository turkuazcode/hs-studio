// ==========================================================================
// Library store (library.json): recent files + resume positions.
// Resume positions used to live in localStorage ("vho_file_..." / "vho_url_..." keys);
// they are moved here once (migrateLegacy) and the old keys are removed afterwards.
// ==========================================================================

import { extractLegacyResume } from "./settings-schema.js";
import { memoryAdapter } from "./settings.js";

export const LIBRARY_VERSION = 1;
export const RECENT_MAX = 20;
export const RESUME_MAX = 500;

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
  let data = { version: LIBRARY_VERSION, recent: [], resume: {}, legacyMigrated: false };
  const subs = new Set();
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
        legacyMigrated: raw.legacyMigrated === true,
      };
    }
    if (!failed) await migrateLegacy();
    notify();
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

  return {
    ready,
    resume,
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
