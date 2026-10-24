// Photo studio pure helpers (src/studio/logic.js, batch.js form mapping).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjustFactors, adjustPixel, adjustImageData, baseName, batchPreview, clampCrop, compareColumns, computeHistogram,
  createHistory, createSettings, cropForRatio, cropPixels, cropRotateCW, dateInputToMs, dateToken, dragCropCorner,
  editFlip, editRotate, editToOps, emptySelection, filterItems, formatBytes, formatExifDate, gridWindow, infoRows,
  initialEdit, isEditIdentity, memoryStorage, naturalCompare, outputExt, parentDir, pathSegments, reconcileSelection,
  renderName, scrollToShow, selectAll, selectClick, selectMove, selectedInOrder, sharpenImageData, sortItems,
  stripWindow, stemOf, toggleFavorite, zoomAt,
} from "../../src/studio/logic.js";
import { batchJobFromForm } from "../../src/studio/batch.js";

const it = (name, o = {}) => ({ path: `C:\\p\\${name}`, name, ext: name.split(".").pop().toLowerCase(), kind: "image", size: 100, mtime: 1000, ...o });

test("paths: baseName, parentDir, stemOf, breadcrumb segments", () => {
  assert.equal(baseName("C:\\a\\b\\c.jpg"), "c.jpg");
  assert.equal(baseName("/home/u/x.png"), "x.png");
  assert.equal(parentDir("C:\\a\\b\\c.jpg"), "C:\\a\\b");
  assert.equal(parentDir("C:\\a"), "C:\\");
  assert.equal(parentDir("C:\\"), "");
  assert.equal(parentDir("/home/u"), "/home");
  assert.equal(parentDir("/home"), "/");
  assert.equal(stemOf("a.b.jpg"), "a.b");
  assert.equal(stemOf(".hidden"), ".hidden");
  assert.deepEqual(pathSegments("C:\\Users\\me"), [
    { name: "C:", path: "C:\\" }, { name: "Users", path: "C:\\Users" }, { name: "me", path: "C:\\Users\\me" },
  ]);
  assert.deepEqual(pathSegments("/home/u").map((s) => s.path), ["/home", "/home/u"]);
});

test("naturalCompare matches the backend's natural order", () => {
  const v = ["IMG_10.jpg", "img_2.jpg", "IMG_1.jpg", "b.jpg", "a10b", "a9b", "IMG_01.jpg"];
  v.sort(naturalCompare);
  assert.deepEqual(v, ["a9b", "a10b", "b.jpg", "IMG_1.jpg", "IMG_01.jpg", "img_2.jpg", "IMG_10.jpg"]);
});

test("sortItems: name / date / size / exifDate, descending, stable ties", () => {
  const items = [
    it("IMG_10.jpg", { mtime: 3, size: 5, exifDate: 50 }),
    it("IMG_2.jpg", { mtime: 1, size: 9 }),
    it("IMG_1.jpg", { mtime: 2, size: 5, exifDate: 10 }),
  ];
  const names = (a) => a.map((x) => x.name);
  assert.deepEqual(names(sortItems(items, "name")), ["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"]);
  assert.deepEqual(names(sortItems(items, "date")), ["IMG_2.jpg", "IMG_1.jpg", "IMG_10.jpg"]);
  assert.deepEqual(names(sortItems(items, "size")), ["IMG_1.jpg", "IMG_10.jpg", "IMG_2.jpg"]);
  // IMG_2 has no EXIF date -> falls back to mtime (1)
  assert.deepEqual(names(sortItems(items, "exifDate")), ["IMG_2.jpg", "IMG_1.jpg", "IMG_10.jpg"]);
  assert.deepEqual(names(sortItems(items, "name", true)), ["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg"]);
  assert.equal(items[0].name, "IMG_10.jpg", "input not mutated");
});

