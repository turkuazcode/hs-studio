// ==========================================================================
// Smart editing pre/post-processing (Plan 07 recipes, Plan 11/A06), pure and unit tested.
// Runs inside the AI worker (off the UI thread). Images are straight RGBA Uint8 arrays.
//
//  LaMa (object removal): brush strokes -> mask; ~2.2x square crop around the mask ->
//    512x512 image [0..1] + mask {0,1}; output 0..255 -> back to crop size -> pasted only
//    inside the mask, grown 9 px and softened 4 px.
//  BiRefNet (background): 1024x1024 ImageNet-normalized; logits -> sigmoid -> bilinear to
//    the photo size -> alpha (>= 0.98 -> 1, <= 0.02 -> 0); transparent / colour / blurred
//    background (alpha softened 1.5 px for the blur composite).
//  DDColor (colorize): 256x256 RGB 0..1 -> Lab ab; the original L channel is kept at full
//    resolution, ab is upscaled bilinearly; very strong chroma is softly compressed.
// ==========================================================================

export const LAMA_SIZE = 512;
export const MATTING_SIZE = 1024;
export const COLORIZE_SIZE = 256;

// ---------------------------------------------------------------- resampling

/** Bilinear resize of an interleaved `channels` image (pixel centres aligned). */
export function resizeBilinear(src, w, h, channels, nw, nh, Out = Float32Array) {
  const out = new Out(nw * nh * channels);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < channels; c++) {
        const a = src[(y0 * w + x0) * channels + c], b = src[(y0 * w + x1) * channels + c];
        const d = src[(y1 * w + x0) * channels + c], e = src[(y1 * w + x1) * channels + c];
        const top = a + (b - a) * tx, bottom = d + (e - d) * tx;
        out[(y * nw + x) * channels + c] = top + (bottom - top) * ty;
      }
    }
  }
  return out;
}

/** RGBA region (x, y, w, h) of an image -> planar float tensor [1,3,size,size] (bilinear). */
function planarTensor(rgba, W, x, y, w, h, size, map) {
  const crop = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = ((y + j) * W + x + i) * 4, d = (j * w + i) * 3;
      crop[d] = rgba[s]; crop[d + 1] = rgba[s + 1]; crop[d + 2] = rgba[s + 2];
    }
  }
  const small = resizeBilinear(crop, w, h, 3, size, size);
  const plane = size * size;
  const t = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) for (let c = 0; c < 3; c++) t[c * plane + p] = map(small[p * 3 + c], c);
  return t;
}

// ---------------------------------------------------------------- LaMa

/**
 * Brush strokes -> mask (Uint8, 255 = remove). strokes: [{ points: [[x, y], ...] (0..1 of the
 * image), radius (0..1 of the shorter side), erase? }]. Later strokes win (an eraser stroke
 * clears what earlier strokes painted).
 */
export function rasterizeStrokes(strokes, w, h) {
  const mask = new Uint8Array(w * h);
  const short = Math.min(w, h);
  for (const s of strokes ?? []) {
    const r = Math.max(0.5, (s.radius ?? 0.02) * short);
    const value = s.erase ? 0 : 255;
    const pts = (s.points ?? []).map(([x, y]) => [x * w, y * h]);
    const stamp = (cx, cy) => {
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= r * r) mask[y * w + x] = value;
        }
      }
    };
    if (pts.length === 1) stamp(...pts[0]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r / 2)));
      for (let k = 0; k <= steps; k++) stamp(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
    }
  }
  return mask;
}

