// A04 integrity: a black-and-white photo stays black-and-white after the AI (Q02 finding:
// colourfulness 0 -> 2-10 on old scans).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGrayscale, keepGrayscale, toGrayscale } from "../../src/media/grayscale.js";

const px = (...rgba) => new Uint8ClampedArray(rgba.flat());

test("grayscale: detection tolerates scan noise, ignores transparent pixels", () => {
  assert.equal(isGrayscale(px([10, 10, 10, 255], [200, 203, 198, 255])), true, "small chroma noise");
  assert.equal(isGrayscale(px([10, 10, 10, 255], [200, 120, 90, 255])), false, "a colour photo");
  assert.equal(isGrayscale(px([50, 50, 50, 255], [255, 0, 0, 0])), true, "colour under alpha 0 ignored");
  assert.equal(isGrayscale(px([255, 0, 0, 0])), false, "nothing visible");
  // a few coloured pixels in a large gray image are noise (>= 99.5 % gray)
  const big = new Uint8ClampedArray(1000 * 4).fill(128);
  big.set([255, 0, 0, 255], 0);
  assert.equal(isGrayscale(big), true);
});

test("grayscale: model colour cast removed only for B/W inputs, alpha untouched", () => {
  const out = px([120, 140, 100, 255], [30, 20, 60, 128]);
  assert.equal(keepGrayscale(px([90, 90, 90, 255], [40, 40, 40, 128]), out), true);
  for (let i = 0; i < out.length; i += 4) assert.ok(out[i] === out[i + 1] && out[i + 1] === out[i + 2], `pixel ${i / 4} gray`);
  assert.equal(out[0], Math.round(0.299 * 120 + 0.587 * 140 + 0.114 * 100));
  assert.equal(out[7], 128, "alpha kept");
  const colour = px([120, 140, 100, 255]);
  assert.equal(keepGrayscale(px([200, 30, 30, 255]), colour), false);
  assert.deepEqual([...colour], [120, 140, 100, 255], "colour photo output unchanged");
  assert.deepEqual([...toGrayscale(px([0, 255, 0, 9]))], [150, 150, 150, 9]);
});
