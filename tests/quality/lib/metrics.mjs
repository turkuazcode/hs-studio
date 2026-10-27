// Image / video quality metrics for the Q02 quality layer. Dependency-free, written from the
// published definitions (no GPL code):
// - PSNR (RGB), SSIM (Wang et al. 2004, luma, 11x11 Gaussian σ=1.5, K1=0.01, K2=0.03)
// - GMSD (Xue et al. 2014, gradient magnitude similarity deviation; lower = better, 0 = identical)
// - sharpness: variance of the 4-neighbour Laplacian of luma (no-reference)
// - noise σ: Immerkær 1996 fast noise estimation (no-reference)
// - colourfulness: Hasler & Süsstrunk 2003 (no-reference)
// - temporal: mean |Δout − Δref| between consecutive frames (flicker / temporal error vs the
//   reference) and the mean frame-to-frame change of the output alone.
// Images are { width, height, data: RGBA Uint8 } unless noted. A region (roi) is
// { x, y, w, h } as fractions of the image size.
//
// PSNR/SSIM/GMSD are auxiliary: with generative restoration they are not a quality verdict on
// their own (Plan 14 Q02); they flag fidelity loss, the blind A/B rating decides preference.

export function luma(img) {
  const n = img.width * img.height;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  return y;
}

/** Crops an RGBA image to a fractional region (pixel-rounded). */
export function crop(img, roi) {
  if (!roi) return img;
  const x0 = Math.round(roi.x * img.width), y0 = Math.round(roi.y * img.height);
  const w = Math.max(1, Math.round(roi.w * img.width)), h = Math.max(1, Math.round(roi.h * img.height));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}

