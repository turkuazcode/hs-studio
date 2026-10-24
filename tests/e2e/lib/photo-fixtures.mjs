// Synthetic photo folders for the photo studio E2E tests (generated at test time,
// deleted afterwards). Base pixels come from tests/fixtures/photo-a.jpg (640x480) and
// photo-b.png (400x300); every copy gets its own EXIF block (camera, capture date,
// orientation, GPS), its own size (padding) and its own modification time.
import { mkdirSync, readFileSync, utimesSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { fixture } from "./app.mjs";

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5 };

const ascii = (s) => Buffer.from(s + "\0", "latin1");
const short = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const long = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const rationals = (pairs) => Buffer.concat(pairs.map(([n, d]) => Buffer.concat([long(n), long(d)])));

/** One IFD at `offset` (little endian); values > 4 bytes follow the entry table. */
function ifd(entries, offset) {
  entries = [...entries].sort((a, b) => a.tag - b.tag);
  const head = Buffer.alloc(2 + 12 * entries.length + 4);
  head.writeUInt16LE(entries.length, 0);
  let dataOff = offset + head.length;
  const data = [];
  entries.forEach((e, i) => {
    const p = 2 + 12 * i;
    head.writeUInt16LE(e.tag, p);
    head.writeUInt16LE(e.type, p + 2);
    head.writeUInt32LE(e.count, p + 4);
    if (e.value.length <= 4) e.value.copy(head, p + 8);
    else {
      head.writeUInt32LE(dataOff, p + 8);
      const v = e.value.length % 2 ? Buffer.concat([e.value, Buffer.alloc(1)]) : e.value;
      data.push(v);
      dataOff += v.length;
    }
  });
  return Buffer.concat([head, ...data]);
}

const dms = (deg) => {
  const a = Math.abs(deg), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60 * 100);
  return rationals([[d, 1], [m, 1], [s, 100]]);
};

/** TIFF/EXIF payload: { make, model, orientation, date: "YYYY:MM:DD HH:MM:SS", gps: {lat, lon} } */
export function exifTiff({ make = "VHO Test", model = "Synthetic", orientation = 1, date, gps }) {
  const exifEntries = date ? [{ tag: 0x9003, type: T.ASCII, count: 20, value: ascii(date) }] : [];
  const gpsEntries = gps ? [
    { tag: 0x0000, type: T.BYTE, count: 4, value: Buffer.from([2, 3, 0, 0]) },
    { tag: 0x0001, type: T.ASCII, count: 2, value: ascii(gps.lat >= 0 ? "N" : "S") },
    { tag: 0x0002, type: T.RATIONAL, count: 3, value: dms(gps.lat) },
    { tag: 0x0003, type: T.ASCII, count: 2, value: ascii(gps.lon >= 0 ? "E" : "W") },
    { tag: 0x0004, type: T.RATIONAL, count: 3, value: dms(gps.lon) },
  ] : [];
  const ifd0 = (exifOff, gpsOff) => ifd([
    { tag: 0x010f, type: T.ASCII, count: make.length + 1, value: ascii(make) },
    { tag: 0x0110, type: T.ASCII, count: model.length + 1, value: ascii(model) },
    { tag: 0x0112, type: T.SHORT, count: 1, value: short(orientation) },
    ...(exifEntries.length ? [{ tag: 0x8769, type: T.LONG, count: 1, value: long(exifOff) }] : []),
    ...(gpsEntries.length ? [{ tag: 0x8825, type: T.LONG, count: 1, value: long(gpsOff) }] : []),
  ], 8);
  const size0 = ifd0(0, 0).length;
  const exifBuf = exifEntries.length ? ifd(exifEntries, 8 + size0) : Buffer.alloc(0);
  const gpsOff = 8 + size0 + exifBuf.length;
  const gpsBuf = gpsEntries.length ? ifd(gpsEntries, gpsOff) : Buffer.alloc(0);
  const header = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  return Buffer.concat([header, ifd0(8 + size0, gpsOff), exifBuf, gpsBuf]);
}

