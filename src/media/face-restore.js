// ==========================================================================
// VHO face restoration stage (runs inside ai-worker.js)
//   YuNet detect (MIT) -> FFHQ 5-point similarity alignment -> GFPGAN v1.4 (Apache-2.0)
//   -> feathered paste back.
// Mirrors the validated Python prototype step by step.
// ==========================================================================

const DET_SIZE = 640;
const FACE = 512;
// FFHQ 512 template: image-left eye, image-right eye, nose, mouth-left, mouth-right
const FFHQ_512 = [
  [192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935],
  [201.26117, 371.41043], [313.08905, 371.15118],
];

/** YuNet detection on an RGBA image. Returns [{ score, box:[x,y,w,h], lm:[[x,y]x5] }] in image pixels. */
export async function detectFaces(ort, session, image, { scoreTh = 0.6, nmsTh = 0.3 } = {}) {
  const { width: W, height: H } = image;
  const scale = DET_SIZE / Math.max(W, H);
  const nw = Math.round(W * scale), nh = Math.round(H * scale);

  // Letterbox: resized image at the top-left of a black 640x640 canvas (high-quality resampling)
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(image.data), W, H));
  const canvas = new OffscreenCanvas(DET_SIZE, DET_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, nw, nh);
  bmp.close();
  const px = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;

  // BGR, 0..255, NCHW, no normalisation
  const plane = DET_SIZE * DET_SIZE;
  const blob = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    blob[i] = px[i * 4 + 2];
    blob[plane + i] = px[i * 4 + 1];
    blob[2 * plane + i] = px[i * 4];
  }
  const input = new ort.Tensor("float32", blob, [1, 3, DET_SIZE, DET_SIZE]);
  const outs = await session.run({ [session.inputNames[0]]: input });
  input.dispose();

  const dets = [];
  for (const st of [8, 16, 32]) {
    const cls = await outs[`cls_${st}`].getData();
    const obj = await outs[`obj_${st}`].getData();
    const box = await outs[`bbox_${st}`].getData();
    const kps = await outs[`kps_${st}`].getData();
    const cols = DET_SIZE / st;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < scoreTh) continue;
      const r = Math.floor(i / cols), c = i % cols;
      const cx = (c + box[i * 4]) * st, cy = (r + box[i * 4 + 1]) * st;
      const w = Math.exp(box[i * 4 + 2]) * st, h = Math.exp(box[i * 4 + 3]) * st;
      const lm = [];
      for (let k = 0; k < 5; k++) lm.push([(kps[i * 10 + 2 * k] + c) * st, (kps[i * 10 + 2 * k + 1] + r) * st]);
      dets.push({ score, box: [cx - w / 2, cy - h / 2, w, h], lm });
    }
  }
  Object.values(outs).forEach((t) => t.dispose());

  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) if (keep.every((k) => iou(d.box, k.box) < nmsTh)) keep.push(d);
  return keep.map((d) => ({
    score: d.score,
    box: d.box.map((v) => v / scale),
    lm: d.lm.map(([x, y]) => [x / scale, y / scale]),
  }));
}

function iou(a, b) {
  const iw = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9);
}

/** Least-squares similarity transform src -> dst (Umeyama, closed form). Returns [a, b, tx, ty]: M = [[a,-b,tx],[b,a,ty]]. */
function similarity(src, dst) {
  const mean = (p) => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  const ms = mean(src), md = mean(dst);
  let den = 0, sa = 0, sb = 0;
  for (let i = 0; i < src.length; i++) {
    const x = src[i][0] - ms[0], y = src[i][1] - ms[1];
    const u = dst[i][0] - md[0], v = dst[i][1] - md[1];
    den += x * x + y * y;
    sa += x * u + y * v;
    sb += x * v - y * u;
  }
  const a = sa / den, b = sb / den;
  return [a, b, md[0] - (a * ms[0] - b * ms[1]), md[1] - (b * ms[0] + a * ms[1])];
}

const reflect101 = (i, n) => {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i;
  return i;
};

/** Bilinear RGB sample with reflect-101 borders. */
function sampleRGB(data, W, H, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const xa = reflect101(x0, W), xb = reflect101(x0 + 1, W);
  const ya = reflect101(y0, H), yb = reflect101(y0 + 1, H);
  for (let ch = 0; ch < 3; ch++) {
    const p00 = data[(ya * W + xa) * 4 + ch], p10 = data[(ya * W + xb) * 4 + ch];
    const p01 = data[(yb * W + xa) * 4 + ch], p11 = data[(yb * W + xb) * 4 + ch];
    out[ch] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
  }
}