test("filterItems: type, date range, Turkish-aware name search", () => {
  const day = (d) => new Date(2024, 4, d, 12).getTime();
  const items = [
    it("İstanbul.jpg", { mtime: day(1) }),
    it("ışık.CR2", { kind: "raw", mtime: day(5) }),
    it("clip.mp4", { kind: "video", mtime: day(9) }),
    it("x.heic", { kind: "heif", mtime: day(20) }),
  ];
  const n = (f) => filterItems(items, f).map((x) => x.name);
  assert.deepEqual(n({ type: "photo" }), ["İstanbul.jpg", "ışık.CR2", "x.heic"]);
  assert.deepEqual(n({ type: "video" }), ["clip.mp4"]);
  assert.deepEqual(n({ type: "raw" }), ["ışık.CR2"]);
  assert.deepEqual(n({ query: "istanbul" }), ["İstanbul.jpg"]);
  assert.deepEqual(n({ query: "IŞIK" }), ["ışık.CR2"]);
  assert.deepEqual(n({ query: "isik" }), ["ışık.CR2"]);
  assert.deepEqual(filterItems([it("IMG_1.jpg")], { query: "img_1" }).length, 1, "ASCII I matches i");
  assert.deepEqual(n({ from: dateInputToMs("2024-05-05"), to: dateInputToMs("2024-05-09", true) }), ["ışık.CR2", "clip.mp4"]);
  assert.equal(dateInputToMs("bad"), null);
  // EXIF dates are wall clock stored as UTC
  const exif = [it("e.jpg", { exifDate: Date.UTC(2024, 4, 5, 23, 30), mtime: day(30) })];
  assert.equal(filterItems(exif, { from: dateInputToMs("2024-05-05"), to: dateInputToMs("2024-05-05", true) }).length, 1);
});

test("rename pattern: tokens, counter width, date, sanitising, preview dedupe", () => {
  const a = it("IMG_0001.JPG", { exifDate: Date.UTC(2024, 4, 17, 14, 30, 5) });
  assert.equal(renderName("{name}", a, 0), "IMG_0001");
  assert.equal(renderName("tatil_{counter:4}", a, 9, 1), "tatil_0010");
  assert.equal(renderName("{date}_{counter}", a, 0, 7), "20240517_143005_7");
  assert.equal(renderName("{name}-{ext}{unknown}", a, 0), "IMG_0001-jpg{unknown}");
  assert.equal(renderName("a/b:c", a, 0), "a_b_c");
  assert.equal(renderName("", a, 0), "IMG_0001");
  assert.equal(renderName("x...", a, 0), "x");
  assert.equal(dateToken(0), "19700101_000000");
  assert.equal(outputExt("same", "JPEG"), "jpeg");
  assert.equal(outputExt("same", "heic"), "jpg");
  assert.equal(outputExt("jpeg", "png"), "jpg");
  assert.equal(outputExt("webp", "jpg"), "webp");
  assert.equal(outputExt("same", "tiff"), "tiff");
  const rows = batchPreview([it("a.jpg"), it("b.jpg"), it("c.png")], { nameTemplate: "foto", format: "jpeg" });
  assert.deepEqual(rows.map((r) => r.to), ["foto.jpg", "foto (1).jpg", "foto (2).jpg"]);
  assert.deepEqual(batchPreview([it("a.jpg")], { nameTemplate: "{name}_{counter:2}", counterStart: 5, format: "png" })[0], { from: "a.jpg", to: "a_05.png" });
});

test("selection: click, ctrl toggle, shift range, keyboard, select all, reconcile", () => {
  const paths = ["a", "b", "c", "d", "e"];
  let s = selectClick(emptySelection(), 1, {}, paths);
  assert.deepEqual([...s.selected], ["b"]);
  s = selectClick(s, 3, { shift: true }, paths);
  assert.deepEqual(selectedInOrder(s, paths), ["b", "c", "d"]);
  s = selectClick(s, 0, { ctrl: true }, paths);
  assert.deepEqual(selectedInOrder(s, paths), ["a", "b", "c", "d"]);
  s = selectClick(s, 2, { ctrl: true }, paths);
  assert.deepEqual(selectedInOrder(s, paths), ["a", "b", "d"]);
  assert.equal(s.anchor, 2);
  s = selectClick(s, 4, { shift: true, ctrl: true }, paths);
  assert.deepEqual(selectedInOrder(s, paths), ["a", "b", "c", "d", "e"]);
  // Keyboard
  s = selectMove(emptySelection(), 1, {}, paths);
  assert.equal(s.focus, 0);
  s = selectMove(s, 2, { shift: true }, paths);
  assert.deepEqual(selectedInOrder(s, paths), ["a", "b", "c"]);
  s = selectMove(s, 100, {}, paths);
  assert.deepEqual([...s.selected], ["e"]);
  s = selectMove(s, -1, { ctrl: true }, paths);
  assert.equal(s.focus, 3);
  assert.deepEqual([...s.selected], ["e"], "ctrl moves focus only");
  s = selectAll(paths, s);
  assert.equal(s.selected.size, 5);
  const r = reconcileSelection({ selected: new Set(["b", "d"]), anchor: 1, focus: 3 }, paths, ["d", "x", "b"]);
  assert.deepEqual([...r.selected].sort(), ["b", "d"]);
  assert.deepEqual([r.anchor, r.focus], [2, 0]);
});