/** JPEG with APP1 EXIF (existing APP1 removed) and an optional COM padding segment. */
export function jpegWithExif(jpeg, tiff, padding = 0) {
  const segs = [];
  let pos = 2;
  while (pos < jpeg.length && jpeg[pos] === 0xff && jpeg[pos + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(pos + 2);
    segs.push({ marker: jpeg[pos + 1], buf: jpeg.subarray(pos, pos + 2 + len) });
    pos += 2 + len;
  }
  const rest = jpeg.subarray(pos);
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(app1Body.length + 2); return b; })(), app1Body]);
  const app0 = segs.filter((s) => s.marker === 0xe0).map((s) => s.buf);
  const others = segs.filter((s) => s.marker !== 0xe0 && s.marker !== 0xe1).map((s) => s.buf);
  const com = [];
  for (let left = padding; left > 0; left -= 60000) {
    const n = Math.min(left, 60000);
    const b = Buffer.alloc(4 + n, 0x20);
    b[0] = 0xff; b[1] = 0xfe;
    b.writeUInt16BE(n + 2, 2);
    com.push(b);
  }
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...app0, app1, ...com, ...others, rest]);
}

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

/** PNG with an eXIf chunk (and tEXt padding) before the first IDAT. */
export function pngWithExif(png, tiff, padding = 0) {
  let pos = 8;
  while (pos < png.length && png.toString("latin1", pos + 4, pos + 8) !== "IDAT") pos += 12 + png.readUInt32BE(pos);
  const extra = [pngChunk("eXIf", tiff)];
  if (padding > 0) extra.push(pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.alloc(padding, 0x20)])));
  return Buffer.concat([png.subarray(0, pos), ...extra, png.subarray(pos)]);
}

/** Width/height from a JPEG SOF segment (stored, not EXIF-rotated). */
export function jpegSize(buf) {
  let pos = 2;
  while (pos < buf.length) {
    const m = buf[pos + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) };
    pos += 2 + buf.readUInt16BE(pos + 2);
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");
export const BASE_DATE = Date.UTC(2021, 0, 1, 10, 0, 0);
const DAY = 86400000;

/** EXIF date string for a UTC ms timestamp. */
export const exifDateString = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};

/**
 * Writes `count` photos IMG_1..IMG_count (every 3rd a PNG) into `dir`, plus `clip.mp4`.
 * Returns the manifest: [{ name, path, exifDate (ms), mtime (ms), size, orientation }].
 */
export function makePhotoFolder(dir, count = 300, { video = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const jpg = readFileSync(fixture("photo-a.jpg"));
  const png = readFileSync(fixture("photo-b.png"));
  const out = [];
  const mtimeBase = Date.UTC(2023, 5, 1) / 1000;
  for (let i = 1; i <= count; i++) {
    const isPng = i % 3 === 0;
    const exifDate = BASE_DATE + ((i * 7) % count) * DAY + i * 1000; // unique, unrelated to name order
    const orientation = !isPng && i % 10 === 0 ? 6 : 1;
    const tiff = exifTiff({
      model: `Kamera ${i % 4}`, orientation, date: exifDateString(exifDate),
      gps: isPng ? null : { lat: 41 + i / 1000, lon: 28.97 + i / 1000 },
    });
    const padding = (i * 37) % 3000;
    const name = `IMG_${i}.${isPng ? "png" : "jpg"}`;
    const path = join(dir, name);
    const bytes = isPng ? pngWithExif(png, tiff, padding) : jpegWithExif(jpg, tiff, padding);
    writeFileSync(path, bytes);
    const mtime = mtimeBase + (count - i) * 60; // reverse of name order
    utimesSync(path, mtime, mtime);
    out.push({ name, path, exifDate, mtime: mtime * 1000, size: bytes.length, orientation, isPng });
  }
  if (video) copyFileSync(fixture("sample-h264.mp4"), join(dir, "clip.mp4"));
  return out;
}

/** `count` identical small JPEGs (performance folder). */
export function makeBulkFolder(dir, count) {
  mkdirSync(dir, { recursive: true });
  const jpg = readFileSync(fixture("photo-a.jpg"));
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `P${String(i).padStart(5, "0")}.jpg`), jpg);
}
