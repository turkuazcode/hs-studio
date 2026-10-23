// ==========================================================================
// Pure formatting helpers (no DOM).
// ==========================================================================

/** 75 -> "01:15", 3725 -> "01:02:05", Infinity -> "CANLI" (live stream). */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return seconds === Infinity ? "CANLI" : "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Photo info card size text: "-" when unknown, "x.xx MB" from 1 MB, else "n KB". */
export function formatFileSize(size) {
  if (!size) return "-";
  const sizeMB = size / (1024 * 1024);
  return sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${Math.round(size / 1024)} KB`;
}

/** 1920x1080 -> "16:9"; "-" when undefined. */
export function aspectRatioText(w, h) {
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const d = gcd(w, h);
  return d > 0 ? `${Math.round(w / d)}:${Math.round(h / d)}` : "-";
}

/** Characters outside [A-Za-z0-9_-] become "_" (download file names). */
export const safeFileName = (name) => name.replace(/[^a-zA-Z0-9_\-]/g, "_");

/** "01:02" -> "01-02" for file names. */
export const timeForFileName = (seconds) => formatTime(seconds).replaceAll(":", "-");
