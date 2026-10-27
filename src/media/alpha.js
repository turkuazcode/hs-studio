// ==========================================================================
// Alpha handling around RGB models (Plan 11/A04), pure and unit tested.
// The models see RGB only. Fully transparent pixels usually hold meaningless colour (black
// after a canvas round trip), which a model smears into the visible edge as a dark halo.
//  - bleedTransparent: transparent pixels take the colour of the nearest visible pixels
//    (multi-source breadth-first fill), so the edge context is the object's own colour;
//  - upscaleAlpha: the alpha channel is scaled separately (bilinear, pixel centres) and put
//    back on the model output.
// Straight (non-premultiplied) RGBA, 8 bit.
// ==========================================================================

/** True when any pixel is not fully opaque. */
export function hasTransparency(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  return false;
}

/**
 * Copy of `data` where every alpha-0 pixel gets the average colour of its already filled
 * 8-neighbours, filling outwards from the visible pixels. Visible pixels are unchanged.
 * An image without any visible pixel is returned as is.
 */
export function bleedTransparent(data, width, height) {
  const out = new Uint8ClampedArray(data);
  const n = width * height;
  const filled = new Uint8Array(n);
  let queue = [];
  for (let p = 0; p < n; p++) {
    if (data[p * 4 + 3] > 0) filled[p] = 1;
  }
  // first ring: transparent pixels next to a visible one
  const neighbours = (p, fn) => {
    const x = p % width, y = (p / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((dx || dy) && xx >= 0 && xx < width) fn(yy * width + xx);
      }
    }
  };
  const queued = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (filled[p]) continue;
    let near = false;
    neighbours(p, (q) => { if (filled[q]) near = true; });
    if (near) { queue.push(p); queued[p] = 1; }
  }
  while (queue.length) {
    // one ring at a time: a ring only reads pixels filled before it
    const ring = [];
    for (const p of queue) {
      let r = 0, g = 0, b = 0, k = 0;
      neighbours(p, (q) => {
        if (!filled[q]) return;
        r += out[q * 4]; g += out[q * 4 + 1]; b += out[q * 4 + 2]; k++;
      });
      ring.push([p, r / k, g / k, b / k]);
    }
    const next = [];
    for (const [p, r, g, b] of ring) {
      out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b;
      filled[p] = 1;
    }
    for (const [p] of ring) {
      neighbours(p, (q) => { if (!filled[q] && !queued[q]) { queued[q] = 1; next.push(q); } });
    }
    queue = next;
  }
  return out;
}

/** Writes the bilinear x`scale` upscale of `src`'s alpha into the alpha channel of `dst`. */
export function upscaleAlpha(src, width, height, scale, dst) {
  const W = width * scale, H = height * scale;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      const a00 = src[(y0 * width + x0) * 4 + 3], a10 = src[(y0 * width + x1) * 4 + 3];
      const a01 = src[(y1 * width + x0) * 4 + 3], a11 = src[(y1 * width + x1) * 4 + 3];
      const top = a00 + (a10 - a00) * fx, bottom = a01 + (a11 - a01) * fx;
      dst[(y * W + x) * 4 + 3] = Math.round(top + (bottom - top) * fy);
    }
  }
  return dst;
}

/** Copies the alpha channel of `from` into `to` (same size), e.g. after the face pass. */
export function copyAlpha(from, to) {
  for (let i = 3; i < to.length && i < from.length; i += 4) to[i] = from[i];
  return to;
}
