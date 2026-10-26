// Library (Plan 13/L02) in the real app: library folder with 5,000+ generated files, paged
// virtual list + FTS search, UI responsive during the scan, watcher picks up a new file and a
// rename outside the app, missed events (watcher off) repaired by a rescan, D1 rename keeps
// favorite + resume position, a simulated external disk (subst drive created and removed by
// the test) goes offline and comes back, playlist export/import round trip, photo studio
// rating. Everything lives in fresh temp folders and an isolated VHO_DATA_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HTML5_ENGINE, fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";
import { withDb } from "./lib/db.mjs";
import { sleep } from "./lib/cdp.mjs";

const J = JSON.stringify;
const L = "window.__vhoLibrary";
const api = (call) => `${L}.api.${call}`;

function makeLibrary(root) {
  let videos = 0;
  for (let d = 0; d < 26; d++) {
    const dir = join(root, `klasör ${d}`, `alt${d % 3}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 200; i++) {
      const ext = ["mp4", "mkv", "mp3", "flac", "jpg", "png"][(i + d) % 6];
      if (ext === "mp4" || ext === "mkv") videos++;
      writeFileSync(join(dir, `dosya-${d}-${i}.${ext}`), `${d}/${i}`);
    }
  }
  writeFileSync(join(root, "notlar.txt"), "x");
  return { files: 26 * 200, videos };
}

const dbGet = (dataDir, sql, ...args) => {
  try { return withDb(dataDir, (db) => db.prepare(sql).get(...args)) ?? null; } catch { return null; }
};

async function waitDb(dataDir, sql, args, pred, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = dbGet(dataDir, sql, ...args);
    if (last && pred(last)) return last;
    await sleep(200);
  }
  throw new Error(`library.db: timed out waiting for ${what}; last=${J(last)}`);
}

const idOf = (dataDir, path) => dbGet(dataDir, "SELECT id, status, path, favorite, rating FROM media WHERE path = ?", path);

test("library: folders, scan, search, watcher, reconciliation, rename, offline disk, playlists", { timeout: 300000 }, async (t) => {
  const dataDir = await makeDataDir();
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-library-"));
  const root = join(work, "Kütüphane");
  const { files, videos } = makeLibrary(root);
  const film = join(root, "film.mp4");
  copyFileSync(fixture("sample-h264.mp4"), film);
  const app = await launchApp({ dataDir, env: HTML5_ENGINE });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!${L}?.api`, { timeoutMs: 15000, message: "platform ready" });

    await t.test("start screen entry opens the library; empty state offers a folder", async () => {
      await app.click("#btn-open-library");
      await app.waitFor(`!document.getElementById("library").hidden && document.getElementById("library").dataset.loading === "0"`, { timeoutMs: 8000 });
      await app.waitFor(`!document.getElementById("lib-empty").hidden && !document.getElementById("lib-empty-add").hidden`, { timeoutMs: 8000, message: "empty state" });
      // video and music layouts are separate; lists tab has no media columns
      await app.click('.lib-tab[data-tab="audio"]');
      assert.equal(await app.eval(`document.getElementById("library").dataset.tab`), "audio");
      await app.click('.lib-tab[data-tab="video"]');
    });

    let scanMs = 0;
    await t.test(`adding a folder scans ${files + 1} files without blocking the UI`, async () => {
      const started = Date.now();
      const r = await app.eval(`${api(`addFolder(${J(root)})`)}`);
      assert.equal(r.status, "added");
      // the page keeps answering while the backend scans
      let worst = 0;
      while (Date.now() - started < 60000) {
        const t0 = Date.now();
        await app.eval(`new Promise((r) => requestAnimationFrame(() => r(true)))`);
        worst = Math.max(worst, Date.now() - t0);
        const n = dbGet(dataDir, "SELECT COUNT(*) AS n FROM media WHERE in_library = 1")?.n ?? 0;
        const status = await app.eval(`${api("status()")}`);
        if (n >= files + 1 && !status.running) break;
        await sleep(100);
      }
      scanMs = Date.now() - started;
      const n = dbGet(dataDir, "SELECT COUNT(*) AS n FROM media WHERE in_library = 1").n;
      assert.equal(n, files + 1);
      console.log(`[perf] library scan of ${files + 1} files: ${scanMs} ms; worst frame round trip during scan ${worst} ms`);
      assert.ok(worst < 1000, `UI blocked for ${worst} ms`);
      // the same folder again: no second folder, no duplicates
      assert.equal((await app.eval(`${api(`addFolder(${J(root)})`)}`)).status, "exists");
      assert.equal((await app.eval(`${api(`addFolder(${J(join(root, "klasör 1"))})`)}`)).status, "covered");
      await app.eval(`${api("rescan()")}`);
      await sleep(1500);
      await app.waitFor(`${api("status()")}.then((s) => !s.running)`, { timeoutMs: 30000 });
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM media").n, files + 1);
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM folders WHERE watched = 1").n, 1);
    });

    await t.test("virtual list: first page, scroll, search (FTS, diacritics folded)", async () => {
      await app.eval(`(${L}.hide(), ${L}.show("video"), true)`);
      const t0 = Date.now();
      await app.waitFor(`document.getElementById("library").dataset.loading === "0" && Number(document.getElementById("lib-list").dataset.rendered) > 0`, { timeoutMs: 8000 });
      const firstPage = Date.now() - t0;
      assert.equal(Number(await app.eval(`document.getElementById("library").dataset.total`)), videos + 1);
      const rendered = Number(await app.eval(`document.getElementById("lib-list").dataset.rendered`));
      assert.ok(rendered < 120, `virtualised (${rendered} rows in the DOM)`);
      await app.eval(`document.getElementById("lib-list").scrollTop = 44 * 1500, true`);
      await app.waitFor(`[...document.querySelectorAll("#lib-list .lib-row")].some((r) => Number(r.dataset.index) > 1400)`, { timeoutMs: 8000, message: "scrolled page loaded" });
      const t1 = Date.now();
      await app.eval(`(() => { const s = document.getElementById("lib-search"); s.value = "DOSYA-7-1"; s.dispatchEvent(new Event("input")); return true; })()`);
      await app.waitFor(`document.getElementById("library").dataset.loading === "0" && Number(document.getElementById("library").dataset.total) > 0 && Number(document.getElementById("library").dataset.total) < 100`, { timeoutMs: 8000, message: "search result" });
      const searchMs = Date.now() - t1;
      const names = await app.eval(`[...document.querySelectorAll("#lib-list .lib-name")].map((e) => e.textContent)`);
      assert.ok(names.every((n) => n.startsWith("dosya-7-1")), names.join());
      const folded = await app.eval(`${api(`query({ search: "klasor", limit: 1 })`)}`);
      assert.equal(folded.total, 0, "folder names are not indexed, only file names / tags / titles");
      console.log(`[perf] library first page ${firstPage} ms (incl. 150 ms debounce-free open), search ${searchMs} ms (incl. 150 ms input debounce)`);
      await app.eval(`(() => { const s = document.getElementById("lib-search"); s.value = ""; s.dispatchEvent(new Event("input")); return true; })()`);
    });

    await t.test("watcher: a new file and a rename outside the app", async () => {
      await app.eval(`${api("setOptions({ watch: true, reconcileMinutes: 0 })")}`);
      await sleep(500);
      const added = join(root, "yeni şarkı.mp3");
      writeFileSync(added, "new");
      await waitDb(dataDir, "SELECT status FROM media WHERE path = ?", [added], (r) => r.status === "present", "watcher: new file");
      const before = idOf(dataDir, added);
      const renamed = join(root, "klasör 2", "taşındı.mp3");
      renameSync(added, renamed);
      const after = await waitDb(dataDir, "SELECT id, status FROM media WHERE path = ?", [renamed], (r) => r.status === "present", "watcher: rename");
      assert.equal(after.id, before.id, "same identity after a move + rename");
    });

    await t.test("missed events (watcher off) are repaired by the rescan", async () => {
      await app.eval(`${api("setOptions({ watch: false, reconcileMinutes: 0 })")}`);
      await sleep(500);
      const a = join(root, "klasör 3", "alt0", "dosya-3-5.mp3");
      const gone = join(root, "klasör 3", "alt0", "dosya-3-3.mp4");
      const aId = idOf(dataDir, a).id;
      const goneId = idOf(dataDir, gone).id;
      const moved = join(root, "klasör 4", "dosya-3-5 yeni.mp3");
      renameSync(a, moved);
      unlinkSync(gone);
      await sleep(2500);
      assert.equal(idOf(dataDir, a)?.status, "present", "not noticed without the watcher");
      await app.eval(`${api("rescan()")}`);
      await waitDb(dataDir, "SELECT id FROM media WHERE path = ?", [moved], (r) => r.id === aId, "reconciled move");
      assert.equal(dbGet(dataDir, "SELECT status FROM media WHERE id = ?", goneId).status, "missing");
      const missing = await app.eval(`${api(`query({ kind: "video", view: "missing" })`)}`);
      assert.ok(missing.items.some((i) => i.id === goneId));
      await app.eval(`${api("setOptions({ watch: true, reconcileMinutes: 0 })")}`);
    });

    await t.test("D1 rename in the app: favorite and resume position follow the identity", async () => {
      await app.eval(`(${L}.hide(), window.__vhoEngine.openPaths([${J(film)}]), true)`);
      await app.waitFor(`window.__vhoEngine.duration > 2 && window.__vhoActions.current().kind === "video"`, { timeoutMs: 20000, message: "video loaded" });
      const { id } = idOf(dataDir, film);
      await app.eval(`(window.__vhoActions.run("favorite"), true)`);
      await waitDb(dataDir, "SELECT favorite FROM media WHERE id = ?", [id], (r) => r.favorite === 1, "favorite saved");
      // the 3 s clip plays to its end first (the player clears the resume position at the end)
      await app.waitFor(`window.__vhoEngine.paused && window.__vhoEngine.time > 2`, { timeoutMs: 20000, message: "clip ended" });
      // resume position + bookmark as the player stores them (key = name + size)
      const key = `vho_file_film.mp4_${statSync(film).size}`;
      await app.eval(`(${L}.store.resume.set(${J(key)}, 1.5), ${L}.store.bookmarks.set(${J(key)}, [{ time: 1, label: "b" }]), ${L}.store.flush().then(() => true))`);
      await waitDb(dataDir, "SELECT seconds FROM resume_positions WHERE key = ?", [key], (r) => r.seconds === 1.5, "resume saved");
      await app.eval(`(window.__vhoActions.run("renameFile"), true)`);
      await app.waitFor(`!!document.getElementById("vho-rename-input")`, { timeoutMs: 3000 });
      const newName = "film yeni ad – ğüşİ.mp4";
      await app.eval(`(() => { const i = document.getElementById("vho-rename-input"); i.value = ${J(newName)}; return true; })()`);
      await app.click("#vho-rename-ok");
      const newPath = join(root, newName);
      const row = await waitDb(dataDir, "SELECT id, favorite, status FROM media WHERE path = ?", [newPath], () => true, "renamed row");
      assert.deepEqual([row.id, row.favorite, row.status], [id, 1, "present"]);
      assert.ok(existsSync(newPath));
      await sleep(1500); // past the document save debounce: the old path must not come back
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM media WHERE path = ?", film).n, 0);
      assert.deepEqual({ ...dbGet(dataDir, "SELECT op, state FROM media_ops WHERE op = 'rename' ORDER BY id DESC LIMIT 1") }, { op: "rename", state: "done" });
      const newKey = `vho_file_${newName}_${statSync(newPath).size}`;
      assert.equal(dbGet(dataDir, "SELECT seconds FROM resume_positions WHERE key = ?", newKey)?.seconds, 1.5);
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM resume_positions WHERE key = ?", key).n, 0);
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM bookmarks WHERE file_key = ?", newKey).n, 1);
      assert.deepEqual(await app.eval(`${L}.store.favorites.list()`), [newPath]);
    });

    await t.test("playlists: export M3U8 with relative paths, import keeps order and marks missing", async () => {
      const a = join(root, "klasör 5", "alt2", "dosya-5-1.mp4");
      const b = join(root, "film yeni ad – ğüşİ.mp4"); // renamed above: a real clip
      const missing = join(root, "yok.mp3");
      const out = join(root, "liste Ş.m3u8");
      const items = [{ path: b, title: "İkinci" }, { url: "http://127.0.0.1:9/stream", title: "Radyo" }, { path: missing }, { path: a }];
      assert.equal(await app.eval(`${api(`exportPlaylist(${J(out)}, { items: ${J(items)} })`)}`), 4);
      const text = readFileSync(out, "utf8");
      assert.ok(text.startsWith("#EXTM3U"), "no BOM in .m3u8");
      // relative paths: next to the list / in a sub folder
      assert.ok(text.includes("\nfilm yeni ad – ğüşİ.mp4") && (text.includes("klasör 5\\alt2\\dosya-5-1.mp4") || text.includes("klasör 5/alt2/dosya-5-1.mp4")), text);
      writeFileSync(join(root, "kötü.m3u"), "﻿#EXTM3U\r\njavascript:alert(1)\r\nklasör 5\\alt2\\dosya-5-1.mp4\r\n");
      const bad = await app.eval(`${api(`importPlaylist(${J(join(root, "kötü.m3u"))})`)}`);
      assert.deepEqual([bad.total, bad.skipped], [1, 1]);
      const r = await app.eval(`${api(`importPlaylist(${J(out)})`)}`);
      assert.deepEqual([r.total, r.missing, r.streams], [4, 1, 1]);
      const pl = await app.eval(`${api(`playlist(${J(r.id)})`)}`);
      assert.deepEqual(pl.items.map((i) => i.path ?? i.url), [b, "http://127.0.0.1:9/stream", missing, a]);
      assert.deepEqual(pl.items.map((i) => i.missing), [false, false, true, false]);
      // lists tab shows it; opening plays the existing local items in order, the stream stays a URL
      await app.eval(`(${L}.show("lists"), true)`);
      await app.waitFor(`document.querySelectorAll("#lib-playlists .lib-pl-row").length === 2`, { timeoutMs: 5000 });
      await app.eval(`${L}.playlists.openSaved(${J(r.id)}, ${L}.openQueue)`);
      await app.waitFor(`document.getElementById("library").hidden`, { timeoutMs: 5000 });
      const queue = await app.eval(`[...document.querySelectorAll("#playlist-items .item-name")].map((e) => e.title)`);
      assert.deepEqual(queue, ["film yeni ad – ğüşİ.mp4", "Radyo", "dosya-5-1.mp4"]);
    });

    await t.test("photo studio: star rating is stored in the shared library", async () => {
      const photoDir = join(root, "klasör 0", "alt0");
      await app.eval(`(window.__vhoLibrary.hide(), true)`);
      await app.click("#btn-photo-studio");
      await app.eval(`(() => { document.getElementById("ps-path-edit").click(); const i = document.getElementById("ps-path"); i.value = ${J(photoDir)}; i.form.requestSubmit(); return true; })()`);
      await app.waitFor(`document.getElementById("ps-grid").dataset.loading === "0" && Number(document.getElementById("ps-grid").dataset.total) > 0`, { timeoutMs: 15000 });
      const path = await app.eval(`document.querySelector("#ps-grid .ps-cell").dataset.path`);
      await app.eval(`(document.getElementById("ps-grid").focus(), window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })), true)`);
      await app.eval(`(window.dispatchEvent(new KeyboardEvent("keydown", { key: "4", bubbles: true })), true)`);
      const focused = await app.eval(`document.querySelector("#ps-grid .ps-cell.focused")?.dataset.path ?? null`);
      const target = focused ?? path;
      await waitDb(dataDir, "SELECT rating FROM media WHERE path = ?", [target], (r) => r.rating === 4, "rating stored");
      const rated = await app.eval(`${api(`query({ kind: "image", minRating: 4 })`)}`);
      assert.ok(rated.items.some((i) => i.path === target), J({ target, rated, row: { ...dbGet(dataDir, "SELECT path, kind, status, in_library, rating FROM media WHERE path = ?", target) } }));
      await app.click("#ps-close");
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
      assert.deepEqual(await app.blockedCalls(), []);
    });
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await removeDir(dataDir);
  }
});

