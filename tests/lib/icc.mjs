// Synthetic ICC v2 RGB display profile (matrix + gamma TRC) for colour-management tests
// (A04): a wide-gamut "Rec.2020-like" profile, generated here so no third-party profile file
// is needed. Plus a helper that embeds a profile into a PNG (iCCP chunk).
import { crc32, deflateSync } from "node:zlib";

const s15 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v * 65536));
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
};
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

const xyz = (x, y, z) => Buffer.concat([Buffer.from("XYZ "), Buffer.alloc(4), s15(x), s15(y), s15(z)]);
const curv = (gamma) => Buffer.concat([Buffer.from("curv"), Buffer.alloc(4), u32(1), Buffer.from([Math.floor(gamma), Math.round((gamma % 1) * 256)])]);
function desc(text) {
  const ascii = Buffer.from(`${text}\0`, "latin1");
  return Buffer.concat([Buffer.from("desc"), Buffer.alloc(4), u32(ascii.length), ascii, Buffer.alloc(4 + 4 + 2 + 1 + 67)]);
}
const textTag = (text) => Buffer.concat([Buffer.from("text"), Buffer.alloc(4), Buffer.from(`${text}\0`, "latin1")]);

/**
 * Wide-gamut RGB profile: Rec.2020 primaries (D50-adapted colorants), gamma 2.2.
 * Pixels tagged with it look clearly different after conversion to sRGB.
 */
export function wideGamutProfile(name = "VHO test wide gamut") {
  const tags = [
    ["desc", desc(name)],
    ["cprt", textTag("Public domain test profile")],
    ["wtpt", xyz(0.9642, 1.0, 0.8249)],
    ["rXYZ", xyz(0.6734, 0.279, -0.0019)],
    ["gXYZ", xyz(0.1656, 0.6753, 0.0298)],
    ["bXYZ", xyz(0.1251, 0.0456, 0.7973)],
    ["rTRC", curv(2.2)],
    ["gTRC", curv(2.2)],
    ["bTRC", curv(2.2)],
  ];
  const tableSize = 4 + tags.length * 12;
  let offset = 128 + tableSize;
  const entries = [];
  const blobs = [];
  for (const [sig, data] of tags) {
    const d = pad4(data);
    entries.push(Buffer.concat([Buffer.from(sig), u32(offset), u32(data.length)]));
    blobs.push(d);
    offset += d.length;
  }
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.writeUInt32BE(0x02100000, 8);
  header.write("mntr", 12, "latin1");
  header.write("RGB ", 16, "latin1");
  header.write("XYZ ", 20, "latin1");
  header.writeUInt16BE(2026, 24);
  header.writeUInt16BE(1, 26);
  header.writeUInt16BE(1, 28);
  header.write("acsp", 36, "latin1");
  s15(0.9642).copy(header, 68);
  s15(1.0).copy(header, 72);
  s15(0.8249).copy(header, 76);
  return Buffer.concat([header, u32(tags.length), ...entries, ...blobs]);
}

function chunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([u32(data.length), t, data, c]);
}

/** PNG bytes with an iCCP chunk inserted right after IHDR. */
export function pngWithIcc(png, profile, name = "wide") {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const iccp = chunk("iCCP", Buffer.concat([Buffer.from(`${name}\0`, "latin1"), Buffer.from([0]), deflateSync(profile)]));
  return Buffer.concat([png.subarray(0, ihdrEnd), iccp, png.subarray(ihdrEnd)]);
}

/** Chunk types of a PNG (order kept). */
export function pngChunks(png) {
  const out = [];
  for (let i = 8; i + 8 <= png.length;) {
    const len = png.readUInt32BE(i);
    out.push(png.toString("latin1", i + 4, i + 8));
    i += 12 + len;
  }
  return out;
}
