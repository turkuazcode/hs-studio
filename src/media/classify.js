// ==========================================================================
// File classification by extension / MIME type (pure functions, no DOM).
// ==========================================================================

export const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "ogv", "ts", "avi", "wmv", "flv", "3gp", "3g2", "asf", "mpg", "mpeg", "vob", "mts", "m2ts", "divx",
  "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "amr", "wma"]);
export const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"]);
export const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "avif", "ico"]);
export const SUB_EXT = new Set(["srt", "vtt", "ass", "ssa"]); // ASS/SSA: rendered by libmpv (libass)

/** Lower-case extension of a file name or URL (query string / hash ignored). */
export const extOf = (n = "") => n.split(/[?#]/)[0].split(".").pop().toLowerCase();

/**
 * "video" | "image" | "sub" | "unknown".
 * Works for File objects and for { name } entries coming from the backend.
 */
export function classify({ name, type = "" }) {
  const ext = extOf(name);
  if (SUB_EXT.has(ext)) return "sub";
  if (IMAGE_EXT.has(ext) || type.startsWith("image/")) return "image";
  if (VIDEO_EXT.has(ext) || type.startsWith("video/") || type.startsWith("audio/")) return "video";
  return "unknown";
}

export const isImageFile = (url) => IMAGE_EXT.has(extOf(url));

/** Audio-only formats never produce a picture (no "video not decoded" warning). */
export const isAudioOnlyName = (name) => AUDIO_EXT.has(extOf(name));

/** http(s) URL served by another origin (needs CORS for Web Audio / WebGL / snapshots). */
export const isRemoteUrl = (src, origin = globalThis.location?.origin) =>
  /^https?:/i.test(src) && !src.startsWith(origin);

/** Native file dialog filters. */
export const DIALOG_FILTERS = [
  { name: "Medya ve Altyazı", extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...SUB_EXT] },
  { name: "Tüm Dosyalar", extensions: ["*"] },
];

/** Playlist entry size in bytes (File, backend entry or unknown). */
export const itemSize = (item) => item.file?.size ?? item.size ?? 0;

/** Display name for the URL modal: last path segment, decoded. */
export function nameFromUrl(url, fallback = "Ağ Akışı") {
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
