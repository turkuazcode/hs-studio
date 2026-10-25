// Library store on top of library.db (Plan 13/L01): bookmarks + favorites API, legacy
// localStorage bookmark move, database adapter document mapping, JSON fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryAdapter } from "../../src/core/settings.js";
import { createLibrary, sanitizeBookmarks, sanitizeFavorites } from "../../src/core/library.js";
import {
  announceStorageStatus, appLibraryAdapter, fallbackAdapter, sqliteLibraryAdapter, storageNoticeKey,
} from "../../src/core/library-db.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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

/** Fake backend: keeps the last saved document in the Rust (pair list) shape. */
function fakeBackend({ fail = null, doc = null, report = { recovered: null } } = {}) {
  const b = {
    calls: [],
    stored: doc ?? { recent: [], resume: [], bookmarks: [], favorites: [], legacyMigrated: false, legacyBookmarksMigrated: false },
    async invoke(cmd, args) {
      b.calls.push(cmd);
      if (fail) throw fail;
      if (cmd === "library_load") return { doc: structuredClone(b.stored), report };
      if (cmd === "library_save") { b.stored = structuredClone(args.doc); return null; }
      throw new Error(`unexpected ${cmd}`);
    },
  };
  return b;
}

test("library: sanitizers for bookmarks and favorites", () => {
  assert.deepEqual(
    sanitizeBookmarks({ a: [{ time: 3, label: "x" }, { time: -1 }, { time: "2" }, null, { time: 5 }], "": [{ time: 1 }], b: "no", c: [] }),
    { a: [{ time: 3, label: "x" }, { time: 5, label: "" }] },
  );
  assert.deepEqual(sanitizeBookmarks(null), {});
  assert.deepEqual(sanitizeFavorites(["a", "", 3, "b", "a"]), ["a", "b"]);
  assert.deepEqual(sanitizeFavorites("x"), []);
});

test("library: favorites and bookmarks are stored in the library document", async () => {
  const adapter = memoryAdapter();
  const lib = createLibrary({ adapter, saveDelayMs: 1 });
  await lib.ready;
  const seen = [];
  lib.favorites.subscribe((l) => seen.push(l));
  assert.equal(lib.favorites.toggle("C:\\a.mp4"), true);
  assert.equal(lib.favorites.toggle("C:\\b.mp3"), true);
  assert.equal(lib.favorites.toggle("C:\\a.mp4"), false);
  assert.equal(lib.favorites.has("C:\\b.mp3"), true);
  assert.deepEqual(seen.at(-1), ["C:\\b.mp3"]);
  lib.bookmarks.set("vho_file_a.mp4_1", [{ time: 1.5, label: "" }, { time: 9, label: "son" }]);
  const got = lib.bookmarks.get("vho_file_a.mp4_1");
  got[0].time = 99; // a copy
  assert.equal(lib.bookmarks.get("vho_file_a.mp4_1")[0].time, 1.5);
  assert.deepEqual(lib.bookmarks.get("unknown"), []);
  await tick(20);
  assert.deepEqual(adapter.doc.favorites, ["C:\\b.mp3"]);
  assert.equal(adapter.doc.bookmarks["vho_file_a.mp4_1"].length, 2);
  lib.bookmarks.set("vho_file_a.mp4_1", []);
  lib.favorites.clear();
  await tick(20);
  assert.deepEqual(adapter.doc.bookmarks, {});
  assert.deepEqual(adapter.doc.favorites, []);

  // restart: values come back
  lib.favorites.set(["C:\\x.jpg"]);
  await lib.flush();
  const lib2 = createLibrary({ adapter, saveDelayMs: 1 });
  await lib2.ready;
  assert.deepEqual(lib2.favorites.list(), ["C:\\x.jpg"]);
});

test("library: one-time move of localStorage bookmarks (existing builds already moved resume)", async () => {
  const storage = fakeStorage({
    "vho_bm_vho_file_a.mp4_10": JSON.stringify([{ time: 4, label: "" }]),
    "vho_bm_vho_file_b.mp4_20": "not json",
    "vho_bm_vho_file_c.mp4_30": JSON.stringify([{ time: 7, label: "c" }]),
    "theme": "dark",
  });
  // resume already migrated by an older build; c already has bookmarks in the store
  const adapter = memoryAdapter({ version: 1, recent: [], resume: {}, legacyMigrated: true, bookmarks: { "vho_file_c.mp4_30": [{ time: 1, label: "" }] } });
  const lib = createLibrary({ adapter, legacyStorage: storage, saveDelayMs: 1 });
  await lib.ready;
  assert.deepEqual(lib.bookmarks.get("vho_file_a.mp4_10"), [{ time: 4, label: "" }]);
  assert.deepEqual(lib.bookmarks.get("vho_file_c.mp4_30"), [{ time: 1, label: "" }], "store list wins");
  assert.deepEqual(storage.keys(), ["theme"], "old keys removed after the store write");
  assert.equal(adapter.doc.legacyBookmarksMigrated, true);
  assert.equal(adapter.doc.bookmarks["vho_file_a.mp4_10"].length, 1, "written before the keys were removed");

  // second start: not again
  storage.setItem("vho_bm_vho_file_z_1", JSON.stringify([{ time: 2 }]));
  const lib2 = createLibrary({ adapter, legacyStorage: storage, saveDelayMs: 1 });
  await lib2.ready;
  assert.deepEqual(lib2.bookmarks.get("vho_file_z_1"), []);
  assert.ok(storage.keys().includes("vho_bm_vho_file_z_1"));
});

