// AI component status helpers (src/media/ai-status.js) and their TR/EN texts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interpolate, lookup } from "../../src/core/i18n.js";
import { SETTINGS_SECTIONS } from "../../src/core/settings.js";
import {
  ERROR_CODES, componentActions, consentText, megabytes, progressFraction, sizeText, toAiError,
} from "../../src/media/ai-status.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const dict = (lang) => JSON.parse(readFileSync(join(SRC, "i18n", `${lang}.json`), "utf8"));
const translator = (lang) => {
  const d = dict(lang);
  return (key, vars) => interpolate(lookup(d, key) ?? key, vars);
};
const t = translator("tr");

const status = (over = {}) => ({
  id: "photo-x4", title: "4xRealWebPhoto v4 (DAT-2)", author: "Philip Hofmann", license: "CC-BY-4.0",
  state: "missing", installed: false, downloadBytes: 48_760_847, totalBytes: 48_760_847, diskBytes: 48_760_847,
  inUse: false, ...over,
});

test("ai-status: backend error codes become localized errors, cancel is an AbortError", () => {
  const e = toAiError({ code: "checksum", detail: "a.onnx: got 10 bytes" }, t);
  assert.equal(e.code, "checksum");
  assert.equal(e.detail, "a.onnx: got 10 bytes");
  assert.equal(e.message, dict("tr").aiModels.errors.checksum, "user text from i18n, not the detail");
  assert.equal(toAiError({ code: "cancelled", detail: "" }, t).name, "AbortError");
  // unknown codes / plain strings fall back to a generic file error
  assert.equal(toAiError({ code: "weird" }, t).code, "io");
  assert.equal(toAiError("boom", t).detail, "boom");
  const original = new Error("x");
  assert.equal(toAiError(original, t), original);
  const en = toAiError({ code: "disk-full" }, translator("en"));
  assert.equal(en.message, "Not enough free disk space.");
});

test("ai-status: consent text lists size, author and license of missing components only", () => {
  assert.equal(consentText([status({ installed: true, state: "ready" })], t), null);
  const text = consentText([
    status({ id: "ort-web", title: "ONNX Runtime Web 1.30.0", author: "Microsoft", license: "MIT", downloadBytes: 27_240_481 }),
    status(),
    status({ id: "face-restore", installed: true, state: "installed" }),
  ], t);
  assert.match(text, /yaklaşık 72 MB/);
  assert.match(text, /• ONNX Runtime Web 1\.30\.0 — Microsoft, MIT \(26 MB\)/);
  assert.match(text, /• 4xRealWebPhoto v4 \(DAT-2\) — Philip Hofmann, CC-BY-4\.0 \(47 MB\)/);
  assert.doesNotMatch(text, /face/i);
  assert.match(text, /Ayarlar > AI modelleri/);
  assert.match(consentText([status()], translator("en")), /^First use: about 47 MB/);
});

test("ai-status: actions per state (rare actions live in Settings)", () => {
  assert.deepEqual(componentActions(status()), ["install"]);
  assert.deepEqual(componentActions(status({ state: "partial" })), ["install", "remove"]);
  assert.deepEqual(componentActions(status({ state: "corrupt" })), ["repair", "remove"]);
  assert.deepEqual(componentActions(status({ state: "ready" })), ["verify", "remove"]);
  assert.deepEqual(componentActions(status({ state: "installed", inUse: true })), ["verify"], "no removal while a job uses it");
  assert.deepEqual(componentActions(status({ state: "downloading" })), ["cancel"]);
  assert.deepEqual(componentActions(status({ state: "ready" }), { busy: true }), ["cancel"]);
});

test("ai-status: sizes and progress", () => {
  assert.equal(megabytes(0), 1);
  assert.equal(megabytes(170_289_207), 162);
  assert.equal(sizeText(48_760_847), "46.5 MB");
  assert.equal(sizeText(66_349), "65 KB");
  assert.equal(sizeText(0), "0 MB");
  assert.equal(progressFraction({ done: 50, total: 200 }), 0.25);
  assert.equal(progressFraction({ done: 5, total: 0 }), null);
  assert.equal(progressFraction(null), null);
  assert.equal(progressFraction({ done: 300, total: 200 }), 1);
});

test("ai-status: every AI models text exists in TR and EN (incl. dynamic keys)", () => {
  const used = new Set();
  for (const f of ["ui/ai-models.js", "media/ai-engine.js", "media/ai-status.js"]) {
    const src = readFileSync(join(SRC, f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/"data-i18n"\s*:\s*"([\w.]+)"/g)) used.add(m[1]);
  }
  for (const c of ERROR_CODES) used.add(`aiModels.errors.${c}`);
  for (const s of ["missing", "partial", "installed", "ready", "corrupt", "downloading", "verifying"]) used.add(`aiModels.state.${s}`);
  for (const a of ["install", "cancel", "verify", "repair", "remove", "source"]) used.add(`aiModels.actions.${a}`);
  for (const p of ["verify", "download", "extract"]) used.add(`aiModels.phase.${p}`);
  for (const k of ["runtime", "photo-upscale", "face-restore"]) used.add(`aiModels.task.${k}`);
  for (const s of SETTINGS_SECTIONS) used.add(`settings.tabs.${s}`);
  assert.ok(SETTINGS_SECTIONS.includes("components"));
  for (const lang of ["tr", "en"]) {
    const d = dict(lang);
    assert.deepEqual([...used].filter((k) => !lookup(d, k)), [], lang);
  }
});
