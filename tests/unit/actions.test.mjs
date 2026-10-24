// Media actions (Plan 06): pure helpers, LRC parser, shortcut table, i18n keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenKeys, lookup } from "../../src/core/i18n.js";
import { findConflicts } from "../../src/core/keymap.js";
import {
  ACTION_SHORTCUTS, basename, bestOrientation, checkRange, defaultRange, dirname as dirOf, errorCode, errorText,
  formatBytes, formatTimePrecise, mediaKind, newJobId, ocrLayer, parseTime, printLayout, removeAt, renamedItem,
  splitName, toggleFavorite, validateFileName,
} from "../../src/media/actions-logic.js";
import { formatStamp, lineIndexAt, parseLrc } from "../../src/media/lyrics.js";
import { defaultActions } from "../../src/ui/shortcuts.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const dict = (lang) => JSON.parse(readFileSync(join(SRC, "i18n", `${lang}.json`), "utf8"));

test("actions: media kind per item", () => {
  assert.equal(mediaKind(null), "none");
  assert.equal(mediaKind({ name: "a.jpg", isImage: true }), "photo");
  assert.equal(mediaKind({ name: "a.mp4" }), "video");
  assert.equal(mediaKind({ name: "a.flac" }), "music");
  assert.equal(mediaKind({ name: "clip.mkv" }, { audioOnly: true }), "music"); // audio-only container
});

test("actions: file names, rename validation and renamed playlist items", () => {
  assert.deepEqual(splitName("tatil.2024.jpg"), { stem: "tatil.2024", ext: "jpg" });
  assert.deepEqual(splitName(".gizli"), { stem: ".gizli", ext: "" });
  assert.deepEqual(splitName("noext"), { stem: "noext", ext: "" });
  assert.equal(basename("C:\\m\\a b.mp4"), "a b.mp4");
  assert.equal(basename("/home/x/ç.flac"), "ç.flac");
  assert.equal(dirOf("C:\\m\\a.mp4"), "C:\\m");
  assert.equal(dirOf("a.mp4"), "");

  assert.equal(validateFileName(" Çiçek ğüşıöç.mp4 "), null);
  for (const [bad, code] of [["", "empty"], ["  ", "empty"], ["..", "empty"], ["a/b", "chars"], ["a:b", "chars"], ["x?.jpg", "chars"],
    ["a\u0007", "chars"], ["a.", "dot"], ["CON", "reserved"], ["nul.txt", "reserved"], ["ç".repeat(200), "long"]]) {
    assert.equal(validateFileName(bad), code, bad);
  }
  assert.equal(validateFileName("console.log"), null);

  const item = { path: "C:\\m\\old.wmv", playPath: "C:\\cache\\x.mp4", name: "old.wmv", size: 3, isImage: false };
  assert.deepEqual(renamedItem(item, "C:\\m\\yeni.wmv"), { path: "C:\\m\\yeni.wmv", name: "yeni.wmv", size: 3, isImage: false });
});

test("actions: removing the current item picks the next one", () => {
  assert.deepEqual(removeAt(["a", "b", "c"], 1), { list: ["a", "c"], next: 1 });
  assert.deepEqual(removeAt(["a", "b", "c"], 2), { list: ["a", "b"], next: 1 });
  assert.deepEqual(removeAt(["a"], 0), { list: [], next: -1 });
  assert.deepEqual(removeAt(["a", "b"], 5).list, ["a", "b"]);
});

test("actions: time fields and ranges", () => {
  assert.equal(parseTime("75.25"), 75.25);
  assert.equal(parseTime("1:02"), 62);
  assert.equal(parseTime("1:02:03,5"), 3723.5);
  assert.ok(Number.isNaN(parseTime("1:2:3:4")));
  assert.ok(Number.isNaN(parseTime("abc")));
  assert.ok(Number.isNaN(parseTime("")));
  assert.equal(formatTimePrecise(62.04), "1:02.0");
  assert.equal(formatTimePrecise(3723.46), "1:02:03.5");
  assert.equal(formatTimePrecise(-3), "0:00.0");
  for (const t of [0, 9.9, 61.3, 3599.9, 7322.1]) assert.equal(parseTime(formatTimePrecise(t)), Math.round(t * 10) / 10);

  assert.deepEqual(defaultRange({ loop: { a: 2, b: 5 }, time: 9, duration: 60 }), { start: 2, end: 5, fromLoop: true });
  assert.deepEqual(defaultRange({ loop: { a: 2, b: null }, time: 9, duration: 60 }), { start: 9, end: 19, fromLoop: false });
  assert.deepEqual(defaultRange({ time: 58, duration: 60 }), { start: 58, end: 60, fromLoop: false });
  assert.deepEqual(defaultRange({ time: 60, duration: 60 }), { start: 50, end: 60, fromLoop: false });
  assert.deepEqual(defaultRange({ time: 0, duration: 3 }), { start: 0, end: 3, fromLoop: false });
  assert.deepEqual(defaultRange({ time: 5, duration: 0 }, 30), { start: 5, end: 35, fromLoop: false });
  assert.equal(checkRange(1, 3, 10), null);
  assert.equal(checkRange(3, 3, 10), "order");
  assert.equal(checkRange(NaN, 3, 10), "format");
  assert.equal(checkRange(12, 15, 10), "beyond");
});

