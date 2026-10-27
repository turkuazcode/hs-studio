// Q02 quality set: downloads the pinned public-domain sources once and rebuilds every sample
// deterministically with the app's LGPL ffmpeg (or in Node for generated patterns).
//
//   cache:   VHO_QUALITY_CACHE (default <repo>/tests/.cache/quality)
//            src/<file>          downloaded sources (SHA-256 checked, reused when it matches)
//            set/<id>/...        built samples: ref.png + input.png (photos), ref.mkv + input.mkv (clips)
//   lock:    tests/quality/set-lock.json — SHA-256 of every built file + the ffmpeg version that
//            produced it. A mismatch means the recipe or the ffmpeg build changed: rebuild with
//            VHO_QUALITY_UPDATE_LOCK=1 and review (results are only comparable within one lock).
//   offline: VHO_QUALITY_OFFLINE=1 never downloads (missing sources -> error).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../../ai/lib/image.mjs";
import { ffmpeg, ffmpegVersion, requireTools } from "./ffmpeg.mjs";

export const QUALITY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(QUALITY_DIR, "../..");
export const CACHE = process.env.VHO_QUALITY_CACHE || join(REPO_ROOT, "tests", ".cache", "quality");
export const MANIFEST_PATH = join(QUALITY_DIR, "manifest.json");
export const LOCK_PATH = join(QUALITY_DIR, "set-lock.json");
const USER_AGENT = "VHO-quality-set/1 (open-source media player test fixtures; https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)";
const CLIP_SECONDS = 3;

export const loadManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
export const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const log = (...a) => console.log("[quality-set]", ...a);

/** Downloads one source (retry + backoff; Wikimedia rate-limits bursts) and checks its hash. */
async function download(src, dest) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash("sha256").update(buf).digest("hex");
      if (buf.length !== src.bytes || hash !== src.sha256) {
        throw new Error(`content changed at the source (${buf.length} bytes, sha256 ${hash}); the pinned file is no longer served`);
      }
      writeFileSync(dest + ".part", buf);
      renameSync(dest + ".part", dest);
      return;
    } catch (e) {
      lastErr = e;
      if (/content changed/.test(e.message)) break;
    }
  }
  throw new Error(`INFRA: download of ${src.url} failed: ${lastErr?.message}`);
}

/** Every source present and hash-verified; returns { id: path }. */
export async function ensureSources(manifest, { offline = process.env.VHO_QUALITY_OFFLINE === "1" } = {}) {
  const dir = join(CACHE, "src");
  mkdirSync(dir, { recursive: true });
  const paths = {};
  const stats = { downloaded: 0, bytes: 0, ms: 0, reused: 0 };
  for (const [id, src] of Object.entries(manifest.sources)) {
    const dest = join(dir, decodeURIComponent(basename(new URL(src.url).pathname)));
    if (existsSync(dest) && statSync(dest).size === src.bytes && sha256File(dest) === src.sha256) {
      stats.reused++;
    } else {
      if (offline) throw new Error(`VHO_QUALITY_OFFLINE=1 and source ${id} is not in the cache (${dest})`);
      const t0 = Date.now();
      await download(src, dest);
      stats.downloaded++;
      stats.bytes += src.bytes;
      stats.ms += Date.now() - t0;
      await new Promise((r) => setTimeout(r, 1500)); // be gentle with upload.wikimedia.org
    }
    paths[id] = dest;
  }
  return { paths, stats };
}

/** Generated patterns (no external source). */
function nodePattern(name, size) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (name === "zoneplate") {
        const cx = x - size / 2, cy = y - size / 2;
        const v = Math.round(127.5 + 127.5 * Math.cos((Math.PI * (cx * cx + cy * cy)) / (size * 1.0)));
        data.set([v, v, v, 255], i);
      } else if (name === "alpha") {
        // colour wheel-ish gradient, a transparent disc and a half-transparent band
        const r = Math.round((x / (size - 1)) * 255), g = Math.round((y / (size - 1)) * 255), b = Math.round(255 - ((x + y) / (2 * size)) * 255);
        const d = Math.hypot(x - size * 0.65, y - size * 0.4);
        const a = d < size * 0.2 ? 0 : y > size * 0.75 ? 128 : 255;
        data.set([r, g, b, a], i);
      } else throw new Error(`unknown pattern ${name}`);
    }
  }
  return encodePng({ width: size, height: size, data });
}

