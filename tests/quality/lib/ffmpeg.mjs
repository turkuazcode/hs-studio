// ffmpeg / ffprobe helpers for the quality layer (Q02). Uses the app's own LGPL build
// (staged next to vho.exe by `npm run stage:mpv`) or VHO_FFMPEG / VHO_FFPROBE.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultExe } from "../../e2e/lib/app.mjs";

function locate(name, envKey) {
  if (process.env[envKey]) return process.env[envKey];
  const dir = dirname(defaultExe());
  for (const sub of ["", "mpv", join("resources", "mpv")]) {
    const p = join(dir, sub, `${name}.exe`);
    if (existsSync(p)) return p;
  }
  return null;
}

export const FFMPEG = locate("ffmpeg", "VHO_FFMPEG");
export const FFPROBE = locate("ffprobe", "VHO_FFPROBE");

export function requireTools() {
  if (!FFMPEG || !FFPROBE) {
    throw new Error("ffmpeg/ffprobe not found: run `npm run stage:mpv -- -Source <LGPL mpv dist>` or set VHO_FFMPEG/VHO_FFPROBE");
  }
}

/** Runs a tool; resolves stdout (Buffer). Rejects with stderr on a non-zero exit. */
export function run(tool, args, { maxBuffer = 1 << 30 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, { encoding: "buffer", maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${tool.split(/[\\/]/).pop()} ${args.join(" ")}\n${String(stderr).slice(-2000)}`));
      else resolve(stdout);
    });
  });
}

export const ffmpeg = (args) => run(FFMPEG, ["-hide_banner", "-v", "error", "-nostdin", "-y", ...args]);

export async function ffmpegVersion() {
  const out = String(await run(FFMPEG, ["-hide_banner", "-version"]));
  return out.split("\n")[0].trim();
}

/** Decodes the first frame of an image/video to RGBA: { width, height, data }. */
export async function readImage(path) {
  const info = await probe(path);
  const v = info.streams.find((s) => s.codec_type === "video");
  const data = await ffmpeg(["-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  return { width: v.width, height: v.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** Every frame of a video as RGBA (small clips only): { width, height, frames: Uint8Array[], pts: number[] }. */
export async function readFrames(path) {
  const info = await probe(path, ["-show_frames", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time,pts_time"]);
  const v = info.streams.find((s) => s.codec_type === "video");
  const raw = await ffmpeg(["-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  const size = v.width * v.height * 4;
  const frames = [];
  for (let o = 0; o + size <= raw.length; o += size) frames.push(new Uint8Array(raw.buffer, raw.byteOffset + o, size));
  const pts = (info.frames ?? []).map((f) => Number(f.best_effort_timestamp_time ?? f.pts_time));
  return { width: v.width, height: v.height, frames, pts };
}

/** ffprobe JSON (streams + format, plus extra arguments). */
export async function probe(path, extra = []) {
  const out = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", ...extra, path]);
  return JSON.parse(String(out));
}
