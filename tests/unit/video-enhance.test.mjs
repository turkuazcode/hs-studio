// Faithful video enhance: dialog logic without the app (media/video-enhance.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, PREVIEW_SECONDS, blockerKey, previewStart } from "../../src/media/video-enhance.js";

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
