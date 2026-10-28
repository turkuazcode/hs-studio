// A05 faithful photo enhance: slider -> Rust parameter mapping, level words, output format,
// defaults shared with the settings schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENHANCE_DEFAULTS, enhanceParams, levelKey, outputFormat } from "../../src/media/photo-enhance.js";
import { BASE_FIELDS } from "../../src/core/settings-schema.js";

test("photo enhance: recommended defaults map to the Rust defaults (scale 2, shadow 0.2, sharpness 1.6)", () => {
  const p = enhanceParams(ENHANCE_DEFAULTS);
  assert.equal(p.scale, 2);
  assert.ok(Math.abs(p.shadow - 0.2) < 0.005, `shadow ${p.shadow}`);
  assert.equal(p.sharpness, 1.6);
  assert.equal(p.grain, false);
  assert.equal(p.denoise, 1);
  for (const k of ["sharpness", "shadow", "scale", "grain"]) {
    assert.deepEqual(BASE_FIELDS[`photoEnhance.${k}`].default, ENHANCE_DEFAULTS[k], k);
  }
});

test("photo enhance: slider ends stay inside the Rust ranges, bad input is clamped", () => {
  assert.deepEqual(enhanceParams({ sharpness: 0, shadow: 0, scale: 1, grain: false }), { scale: 1, sharpness: 1, shadow: 0, denoise: 1, grain: false });
  const hi = enhanceParams({ sharpness: 100, shadow: 100, scale: 4, grain: true });
  assert.equal(hi.sharpness, 2.5);
  assert.equal(hi.shadow, 0.6);
  assert.equal(hi.scale, 4);
  const bad = enhanceParams({ sharpness: "x", shadow: 500, scale: 3, grain: 1 });
  assert.equal(bad.scale, 2);
  assert.equal(bad.sharpness, 1);
  assert.equal(bad.shadow, 0.6);
  assert.equal(bad.grain, true);
});

test("photo enhance: level words and output format", () => {
  assert.equal(levelKey(0), "photoEnhance.level.off");
  assert.equal(levelKey(33), "photoEnhance.level.low");
  assert.equal(levelKey(40), "photoEnhance.level.mid");
  assert.equal(levelKey(90), "photoEnhance.level.high");
  assert.equal(outputFormat("C:/a/b.JPG"), "jpeg");
  assert.equal(outputFormat("x.jpeg"), "jpeg");
  assert.equal(outputFormat("x.png"), "png");
  assert.equal(outputFormat("x.heic"), "png");
});
