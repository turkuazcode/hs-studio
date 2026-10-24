// ==========================================================================
// Media actions (Plan 06): pure helpers, unit tested (tests/unit/actions.test.mjs).
// No DOM, no Tauri.
// ==========================================================================

import { isAudioOnlyName } from "./classify.js";

/** "photo" | "music" | "video" | "none" for the current playlist item. */
export function mediaKind(item, { audioOnly = false } = {}) {
  if (!item) return "none";
  if (item.isImage) return "photo";
  if (audioOnly || isAudioOnlyName(item.name ?? "")) return "music";
  return "video";
}

/** Last path segment (both separators). */
export const basename = (p = "") => String(p).split(/[\\/]/).pop();

/** Folder part of a path ("" when none). */
export function dirname(p = "") {
  const s = String(p);
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : "";
}

/** "tatil.2024.jpg" -> { stem: "tatil.2024", ext: "jpg" }; dot files keep their name as stem. */
export function splitName(name = "") {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return { stem: name, ext: "" };
  return { stem: name.slice(0, i), ext: name.slice(i + 1) };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * New file name check (same rules as the backend, src-tauri/src/actions/files.rs).
 * Returns null when valid, else an error code: "empty" | "chars" | "dot" | "long" | "reserved".
 */
export function validateFileName(name) {
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === "..") return "empty";
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(n)) return "chars";
  if (n.endsWith(".")) return "dot";
  if (new TextEncoder().encode(n).length > 255) return "long";
  if (RESERVED.test(n.split(".")[0])) return "reserved";
  return null;
}

/** Playlist entry after a rename (conversion caches / play paths are dropped). */
export function renamedItem(item, newPath) {
  const { playPath: _drop, ...rest } = item;
  return { ...rest, path: newPath, name: basename(newPath) };
}

/**
 * Removes index from the list. Returns { list, next }: the index to show afterwards
 * (the item that moved into the slot, else the new last one; -1 when empty).
 */
export function removeAt(list, index) {
  const out = list.slice();
  if (index < 0 || index >= out.length) return { list: out, next: Math.min(index, out.length - 1) };
  out.splice(index, 1);
  return { list: out, next: out.length ? Math.min(index, out.length - 1) : -1 };
}

/** "1:02:03.5" | "02:03" | "75.25" -> seconds; NaN when invalid. */
export function parseTime(text) {
  const s = String(text ?? "").trim().replace(",", ".");
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Seconds -> "m:ss.d" / "h:mm:ss.d" (one decimal, for range fields). */
export function formatTimePrecise(t) {
  const v = Math.max(0, Number(t) || 0);
  const tenths = Math.round(v * 10);
  const h = Math.floor(tenths / 36000), m = Math.floor((tenths % 36000) / 600), s = (tenths % 600) / 10;
  const ss = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Initial range of a cut / GIF / segment dialog: the A-B loop when both points are set,
 * otherwise `length` seconds from the current position (clamped to the duration).
 */
export function defaultRange({ loop, time = 0, duration = 0 }, length = 10) {
  if (loop && loop.a != null && loop.b != null && loop.b > loop.a) return { start: loop.a, end: loop.b, fromLoop: true };
  const d = Number.isFinite(duration) && duration > 0 ? duration : time + length;
  let start = Math.max(0, Math.min(time, d));
  let end = Math.min(d, start + length);
  if (end - start < Math.min(1, d)) start = Math.max(0, end - length);
  return { start, end, fromLoop: false };
}

/** Range check for the dialogs: null or an error code. */
export function checkRange(start, end, duration) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "format";
  if (start < 0 || end <= start + 0.05) return "order";
  if (Number.isFinite(duration) && duration > 0 && start >= duration) return "beyond";
  return null;
}

/** Favorites (paths): toggled copy + whether it is now a favorite. */
export function toggleFavorite(paths, path) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : [];
  const i = list.indexOf(path);
  if (i >= 0) {
    list.splice(i, 1);
    return { paths: list, favorite: false };
  }
  return { paths: [...list, path], favorite: true };
}

/** 1536 -> "1,5 KB" (Turkish decimal comma by default). */
export function formatBytes(n, locale = "tr") {
  const v = Number(n) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  const num = i === 0 ? String(Math.round(x)) : x.toFixed(x >= 100 ? 0 : 1);
  return `${locale === "tr" ? num.replace(".", ",") : num} ${units[i]}`;
}

/** Video conversion presets (backend: actions/ffmpeg.rs Preset). */
export const CONVERT_PRESETS = Object.freeze(["whatsapp", "email", "720p", "1080p", "audio"]);

