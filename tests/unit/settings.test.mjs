import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_FIELDS, SETTINGS_VERSION, defaultValues, extractLegacyResume, isLegacyResumeKey, migrateSettings,
  sanitizeValues, validateValue,
} from "../../src/core/settings-schema.js";
import { createSettings, memoryAdapter, tauriStoreAdapter } from "../../src/core/settings.js";
import { addRecent, createLibrary, RECENT_MAX, sanitizeRecent, setResume } from "../../src/core/library.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Minimal Storage (localStorage) fake. */
function fakeStorage(entries) {
  const m = new Map(Object.entries(entries));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  };
}

test("schema: defaults are valid and PC sleep is off by default", () => {
  const d = defaultValues();
  for (const [k, f] of Object.entries(BASE_FIELDS)) {
    assert.equal(validateValue(f, d[k]).ok, true, k);
  }
  assert.equal(d["sleep.pcSleep"], false);
  assert.equal(d["general.language"], "system");
  assert.equal(d["appearance.theme"], "dark");
});

test("schema: validation coerces, clamps and rejects", () => {
  const vol = BASE_FIELDS["playback.volume"];
  assert.deepEqual(validateValue(vol, 250), { ok: true, value: 200 });
  assert.deepEqual(validateValue(vol, "55.6"), { ok: true, value: 56 });
  assert.equal(validateValue(vol, "abc").ok, false);
  assert.equal(validateValue(vol, NaN).ok, false);
  assert.deepEqual(validateValue(BASE_FIELDS["playback.speed"], "1.5"), { ok: true, value: 1.5 });
  assert.equal(validateValue(BASE_FIELDS["playback.speed"], 3).ok, false);
  assert.equal(validateValue(BASE_FIELDS["sleep.pcSleep"], "true").ok, false);
  assert.deepEqual(validateValue(BASE_FIELDS["appearance.accent"], "#ABCDEF"), { ok: true, value: "#abcdef" });
  assert.equal(validateValue(BASE_FIELDS["appearance.accent"], "red").ok, false);
  assert.equal(validateValue(BASE_FIELDS["shortcuts.bindings"], []).ok, false);
});

test("schema: sanitize keeps unknown keys (registered later) and resets invalid ones", () => {
  const { values, invalid } = sanitizeValues({ "playback.volume": "x", "engine.hwdec": "auto", "appearance.theme": "light" });
  assert.equal(values["playback.volume"], 100);
  assert.equal(values["engine.hwdec"], "auto");
  assert.equal(values["appearance.theme"], "light");
  assert.deepEqual(invalid, ["playback.volume"]);
});

test("migration: empty / v0 flat / v0 nested / current / newer documents", () => {
  const empty = migrateSettings(undefined);
  assert.equal(empty.doc.version, SETTINGS_VERSION);
  assert.deepEqual(empty.doc.values, defaultValues());
  assert.equal(empty.migrated, true);

  const flat = migrateSettings({ "playback.volume": 40, "sleep.pcSleep": true });
  assert.equal(flat.doc.values["playback.volume"], 40);
  assert.equal(flat.doc.values["sleep.pcSleep"], true);

  const nested = migrateSettings({ playback: { volume: 70, speed: 2 }, appearance: { theme: "contrast" } });
  assert.equal(nested.doc.values["playback.volume"], 70);
  assert.equal(nested.doc.values["playback.speed"], 2);
  assert.equal(nested.doc.values["appearance.theme"], "contrast");

  const current = migrateSettings({ version: 1, values: { "playback.aspect": "4-3" } });
  assert.equal(current.migrated, false);
  assert.equal(current.doc.values["playback.aspect"], "4-3");

  const newer = migrateSettings({ version: 9, values: { "playback.volume": 10, "future.key": 1 } });
  assert.equal(newer.doc.version, 9);
  assert.equal(newer.doc.values["playback.volume"], 10);
  assert.equal(newer.doc.values["future.key"], 1);

  assert.deepEqual(migrateSettings("garbage").doc.values, defaultValues());
});

test("legacy resume keys are extracted from localStorage", () => {
  assert.equal(isLegacyResumeKey("vho_file_a.mp4_123"), true);
  assert.equal(isLegacyResumeKey("vho_url_https://x/a.mp4"), true);
  assert.equal(isLegacyResumeKey("vho.ai.backend"), false);
  const s = fakeStorage({ "vho_file_a.mp4_1": "42.5", "vho_url_http://x": "bad", "vho.ai.backend": "wasm" });
  const r = extractLegacyResume(s);
  assert.deepEqual(r.positions, { "vho_file_a.mp4_1": 42.5 });
  assert.deepEqual(r.keys.sort(), ["vho_file_a.mp4_1", "vho_url_http://x"]);
});

test("settings service: load, set, persist (debounced), subscribe, reject invalid", async () => {
  const adapter = memoryAdapter({ version: 1, values: { "playback.volume": 30 } });
  const s = createSettings({ adapter, saveDelayMs: 1 });
  await s.ready;
  assert.equal(s.get("playback.volume"), 30);
  const seen = [];
  s.subscribe("playback.volume", (v, old) => seen.push([v, old]));
  assert.equal(s.set("playback.volume", 80), true);
  assert.equal(s.set("playback.volume", 80), true); // unchanged: no event
  assert.equal(s.set("playback.volume", "nope"), false);
  assert.throws(() => s.set("no.such.key", 1));
  await tick(20);
  assert.deepEqual(seen, [[80, 30]]);
  assert.equal(adapter.doc.values["playback.volume"], 80);
  assert.equal(adapter.doc.version, SETTINGS_VERSION);
});

