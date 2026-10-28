// Faithful video enhance: dialog logic without the app (media/video-enhance.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, PREVIEW_SECONDS, blockerKey, latestOnly, previewStart, settingsKey } from "../../src/media/video-enhance.js";

test("defaults are light (fidelity first) and the preview is 10 s", () => {
  assert.deepEqual({ ...DEFAULT_OPTIONS }, { denoise: "light", sharpen: "light", upscale: false });
  assert.equal(PREVIEW_SECONDS, 10);
});

test("preview starts at the current position, keeping 10 s before the end", () => {
  assert.equal(previewStart(0, 120), 0);
  assert.equal(previewStart(42.7, 120), 42);
  assert.equal(previewStart(115, 120), 110);
  assert.equal(previewStart(5, 6), 0, "shorter than the preview");
  assert.equal(previewStart(NaN, 120), 0);
  assert.equal(previewStart(33, NaN), 33, "unknown duration");
});

test("plan blockers map to one message; an undecided field order is asked, not shown", () => {
  assert.equal(blockerKey([]), null);
  assert.equal(blockerKey(["field-order-unconfirmed"]), null);
  assert.equal(blockerKey(["hdr-unsupported"]), "videoEnhance.blocker.hdr");
  assert.equal(blockerKey(["dynamic-range-unknown", "field-order-unconfirmed"]), "videoEnhance.blocker.hdr");
  assert.equal(blockerKey(["filter-missing:cas"]), "videoEnhance.blocker.filters");
  assert.equal(blockerKey(["rotation-unsupported"]), "videoEnhance.blocker.generic");
});

test("fast setting changes: an older plan answer arriving last is not applied", async () => {
  const latest = latestOnly();
  let resolveOld, rejectMid;
  const old = latest(new Promise((r) => { resolveOld = r; }));
  const mid = latest(new Promise((_, j) => { rejectMid = j; }));
  const now = latest(Promise.resolve("x2"));
  assert.deepEqual(await now, { fresh: true, value: "x2" });
  resolveOld("none");
  rejectMid(new Error("probe failed"));
  assert.deepEqual(await old, { fresh: false, value: "none" }, "the slow first answer comes last and is stale");
  const m = await mid;
  assert.equal(m.fresh, false, "a stale error is not shown either");
  assert.match(m.error.message, /probe failed/);
  // the next call is fresh again, also when it fails
  const err = await latest(Promise.reject(new Error("boom")));
  assert.equal(err.fresh, true);
});

test("a preview is out of date as soon as any setting differs from the one it was made with", () => {
  const k = settingsKey(DEFAULT_OPTIONS, null);
  assert.equal(k, settingsKey({ denoise: "light", sharpen: "light", upscale: false }, null));
  for (const changed of [
    settingsKey({ ...DEFAULT_OPTIONS, denoise: "medium" }, null),
    settingsKey({ ...DEFAULT_OPTIONS, sharpen: "off" }, null),
    settingsKey({ ...DEFAULT_OPTIONS, upscale: true }, null),
    settingsKey(DEFAULT_OPTIONS, "tff"),
  ]) assert.notEqual(changed, k);
});