/** Bicubic (A = -0.75, same as OpenCV INTER_CUBIC) RGB sample with reflect-101 borders. */
function cubicW(t) {
  const A = -0.75, x = Math.abs(t);
  if (x <= 1) return ((A + 2) * x - (A + 3)) * x * x + 1;
  if (x < 2) return ((A * x - 5 * A) * x + 8 * A) * x - 4 * A;
  return 0;
}

function sampleRGBCubic(data, W, H, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (let j = -1; j <= 2; j++) {
    const wy = cubicW(j - fy), yy = reflect101(y0 + j, H);
    for (let i = -1; i <= 2; i++) {
      const w = wy * cubicW(i - fx), p = (yy * W + reflect101(x0 + i, W)) * 4;
      out[0] += data[p] * w;
      out[1] += data[p + 1] * w;
      out[2] += data[p + 2] * w;
    }
  }
  for (let ch = 0; ch < 3; ch++) out[ch] = Math.min(255, Math.max(0, out[ch]));
}

/** 512x512 feather mask: linear ramp over 10% at the borders, then Gaussian blur (σ = margin/4). */
function featherMask() {
  const m = Math.floor(FACE * 0.1);
  const ramp = new Float32Array(FACE);
  for (let i = 0; i < FACE; i++) ramp[i] = Math.min(1, Math.max(0, Math.min(i, FACE - 1 - i) / m));
  let mask = new Float32Array(FACE * FACE);
  for (let y = 0; y < FACE; y++) for (let x = 0; x < FACE; x++) mask[y * FACE + x] = Math.min(ramp[x], ramp[y]);
  // Separable Gaussian blur
  const sigma = m / 4, rad = Math.ceil(sigma * 3);
  const k = [];
  let ks = 0;
  for (let i = -rad; i <= rad; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); ks += w; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  for (const horizontal of [true, false]) {
    const outM = new Float32Array(FACE * FACE);
    for (let y = 0; y < FACE; y++) {
      for (let x = 0; x < FACE; x++) {
        let s = 0;
        for (let i = -rad; i <= rad; i++) {
          const xx = horizontal ? reflect101(x + i, FACE) : x;
          const yy = horizontal ? y : reflect101(y + i, FACE);
          s += mask[yy * FACE + xx] * k[i + rad];
        }
        outM[y * FACE + x] = s;
      }
    }
    mask = outM;
  }
  return mask;
}

let maskCache = null;

/**
 * Restores every detected face in place.
 * image: { width, height, data: Uint8ClampedArray RGBA } at final resolution.
 * opts.minEyePx: skip faces whose eye distance in the ORIGINAL photo is smaller (mostly hallucination).
 * opts.srcScale: final / original size ratio. opts.strength: 0..1 blend with the unrestored crop.
 * cropSource: the ORIGINAL (pre-upscale) image. Faces are detected on the upscaled image but
 *   cropped from the original: the upscaler tends to "melt" small eyes/noses, and GFPGAN
 *   (trained on blurry faces) repairs blur far better than it repairs wrong structure.
 */