test("settings service: first run writes defaults; reset restores them", async () => {
  const adapter = memoryAdapter(undefined);
  const s = createSettings({ adapter, saveDelayMs: 1 });
  await s.ready;
  assert.equal(adapter.saved.length, 1);
  s.set("appearance.theme", "light");
  s.reset(["appearance.theme"]);
  assert.equal(s.get("appearance.theme"), "dark");
});

test("settings service: register() validates values loaded before registration", async () => {
  const adapter = memoryAdapter({ version: 1, values: { "engine.hwdec": "no", "engine.profile": "broken" } });
  const s = createSettings({ adapter, saveDelayMs: 1 });
  await s.ready;
  const changes = [];
  const registered = [];
  s.onRegister((section, keys) => registered.push([section, keys]));
  s.register("playback", [
    { key: "engine.hwdec", type: "enum", values: ["auto", "no"], default: "auto", control: "select", onChange: (v) => changes.push(v) },
    { key: "engine.profile", type: "enum", values: ["default", "fast"], default: "default", control: "select" },
    { control: "button", label: "Literal", onClick() {} },
  ]);
  assert.equal(s.get("engine.hwdec"), "no");
  assert.equal(s.get("engine.profile"), "default");
  s.set("engine.hwdec", "auto");
  assert.deepEqual(changes, ["auto"]);
  assert.deepEqual(registered, [["playback", ["engine.hwdec", "engine.profile"]]]);
  assert.equal(s.fieldsOf("playback").length, 3);
  // A brand new section (tab) is created on demand
  s.register("engine", [{ key: "engine.x", type: "boolean", default: true, control: "toggle" }]);
  assert.ok(s.sections().includes("engine"));
});

test("library: recent list dedupes, caps at 20, sanitizes", () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = addRecent(list, { id: `p${i}`, name: `n${i}` });
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].id, "p24");
  list = addRecent(list, { id: "p10", name: "again", duration: undefined });
  assert.equal(list[0].name, "again");
  assert.equal(list.filter((e) => e.id === "p10").length, 1);
  const clean = sanitizeRecent([{ id: "a", name: "a", type: "weird" }, { id: "a", name: "dup" }, null, { name: "noid" }]);
  assert.deepEqual(clean.map((e) => [e.id, e.type]), [["a", "video"]]);
  const capped = setResume({ a: 1, b: 2 }, "c", 3, 2);
  assert.deepEqual(Object.keys(capped), ["b", "c"]);
});

test("library: one-time migration of localStorage resume positions", async () => {
  const storage = fakeStorage({ "vho_file_a.mp4_10": "33", "vho_url_http://x/b.mp4": "12.5", "other": "1" });
  const adapter = memoryAdapter({ version: 1, recent: [], resume: { "vho_file_a.mp4_10": 99 }, legacyMigrated: false });
  const lib = createLibrary({ adapter, legacyStorage: storage, saveDelayMs: 1 });
  await lib.ready;
  assert.equal(lib.resume.get("vho_file_a.mp4_10"), 99, "store value wins");
  assert.equal(lib.resume.get("vho_url_http://x/b.mp4"), 12.5);
  assert.deepEqual(storage.keys(), ["other"], "legacy keys removed after the store write");
  assert.equal(adapter.doc.legacyMigrated, true);

  // Second start: nothing is migrated again
  storage.setItem("vho_file_new_1", "50");
  const lib2 = createLibrary({ adapter, legacyStorage: storage, saveDelayMs: 1 });
  await lib2.ready;
  assert.equal(lib2.resume.get("vho_file_new_1"), null);

  lib2.resume.set("k", 12.34);
  lib2.recent.add({ id: "C:\\v.mp4", path: "C:\\v.mp4", name: "v.mp4", type: "video" });
  await tick(20);
  assert.equal(adapter.doc.resume.k, 12.3);
  assert.equal(adapter.doc.recent[0].name, "v.mp4");
  lib2.resume.remove("k");
  lib2.recent.remove("C:\\v.mp4");
  await tick(20);
  assert.equal(adapter.doc.resume.k, undefined);
  assert.deepEqual(adapter.doc.recent, []);
});

test("settings: a value left unsaved in the backend store by a reloaded page is written to disk on load", async () => {
  // tauri-plugin-store returns the already-loaded instance for the same path after a page reload
  const disk = {};
  const cache = {};
  const store = {
    async get(k) { return cache[k]; },
    async set(k, v) { cache[k] = v; },
    async save() { Object.assign(disk, structuredClone(cache)); },
  };
  const prev = globalThis.window;
  globalThis.window = { __TAURI__: { core: { invoke: async () => "C:\data" }, store: { load: async () => store } } };
  try {
    // previous page: set() ran, the page reloaded before save()
    await store.set("settings", { version: SETTINGS_VERSION, values: defaultValues(BASE_FIELDS) });
    assert.equal(disk.settings, undefined);
    const settings = createSettings({ adapter: tauriStoreAdapter("settings.json", "settings") });
    await settings.ready;
    assert.equal(disk.settings?.version, SETTINGS_VERSION, "persisted on load");
  } finally {
    globalThis.window = prev;
  }
});