test("virtual grid window: columns, visible range, overscan, totals", () => {
  const base = { count: 10000, width: 1000, height: 600, cellWidth: 160, cellHeight: 184, gap: 8, overscan: 2 };
  let w = gridWindow({ ...base, scrollTop: 0 });
  assert.equal(w.cols, 6);
  assert.equal(w.rows, Math.ceil(10000 / 6));
  assert.equal(w.totalHeight, w.rows * 192 - 8);
  assert.equal(w.start, 0);
  assert.equal(w.lastRow, Math.floor(600 / 192) + 2);
  assert.equal(w.end, (w.lastRow + 1) * 6);
  w = gridWindow({ ...base, scrollTop: 192 * 100 });
  assert.equal(w.firstRow, 98);
  assert.equal(w.start, 98 * 6);
  assert.ok(w.end - w.start <= 6 * 9, "only a few rows rendered");
  w = gridWindow({ ...base, scrollTop: 1e9 });
  assert.equal(w.end, 10000);
  assert.deepEqual(gridWindow({ ...base, count: 0 }).end, 0);
  assert.equal(gridWindow({ ...base, width: 50 }).cols, 1);
  // scrollToShow
  const geo = { cols: 6, cellHeight: 184, gap: 8, height: 600, scrollTop: 0 };
  assert.equal(scrollToShow(5, geo), 0);
  assert.equal(scrollToShow(6 * 10, geo), 10 * 192 + 184 - 600);
  assert.equal(scrollToShow(0, { ...geo, scrollTop: 500 }), 0);
});

test("histogram binning (RGBA, skips transparent, luma, step)", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    10, 10, 10, 0, // transparent: ignored
    128, 128, 128, 255,
  ]);
  const h = computeHistogram(data);
  assert.equal(h.count, 4);
  assert.equal(h.r[255], 1);
  assert.equal(h.r[0], 2);
  assert.equal(h.g[255], 1);
  assert.equal(h.b[255], 1);
  assert.equal(h.l[54], 1); // 0.2126*255
  assert.equal(h.l[182], 1); // 0.7152*255
  assert.equal(h.l[18], 1);
  assert.equal(h.l[128], 1);
  assert.equal(h.max, 2);
  assert.equal(computeHistogram(data, 2).count, 3);
});

test("colour adjustments match ops.rs reference values", () => {
  const a = (b, c, s, t, px) => adjustPixel(px, adjustFactors({ brightness: b, contrast: c, saturation: s, temperature: t }));
  assert.deepEqual(a(0, 0, 0, 0, [10, 128, 250]), [10, 128, 250]);
  assert.deepEqual(a(50, 0, 0, 0, [100, 100, 100]), [150, 150, 150]);
  assert.deepEqual(a(-100, 0, 0, 0, [200, 50, 9]), [0, 0, 0]);
  assert.deepEqual(a(0, 100, 0, 0, [100, 200, 128]), [73, 255, 129]);
  assert.deepEqual(a(0, -100, 0, 0, [0, 255, 30]), [128, 128, 128]);
  assert.deepEqual(a(0, 0, -100, 0, [255, 0, 0]), [54, 54, 54]);
  assert.deepEqual(a(0, 0, 0, 100, [100, 100, 100]), [115, 100, 85]);
  assert.deepEqual(a(20, 10, 30, -40, [120, 80, 40]), [147, 91, 27]);
  const d = new Uint8ClampedArray([100, 100, 100, 77]);
  adjustImageData(d, { brightness: 100 });
  assert.deepEqual([...d], [200, 200, 200, 77]);
});

test("sharpen: flat areas unchanged, edges boosted, alpha kept", () => {
  // 4x1 image: two dark then two bright pixels
  const px = (v) => [v, v, v, 200];
  const data = new Uint8ClampedArray([...px(50), ...px(50), ...px(150), ...px(150)]);
  const out = sharpenImageData(data, 4, 1, 100);
  assert.equal(out[0], 50);
  assert.equal(out[4], 0); // 50 + (4*50 - 50 - 50 - 50 - 150) = -50 -> 0
  assert.equal(out[8], 250);
  assert.equal(out[12], 150);
  assert.equal(out[3], 200);
  assert.equal(sharpenImageData(data, 4, 1, 0), data);
});

