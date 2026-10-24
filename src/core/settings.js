// ==========================================================================
// Persistent settings (tauri-plugin-store in the app, localStorage in a browser).
//
//   const settings = createSettings({ adapter: tauriStoreAdapter("settings.json", "settings") });
//   await settings.ready;
//   settings.get("playback.volume"); settings.set("playback.volume", 80);
//   settings.subscribe("appearance.theme", (value, old) => ...);
//
// Registration API (other modules plug their options into the Settings window):
//   settings.register("playback", [
//     { key: "engine.hwdec", type: "enum", values: ["auto", "no"], default: "auto",
//       control: "select", label: "Donanım çözme", options: [{ value: "auto", label: "Otomatik" }, ...],
//       onChange: (value) => engine.setHwdec(value) },
//   ]);
// Fields with a `key` + `type` are persisted and validated; fields without a key are UI-only
// (control: "button" with onClick, or control: "custom" with render(container, ctx)).
// Labels: `labelKey` / `helpKey` (i18n keys) or literal `label` / `help` strings.
// ==========================================================================

import { BASE_FIELDS, defaultValues, migrateSettings, SETTINGS_VERSION, validateValue } from "./settings-schema.js";

/** Settings window tabs, in display order. */
export const SETTINGS_SECTIONS = ["general", "playback", "subtitle", "audio", "photo", "appearance", "shortcuts", "advanced", "about"];

const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

// --------------------------------------------------------------------------
// Storage adapters: { load(): Promise<doc|undefined>, save(doc): Promise }
// --------------------------------------------------------------------------

/** In-memory adapter (unit tests). `saved` records every write. */
export function memoryAdapter(initial) {
  const a = {
    doc: clone(initial),
    saved: [],
    async load() { return clone(a.doc); },
    async save(doc) { a.doc = clone(doc); a.saved.push(clone(doc)); },
  };
  return a;
}

/** Browser fallback (vite dev server): one localStorage key. */
export function localStorageAdapter(key) {
  return {
    async load() {
      try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? undefined; } catch { return undefined; }
    },
    async save(doc) {
      try { localStorage.setItem(key, JSON.stringify(doc)); } catch { /* quota / private mode */ }
    },
  };
}

/**
 * tauri-plugin-store file in the app data folder (or VHO_DATA_DIR for tests), as returned by
 * the backend's settings_dir command. One document under `storeKey`.
 */
export function tauriStoreAdapter(fileName, storeKey) {
  let storePromise = null;
  const open = () => {
    storePromise ??= (async () => {
      const tauri = globalThis.window?.__TAURI__;
      const dir = await tauri.core.invoke("settings_dir");
      const sep = dir.includes("\\") ? "\\" : "/";
      const path = dir.endsWith(sep) ? dir + fileName : dir + sep + fileName;
      return tauri.store.load(path, { autoSave: false, defaults: {} });
    })();
    return storePromise;
  };
  return {
    async load() { return (await open()).get(storeKey); },
    async save(doc) {
      const store = await open();
      await store.set(storeKey, doc);
      await store.save();
    },
  };
}

/** Store-backed adapter in the app, localStorage in a browser. */
export function defaultAdapter(fileName, storeKey) {
  return globalThis.window?.__TAURI__?.store
    ? tauriStoreAdapter(fileName, storeKey)
    : localStorageAdapter(`vho.${storeKey}`);
}

// --------------------------------------------------------------------------
// Settings service
// --------------------------------------------------------------------------

export function createSettings({ adapter = memoryAdapter(), saveDelayMs = 250 } = {}) {
  const schema = { ...BASE_FIELDS };
  const ui = new Map(SETTINGS_SECTIONS.map((s) => [s, []])); // section -> field descriptors
  const subs = new Map(); // key | "*" | "register" -> Set<fn>
  let values = defaultValues(schema);
  let saveTimer = 0;
  let pendingSave = null;
  let loadError = null;

  const emit = (key, ...args) => {
    for (const fn of subs.get(key) ?? []) {
      try { fn(...args); } catch (e) { console.error("[settings] subscriber", key, e); }
    }
  };

  async function writeNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const doc = { version: SETTINGS_VERSION, values: clone(values) };
    pendingSave = adapter.save(doc).catch((e) => console.error("[settings] save failed", e));
    return pendingSave;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, saveDelayMs);
  }

  const ready = (async () => {
    let raw;
    try {
      raw = await adapter.load();
    } catch (e) {
      loadError = e;
      console.error("[settings] load failed, using defaults", e);
    }
    const { doc, migrated, invalid } = migrateSettings(raw, schema);
    values = doc.values;
    if (invalid.length) console.warn("[settings] invalid values reset to defaults:", invalid);
    if (!loadError && (raw === undefined || raw === null || migrated || invalid.length)) await writeNow();
    return api;
  })();

  function set(key, value) {
    const field = schema[key];
    if (!field) throw new Error(`unknown setting: ${key}`);
    const r = validateValue(field, value);
    if (!r.ok) return false;
    const old = values[key];
    if (sameJson(old, r.value)) return true;
    values[key] = r.value;
    scheduleSave();
    emit(key, clone(r.value), old);
    emit("*", key, clone(r.value), old);
    return true;
  }

  function register(section, fields) {
    if (!ui.has(section)) ui.set(section, []);
    const keys = [];
    for (const f of fields) {
      const desc = { ...f, section };
      if (f.key && f.type) {
        const { key } = f;
        schema[key] = {
          type: f.type, default: f.default, values: f.values, min: f.min, max: f.max,
          integer: f.integer, maxLength: f.maxLength, validate: f.validate,
        };
        // A value loaded before registration is validated now
        const r = key in values ? validateValue(schema[key], values[key]) : { ok: false };
        values[key] = r.ok ? r.value : clone(f.default);
        if (f.onChange) subscribe(key, f.onChange);
        keys.push(key);
      }
      ui.get(section).push(desc);
    }
    emit("register", section, keys);
    return keys;
  }

  function subscribe(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key)?.delete(fn);
  }

  const api = {
    ready,
    get: (key) => clone(values[key]),
    set,
    has: (key) => key in schema,
    field: (key) => schema[key],
    /** Back to defaults: the given keys, or every known key. */
    reset(keys = Object.keys(schema)) {
      for (const k of keys) if (schema[k]) set(k, clone(schema[k].default));
    },
    subscribe,
    /** fn(section, keys) after register(). */
    onRegister: (fn) => subscribe("register", fn),
    register,
    /** UI field descriptors of a settings tab (registration order). */
    fieldsOf: (section) => [...(ui.get(section) ?? [])],
    sections: () => [...ui.keys()],
    /** Writes pending changes now (e.g. before closing). */
    flush: () => (saveTimer ? writeNow() : pendingSave ?? Promise.resolve()),
    snapshot: () => clone(values),
    get loadError() { return loadError; },
  };
  return api;
}
