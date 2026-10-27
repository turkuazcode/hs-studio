// L02 frontend helpers: paged virtual list source, queries, playlist helpers, tag parsing,
// library document following a rename/move.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuery, createPagedSource, parseTags, playlistFileName, queueToEntries, stars, visibleRange,
} from "../../src/core/library-api.js";
import { createLibrary } from "../../src/core/library.js";
import { memoryAdapter } from "../../src/core/settings.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("paged source loads pages on demand and keeps memory bounded", async () => {
  const calls = [];
  const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
  let loaded = 0;
  const src = createPagedSource((offset, limit) => {
    calls.push(offset);
    return Promise.resolve({ total: rows.length, items: rows.slice(offset, offset + limit) });
  }, { pageSize: 100, maxPages: 3, onLoad: () => loaded++ });
  assert.equal(src.get(0), undefined); // starts loading page 0
  assert.equal(src.get(5), undefined); // same page: no second request
  await tick();
  assert.deepEqual(calls, [0]);
  assert.equal(src.total, 5000);
  assert.equal(src.get(5).id, 5);
  for (const i of [1000, 2000, 3000, 4999]) src.get(i);
  await tick();
  assert.equal(loaded, 5);
  assert.ok(src.loadedPages.length <= 3, String(src.loadedPages));
  assert.equal(src.get(4999).id, 4999);
  // a disposed (stale) source ignores late answers
  let resolve;
  const late = createPagedSource(() => new Promise((r) => { resolve = r; }), { onLoad: () => assert.fail("stale") });
  late.get(0);
  late.dispose();
  resolve({ total: 1, items: [{}] });
  await tick();
});

test("visible range with overscan", () => {
  assert.deepEqual(visibleRange(0, 440, 44, 5000, 0), { start: 0, end: 10 });
  assert.deepEqual(visibleRange(4400, 440, 44, 5000, 8), { start: 92, end: 118 });
  assert.deepEqual(visibleRange(10 ** 9, 440, 44, 50, 8), { start: 50, end: 50 }); // list shrank under the scroll position
  assert.deepEqual(visibleRange(0, 440, 44, 0), { start: 0, end: 0 });
});

test("query of a tab / view / search", () => {
  assert.deepEqual(buildQuery({ kind: "video", view: "continue", search: "  " }), { kind: "video", view: "continue", desc: false });
  assert.deepEqual(buildQuery({ kind: "audio", search: " barış " }), { kind: "audio", view: "all", desc: false, search: "barış", sort: "track" });
});

test("playlist helpers and tags", () => {
  assert.deepEqual(queueToEntries([{ path: "C:\\a.mp3", name: "a" }, { url: "https://x/s", name: "Radyo" }, { file: {} }]), [
    { path: "C:\\a.mp3", title: null },
    { url: "https://x/s", title: "Radyo" },
  ]);
  assert.equal(playlistFileName('Yol: "gece"/1'), "Yol gece1.m3u8");
  assert.equal(playlistFileName("", "pls"), "playlist.pls");
  assert.equal(playlistFileName("a", "exe"), "a.m3u8");
  assert.deepEqual(parseTags("Aile, aile; Yaz 2024,\n , İzmir"), ["Aile", "Yaz 2024", "İzmir"]);
  assert.equal(stars(3), "★★★");
  assert.equal(stars(0), "");
});

test("library document follows a rename: recent, favorite, resume, bookmarks", async () => {
  const saved = [];
  const adapter = { ...memoryAdapter(), save: async (d) => { saved.push(d); } };
  const lib = createLibrary({ adapter, saveDelayMs: 0 });
  await lib.ready;
  const old = "C:\\v\\film.mp4", now = "C:\\v\\Yeni ad.mp4";
  const oldKey = "vho_file_film.mp4_10", newKey = "vho_file_Yeni ad.mp4_10";
  lib.recent.add({ id: old, path: old, name: "film.mp4", type: "video", resumeKey: oldKey });
  lib.favorites.set([old]);
  lib.resume.set(oldKey, 42);
  lib.bookmarks.set(oldKey, [{ time: 3, label: "x" }]);
  assert.equal(lib.applyMove({ oldPath: old, newPath: now, oldKey, newKey }), true);
  assert.deepEqual(lib.recent.list().map((e) => [e.id, e.name, e.resumeKey]), [[now, "Yeni ad.mp4", newKey]]);
  assert.deepEqual(lib.favorites.list(), [now]);
  assert.equal(lib.resume.get(oldKey), null);
  assert.equal(lib.resume.get(newKey), 42);
  assert.deepEqual(lib.bookmarks.get(newKey), [{ time: 3, label: "x" }]);
  assert.deepEqual(lib.bookmarks.get(oldKey), []);
  // a move to another folder keeps the key
  assert.equal(lib.applyMove({ oldPath: now, newPath: "D:\\x\\Yeni ad.mp4" }), true);
  assert.deepEqual(lib.favorites.list(), ["D:\\x\\Yeni ad.mp4"]);
  assert.equal(lib.applyMove({ oldPath: "C:\\nope.mp4", newPath: "C:\\x.mp4" }), false);
  await lib.flush();
  assert.ok(saved.at(-1).favorites.includes("D:\\x\\Yeni ad.mp4"));
});