test("crop geometry: ratio presets, corner drag with ratio, pixel rects", () => {
  assert.deepEqual(cropForRatio(1, 640, 480), { x: 0.125, y: 0, w: 0.75, h: 1 });
  assert.deepEqual(cropForRatio(null, 640, 480), { x: 0, y: 0, w: 1, h: 1 });
  const c = cropForRatio(16 / 9, 400, 400);
  assert.ok(Math.abs(c.w - 1) < 1e-9 && Math.abs(c.h - 0.5625) < 1e-9);
  // free drag of the south-east corner
  let r = dragCropCorner({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "se", 0.9, 0.7, null, 100, 100);
  assert.deepEqual(r, { x: 0.1, y: 0.1, w: 0.8, h: 0.6 });
  // ratio 1:1 on a square image: the smaller side wins
  r = dragCropCorner({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, "se", 0.9, 0.5, 1, 100, 100);
  assert.ok(Math.abs(r.w - 0.4) < 1e-9 && Math.abs(r.h - 0.4) < 1e-9);
  // north-west keeps the opposite corner fixed
  r = dragCropCorner({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, "nw", 0, 0, null, 100, 100);
  assert.deepEqual(r, { x: 0, y: 0, w: 0.7, h: 0.7 });
  assert.deepEqual(clampCrop({ x: 0.9, y: -1, w: 0.5, h: 2 }), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(cropPixels({ x: 0.125, y: 0, w: 0.75, h: 1 }, 640, 480), { x: 80, y: 0, width: 480, height: 480 });
});

test("edit model: rotate/flip move the crop, ops for the backend", () => {
  let e = initialEdit();
  assert.ok(isEditIdentity(e));
  assert.deepEqual(editToOps(e, 640, 480), []);
  e = { ...e, crop: { x: 0, y: 0, w: 0.5, h: 0.25 } };
  // top-left strip -> after 90° CW it is on the right edge
  assert.deepEqual(cropRotateCW(e.crop), { x: 0.75, y: 0, w: 0.25, h: 0.5 });
  e = editRotate(e, 90);
  assert.equal(e.rotation, 90);
  assert.deepEqual(e.crop, { x: 0.75, y: 0, w: 0.25, h: 0.5 });
  e = editRotate(e, -90);
  assert.deepEqual(e.crop, { x: 0, y: 0, w: 0.5, h: 0.25 });
  e = editFlip(e, "horizontal");
  assert.deepEqual(e.crop, { x: 0.5, y: 0, w: 0.5, h: 0.25 });
  // a flip swaps axes when combined with a 90° turn
  const f = editRotate({ ...initialEdit(), flipH: true }, 90);
  assert.equal(f.flipV, true);
  assert.equal(f.flipH, false);
  const ops = editToOps({
    ...initialEdit(), rotation: 90, flipH: true, crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
    adjust: { brightness: 10, contrast: 0, saturation: 0, temperature: -5 }, sharpen: 30,
  }, 640, 480);
  assert.deepEqual(ops, [
    { op: "rotate", degrees: 90 },
    { op: "flip", axis: "horizontal" },
    { op: "crop", x: 0, y: 0, width: 240, height: 320 },
    { op: "adjust", brightness: 10, contrast: 0, saturation: 0, temperature: -5 },
    { op: "sharpen", amount: 30 },
  ]);
  // full-frame crop is not sent
  assert.deepEqual(editToOps({ ...initialEdit(), crop: { x: 0, y: 0, w: 1, h: 1 } }, 10, 10), []);
});

test("undo / redo history", () => {
  const h = createHistory({ v: 0 });
  assert.equal(h.canUndo, false);
  h.push({ v: 1 });
  h.push({ v: 2 });
  h.push({ v: 2 }); // no-op duplicate
  assert.deepEqual(h.undo(), { v: 1 });
  assert.deepEqual(h.undo(), { v: 0 });
  assert.deepEqual(h.undo(), { v: 0 });
  assert.deepEqual(h.redo(), { v: 1 });
  h.push({ v: 9 });
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.state, { v: 9 });
  const small = createHistory(0, 2);
  [1, 2, 3].forEach((v) => small.push(v));
  small.undo(); small.undo();
  assert.equal(small.canUndo, false);
  assert.equal(small.state, 1);
});

test("settings adapter: Storage backend, store backend, favourites", () => {
  const mem = memoryStorage();
  const s = createSettings(mem);
  assert.equal(s.get("x", 5), 5);
  s.set("favorites", ["C:\\A"]);
  assert.equal(mem.getItem("vho.studio.favorites"), '["C:\\\\A"]');
  assert.deepEqual(s.get("favorites", []), ["C:\\A"]);
  mem.setItem("vho.studio.bad", "{");
  assert.equal(s.get("bad", "fallback"), "fallback");
  // Switch to a key/value store (B2's settings store shape)
  const store = new Map();
  s.use({ get: (k) => store.get(k), set: (k, v) => store.set(k, v) });
  s.set("sort", "size");
  assert.equal(store.get("vho.studio.sort"), "size");
  assert.equal(s.get("sort", "name"), "size");
  assert.equal(s.get("missing", 1), 1);
  assert.deepEqual(toggleFavorite(["C:\\A"], "c:\\a\\"), []);
  assert.deepEqual(toggleFavorite(["C:\\A"], "D:\\B"), ["C:\\A", "D:\\B"]);
});

test("info rows from photo_info", () => {
  const rows = Object.fromEntries(infoRows({
    name: "IMG.HEIC", size: 2345678, format: "heif", width: 3024, height: 4032,
    exif: {
      make: "Apple", model: "iPhone 15", lens: "Main", dateTaken: "2024-05-17T14:30:05", dateTakenOffset: "+03:00",
      exposureTime: "1/250", fNumber: 1.8, iso: 64, focalLength: 6.9, focalLength35mm: 26, exposureBias: 0, flash: "off",
      gps: { latitude: 41.01, longitude: 28.98, altitude: 39 },
    },
  }));
  assert.equal(rows["Kamera"], "Apple iPhone 15");
  assert.equal(rows["Boyutlar"], "3024 × 4032 (12,2 MP)");
  assert.equal(rows["Dosya boyutu"], "2,2 MB");
  assert.equal(rows["Çekim tarihi"], "17.05.2024 14:30:05 (UTC+03:00)");
  assert.equal(rows["Pozlama"], "1/250 sn · f/1,8 · ISO 64");
  assert.equal(rows["Odak uzaklığı"], "6,9 mm (35 mm: 26 mm)");
  assert.equal(rows["Flaş"], "Patlamadı");
  assert.equal(rows["Konum"], "41.01000, 28.98000 · 39 m");
  assert.equal(rows["Biçim"], "HEIF");
  assert.deepEqual(infoRows(null), []);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatExifDate("bad"), "bad");
});

test("batch form -> photo_batch job", () => {
  const j = batchJobFromForm({
    template: " tatil_{counter:3} ", counterStart: "1", format: "webp", quality: "80", resizeMode: "longEdge",
    resizeValue: "1920", rotate: "90", metadata: "stripGps", dest: "same", dir: "C:\\x", removeSource: false,
  });
  assert.deepEqual(j.ops, [{ op: "rotate", degrees: 90 }, { op: "resize", longEdge: 1920 }]);
  assert.equal(j.output.nameTemplate, "tatil_{counter:3}");
  assert.equal(j.output.format, "webp");
  assert.equal(j.output.quality, 80);
  assert.equal(j.output.metadata, "stripGps");
  assert.equal(j.output.dir, null, "dir only for dest=dir");
  assert.equal(j.output.conflict, "rename");
  const k = batchJobFromForm({ template: "", resizeMode: "percent", resizeValue: "50", rotate: "0", dest: "dir", dir: "D:\\out", removeSource: true });
  assert.deepEqual(k.ops, [{ op: "resize", percent: 50 }]);
  assert.equal(k.output.nameTemplate, "{name}");
  assert.equal(k.output.dir, "D:\\out");
  assert.equal(k.output.removeSource, true);
  assert.equal(k.output.format, "same");
});

test("compare zoom/pan and filmstrip window", () => {
  let v = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, 100, 50);
  assert.deepEqual(v, { zoom: 2, x: -100, y: -50 });
  v = zoomAt(v, 0.25, 0, 0);
  assert.deepEqual(v, { zoom: 0.5, x: 0, y: 0 });
  assert.equal(zoomAt({ zoom: 10, x: 0, y: 0 }, 10).zoom, 16);
  assert.deepEqual([2, 3, 4].map(compareColumns), [2, 3, 2]);
  assert.deepEqual(stripWindow(0, 100, 9), { start: 0, end: 9 });
  assert.deepEqual(stripWindow(50, 100, 9), { start: 46, end: 55 });
  assert.deepEqual(stripWindow(99, 100, 9), { start: 91, end: 100 });
  assert.deepEqual(stripWindow(3, 5, 9), { start: 0, end: 5 });
});