/** Bounding box { x0, y0, x1, y1 } (x1/y1 exclusive) of the non-zero mask, or null. */
export function maskBBox(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Square context crop around the mask: side = 2.2 x the larger mask side (at least
 * LAMA_SIZE when the photo allows), kept inside the photo (shifted, never past an edge).
 */
export function lamaCrop(bbox, w, h, factor = 2.2) {
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
  let side = Math.ceil(Math.max(bw, bh) * factor);
  side = Math.max(side, Math.min(LAMA_SIZE, w, h));
  const cw = Math.min(side, w), ch = Math.min(side, h);
  const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
  const x = Math.round(Math.min(w - cw, Math.max(0, cx - cw / 2)));
  const y = Math.round(Math.min(h - ch, Math.max(0, cy - ch / 2)));
  return { x, y, w: cw, h: ch };
}

/** Model inputs for a crop: image [1,3,512,512] 0..1 and mask [1,1,512,512] {0,1}. */
export function lamaInputs(rgba, mask, W, crop) {
  const image = planarTensor(rgba, W, crop.x, crop.y, crop.w, crop.h, LAMA_SIZE, (v) => v / 255);
  const m = new Float32Array(crop.w * crop.h);
  for (let j = 0; j < crop.h; j++) for (let i = 0; i < crop.w; i++) m[j * crop.w + i] = mask[(crop.y + j) * W + crop.x + i] ? 1 : 0;
  const small = resizeBilinear(m, crop.w, crop.h, 1, LAMA_SIZE, LAMA_SIZE);
  for (let i = 0; i < small.length; i++) small[i] = small[i] > 0 ? 1 : 0; // any coverage = fill
  return { image, mask: small };
}

/** Grows a binary mask by `r` px (square-ish disc), returns 0/1 floats. */
export function dilate(mask, w, h, r) {
  const out = new Float32Array(w * h);
  const rr = r * r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && dx * dx + dy * dy <= rr) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** Separable box-blur approximation of a Gaussian (3 passes) on a single-channel float image. */
export function blurChannel(src, w, h, radius) {
  if (radius <= 0) return Float32Array.from(src);
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius / Math.sqrt(3)));
  const pass = (from, to, horizontal) => {
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      let acc = 0;
      const at = (i) => (horizontal ? l * w + i : i * w + l);
      for (let i = -r; i <= r; i++) acc += from[at(Math.min(n - 1, Math.max(0, i)))];
      for (let i = 0; i < n; i++) {
        to[at(i)] = acc / (2 * r + 1);
        acc += from[at(Math.min(n - 1, i + r + 1))] - from[at(Math.max(0, i - r))];
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, true);
    pass(b, a, false);
  }
  return a;
}

/** Soft paste weight: mask grown `grow` px, edges softened `soften` px (0..1). */
export const featherMask = (mask, w, h, grow = 9, soften = 4) => {
  const d = dilate(mask, w, h, grow);
  const s = blurChannel(d, w, h, soften);
  for (let i = 0; i < s.length; i++) s[i] = Math.max(s[i], mask[i] ? 1 : 0); // painted area fully replaced
  return s;
};

/** Pastes the model output (planar [3,512,512] 0..255) back into `rgba` inside the feathered mask. */
export function lamaPaste(rgba, W, H, mask, crop, output) {
  const plane = LAMA_SIZE * LAMA_SIZE;
  const inter = new Float32Array(plane * 3);
  for (let p = 0; p < plane; p++) for (let c = 0; c < 3; c++) inter[p * 3 + c] = output[c * plane + p];
  const back = resizeBilinear(inter, LAMA_SIZE, LAMA_SIZE, 3, crop.w, crop.h);
  const weight = featherMask(mask, W, H);
  const out = new Uint8ClampedArray(rgba);
  for (let j = 0; j < crop.h; j++) {
    for (let i = 0; i < crop.w; i++) {
      const p = (crop.y + j) * W + crop.x + i;
      const a = weight[p];
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[p * 4 + c] = rgba[p * 4 + c] * (1 - a) + back[(j * crop.w + i) * 3 + c] * a;
    }
  }
  return out;
}

// ---------------------------------------------------------------- BiRefNet

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export const mattingInput = (rgba, W, H) => planarTensor(rgba, W, 0, 0, W, H, MATTING_SIZE, (v, c) => (v / 255 - MEAN[c]) / STD[c]);

/** Logits [1024x1024] -> alpha (Uint8, photo size): sigmoid, bilinear, edge refine. */
export function mattingAlpha(logits, W, H, size = MATTING_SIZE) {
  const prob = new Float32Array(size * size);
  for (let i = 0; i < prob.length; i++) prob[i] = 1 / (1 + Math.exp(-logits[i]));
  const big = resizeBilinear(prob, size, size, 1, W, H);
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < alpha.length; i++) {
    const a = big[i] >= 0.98 ? 1 : big[i] <= 0.02 ? 0 : big[i];
    alpha[i] = Math.round(a * 255);
  }
  return alpha;
}

