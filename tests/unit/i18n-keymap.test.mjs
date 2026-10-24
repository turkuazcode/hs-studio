import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n, flattenKeys, interpolate, lookup, resolveLanguage } from "../../src/core/i18n.js";
import {
  comboFromEvent, conflictsFor, effectiveBindings, findConflicts, formatCombo, normalizeCombo, resolveAction,
} from "../../src/core/keymap.js";
import { defaultActions } from "../../src/ui/shortcuts.js";
import { accentVariables, hexToRgb } from "../../src/ui/theme.js";
import { entryFromItem, progressOf } from "../../src/ui/recent-files.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const dict = (lang) => JSON.parse(readFileSync(join(SRC, "i18n", `${lang}.json`), "utf8"));

test("i18n: every key exists in both languages, no empty strings", () => {
  const tr = flattenKeys(dict("tr")).sort();
  const en = flattenKeys(dict("en")).sort();
  assert.deepEqual(en.filter((k) => !tr.includes(k)), [], "keys missing in tr.json");
  assert.deepEqual(tr.filter((k) => !en.includes(k)), [], "keys missing in en.json");
  for (const lang of ["tr", "en"]) {
    for (const k of tr) assert.ok(lookup(dict(lang), k)?.trim(), `${lang}: empty ${k}`);
  }
  // Same placeholders in both languages
  for (const k of tr) {
    const vars = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    assert.equal(vars(lookup(dict("en"), k)), vars(lookup(dict("tr"), k)), `placeholders of ${k}`);
  }
});