/** Audio target formats (backend: AudioFormat). "copy" = original stream. */
export const AUDIO_FORMATS = Object.freeze(["copy", "aac", "opus", "flac", "mp3", "wav"]);
export const SEGMENT_FORMATS = Object.freeze(["aac", "mp3", "m4r", "opus", "flac", "wav"]);

/** Paper sizes in mm (portrait). */
export const PAPERS = Object.freeze({ a4: [210, 297], letter: [215.9, 279.4], a5: [148, 210], photo10x15: [102, 152] });
export const MARGINS = Object.freeze({ none: 0, narrow: 5, normal: 12, wide: 25 });

/**
 * Print layout (mm): where the image lands on the page.
 * fit: whole image visible; fill: page area covered (image cropped).
 * Returns { page: [w, h], area: {x, y, w, h}, image: {x, y, w, h} }.
 */
export function printLayout({ paper = "a4", orientation = "portrait", margin = "normal", fit = "fit", image = [1, 1] }) {
  let [pw, ph] = PAPERS[paper] ?? PAPERS.a4;
  if (orientation === "landscape") [pw, ph] = [ph, pw];
  const m = MARGINS[margin] ?? MARGINS.normal;
  const area = { x: m, y: m, w: Math.max(1, pw - 2 * m), h: Math.max(1, ph - 2 * m) };
  const [iw, ih] = image[0] > 0 && image[1] > 0 ? image : [1, 1];
  const scale = (fit === "fill" ? Math.max : Math.min)(area.w / iw, area.h / ih);
  const w = iw * scale, h = ih * scale;
  return { page: [pw, ph], area, image: { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h } };
}

/** Orientation that suits an image best ("landscape" for wide images). */
export const bestOrientation = ([w, h]) => (w > h ? "landscape" : "portrait");

/** OCR words (pixels) -> percentages of the image, for a responsive text layer. */
export function ocrLayer(result) {
  const W = result?.width || 1, H = result?.height || 1;
  const pct = (v, d) => Math.round((v / d) * 100000) / 1000;
  return (result?.lines ?? []).map((line) => ({
    text: line.text,
    words: (line.words ?? []).map((w) => ({ text: w.text, left: pct(w.x, W), top: pct(w.y, H), width: pct(w.w, W), height: pct(w.h, H) })),
  }));
}

/** Error tag of a backend error string: "[exists] ..." -> "exists". */
export const errorCode = (e) => String(e?.message ?? e ?? "").match(/^\[([a-z-]+)\]/)?.[1] ?? null;

/** Backend error without its tag. */
export const errorText = (e) => String(e?.message ?? e ?? "").replace(/^\[[a-z-]+\]\s*/, "");

let jobSeq = 0;
/** Unique id for a media job (progress events / cancel). */
export const newJobId = (prefix = "media") => `${prefix}-${Date.now().toString(36)}-${++jobSeq}`;

/**
 * Shortcuts of the media actions (registered into the central table, ui/shortcuts.js;
 * labels: i18n "shortcuts.actions.<id>"). Scope "video" also covers music (audio files
 * play in video mode).
 */
export const ACTION_SHORTCUTS = Object.freeze([
  { id: "deleteFile", scope: "global", keys: ["Delete"] },
  { id: "renameFile", scope: "global", keys: ["F2"] },
  { id: "copyImage", scope: "photo", keys: ["Ctrl+KeyC"] },
  { id: "copyFile", scope: "video", keys: ["Ctrl+KeyC"] },
  { id: "copyPath", scope: "global", keys: ["Ctrl+Shift+KeyC"] },
  { id: "printPhoto", scope: "photo", keys: ["Ctrl+KeyP"] },
  { id: "saveFrame", scope: "video", keys: ["Ctrl+KeyS"] },
  { id: "cutVideo", scope: "video", keys: ["Ctrl+KeyX"] },
  { id: "convertMedia", scope: "video", keys: ["Ctrl+KeyE"] },
  { id: "properties", scope: "global", keys: ["Alt+Enter"] },
  { id: "favorite", scope: "global", keys: ["Ctrl+KeyD"] },
  { id: "alwaysOnTop", scope: "global", keys: ["Ctrl+KeyT"] },
  { id: "miniPlayer", scope: "video", keys: ["Ctrl+KeyM"] },
  { id: "ocr", scope: "photo", keys: ["Ctrl+Shift+KeyT"] },
  { id: "shareFile", scope: "global", keys: [] },
  { id: "openWith", scope: "global", keys: [] },
  { id: "showInFolder", scope: "global", keys: [] },
  { id: "lyrics", scope: "video", keys: [] },
  { id: "tagEditor", scope: "video", keys: [] },
]);
