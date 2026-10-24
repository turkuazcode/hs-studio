// ==========================================================================
// Settings schema: field definitions, defaults, validation and migration.
// Pure functions (no DOM, no Tauri): unit tested in tests/unit/settings.test.mjs.
//
// Settings are a flat map of dotted keys ("playback.volume") stored as
//   { version: SETTINGS_VERSION, values: { ... } }
// Unknown keys are kept as-is, so values of fields that another module registers
// later (settings.register) survive the load that happens before registration.
// ==========================================================================

export const SETTINGS_VERSION = 1;

/** Field types: number {min,max,step?,integer?}, boolean, enum {values}, string {maxLength}, color, object. */
export const BASE_FIELDS = {
  // Genel
  "general.language": { type: "enum", values: ["system", "tr", "en"], default: "system" },
  "general.rememberRecent": { type: "boolean", default: true },
  "general.wheelVolume": { type: "boolean", default: true },
  "general.middleClickFullscreen": { type: "boolean", default: true },

  // Oynatma
  "playback.volume": { type: "number", min: 0, max: 200, integer: true, default: 100 },
  "playback.muted": { type: "boolean", default: false },
  "playback.rememberSpeed": { type: "boolean", default: true },
  "playback.speed": { type: "enum", values: [0.5, 0.75, 1, 1.25, 1.5, 2], default: 1 },
  "playback.aspect": { type: "enum", values: ["contain", "16-9", "21-9", "4-3", "fill"], default: "contain" },
  "playback.resume": { type: "boolean", default: true },
  "playback.rememberFilters": { type: "boolean", default: true },
  "sleep.pcSleep": { type: "boolean", default: false }, // never on by default: suspends the PC

  // Görüntü filtreleri (effects panel)
  "filters.brightness": { type: "number", min: 50, max: 200, integer: true, default: 100 },
  "filters.contrast": { type: "number", min: 50, max: 200, integer: true, default: 100 },
  "filters.saturate": { type: "number", min: 0, max: 250, integer: true, default: 100 },

  // Altyazı
  "subtitle.delay": { type: "number", min: -600000, max: 600000, integer: true, default: 0 },
  "subtitle.fontScale": { type: "number", min: 50, max: 250, integer: true, default: 100 },
  "subtitle.color": { type: "color", default: "#ffffff" },
  "subtitle.background": { type: "number", min: 0, max: 100, integer: true, default: 78 },

  // AI panel switches
  "ai.voiceClarity": { type: "boolean", default: true },
  "ai.denoise": { type: "boolean", default: true },
  "ai.compressor": { type: "boolean", default: true },
  "ai.deepFaces": { type: "boolean", default: true },
  "ai.sharpLevel": { type: "number", min: 0, max: 3, integer: true, default: 2 },
  "ai.contrastBoost": { type: "number", min: 0, max: 40, integer: true, default: 8 },

  // Görünüm
  "appearance.theme": { type: "enum", values: ["dark", "light", "contrast"], default: "dark" },
  "appearance.accent": { type: "color", default: "#e11d48" },

  // Klavye: only the user's overrides { actionId: ["KeyX", ...] }
  "shortcuts.bindings": { type: "object", default: {} },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);

/**
 * Validates one value against a field definition.
 * Returns { ok: true, value } (possibly coerced/clamped) or { ok: false }.
 */
export function validateValue(field, value) {
  if (!field) return { ok: false };
  switch (field.type) {
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false };
      let v = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
      if (field.integer) v = Math.round(v);
      return { ok: true, value: v };
    }
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "enum": {
      // Numeric enums accept "1.5" from <select> values
      const hit = field.values.find((x) => x === value || (typeof x === "number" && String(x) === String(value)));
      return hit === undefined ? { ok: false } : { ok: true, value: hit };
    }
    case "string":
      if (typeof value !== "string") return { ok: false };
      return { ok: true, value: field.maxLength ? value.slice(0, field.maxLength) : value };
    case "color":
      return typeof value === "string" && HEX_COLOR.test(value) ? { ok: true, value: value.toLowerCase() } : { ok: false };
    case "object":
      if (!isPlainObject(value)) return { ok: false };
      if (field.validate && !field.validate(value)) return { ok: false };
      return { ok: true, value: clone(value) };
    default:
      return { ok: false };
  }
}

/** { key: default } for every field of the schema. */
export function defaultValues(schema = BASE_FIELDS) {
  return Object.fromEntries(Object.entries(schema).map(([k, f]) => [k, clone(f.default)]));
}

/**
 * Known keys: valid value or the default. Unknown keys: kept (JSON values only) for fields
 * registered later. Returns { values, invalid: [keys that fell back to the default] }.
 */
export function sanitizeValues(values, schema = BASE_FIELDS) {
  const out = defaultValues(schema);
  const invalid = [];
  if (!isPlainObject(values)) return { values: out, invalid };
  for (const [key, raw] of Object.entries(values)) {
    const field = schema[key];
    if (!field) {
      if (raw !== undefined && typeof raw !== "function") out[key] = clone(raw);
      continue;
    }
    const r = validateValue(field, raw);
    if (r.ok) out[key] = r.value;
    else invalid.push(key);
  }
  return { values: out, invalid };
}

/**
 * Upgrade steps: MIGRATIONS[n] turns a version-n document into version n+1.
 * v0 = anything without a version number: a bare { key: value } map (pre-store builds or
 * hand-edited files). Older nested shapes are flattened.
 */
export const MIGRATIONS = {
  0: (doc) => {
    const src = isPlainObject(doc?.values) ? doc.values : isPlainObject(doc) ? doc : {};
    const values = {};
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (key === "version" && !prefix) continue;
        if (isPlainObject(v) && !BASE_FIELDS[key] && !k.includes(".")) walk(v, key);
        else values[key] = v;
      }
    };
    walk(src, "");
    return { version: 1, values };
  },
};

/**
 * Any stored document -> { version: SETTINGS_VERSION, values } with validated values.
 * Returns { doc, migrated: bool, invalid: [...] }.
 */
export function migrateSettings(raw, schema = BASE_FIELDS) {
  let doc = isPlainObject(raw) ? raw : {};
  let version = Number.isInteger(doc.version) && doc.version >= 0 ? doc.version : 0;
  const startVersion = version;
  // A newer build wrote this file: keep what we understand, do not downgrade the number
  while (version < SETTINGS_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    doc = step(doc);
    version = doc.version;
  }
  const { values, invalid } = sanitizeValues(doc.values, schema);
  return {
    doc: { version: Math.max(version, SETTINGS_VERSION), values },
    migrated: startVersion < SETTINGS_VERSION,
    invalid,
  };
}

// --------------------------------------------------------------------------
// Resume positions: one-time move from localStorage into the library store
// --------------------------------------------------------------------------

/** localStorage keys written by older builds (video-player resumeKey()). */
export const isLegacyResumeKey = (key) => typeof key === "string" && /^vho_(file|url)_/.test(key);

/**
 * Reads the legacy resume entries from a Storage-like object.
 * Returns { positions: { key: seconds }, keys: [all legacy keys found] }.
 */
export function extractLegacyResume(storage) {
  const positions = {};
  const keys = [];
  if (!storage) return { positions, keys };
  const n = storage.length ?? 0;
  for (let i = 0; i < n; i++) {
    const key = storage.key(i);
    if (!isLegacyResumeKey(key)) continue;
    keys.push(key);
    const t = parseFloat(storage.getItem(key));
    if (Number.isFinite(t) && t > 0) positions[key] = t;
  }
  return { positions, keys };
}