test("actions: favorites, sizes, error tags, job ids", () => {
  let r = toggleFavorite([], "a");
  assert.deepEqual(r, { paths: ["a"], favorite: true });
  r = toggleFavorite(r.paths, "a");
  assert.deepEqual(r, { paths: [], favorite: false });
  assert.deepEqual(toggleFavorite(null, "x").paths, ["x"]);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1,5 KB");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  assert.equal(errorCode("[exists] Bu klasörde"), "exists");
  assert.equal(errorCode("plain"), null);
  assert.equal(errorText("[ocr-language] Dil yok"), "Dil yok");
  assert.notEqual(newJobId(), newJobId());
});

test("actions: print layout fits / fills the printable area", () => {
  const fit = printLayout({ paper: "a4", orientation: "portrait", margin: "normal", fit: "fit", image: [4000, 2000] });
  assert.deepEqual(fit.page, [210, 297]);
  assert.equal(fit.image.w, 186); // 210 - 2*12
  assert.equal(fit.image.h, 93);
  assert.ok(Math.abs(fit.image.y + fit.image.h / 2 - 297 / 2) < 1e-9, "centered");
  const fill = printLayout({ paper: "a4", orientation: "landscape", margin: "none", fit: "fill", image: [1000, 1000] });
  assert.deepEqual(fill.page, [297, 210]);
  assert.equal(fill.image.w, 297);
  assert.ok(fill.image.y < 0, "cropped vertically");
  assert.equal(bestOrientation([1920, 1080]), "landscape");
  assert.equal(bestOrientation([1080, 1920]), "portrait");
});

test("actions: OCR boxes become percentages of the image", () => {
  const layer = ocrLayer({ width: 200, height: 100, lines: [{ text: "Merhaba dünya", words: [{ text: "Merhaba", x: 20, y: 10, w: 60, h: 20 }] }] });
  assert.deepEqual(layer[0].words[0], { text: "Merhaba", left: 10, top: 10, width: 30, height: 20 });
  assert.deepEqual(ocrLayer(null), []);
});

test("lyrics: LRC parsing (stamps, metadata, offset, enhanced, several stamps per line)", () => {
  const lrc = "\uFEFF[ti:Uzun İnce Bir Yol]\n[ar:Âşık Veysel]\n[offset:+500]\n[00:12.50]Uzun ince bir yoldayım\r\n" +
    "[00:05.00][00:40.00]Nakarat\n[01:02:03.25]Saatli\n[00:20.123]<00:20.20>Kelime <00:21.00>bazlı\n[00:30]\nserbest satır\n";
  const r = parseLrc(lrc);
  assert.equal(r.synced, true);
  assert.equal(r.meta.ti, "Uzun İnce Bir Yol");
  assert.equal(r.meta.ar, "Âşık Veysel");
  assert.deepEqual(r.lines.map((l) => [Math.round(l.time * 1000) / 1000, l.text]), [
    [4.5, "Nakarat"], [12, "Uzun ince bir yoldayım"], [19.623, "Kelime bazlı"], [29.5, ""], [39.5, "Nakarat"], [3722.75, "Saatli"],
  ]);
  assert.equal(lineIndexAt(r.lines, 0), -1);
  assert.equal(lineIndexAt(r.lines, 4.5), 0);
  assert.equal(lineIndexAt(r.lines, 13), 1);
  assert.equal(lineIndexAt(r.lines, 5000), 5);
  assert.equal(lineIndexAt([], 3), -1);

  const plain = parseLrc("\n\nBirinci satır\nİkinci satır\n\n");
  assert.equal(plain.synced, false);
  assert.equal(plain.plain, "Birinci satır\nİkinci satır");
  assert.equal(plain.lines[0].time, null);
  assert.equal(parseLrc("").lines.length, 0);
  assert.equal(formatStamp(62.5), "[01:02.50]");
  assert.equal(parseLrc(`${formatStamp(83.27)}x`).lines[0].time, 83.27);
});

test("actions: shortcut table has no conflicts with the default / studio shortcuts", () => {
  const studio = [
    { id: "photoStudio", scope: "global", keys: ["Ctrl+Shift+KeyO"] },
    { id: "photoEdit", scope: "photo", keys: ["Ctrl+KeyE"] },
  ];
  const all = [...defaultActions({ dom: {} }), ...studio, ...ACTION_SHORTCUTS];
  assert.deepEqual(findConflicts(all), []);
  assert.equal(new Set(all.map((a) => a.id)).size, all.length, "unique ids");
  const tr = dict("tr"), en = dict("en");
  for (const a of ACTION_SHORTCUTS) {
    assert.ok(lookup(tr, `shortcuts.actions.${a.id}`), `tr label ${a.id}`);
    assert.ok(lookup(en, `shortcuts.actions.${a.id}`), `en label ${a.id}`);
  }
});

test("actions: every i18n key used by the action modules exists (tr + en)", () => {
  const files = ["ui/media-actions.js", "ui/action-dialogs.js", "ui/export-dialogs.js", "ui/photo-tools.js", "ui/music-tools.js"];
  const used = new Set();
  for (const f of files) {
    const src = readFileSync(join(SRC, f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*"(actions\.[\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?:labelKey|titleKey|helpKey):\s*"(actions\.[\w.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size > 80, `found ${used.size} keys`);
  const tr = dict("tr"), en = dict("en");
  assert.deepEqual([...used].filter((k) => lookup(tr, k) === undefined), [], "missing in tr.json");
  assert.deepEqual([...used].filter((k) => lookup(en, k) === undefined), [], "missing in en.json");
  // parity of the whole actions subtree
  const trKeys = flattenKeys(tr.actions).sort(), enKeys = flattenKeys(en.actions).sort();
  assert.deepEqual(trKeys, enKeys);
  assert.ok(readdirSync(join(SRC, "ui")).includes("media-actions.js"));
});
