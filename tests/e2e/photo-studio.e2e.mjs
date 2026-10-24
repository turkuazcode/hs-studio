// Photo studio: folder browser (grid, sort, filter, search, selection), info panel,
// viewer + filmstrip navigation, editor crop/rotate + save, batch convert + cancel,
// compare mode, and a 5,000-file first-paint measurement.
// Test folders are generated in the temp directory and deleted afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./lib/app.mjs";
import { jpegSize, makeBulkFolder, makePhotoFolder } from "./lib/photo-fixtures.mjs";
import { sortItems } from "../../src/studio/logic.js";

const J = JSON.stringify;
const ROOT = join(tmpdir(), `vho-studio-e2e-${process.pid}`);
const SET = join(ROOT, "set");
const BULK = join(ROOT, "bulk5000");

test("photo studio", { timeout: 300000 }, async (t) => {
  rmSync(ROOT, { recursive: true, force: true });
  const manifest = makePhotoFolder(SET, 300);
  const clip = join(SET, "clip.mp4");
  const all = [
    ...manifest.map((m) => ({ path: m.path, name: m.name, size: m.size, mtime: m.mtime, exifDate: m.exifDate, kind: "image" })),
    { path: clip, name: "clip.mp4", size: statSync(clip).size, mtime: statSync(clip).mtimeMs, kind: "video" },
  ];
  const app = await launchApp();

  const grid = (k) => app.eval(`document.getElementById("ps-grid").dataset[${J(k)}]`);
  const names = (n = 12) => app.eval(`[...document.querySelectorAll("#ps-grid .ps-cell")]
    .sort((a, b) => a.dataset.index - b.dataset.index).slice(0, ${n}).map((c) => c.title)`);
  const cell = (i) => `#ps-grid .ps-cell[data-index="${i}"]`;
  const mouse = (i, opts = {}, type = "mousedown") => app.eval(`(() => {
    const c = document.querySelector(${J(cell(i))});
    if (!c) throw new Error("no cell ${i}");
    c.dispatchEvent(new MouseEvent(${J(type)}, { bubbles: true, cancelable: true, button: 0, ...${J(opts)} }));
    return true; })()`);
  const key = (k, opts = {}) => app.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown",
    { key: ${J(k)}, code: ${J(opts.code ?? "")}, ctrlKey: ${!!opts.ctrl}, shiftKey: ${!!opts.shift}, bubbles: true, cancelable: true })), true`);
  const setValue = (sel, value, ev = "change") => app.eval(`(() => { const el = document.querySelector(${J(sel)});
    el.value = ${J(value)}; el.dispatchEvent(new Event(${J(ev)}, { bubbles: true })); return true; })()`);
  const waitScan = (total) => app.waitFor(`document.getElementById("ps-grid").dataset.loading === "0" &&
    document.getElementById("ps-grid").dataset.total === ${J(String(total))}`, { timeoutMs: 30000, message: `scan of ${total}` });
  /** Types a folder into the address bar (pencil button) and presses Enter. */
  const openPath = (p) => app.eval(`(() => { document.getElementById("ps-path-edit").click();
    const i = document.getElementById("ps-path"); i.value = ${J(p)}; i.form.requestSubmit(); return true; })()`);
  const invoke = (cmd, args) => app.eval(`__TAURI__.core.invoke(${J(cmd)}, ${J(args)})`, { timeoutMs: 30000 });

  try {
    await t.test("open from the titlebar: grid shows every photo + the video", async () => {
      assert.ok(await app.eval(`!!document.getElementById("btn-open-studio")`), "start screen button");
      await app.click("#btn-photo-studio");
      assert.equal(await app.eval(`document.getElementById("photo-studio").hidden`), false);
      assert.equal(await app.eval(`document.getElementById("ps-empty").hidden`), false, "no folder yet: empty state");
      await app.waitFor(`document.querySelectorAll("#ps-tree .ps-tree-node").length > 0`, { message: "folder tree roots" });
      await openPath(SET);
      await waitScan(301);
      assert.equal(await app.eval(`[...document.querySelectorAll("#ps-breadcrumb .ps-crumb")].pop().textContent`), "set");
      assert.equal(await grid("count"), "301");
      const rendered = Number(await grid("rendered"));
      assert.ok(rendered > 0 && rendered < 301, `virtualised: ${rendered} cells in the DOM`);
      // Thumbnails of the first screen arrive through photo-thumb events
      await app.waitFor(`document.querySelector(${J(cell(1) + " img")})?.src.includes("asset")`, { timeoutMs: 20000, message: "first thumbnail" });
      assert.equal(await app.eval(`document.querySelector(${J(cell(0))}).classList.contains("is-video")`), true, "clip.mp4 with video icon");
      assert.match(await app.text("#ps-status"), /^301 öğe · 300 fotoğraf, 1 video/);
    });

    await t.test("sort by name / date / size / EXIF date, descending", async () => {
      const expect = (key, desc = false) => sortItems(all, key, desc).slice(0, 12).map((x) => x.name);
      assert.deepEqual(await names(), expect("name"));
      assert.deepEqual((await names(4)).slice(1), ["IMG_1.jpg", "IMG_2.jpg", "IMG_3.png"]);
      await setValue("#ps-sort", "date");
      assert.deepEqual(await names(), expect("date"));
      await setValue("#ps-sort", "size");
      assert.deepEqual(await names(), expect("size"));
      await app.click("#ps-sort-dir");
      assert.deepEqual(await names(), expect("size", true));
      await app.click("#ps-sort-dir");
      await setValue("#ps-sort", "exifDate"); // needs capture dates -> rescan with exifDates
      await waitScan(301);
      assert.deepEqual(await names(), expect("exifDate"));
      await setValue("#ps-sort", "name");
      assert.deepEqual(await names(), expect("name"));
    });

    await t.test("filter by type / date and search by name", async () => {
      await setValue("#ps-filter-type", "video");
      assert.equal(await grid("count"), "1");
      await setValue("#ps-filter-type", "photo");
      assert.equal(await grid("count"), "300");
      await setValue("#ps-search", "img_1", "input");
      const expected = all.filter((x) => x.name.toLowerCase().includes("img_1") && x.kind !== "video").length;
      await app.waitFor(`document.getElementById("ps-grid").dataset.count === ${J(String(expected))}`, { message: "search result" });
      await setValue("#ps-search", "", "input");
      await setValue("#ps-filter-type", "all");
      // Date range on the capture date: only the first day (EXIF date = BASE + (7i mod 300) days)
      await setValue("#ps-date-from", "2021-01-01");
      await setValue("#ps-date-to", "2021-01-01");
      await app.waitFor(`document.getElementById("ps-grid").dataset.count === "1"`, { message: "date range" });
      assert.deepEqual(await names(1), ["IMG_300.png"]);
      await setValue("#ps-date-from", "");
      await setValue("#ps-date-to", "");
      assert.equal(await grid("count"), "301");
    });

    await t.test("selection: click, Ctrl, Shift, keyboard, Ctrl+A", async () => {
      await mouse(1);
      await mouse(4, { shiftKey: true });
      assert.equal(await grid("selected"), "4");
      await mouse(2, { ctrlKey: true });
      assert.equal(await grid("selected"), "3");
      await mouse(1);
      await key("ArrowRight");
      await key("ArrowRight", { shift: true });
      assert.equal(await grid("selected"), "2");
      assert.equal(await grid("focus"), "3");
      await key("a", { ctrl: true });
      assert.equal(await grid("selected"), "301");
      await key("Escape");
      assert.equal(await grid("selected"), "0");
      assert.equal(await app.eval(`document.getElementById("photo-studio").hidden`), false, "Esc first clears the selection");
    });

    await t.test("minimal UI: filters, actions and info closed by default; ⋯ and right-click menus", async () => {
      const hidden = (id) => app.eval(`document.getElementById(${J(id)}).hidden`);
      assert.equal(await hidden("ps-filters"), true);
      assert.equal(await hidden("ps-info"), true);
      assert.equal(await app.eval(`getComputedStyle(document.getElementById("ps-act-batch")).display === "none" ||
        getComputedStyle(document.querySelector(".ps-commands")).display === "none"`), true, "action buttons not in the toolbar");
      await app.click("#ps-filter-toggle");
      assert.equal(await hidden("ps-filters"), false);
      await app.click("#ps-filter-toggle");
      await mouse(1);
      await mouse(2, { ctrlKey: true });
      await app.click("#ps-more");
      const items = await app.eval(`[...document.querySelectorAll(".ps-menu:not([hidden]) .ps-menu-item")].map((b) => [b.dataset.menu, b.disabled])`);
      assert.deepEqual(Object.fromEntries(items).compare, false, "compare enabled for 2 photos");
      assert.ok(items.some(([id]) => id === "batch"));
      await key("Escape");
      assert.equal(await app.eval(`!!document.querySelector(".ps-menu:not([hidden])")`), false);
      // Right-click a cell: selects it and opens the same menu; the app-wide menu stays closed
      await app.eval(`(() => { const c = document.querySelector(${J(cell(5))}); const r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); return true; })()`);
      assert.equal(await grid("focus"), "5");
      assert.equal(await app.eval(`!!document.querySelector('.ps-menu:not([hidden]) [data-menu="edit"]:not(:disabled)')`), true);
      await app.eval(`document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
      assert.equal(await app.eval(`!!document.querySelector(".ps-menu:not([hidden])")`), false);
    });

    await t.test("info panel: EXIF rows, histogram, GPS map tab (Leaflet vendored)", async () => {
      await mouse(1); // IMG_1.jpg
      await app.click("#ps-act-info");
      await app.waitFor(`document.getElementById("ps-info").dataset.loaded === ${J(manifest[0].path)}`, { timeoutMs: 10000, message: "info loaded" });
      const rows = await app.eval(`Object.fromEntries([...document.querySelectorAll("#ps-info dt")].map((d) => [d.textContent, d.nextElementSibling.textContent]))`);
      assert.equal(rows["Kamera"], "VHO Test Kamera 1");
      assert.equal(rows["Boyutlar"], "640 × 480 (0,3 MP)");
      assert.match(rows["Çekim tarihi"], /^08\.01\.2021 10:00:01/);
      assert.match(rows["Konum"], /^41\.00100, 28\.97100/);
      assert.ok(Number(await app.eval(`document.querySelector("#ps-info .ps-histogram").dataset.pixels`)) > 1000, "histogram from thumbnail");
      assert.equal(await app.eval(`document.getElementById("ps-info").dataset.hasGps`), "1");
      assert.equal(await app.eval(`document.querySelector('[data-tab-btn="map"]').disabled`), false);
      assert.equal(await app.eval(`fetch("vendor/leaflet/leaflet.js").then((r) => r.ok)`), true);
      assert.equal(await app.eval(`fetch("vendor/leaflet/LICENSE").then((r) => r.text()).then((t) => t.startsWith("BSD 2-Clause"))`), true);
      // Tiles are only requested when the map tab is opened: nothing loaded yet
      assert.equal(await app.eval(`typeof window.L`), "undefined");
      await mouse(3); // IMG_3.png: no GPS
      await app.waitFor(`document.getElementById("ps-info").dataset.loaded === ${J(manifest[2].path)}`, { message: "png info" });
      assert.equal(await app.eval(`document.querySelector('[data-tab-btn="map"]').disabled`), true);
      await app.click("#ps-act-info");
    });

    await t.test("double-click opens the viewer; ←/→ navigate the folder; filmstrip; Esc returns", async () => {
      await mouse(1, {}, "dblclick");
      const shown = (name, counter) => app.waitFor(`document.getElementById("image-element").complete &&
        document.getElementById("image-element").naturalWidth > 0 &&
        document.getElementById("current-filename").textContent === ${J(name)} &&
        document.getElementById("photo-counter-badge").textContent === ${J(counter)}`, { timeoutMs: 10000, message: `${name} shown` });
      await shown("IMG_1.jpg", "1 / 300");
      assert.equal(await app.eval(`document.getElementById("photo-studio").hidden`), true);
      assert.equal(await app.eval(`document.getElementById("ps-filmstrip").hidden`), false);
      assert.equal(await app.eval(`document.querySelector("#ps-filmstrip .ps-strip-item.active").dataset.index`), "0");
      await app.key("ArrowRight");
      await shown("IMG_2.jpg", "2 / 300");
      await app.key("ArrowRight");
      await shown("IMG_3.png", "3 / 300");
      assert.equal(await app.eval(`document.querySelector("#ps-filmstrip .ps-strip-item.active").dataset.index`), "2");
      await app.key("ArrowLeft");
      await shown("IMG_2.jpg", "2 / 300");
      await app.click(`#ps-filmstrip .ps-strip-item[data-index="9"]`);
      await shown("IMG_10.jpg", "10 / 300");
      // EXIF orientation 6 is applied by the webview: 640x480 stored -> 480 wide
      assert.equal(await app.eval(`document.getElementById("image-element").naturalWidth`), 480);
      await key("Escape", { code: "Escape" });
      assert.equal(await app.eval(`document.getElementById("photo-studio").hidden`), false);
      const focus = Number(await grid("focus"));
      assert.equal(await app.eval(`document.querySelector(${J(cell(focus))}).title`), "IMG_10.jpg");
    });

    await t.test("editor: crop 1:1 + save copy -> 480x480; rotate + save (confirm) overwrites losslessly", async () => {
      await mouse(1);
      await app.click("#ps-act-edit");
      await app.waitFor(`document.getElementById("ps-editor").dataset.ready === "1"`, { timeoutMs: 15000, message: "editor ready" });
      assert.equal(await app.eval(`document.getElementById("ps-editor").dataset.full`), "640x480");
      await app.click(`#ps-editor [data-act="crop"]`);
      await app.click(`#ps-editor [data-ratio="1:1"]`);
      await app.click(`#ps-editor [data-act="crop-apply"]`);
      assert.deepEqual(JSON.parse(await app.eval(`document.getElementById("ps-editor").dataset.ops`)), [{ op: "crop", x: 80, y: 0, width: 480, height: 480 }]);
      await app.click(`#ps-editor [data-act="save-copy"]`);
      const r1 = JSON.parse(await app.waitFor(`document.getElementById("ps-editor").dataset.lastResult`, { timeoutMs: 15000, message: "copy saved" }));
      assert.ok(r1.ok, J(r1));
      assert.equal(r1.output, join(SET, "IMG_1_düzenlendi.jpg"));
      assert.deepEqual([r1.width, r1.height], [480, 480]);
      assert.deepEqual(jpegSize(readFileSync(r1.output)), { width: 480, height: 480 });
      assert.deepEqual(jpegSize(readFileSync(manifest[0].path)), { width: 640, height: 480 }, "original untouched");
      // Undo / redo
      await app.click(`#ps-editor [data-act="undo"]`);
      assert.equal(await app.eval(`document.getElementById("ps-editor").dataset.ops`), "[]");
      await app.click(`#ps-editor [data-act="redo"]`);
      assert.notEqual(await app.eval(`document.getElementById("ps-editor").dataset.ops`), "[]");
      // Rotate + Save: declined confirmation writes nothing
      await app.click(`#ps-editor [data-act="reset"]`);
      await app.click(`#ps-editor [data-act="rotr"]`);
      await app.click(`#ps-editor [data-act="save"]`);
      assert.equal((await app.eval("window.__confirms")).length, 1);
      assert.equal(JSON.parse(await app.eval(`document.getElementById("ps-editor").dataset.lastResult`)).output, r1.output);
      await app.eval(`window.confirm = (m) => (__confirms.push(String(m)), true)`);
      await app.click(`#ps-editor [data-act="save"]`);
      const r2 = JSON.parse(await app.waitFor(`(() => { const r = JSON.parse(document.getElementById("ps-editor").dataset.lastResult || "{}");
        return r.output === ${J(manifest[0].path)} && document.getElementById("ps-editor").dataset.ready === "1" ? JSON.stringify(r) : ""; })()`, { timeoutMs: 15000, message: "overwrite" }));
      assert.ok(r2.ok && r2.lossless, J(r2));
      assert.deepEqual([r2.width, r2.height], [480, 640]);
      assert.deepEqual(jpegSize(readFileSync(manifest[0].path)), { width: 640, height: 480 }, "pixels untouched (EXIF orientation)");
      const info = await invoke("photo_info", { path: manifest[0].path });
      assert.deepEqual([info.width, info.height, info.exif.orientation], [480, 640, 6]);
      await app.eval(`window.confirm = (m) => (__confirms.push(String(m)), false)`);
      await app.click(`#ps-editor [data-act="close"]`);
      assert.equal(await app.eval(`document.getElementById("ps-editor").hidden`), true);
      await waitScan(302); // the copy appears in the folder
    });

    await t.test("compare 2 photos with synchronised zoom", async () => {
      await mouse(4);
      await mouse(5, { ctrlKey: true });
      await app.click("#ps-act-compare");
      await app.waitFor(`document.getElementById("ps-compare").dataset.loaded === "2"`, { timeoutMs: 10000, message: "compare loaded" });
      await app.eval(`(() => { const p = document.querySelector(".ps-compare-pane"); const r = p.getBoundingClientRect();
        p.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); return true; })()`);
      assert.equal(await app.eval(`document.getElementById("ps-compare").dataset.zoom`), "1.150");
      const transforms = await app.eval(`[...document.querySelectorAll(".ps-compare-pane img")].map((i) => i.style.transform)`);
      assert.equal(transforms.length, 2);
      assert.equal(transforms[0], transforms[1]);
      assert.match(transforms[0], /scale\(1\.15\)/);
      await key("Escape");
      assert.equal(await app.eval(`document.getElementById("ps-compare").hidden`), true);
    });

    await t.test("batch: rename + convert to WebP keeps the EXIF date", async () => {
      // IMG_2 .. IMG_9 (8 files: JPEG + PNG)
      const idx = async (name) => app.eval(`(() => { for (const c of document.querySelectorAll("#ps-grid .ps-cell")) if (c.title === ${J(name)}) return Number(c.dataset.index); return -1; })()`);
      const a = await idx("IMG_2.jpg"), b = await idx("IMG_9.png");
      assert.ok(a > 0 && b > a, `${a}..${b}`);
      await mouse(a);
      await mouse(b, { shiftKey: true });
      assert.equal(await grid("selected"), "8");
      await app.click("#ps-act-batch");
      await setValue(`#ps-batch input[name="template"]`, "{name}_conv_{counter:2}", "input");
      await setValue(`#ps-batch select[name="format"]`, "webp");
      const preview = await app.eval(`[...document.querySelectorAll("#ps-batch .ps-to")].map((e) => e.textContent)`);
      assert.deepEqual(preview.slice(0, 2), ["IMG_2_conv_01.webp", "IMG_3_conv_02.webp"]);
      await app.click(`#ps-batch [data-act="start"]`);
      const s = JSON.parse(await app.waitFor(`document.getElementById("ps-batch").dataset.summary`, { timeoutMs: 60000, message: "batch done" }));
      assert.deepEqual([s.total, s.succeeded, s.failed, s.cancelled], [8, 8, 0, false]);
      assert.equal(await app.eval(`document.querySelector("#ps-batch .ps-progress-bar").style.width`), "100%");
      for (let i = 2; i <= 9; i++) {
        const out = join(SET, `IMG_${i}_conv_${String(i - 1).padStart(2, "0")}.webp`);
        assert.ok(existsSync(out), out);
        const src = await invoke("photo_info", { path: manifest[i - 1].path });
        const dst = await invoke("photo_info", { path: out });
        assert.equal(dst.format, "webp");
        assert.equal(dst.exif?.dateTaken, src.exif.dateTaken, `EXIF date kept for ${out}`);
      }
      await app.click(`#ps-batch [data-act="close"]`);
      await waitScan(310);
    });

    await t.test("batch: cancel a long AVIF conversion", async () => {
      await key("a", { ctrl: true });
      await app.click("#ps-act-batch");
      await setValue(`#ps-batch input[name="template"]`, "{name}_avif", "input");
      await setValue(`#ps-batch select[name="format"]`, "avif");
      await app.click(`#ps-batch [data-act="start"]`);
      await app.waitFor(`document.getElementById("ps-batch").dataset.running === "1"`, { message: "running" });
      await app.click(`#ps-batch [data-act="cancel"]`);
      const s = JSON.parse(await app.waitFor(`document.getElementById("ps-batch").dataset.summary`, { timeoutMs: 120000, message: "cancelled batch" }));
      assert.equal(s.cancelled, true, J(s));
      assert.ok(s.succeeded < s.total, J(s));
      t.diagnostic(`AVIF batch cancelled after ${s.succeeded}/${s.total} files (${s.elapsedMs} ms)`);
      await app.click(`#ps-batch [data-act="close"]`);
      assert.equal(await app.eval(`document.getElementById("ps-batch").hidden`), true);
    });

    await t.test("performance: 5,000-file folder, first grid paint", async () => {
      makeBulkFolder(BULK, 5000);
      const started = Date.now();
      await openPath(BULK);
      await waitScan(5000);
      const firstPaint = Number(await grid("firstPaintMs"));
      const scanMs = Number(await grid("scanMs"));
      await app.waitFor(`(() => { const imgs = [...document.querySelectorAll("#ps-grid .ps-cell img")];
        return imgs.length > 0 && imgs.every((i) => i.src.includes("asset") || i.closest(".ps-cell").getBoundingClientRect().top > innerHeight); })()`,
      { timeoutMs: 60000, intervalMs: 50, message: "first screen thumbnails" });
      const thumbsMs = Date.now() - started;
      const rendered = Number(await grid("rendered"));
      await app.eval(`document.getElementById("ps-grid").scrollTop = 200000, true`);
      await app.waitFor(`Number(document.getElementById("ps-grid").dataset.rendered) > 0 &&
        [...document.querySelectorAll("#ps-grid .ps-cell")].some((c) => Number(c.dataset.index) > 1000)`, { message: "scrolled window" });
      const renderedAfter = Number(await grid("rendered"));
      t.diagnostic(`5000 files: first grid paint ${firstPaint} ms, scan+view ${scanMs} ms, first screen thumbnails (cold cache, 640x480 JPEG) ${thumbsMs} ms, DOM cells ${rendered}/${renderedAfter}`);
      console.log(`[perf] 5000 files: first grid paint ${firstPaint} ms; scan complete ${scanMs} ms; first-screen thumbnails ${thumbsMs} ms; DOM cells ${rendered} (after scroll ${renderedAfter})`);
      assert.ok(firstPaint < 2000, `first paint ${firstPaint} ms`);
      // Favourites: star the folder, it is listed and persisted in the settings store
      await app.click("#ps-fav-toggle");
      assert.equal(await app.eval(`document.querySelector("#ps-favorites .ps-fav")?.dataset.path`), BULK);
      assert.equal(await app.text("#ps-fav-toggle"), "★");
      let stored;
      for (let i = 0; i < 40 && !stored; i++) {
        try {
          const s = JSON.parse(readFileSync(join(app.dataDir, "settings.json"), "utf8"));
          if (s.settings?.values?.["photo.studio.favorites"]?.paths?.includes(BULK)) stored = s.settings.values;
        } catch { /* being written */ }
        if (!stored) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(stored, "favourites persisted in settings.json");
      assert.equal(stored["photo.studio.lastFolder"], BULK);
      assert.ok(rendered < 300 && renderedAfter < 300, "virtualised");
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
      assert.deepEqual(await app.blockedCalls(), []);
    });
  } finally {
    await app.close();
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
