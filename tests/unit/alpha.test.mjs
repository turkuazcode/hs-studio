// A04 alpha handling around RGB models: transparent colour bleeding (no halo), separate alpha
// upscale, alpha copy after the face pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bleedTransparent, copyAlpha, hasTransparency, upscaleAlpha } from "../../src/media/alpha.js";

/** 6x4: left half opaque red, right half alpha 0 with black colour, one alpha-128 pixel. */
function sample() {
  const w = 6, h = 4, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d.set(x < 3 ? [220, 30, 20, 255] : [0, 0, 0, 0], i);
    }
  }
  d.set([200, 40, 30, 128], (1 * w + 3) * 4);
  return { w, h, d };
}

test("alpha: detection", () => {
  assert.equal(hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])), false);
  assert.equal(hasTransparency(sample().d), true);
});

test("alpha: transparent pixels take the visible neighbours' colour (no dark halo)", () => {
  const { w, h, d } = sample();
  const out = bleedTransparent(d, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] > 0) {
        assert.deepEqual([...out.slice(i, i + 4)], [...d.slice(i, i + 4)], "visible pixel unchanged");
      } else {
        assert.ok(out[i] > 150 && out[i + 1] < 80, `bled colour at ${x},${y}: ${out.slice(i, i + 3)}`);
        assert.equal(out[i + 3], 0, "alpha stays 0");
      }
    }
  }
  // nothing visible: unchanged
  const empty = new Uint8ClampedArray(16);
  assert.deepEqual([...bleedTransparent(empty, 2, 2)], [...empty]);
  // input not modified
  assert.equal(d[(0 * w + 5) * 4], 0);
});

test("alpha: separate bilinear upscale and copy after the face pass", () => {
  const { w, h, d } = sample();
  const S = 4;
  const dst = new Uint8ClampedArray(w * S * h * S * 4).fill(255);
  upscaleAlpha(d, w, h, S, dst);
  const a = (x, y) => dst[(y * w * S + x) * 4 + 3];
  assert.equal(a(0, 0), 255, "opaque corner");
  assert.equal(a(w * S - 1, h * S - 1), 0, "transparent corner");
  assert.ok(a(3 * S + 1, 1 * S + 1) > 60 && a(3 * S + 1, 1 * S + 1) < 200, "half alpha region");
  // edge between opaque and transparent: a smooth ramp, no overshoot
  const row = Array.from({ length: w * S }, (_, x) => a(x, 0));
  for (let x = 1; x < row.length; x++) assert.ok(row[x] <= row[x - 1], `monotone edge ${row}`);
  const face = new Uint8ClampedArray(dst.length).fill(255);
  copyAlpha(dst, face);
  assert.equal(face[(h * S * w * S - 1) * 4 + 3], 0);
});