/** Square crop (fractions of the source width/height; height follows from the width). */
async function cropFilter(srcPath, crop, size) {
  const { probe } = await import("./ffmpeg.mjs");
  const v = (await probe(srcPath)).streams.find((s) => s.codec_type === "video");
  const side = Math.floor(crop.w * v.width);
  const h = Math.min(side, v.height - Math.floor(crop.y * v.height));
  const s = Math.min(side, h);
  return `crop=${s}:${s}:${Math.floor(crop.x * v.width)}:${Math.floor(crop.y * v.height)},scale=${size}:${size}:flags=area+accurate_rnd`;
}

async function buildPhoto(p, sources, dir) {
  const ref = join(dir, "ref.png"), input = join(dir, "input.png");
  if (p.generator?.startsWith("node:")) {
    writeFileSync(ref, nodePattern(p.generator.slice(5), p.size));
  } else if (p.generator?.startsWith("lavfi:")) {
    await ffmpeg(["-f", "lavfi", "-i", p.generator.slice(6), "-frames:v", "1", "-pix_fmt", "rgb24", ref]);
  } else {
    const vf = await cropFilter(sources[p.source], p.crop, p.size);
    await ffmpeg(["-i", sources[p.source], "-vf", `${vf},format=rgb24`, "-frames:v", "1", ref]);
  }
  if (p.origin === "real-old") {
    // The real scan is the input; there is no clean reference (no-reference metrics only)
    renameSync(ref, input);
    return [input];
  }
  const small = Math.round(p.size / 4);
  const alpha = p.generator === "node:alpha";
  const filters = [`scale=${small}:${small}:flags=area+accurate_rnd`, p.degrade?.filter].filter(Boolean).join(",");
  if (p.degrade?.jpegQ) {
    const jpg = join(dir, "input.jpg");
    await ffmpeg(["-i", ref, "-vf", `${filters},format=yuvj420p`, "-frames:v", "1", "-q:v", String(p.degrade.jpegQ), jpg]);
    await ffmpeg(["-i", jpg, "-pix_fmt", "rgb24", input]);
    rmSync(jpg);
  } else {
    await ffmpeg(["-i", ref, "-vf", `${filters},format=${alpha ? "rgba" : "rgb24"}`, "-frames:v", "1", input]);
  }
  return [ref, input];
}

/** Turns [S:id] placeholders into ffmpeg inputs. */
function clipGraph(graph, sources) {
  const ids = [...new Set([...graph.matchAll(/\[S:([a-z0-9]+)\]/g)].map((m) => m[1]))];
  const args = ids.flatMap((id) => ["-i", sources[id]]);
  const g = graph.replace(/\[S:([a-z0-9]+)\]/g, (_, id) => `[${ids.indexOf(id)}:v]`);
  return { args, graph: g };
}

async function buildClip(c, sources, dir) {
  const ref = join(dir, "ref.mkv"), input = join(dir, "input.mkv");
  const { args, graph } = clipGraph(c.graph, sources);
  const fc = `${graph},trim=duration=${CLIP_SECONDS},setpts=PTS-STARTPTS,format=bgr0[out]`;
  await ffmpeg([...args, "-filter_complex", fc, "-map", "[out]", "-c:v", "ffv1", "-level", "3", "-g", "1", "-r", "25", ref]);
  const vf = [c.inputFilter, "scale=80:44:flags=area+accurate_rnd", "format=yuv420p"].filter(Boolean).join(",");
  await ffmpeg(["-i", ref, "-vf", vf, "-c:v", "mpeg2video", "-q:v", "6", "-g", "12", "-bf", "0", input]);
  return [ref, input];
}

