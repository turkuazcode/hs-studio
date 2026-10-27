// ==========================================================================
// File classification by extension / MIME type (pure functions, no DOM).
// ==========================================================================

import { t } from "../core/i18n.js";


export const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "ogv", "ts", "avi", "wmv", "flv", "3gp", "3g2", "asf", "mpg", "mpeg", "vob", "mts", "m2ts", "divx",
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "amr", "wma", "oga", "aiff", "aif", "ape", "wv", "alac", "mka", "dsf"]);
export const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "oga", "wma", "aiff", "aif", "ape", "wv", "alac", "mka", "dsf"]);
export const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "avif", "ico"]);
export const SUB_EXT = new Set(["srt", "vtt", "ass", "ssa"]); // ASS/SSA: rendered by libmpv (libass)
/** Photos the webview cannot show itself: opened through the backend's photo_decode. */
export const RAW_EXT = new Set(["3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25",
  "kdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f"]);
export const DECODE_IMAGE_EXT = new Set(["heic", "heif", "hif", "tif", "tiff", "tga", "pbm", "pgm", "ppm", "pnm", "pam",
  "qoi", ...RAW_EXT]);

/** Lower-case extension of a file name or URL (query string / hash ignored). */
export const extOf = (n = "") => n.split(/[?#]/)[0].split(".").pop().toLowerCase();

/**
 * "video" | "image" | "sub" | "unknown".
 * Works for File objects and for { name } entries coming from the backend.
 */
export function classify({ name, type = "" }) {
  const ext = extOf(name);
  if (SUB_EXT.has(ext)) return "sub";
  if (IMAGE_EXT.has(ext) || DECODE_IMAGE_EXT.has(ext) || type.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || type.startsWith("video/") || type.startsWith("audio/")) return "video";
  return "unknown";
}

export const isImageFile = (url) => IMAGE_EXT.has(extOf(url));

/** HEIC / RAW / TIFF...: needs a backend-decoded display copy (photo_decode). */
export const needsDecode = (name) => DECODE_IMAGE_EXT.has(extOf(name));

/** Audio-only formats never produce a picture (no "video not decoded" warning). */
export const isAudioOnlyName = (name) => AUDIO_EXT.has(extOf(name));

/** http(s) URL served by another origin (needs CORS for Web Audio / WebGL / snapshots). */
export const isRemoteUrl = (src, origin = globalThis.location?.origin) =>
  /^https?:/i.test(src) && !src.startsWith(origin);

/** Native file dialog filters (names in the current UI language). */
export const DIALOG_FILTERS = [
  { get name() { return t("ui.dialog.media"); }, extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...DECODE_IMAGE_EXT, ...SUB_EXT] },
  { get name() { return t("ui.dialog.all"); }, extensions: ["*"] },
];

/** Playlist entry size in bytes (File, backend entry or unknown). */
export const itemSize = (item) => item.file?.size ?? item.size ?? 0;

/** Display name for the URL modal: last path segment, decoded. */
export function nameFromUrl(url, fallback = t("ui.playlist.stream")) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop()) || fallback;
  } catch (_) {
    return fallback;
  }
}

/** Accepted by the URL modal: http(s) without whitespace. */
export const isValidMediaUrl = (url) => /^https?:\/\/\S+$/i.test(url);

/** HLS playlist URL (.m3u8). */
export const isHlsUrl = (url) => /\.m3u8(\?|#|$)/i.test(url);