test("i18n: keys used by the platform UI modules exist", () => {
  const files = ["settings-modal.js", "menus.js", "recent-files.js", "shortcut-editor.js", "shortcut-help.js", "platform.js"];
  const tr = dict("tr");
  const used = new Set();
  const patterns = [
    /\bt\(\s*"([\w.]+)"/g,
    /\b(?:labelKey|helpKey|buttonKey|heading)\s*:\s*"([\w.]+)"/g,
    /"data-i18n(?:-[a-z-]+)?"\s*:\s*"([\w.]+)"/g,
    /data-i18n(?:-[a-z-]+)?="([\w.]+)"/g,
    /dataset\.i18n\w*\s*=\s*"([\w.]+)"/g,
    /\bopt\(\s*"[^"]*"\s*,\s*"([\w.]+)"/g,
  ];
  for (const f of files) {
    const src = readFileSync(join(SRC, "ui", f), "utf8");
    for (const re of patterns) for (const m of src.matchAll(re)) used.add(m[1]);
  }
  for (const s of ["general", "playback", "subtitle", "audio", "photo", "appearance", "shortcuts", "advanced", "about"]) used.add(`settings.tabs.${s}`);
  for (const s of ["global", "video", "photo"]) used.add(`shortcuts.scopes.${s}`);
  for (const s of ["video", "audio", "image"]) used.add(`recent.types.${s}`);
  for (const a of defaultActions({ dom: {} })) used.add(`shortcuts.actions.${a.id}`);
  assert.ok(used.size > 60, `found ${used.size} keys`);
  const missing = [...used].filter((k) => lookup(tr, k) === undefined);
  assert.deepEqual(missing, []);
});

test("i18n: t(), fallback, interpolation, language resolution", () => {
  const i = createI18n({ dicts: { tr: { a: { b: "Merhaba {name}" }, only: "sadece tr" }, en: { a: { b: "Hello {name}" } } }, lang: "en" });
  assert.equal(i.t("a.b", { name: "VHO" }), "Hello VHO");
  assert.equal(i.t("only"), "sadece tr"); // falls back to Turkish
  assert.equal(i.t("missing.key"), "missing.key");
  i.setLanguage("de"); // unsupported -> tr
  assert.equal(i.language, "tr");
  assert.equal(interpolate("{a}-{b}", { a: 1 }), "1-{b}");
  assert.equal(resolveLanguage("system", ["en-US", "tr-TR"]), "en");
  assert.equal(resolveLanguage("system", ["de-DE"]), "tr");
  assert.equal(resolveLanguage("en", ["tr-TR"]), "en");
  assert.equal(resolveLanguage("system", []), "tr");
});

test("keymap: combos normalize and come from events", () => {
  assert.equal(normalizeCombo("shift+ctrl+KeyR"), "Ctrl+Shift+KeyR");
  assert.equal(normalizeCombo("Meta+KeyO"), "Ctrl+KeyO");
  assert.equal(normalizeCombo("KeyA+KeyB"), null);
  assert.equal(normalizeCombo("Shift"), null);
  assert.equal(normalizeCombo(""), null);
  assert.equal(comboFromEvent({ code: "KeyR", shiftKey: true }), "Shift+KeyR");
  assert.equal(comboFromEvent({ code: "KeyO", metaKey: true }), "Ctrl+KeyO");
  assert.equal(comboFromEvent({ code: "ShiftLeft", shiftKey: true }), null);
  assert.equal(formatCombo("Shift+KeyR"), "Shift + R");
  assert.equal(formatCombo("Space", { Space: "Boşluk" }), "Boşluk");
  assert.equal(formatCombo("Digit0"), "0");
});

test("keymap: the default shortcut table has no conflicts", () => {
  const actions = defaultActions({ dom: {} });
  assert.deepEqual(findConflicts(actions), []);
  assert.equal(new Set(actions.map((a) => a.id)).size, actions.length, "unique ids");
});

test("keymap: conflict detection respects scopes and overrides", () => {
  const actions = [
    { id: "full", scope: "global", keys: ["KeyF"] },
    { id: "play", scope: "video", keys: ["Space"] },
    { id: "slide", scope: "photo", keys: ["Space"] },
    { id: "rot", scope: "photo", keys: ["KeyR"] },
  ];
  assert.deepEqual(findConflicts(actions), [], "video/photo may share keys");
  assert.deepEqual(findConflicts(actions, { play: ["KeyF"] }), [{ combo: "KeyF", ids: ["full", "play"] }]);
  assert.deepEqual(conflictsFor(actions, {}, "rot", ["Space"]), [{ combo: "Space", id: "slide" }]);
  assert.deepEqual(conflictsFor(actions, {}, "rot", ["KeyX"]), []);
  // Invalid overrides fall back to defaults; an empty list unbinds
  const b = effectiveBindings(actions, { full: "bad", play: [] });
  assert.deepEqual(b.get("full"), ["KeyF"]);
  assert.deepEqual(b.get("play"), []);
});

test("keymap: action resolution by mode, Shift falls back to the plain key", () => {
  const actions = defaultActions({ dom: {} });
  const b = effectiveBindings(actions, {});
  assert.equal(resolveAction(actions, b, "Space", "video").id, "playPause");
  assert.equal(resolveAction(actions, b, "Space", "photo").id, "slideshow");
  assert.equal(resolveAction(actions, b, "Shift+KeyR", "photo").id, "rotateLeft");
  assert.equal(resolveAction(actions, b, "KeyR", "photo").id, "rotateRight");
  assert.equal(resolveAction(actions, b, "Shift+ArrowLeft", "video").id, "seekBackLong");
  assert.equal(resolveAction(actions, b, "Shift+ArrowLeft", "photo").id, "photoPrev");
  assert.equal(resolveAction(actions, b, "Shift+KeyF", "video").id, "fullscreen");
  assert.equal(resolveAction(actions, b, "Ctrl+KeyZ", "video"), null);
});

test("theme: accent variables derive from one colour", () => {
  assert.deepEqual(hexToRgb("#e11d48"), [225, 29, 72]);
  assert.equal(hexToRgb("nope"), null);
  const v = accentVariables("#2563eb");
  assert.equal(v["--accent-ruby"], "#2563eb");
  assert.match(v["--accent-ruby-dim"], /^rgba\(37, 99, 235, 0\.16\)$/);
  assert.match(v["--accent-gradient"], /^linear-gradient/);
});

test("recent files: entries from playlist items", () => {
  assert.equal(entryFromItem({ file: {}, name: "dropped.mp4" }), null);
  const v = entryFromItem({ path: "C:\\m\\a.mp4", name: "a.mp4", size: 10 }, 5);
  assert.deepEqual(v, { id: "C:\\m\\a.mp4", path: "C:\\m\\a.mp4", url: undefined, name: "a.mp4", type: "video", resumeKey: "vho_file_a.mp4_10", openedAt: 5 });
  assert.equal(entryFromItem({ path: "/x/s.flac", name: "s.flac" }).type, "audio");
  const img = entryFromItem({ path: "/x/p.jpg", name: "p.jpg", isImage: true });
  assert.equal(img.type, "image");
  assert.equal(img.resumeKey, "");
  assert.equal(entryFromItem({ url: "https://e.com/v.mp4", name: "v.mp4" }).resumeKey, "vho_url_https://e.com/v.mp4");
  assert.equal(progressOf(30, 120), 0.25);
  assert.equal(progressOf(0, 120), 0);
  assert.equal(progressOf(30, 0), 0);
});