const sameSize = (a, b) => {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} != ${b.width}x${b.height}`);
};

export function psnr(a, b) {
  sameSize(a, b);
  let sq = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i * 4 + c] - b.data[i * 4 + c];
      sq += d * d;
    }
  }
  const mse = sq / (n * 3);
  return mse === 0 ? 99 : Math.min(99, 10 * Math.log10((255 * 255) / mse));
}

const GAUSS = (() => {
  const k = [];
  let s = 0;
  for (let i = -5; i <= 5; i++) { const v = Math.exp(-(i * i) / (2 * 1.5 * 1.5)); k.push(v); s += v; }
  return k.map((v) => v / s);
})();

/** Separable Gaussian blur with edge clamping. */
function blur(src, w, h) {
  const tmp = new Float64Array(w * h), out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -5; k <= 5; k++) s += GAUSS[k + 5] * src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -5; k <= 5; k++) s += GAUSS[k + 5] * tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

export function ssim(a, b) {
  sameSize(a, b);
  const w = a.width, h = a.height, n = w * h;
  const x = luma(a), y = luma(b);
  const xx = new Float64Array(n), yy = new Float64Array(n), xy = new Float64Array(n);
  for (let i = 0; i < n; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
  const mx = blur(x, w, h), my = blur(y, w, h), sxx = blur(xx, w, h), syy = blur(yy, w, h), sxy = blur(xy, w, h);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const vx = sxx[i] - mx[i] * mx[i], vy = syy[i] - my[i] * my[i], cxy = sxy[i] - mx[i] * my[i];
    sum += ((2 * mx[i] * my[i] + C1) * (2 * cxy + C2)) / ((mx[i] * mx[i] + my[i] * my[i] + C1) * (vx + vy + C2));
  }
  return sum / n;
}

/** Prewitt gradient magnitude of luma (values 0..255 scale). */
function gradMag(y, w, h) {
  const g = new Float64Array(w * h);
  const at = (xx, yy) => y[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const gx = (at(i + 1, j - 1) + at(i + 1, j) + at(i + 1, j + 1) - at(i - 1, j - 1) - at(i - 1, j) - at(i - 1, j + 1)) / 3;
      const gy = (at(i - 1, j + 1) + at(i, j + 1) + at(i + 1, j + 1) - at(i - 1, j - 1) - at(i, j - 1) - at(i + 1, j - 1)) / 3;
      g[j * w + i] = Math.hypot(gx, gy);
    }
  }
  return g;
}

export function gmsd(a, b) {
  sameSize(a, b);
  const w = a.width, h = a.height;
  const ga = gradMag(luma(a), w, h), gb = gradMag(luma(b), w, h);
  const c = 170; // constant from the paper for 0..255 images
  const gms = new Float64Array(w * h);
  let mean = 0;
  for (let i = 0; i < gms.length; i++) { gms[i] = (2 * ga[i] * gb[i] + c) / (ga[i] * ga[i] + gb[i] * gb[i] + c); mean += gms[i]; }
  mean /= gms.length;
  let v = 0;
  for (const s of gms) v += (s - mean) ** 2;
  return Math.sqrt(v / gms.length);
}

export function sharpness(img) {
  const w = img.width, h = img.height, y = luma(img);
  let s = 0, s2 = 0, n = 0;
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const l = 4 * y[j * w + i] - y[j * w + i - 1] - y[j * w + i + 1] - y[(j - 1) * w + i] - y[(j + 1) * w + i];
      s += l; s2 += l * l; n++;
    }
  }
  return n ? s2 / n - (s / n) ** 2 : 0;
}

export function noiseSigma(img) {
  const w = img.width, h = img.height, y = luma(img);
  // Immerkær mask [1 -2 1; -2 4 -2; 1 -2 1]
  let s = 0;
  for (let j = 1; j < h - 1; j++) {
    for (let i = 1; i < w - 1; i++) {
      const p = (dx, dy) => y[(j + dy) * w + i + dx];
      s += Math.abs(p(-1, -1) - 2 * p(0, -1) + p(1, -1) - 2 * p(-1, 0) + 4 * p(0, 0) - 2 * p(1, 0) + p(-1, 1) - 2 * p(0, 1) + p(1, 1));
    }
  }
  return (Math.sqrt(Math.PI / 2) / (6 * (w - 2) * (h - 2))) * s;
}

export function colorfulness(img) {
  const n = img.width * img.height;
  let mrg = 0, myb = 0, srg = 0, syb = 0;
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const rg = r - g, yb = 0.5 * (r + g) - b;
    mrg += rg; myb += yb; srg += rg * rg; syb += yb * yb;
  }
  mrg /= n; myb /= n;
  const sdrg = Math.sqrt(Math.max(0, srg / n - mrg * mrg)), sdyb = Math.sqrt(Math.max(0, syb / n - myb * myb));
  return Math.hypot(sdrg, sdyb) + 0.3 * Math.hypot(mrg, myb);
}

/** Full-reference metrics of an output against its reference, optionally inside a region. */
export function fullReference(out, ref, roi) {
  const o = crop(out, roi), r = crop(ref, roi);
  return { psnr: psnr(o, r), ssim: ssim(o, r), gmsd: gmsd(o, r), sharpnessRatio: sharpness(o) / Math.max(1e-9, sharpness(r)) };
}

/** No-reference metrics (real old sources). */
export function noReference(img, roi) {
  const c = crop(img, roi);
  return { sharpness: sharpness(c), noise: noiseSigma(c), colorfulness: colorfulness(c) };
}

/** Mean absolute luma of a frame difference (frames: RGBA Uint8Array of equal size). */
function frameDiffLuma(a, b, out) {
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    out[p] = 0.299 * (a[i] - b[i]) + 0.587 * (a[i + 1] - b[i + 1]) + 0.114 * (a[i + 2] - b[i + 2]);
  }
  return out;
}

/**
 * Video: per-frame PSNR/SSIM (every `stride`-th frame for SSIM), temporal error against the
 * reference and output-only temporal change. out/ref: { width, height, frames }.
 */
export function videoMetrics(out, ref, { ssimStride = 5 } = {}) {
  const n = Math.min(out.frames.length, ref.frames.length);
  const img = (v, i) => ({ width: v.width, height: v.height, data: v.frames[i] });
  const ps = [], ss = [];
  let tErr = 0, tOut = 0;
  const px = out.width * out.height;
  const dOut = new Float64Array(px), dRef = new Float64Array(px);
  for (let i = 0; i < n; i++) {
    ps.push(psnr(img(out, i), img(ref, i)));
    if (i % ssimStride === 0) ss.push(ssim(img(out, i), img(ref, i)));
    if (i > 0) {
      frameDiffLuma(out.frames[i], out.frames[i - 1], dOut);
      frameDiffLuma(ref.frames[i], ref.frames[i - 1], dRef);
      let e = 0, o = 0;
      for (let p = 0; p < px; p++) { e += Math.abs(dOut[p] - dRef[p]); o += Math.abs(dOut[p]); }
      tErr += e / px; tOut += o / px;
    }
  }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return {
    frames: n,
    psnr: mean(ps), psnrMin: Math.min(...ps),
    ssim: mean(ss), ssimMin: Math.min(...ss),
    temporalError: tErr / Math.max(1, n - 1),
    temporalChange: tOut / Math.max(1, n - 1),
  };
}