/** A drive letter mapped with `subst` by this test (never a real device). */
function freeLetter() {
  for (const l of "ZYXWVUTSRQP") if (!existsSync(`${l}:\\`)) return l;
  return null;
}

test("library: a simulated external disk goes offline and comes back", { timeout: 150000, skip: process.platform !== "win32" && "subst is Windows only" }, async (t) => {
  const letter = freeLetter();
  assert.ok(letter, "a free drive letter");
  const drive = `${letter}:`;
  const dataDir = await makeDataDir();
  const disk = mkdtempSync(join(tmpdir(), "vho-e2e-disk-"));
  mkdirSync(join(disk, "Filmler"), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(disk, "Filmler", `film-${i}.mkv`), `film ${i}`);
  const mount = () => execFileSync("subst", [drive, disk]);
  const eject = () => { try { execFileSync("subst", [drive, "/d"]); } catch { /* not mapped */ } };
  mount();
  const root = `${drive}\\Filmler`;
  const app = await launchApp({ dataDir, env: HTML5_ENGINE });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!${L}?.api`, { timeoutMs: 15000 });
    await app.eval(`${api(`addFolder(${J(root)})`)}`);
    await waitDb(dataDir, "SELECT COUNT(*) AS n FROM media WHERE status = 'present'", [], (r) => r.n === 20, "scanned");
    const { id } = idOf(dataDir, `${root}\\film-3.mkv`);
    await t.test("ejected: offline, not missing, still listed", async () => {
      eject();
      await app.eval(`${api("rescan()")}`);
      await waitDb(dataDir, "SELECT status FROM folders WHERE watched = 1", [], (r) => r.status === "offline", "folder offline");
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM media WHERE status = 'offline'").n, 20);
      const page = await app.eval(`${api(`query({ kind: "video" })`)}`);
      assert.equal(page.total, 20);
      assert.ok(page.items.every((i) => i.status === "offline"));
    });
    await t.test("plugged in again: present with the same identities", async () => {
      mount();
      await app.eval(`${api("rescan()")}`);
      await waitDb(dataDir, "SELECT status FROM folders WHERE watched = 1", [], (r) => r.status === "online", "folder online");
      await waitDb(dataDir, "SELECT COUNT(*) AS n FROM media WHERE status = 'present'", [], (r) => r.n === 20, "present again");
      assert.equal(idOf(dataDir, `${root}\\film-3.mkv`).id, id);
      assert.equal(dbGet(dataDir, "SELECT COUNT(*) AS n FROM media").n, 20);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
    eject();
    rmSync(disk, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await removeDir(dataDir);
  }
});