test("library-db: database adapter maps the document both ways (order kept)", async () => {
  const backend = fakeBackend({
    doc: {
      recent: [{ id: "C:\\v.mp4", path: "C:\\v.mp4", url: null, name: "v.mp4", type: "video", duration: 3, resumeKey: "k1", thumb: "", openedAt: 5 }],
      resume: [["k_z", 10], ["k_a", 20]],
      bookmarks: [["k1", [{ time: 1, label: "" }]]],
      favorites: ["C:\\v.mp4"],
      legacyMigrated: true,
      legacyBookmarksMigrated: true,
    },
    report: { recovered: null, schemaVersion: 1 },
  });
  const adapter = sqliteLibraryAdapter((c, a) => backend.invoke(c, a));
  const lib = createLibrary({ adapter, legacyStorage: fakeStorage({}), saveDelayMs: 1 });
  await lib.ready;
  assert.equal(lib.recent.list()[0].path, "C:\\v.mp4");
  assert.equal(lib.recent.list()[0].url, undefined, "null from the backend is dropped");
  assert.equal(lib.resume.get("k_a"), 20);
  assert.deepEqual(lib.bookmarks.get("k1"), [{ time: 1, label: "" }]);
  assert.deepEqual(lib.favorites.list(), ["C:\\v.mp4"]);
  assert.deepEqual(lib.status, { backend: "sqlite", report: { recovered: null, schemaVersion: 1 } });
  assert.deepEqual(backend.calls, ["library_load"], "flags set: nothing to migrate, no write at start");

  lib.resume.set("k_new", 7);
  lib.resume.set("k_z", 11); // moved to the end (newest)
  await lib.flush();
  assert.deepEqual(backend.stored.resume, [["k_a", 20], ["k_new", 7], ["k_z", 11]]);
  assert.deepEqual(backend.stored.bookmarks, [["k1", [{ time: 1, label: "" }]]]);
  assert.equal(backend.stored.legacyMigrated, true);
});

test("library-db: JSON store takes over when the database cannot be opened", async () => {
  const backend = fakeBackend({ fail: { code: "schemaNewer", message: "library.db schema v3 is newer" } });
  const json = memoryAdapter({ version: 1, recent: [{ id: "u", url: "u", name: "u", type: "video" }], resume: { k: 5 }, legacyMigrated: true });
  const adapter = appLibraryAdapter((c, a) => backend.invoke(c, a), json);
  const lib = createLibrary({ adapter, saveDelayMs: 1 });
  await lib.ready;
  assert.equal(lib.recent.list()[0].id, "u");
  assert.equal(lib.resume.get("k"), 5);
  assert.equal(lib.status.error, "schemaNewer");
  lib.favorites.toggle("C:\\f.mp4");
  await lib.flush();
  assert.deepEqual(backend.calls, ["library_load"], "the newer database is never written");
  assert.deepEqual(json.doc.favorites, ["C:\\f.mp4"]);

  // no backend at all (browser): plain JSON adapter
  assert.equal(appLibraryAdapter(null, json), json);
  // generic error
  const other = fallbackAdapter({ load: () => Promise.reject(new Error("boom")) }, memoryAdapter());
  await other.load();
  assert.equal(other.status.error, "unavailable");
});

test("library-db: storage notices", () => {
  assert.equal(storageNoticeKey(null), null);
  assert.equal(storageNoticeKey({ backend: "sqlite", report: { recovered: null } }), null);
  assert.equal(storageNoticeKey({ backend: "sqlite", report: { recovered: "backup" } }), "storage.recoveredBackup");
  assert.equal(storageNoticeKey({ backend: "sqlite", report: { recovered: "fresh" } }), "storage.recoveredFresh");
  assert.equal(storageNoticeKey({ backend: "json", error: "schemaNewer" }), "storage.schemaNewer");
  assert.equal(storageNoticeKey({ backend: "json", error: "corrupt" }), "storage.unavailable");
  const toasts = [];
  const key = announceStorageStatus({ library: { status: { error: "schemaNewer" } }, toast: (m) => toasts.push(m) });
  assert.equal(key, "storage.schemaNewer");
  assert.equal(toasts.length, 1);
  assert.equal(announceStorageStatus({ library: { status: null }, toast: (m) => toasts.push(m) }), null);
  assert.equal(toasts.length, 1);
});