/**
 * New background behind the subject. mode: "transparent" | "color" | "blur".
 * color: [r, g, b]; blur: radius in px (default ~1.5 % of the longer side).
 */
export function composeBackground(rgba, W, H, alpha, { mode = "transparent", color = [255, 255, 255], blur } = {}) {
  const out = new Uint8ClampedArray(rgba.length);
  if (mode === "transparent") {
    for (let p = 0; p < W * H; p++) {
      out.set([rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]], p * 4);
      out[p * 4 + 3] = Math.round((rgba[p * 4 + 3] * alpha[p]) / 255);
    }
    return out;
  }
  let bg;
  if (mode === "blur") {
    const radius = blur ?? Math.max(2, Math.round(Math.max(W, H) * 0.015));
    bg = [0, 1, 2].map((c) => blurChannel(Float32Array.from({ length: W * H }, (_, p) => rgba[p * 4 + c]), W, H, radius));
  }
  const a = mode === "blur" ? blurChannel(Float32Array.from(alpha, (v) => v / 255), W, H, 1.5) : Float32Array.from(alpha, (v) => v / 255);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) {
      const back = mode === "blur" ? bg[c][p] : color[c];
      out[p * 4 + c] = rgba[p * 4 + c] * a[p] + back * (1 - a[p]);
    }
    out[p * 4 + 3] = rgba[p * 4 + 3];
  }
  return out;
}

// ---------------------------------------------------------------- DDColor (Lab, D65)

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const WHITE = [0.95047, 1, 1.08883];
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

/** sRGB 0..255 -> CIE Lab (L 0..100). */
export function rgbToLab(r, g, b) {
  const [R, G, B] = [r, g, b].map((v) => srgbToLinear(v / 255));
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0];
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / WHITE[1];
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2];
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab -> sRGB 0..255 (clamped). */
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fInv(fx) * WHITE[0], Y = (L > 8 ? fy ** 3 : L / (24389 / 27)) * WHITE[1], Z = fInv(fz) * WHITE[2];
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [R, G, B].map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.max(0, v)))) * 255));
}

export const colorizeInput = (rgba, W, H) => planarTensor(rgba, W, 0, 0, W, H, COLORIZE_SIZE, (v) => v / 255);

/** Chroma above `knee` grows at half speed (very saturated predictions are softened). */
export const softChroma = (c, knee = 45) => (c <= knee ? c : knee + (c - knee) * 0.5);

/**
 * Full-resolution colour: L from the original, ab (planar [2,256,256]) upscaled bilinearly,
 * chroma softly compressed. Alpha kept.
 */
export function mergeColorize(rgba, W, H, ab, size = COLORIZE_SIZE) {
  const plane = size * size;
  const inter = new Float32Array(plane * 2);
  for (let p = 0; p < plane; p++) { inter[p * 2] = ab[p]; inter[p * 2 + 1] = ab[plane + p]; }
  const big = resizeBilinear(inter, size, size, 2, W, H);
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < W * H; p++) {
    const [L] = rgbToLab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
    let a = big[p * 2], b = big[p * 2 + 1];
    const c = Math.hypot(a, b);
    if (c > 0) { const k = softChroma(c) / c; a *= k; b *= k; }
    const [r, g, bl] = labToRgb(L, a, b);
    out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = bl; out[p * 4 + 3] = rgba[p * 4 + 3];
  }
  return out;
}

/** Mean Lab chroma of the visible pixels (sampled): low = black-and-white / faded photo. */
export function meanChroma(rgba, step = 7) {
  let sum = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * step) {
    if (rgba[i + 3] === 0) continue;
    const [, a, b] = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
    sum += Math.hypot(a, b);
    n++;
  }
  return n ? sum / n : 0;
}

/** "Renklendir" is offered only for black-and-white / strongly faded photos. */
export const COLORIZE_MAX_CHROMA = 8;
export const isColorizeCandidate = (rgba) => meanChroma(rgba) <= COLORIZE_MAX_CHROMA;