async function buildStructural(s, dir) {
  if (s.id === "s01-interlaced-tff") {
    const out = join(dir, "interlaced-tff.mpg"); // MPEG-PS: ffprobe reports the coded field order (mkv shows "tb")
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x176:r=50:d=2", "-vf", "scale=320:88:flags=area,weave=first_field=top,setfield=tff,format=yuv420p",
      "-c:v", "mpeg2video", "-flags", "+ilme+ildct", "-top", "1", "-q:v", "4", out]);
    return [out];
  }
  if (s.id === "s02-vfr") {
    const out = join(dir, "vfr.mkv");
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x176:r=30:d=3", "-vf", "select='not(between(n,20,40)*mod(n,2))',format=yuv420p",
      "-fps_mode", "passthrough", "-c:v", "ffv1", out]);
    return [out];
  }
  if (s.id === "s03-av-sync") {
    const out = join(dir, "av-sync.mkv");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=320x176:r=25:d=3", "-f", "lavfi", "-i", "sine=f=1000:r=48000:d=3",
      "-filter_complex", "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.04)',format=yuv420p[v];[1:a]volume=enable='gte(mod(t,1),0.04)':volume=0[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "ffv1", "-c:a", "flac", out]);
    return [out];
  }
  throw new Error(`unknown structural fixture ${s.id}`);
}

const loadLock = () => (existsSync(LOCK_PATH) ? JSON.parse(readFileSync(LOCK_PATH, "utf8")) : { files: {} });

/**
 * Builds (or reuses) every sample. Returns { manifest, sources, dir(id), version, problems }.
 * problems: lock mismatches (empty when the set is identical to the committed lock).
 */
export async function prepareSet({ update = process.env.VHO_QUALITY_UPDATE_LOCK === "1" } = {}) {
  requireTools();
  const manifest = loadManifest();
  const { paths: sources, stats } = await ensureSources(manifest);
  const version = await ffmpegVersion();
  const lock = loadLock();
  const files = {};
  const setDir = join(CACHE, "set");
  const stamp = createHash("sha256").update(JSON.stringify({ manifest, version })).digest("hex").slice(0, 16);
  const stampFile = join(setDir, "stamp.txt");
  const fresh = !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp;
  if (fresh) rmSync(setDir, { recursive: true, force: true });
  const t0 = Date.now();
  const build = async (id, fn) => {
    const dir = join(setDir, id);
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, "files.json");
    let out = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
    if (!out || !out.every((f) => existsSync(join(dir, f)))) {
      out = (await fn(dir)).map((p) => basename(p));
      writeFileSync(marker, JSON.stringify(out));
    }
    for (const f of out) files[`${id}/${f}`] = sha256File(join(dir, f));
  };
  for (const p of manifest.photos) await build(p.id, (d) => buildPhoto(p, sources, d));
  for (const c of manifest.clips) await build(c.id, (d) => buildClip(c, sources, d));
  for (const s of manifest.structural) await build(s.id, (d) => buildStructural(s, d));
  writeFileSync(stampFile, stamp);
  const buildMs = Date.now() - t0;

  const problems = [];
  if (update) {
    writeFileSync(LOCK_PATH, JSON.stringify({ ffmpeg: version, files }, null, 2) + "\n");
    log(`lock rewritten: ${LOCK_PATH}`);
  } else {
    if (lock.ffmpeg && lock.ffmpeg !== version) problems.push(`ffmpeg ${version} != lock ${lock.ffmpeg}`);
    for (const [k, h] of Object.entries(files)) {
      if (!lock.files[k]) problems.push(`${k}: not in set-lock.json`);
      else if (lock.files[k] !== h) problems.push(`${k}: sha256 ${h.slice(0, 12)}… != lock ${lock.files[k].slice(0, 12)}…`);
    }
    for (const k of Object.keys(lock.files)) if (!files[k]) problems.push(`${k}: in the lock but not built`);
  }
  log(`sources: ${stats.reused} reused, ${stats.downloaded} downloaded (${(stats.bytes / 1048576).toFixed(1)} MB in ${(stats.ms / 1000).toFixed(1)} s); set ${fresh ? "built" : "reused"} in ${(buildMs / 1000).toFixed(1)} s at ${setDir}`);
  return { manifest, sources, version, problems, stats, dir: (id) => join(setDir, id) };
}
