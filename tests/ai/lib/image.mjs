// Small, dependency-free image helpers for the real-AI smoke tests: 8-bit RGBA PNG
// encode/decode (non-interlaced), the synthetic fixture, a reference upscale and comparisons.
import { deflateSync, inflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** { width, height, data: Uint8Array RGBA } -> PNG bytes (filter 0, deterministic). */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** PNG bytes (8-bit RGBA or RGB, non-interlaced) -> { width, height, data: Uint8Array RGBA }. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) {
        throw new Error("only 8-bit non-interlaced RGB/RGBA PNGs are supported");
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  if (bpp === 4) return { width, height, data: new Uint8Array(px) };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

/**
 * The synthetic, shareable smoke fixture (generated, no camera/personal content). 44x28 so
 * that both sides need padding to the model's multiple of 16.
 * - top half: three saturated stripes red | green | blue (channel order)
 * - bottom half: grey ramp with a hard diagonal edge and a 2 px checker (detail, non-constant)
 * - bottom right 8x6 block: alpha 0, a strip above it: alpha 128 (alpha handling)
 */
export const FIXTURE_REGIONS = Object.freeze({
  red: { x0: 2, x1: 12, y0: 2, y1: 11 },
  green: { x0: 17, x1: 27, y0: 2, y1: 11 },
  blue: { x0: 32, x1: 42, y0: 2, y1: 11 },
  transparent: { x0: 36, x1: 44, y0: 22, y1: 28 },
  halfAlpha: { x0: 36, x1: 44, y0: 19, y1: 22 },
});

export function makeFixture() {
  const width = 44, height = 28;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r, g, b;
      if (y < 13) {
        const stripe = Math.min(2, Math.floor(x / (width / 3)));
        [r, g, b] = [[215, 35, 30], [30, 190, 45], [35, 50, 210]][stripe];
      } else {
        const ramp = Math.round(40 + (x / (width - 1)) * 170);
        const edge = x - (y - 13) * 1.5 > 10 ? 1 : 0;
        const checker = x >= 24 && x < 34 && y >= 16 && y < 26 ? ((x >> 1) + (y >> 1)) & 1 : -1;
        const v = checker >= 0 ? (checker ? 235 : 20) : edge ? ramp : 255 - ramp;
        [r, g, b] = [v, v, Math.min(255, v + 10)];
      }
      let a = 255;
      const inside = (q) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1;
      if (inside(FIXTURE_REGIONS.transparent)) a = 0;
      else if (inside(FIXTURE_REGIONS.halfAlpha)) a = 128;
      data.set([r, g, b, a], i);
    }
  }
  return { width, height, data };
}

/** Bilinear (pixel-centre aligned) upscale of the RGB channels; independent baseline. */
export function bilinearUpscale({ width, height, data }, s) {
  const W = width * s, H = height * s;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) / s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(height - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) / s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(width - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => data[(yy * width + xx) * 4 + c];
        const v = (p(y0, x0) * (1 - wx) + p(y0, x1) * wx) * (1 - wy) + (p(y1, x0) * (1 - wx) + p(y1, x1) * wx) * wy;
        out[(y * W + x) * 4 + c] = Math.round(v);
      }
      out[(y * W + x) * 4 + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** RGB difference: mean / max absolute error, the 99.9th percentile and PSNR (dB). */
export function compareRgb(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} != ${b.width}x${b.height}`);
  const n = a.width * a.height;
  const hist = new Uint32Array(256);
  let sum = 0, sq = 0, max = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]);
      sum += d;
      sq += d * d;
      if (d > max) max = d;
      hist[d]++;
    }
  }
  let acc = 0, p999 = 0;
  for (let d = 0; d < 256; d++) {
    acc += hist[d];
    if (acc >= n * 3 * 0.999) { p999 = d; break; }
  }
  const mse = sq / (n * 3);
  return { meanAbs: sum / (n * 3), maxAbs: max, p999, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse) };
}

/** Mean RGB of a fixture region mapped to the output scale, with an inner margin (no edges). */
export function regionMean(img, region, scale, margin = 2) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = (region.y0 + margin) * scale; y < (region.y1 - margin) * scale; y++) {
    for (let x = (region.x0 + margin) * scale; x < (region.x1 - margin) * scale; x++) {
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += img.data[i + c];
      n++;
    }
  }
  return sum.map((v) => v / n);
}

/** Standard deviation of the luma over the whole image (constant output -> ~0). */
export function lumaStdDev(img) {
  const n = img.width * img.height;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
    s += l;
    s2 += l * l;
  }
  return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
}