export async function restoreFaces(ort, detSession, faceSession, image, opts = {}, onFace = () => {}, cropSource = null) {
  const { strength = 1, srcScale = 1, minEyePx = 8, minFacePx = 16, debug = false } = opts;
  const debugFaces = [];
  const { width: W, height: H, data } = image;
  const faces = await detectFaces(ort, detSession, image);
  maskCache ??= featherMask();
  const mask = maskCache;
  let restored = 0;

  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const eye = Math.hypot(f.lm[1][0] - f.lm[0][0], f.lm[1][1] - f.lm[0][1]);
    if (Math.min(f.box[2], f.box[3]) < minFacePx || eye / srcScale < minEyePx) {
      onFace(fi + 1, faces.length);
      continue;
    }
    const [a, b, tx, ty] = similarity(f.lm, FFHQ_512); // image -> aligned
    const det = a * a + b * b;
    const ia = a / det, ib = -b / det;                  // inverse rotation/scale
    const itx = -(ia * tx - ib * ty), ity = -(ib * tx + ia * ty);

    // Aligned 512 crop (RGB 0..255) + restorer input in [-1, 1]
    const plane = FACE * FACE;
    const crop = new Float32Array(3 * plane);
    const x = new Float32Array(3 * plane);
    const rgb = [0, 0, 0];
    let satSum = 0;
    for (let v = 0; v < FACE; v++) {
      for (let u = 0; u < FACE; u++) {
        const sx = ia * u - ib * v + itx, sy = ib * u + ia * v + ity;
        if (cropSource) {
          sampleRGBCubic(cropSource.data, cropSource.width, cropSource.height, sx / srcScale, sy / srcScale, rgb);
        } else {
          sampleRGB(data, W, H, sx, sy, rgb);
        }
        const i = v * FACE + u;
        for (let ch = 0; ch < 3; ch++) {
          crop[ch * plane + i] = rgb[ch];
          x[ch * plane + i] = rgb[ch] / 127.5 - 1;
        }
        const mx = Math.max(rgb[0], rgb[1], rgb[2]), mn = Math.min(rgb[0], rgb[1], rgb[2]);
        satSum += mx > 0 ? ((mx - mn) / mx) * 255 : 0;
      }
    }
    const grayscale = satSum / plane < 12; // old B/W photo: don't colourise the face

    const input = new ort.Tensor("float32", x, [1, 3, FACE, FACE]);
    const res = await faceSession.run({ [faceSession.inputNames[0]]: input }, [faceSession.outputNames[0]]);
    input.dispose();
    const yt = res[faceSession.outputNames[0]];
    const y = await yt.getData();
    yt.dispose();

    if (debug) { // aligned input + raw restorer output as RGBA, for comparing against the reference
      const toRGBA = (src, map) => {
        const o = new Uint8ClampedArray(plane * 4);
        for (let i = 0; i < plane; i++) {
          for (let ch = 0; ch < 3; ch++) o[i * 4 + ch] = map(src[ch * plane + i]);
          o[i * 4 + 3] = 255;
        }
        return o;
      };
      debugFaces.push({
        lm: f.lm, score: f.score,
        aligned: toRGBA(crop, (v) => v),
        restored: toRGBA(y, (v) => (Math.min(1, Math.max(-1, v)) + 1) * 127.5),
      });
    }

    // Restored face 0..255 (optionally luminance-only, then blended by strength)
    const face = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      let r = (Math.min(1, Math.max(-1, y[i])) + 1) * 127.5;
      let g = (Math.min(1, Math.max(-1, y[plane + i])) + 1) * 127.5;
      let bl = (Math.min(1, Math.max(-1, y[2 * plane + i])) + 1) * 127.5;
      if (grayscale) r = g = bl = 0.299 * r + 0.587 * g + 0.114 * bl;
      face[i] = strength * r + (1 - strength) * crop[i];
      face[plane + i] = strength * g + (1 - strength) * crop[plane + i];
      face[2 * plane + i] = strength * bl + (1 - strength) * crop[2 * plane + i];
    }

    // Paste back: bounding box of the aligned square in image space, then blend with the mask
    const corners = [[0, 0], [FACE - 1, 0], [0, FACE - 1], [FACE - 1, FACE - 1]]
      .map(([u, v]) => [ia * u - ib * v + itx, ib * u + ia * v + ity]);
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const u = a * px - b * py + tx, v = b * px + a * py + ty;
        if (u < 0 || v < 0 || u > FACE - 1 || v > FACE - 1) continue;
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        const u1 = Math.min(FACE - 1, u0 + 1), v1 = Math.min(FACE - 1, v0 + 1);
        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
        const i00 = v0 * FACE + u0, i10 = v0 * FACE + u1, i01 = v1 * FACE + u0, i11 = v1 * FACE + u1;
        const m = mask[i00] * w00 + mask[i10] * w10 + mask[i01] * w01 + mask[i11] * w11;
        if (m <= 0) continue;
        const di = (py * W + px) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const o = ch * plane;
          const fval = face[o + i00] * w00 + face[o + i10] * w10 + face[o + i01] * w01 + face[o + i11] * w11;
          data[di + ch] = data[di + ch] * (1 - m) + fval * m;
        }
      }
    }
    restored++;
    onFace(fi + 1, faces.length);
  }
  return debug ? { found: faces.length, restored, debugFaces } : { found: faces.length, restored };
}
