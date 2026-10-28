// ==========================================================================
// Music mode rules (Plan 13/L03), pure and unit tested: queue order with shuffle / repeat,
// ReplayGain gain (track / album, preamp, clipping prevention), output device removal,
// "now playing" text for the system media controls.
// ==========================================================================

export const REPEAT_MODES = ["off", "all", "one"];
export const REPLAYGAIN_MODES = ["off", "track", "album"];

/** Seeded PRNG (mulberry32) so a shuffle order is reproducible in tests. */
export function seededRandom(seed = Date.now()) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shuffled play order of `length` items that starts with `first` (Fisher-Yates). */
export function shuffleOrder(length, first = 0, random = Math.random) {
  const rest = [];
  for (let i = 0; i < length; i++) if (i !== first) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return length > 0 && first >= 0 && first < length ? [first, ...rest] : rest;
}

/**
 * Index to play after `current` moving `step` (+1 next / -1 previous).
 * auto = the track ended by itself (repeat "one" replays it; a manual "next" moves on).
 * order = shuffle order (indexes) or null. Returns -1 when playback should stop.
 */
export function nextIndex(current, step, length, { repeat = "off", order = null, auto = false } = {}) {
  if (!length) return -1;
  if (auto && repeat === "one" && current >= 0) return current;
  const seq = order && order.length === length ? order : null;
  const pos = seq ? seq.indexOf(current) : current;
  let next = pos + step;
  if (next < 0 || next >= length) {
    if (repeat === "off" && auto) return -1;
    if (repeat === "off" && !auto && next < 0) return seq ? seq[0] : 0;
    if (repeat === "off" && !auto) return -1;
    next = (next + length) % length;
  }
  return seq ? seq[next] : next;
}

/** "-6.20 dB" / "+1.5" / "0.988" -> number (null when absent/garbage). */
export function parseGain(text) {
  if (text === null || text === undefined || text === "") return null;
  const n = Number(String(text).trim().replace(/\s*db$/i, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Linear volume factor for ReplayGain (same rule as libmpv's replaygain options):
 *   gain = (album gain in "album" mode when present, else track gain) + preamp
 *   factor = 10^(gain / 20); with preventClip the factor is limited to 1 / peak (sample peak).
 * Files without tags: factor 1 (no fallback gain). mode "off": 1.
 */
export function replayGainFactor({ mode = "off", trackGain = null, trackPeak = null, albumGain = null, albumPeak = null, preampDb = 0, preventClip = true } = {}) {
  if (mode === "off") return 1;
  const useAlbum = mode === "album" && albumGain !== null;
  const gain = useAlbum ? albumGain : trackGain;
  if (gain === null) return 1;
  let f = 10 ** ((gain + (preampDb || 0)) / 20);
  const peak = useAlbum ? (albumPeak ?? trackPeak) : trackPeak;
  if (preventClip && peak > 0) f = Math.min(f, 1 / peak);
  return f;
}

/** libmpv options for the ReplayGain settings. */
export const mpvReplayGainOptions = ({ mode = "off", preampDb = 0, preventClip = true } = {}) => ({
  replaygain: REPLAYGAIN_MODES.includes(mode) ? (mode === "off" ? "no" : mode) : "no",
  "replaygain-preamp": Number(preampDb) || 0,
  // mpv: replaygain-clip=yes = "prevent clipping" (lower the gain using the peak)
  "replaygain-clip": preventClip ? "yes" : "no",
});

/**
 * An output device disappeared (headphones unplugged, USB DAC removed): the previous list
 * had a device the new one lacks. "auto"/default entries are ignored.
 */
export function deviceRemoved(prev, next) {
  const ids = (list) => new Set((list ?? []).map((d) => (typeof d === "string" ? d : d?.name ?? d?.deviceId)).filter((n) => n && n !== "auto" && n !== "default"));
  const a = ids(prev), b = ids(next);
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

/** Text for the OS "now playing" card: tags first, file name otherwise. */
export function nowPlayingText(item, tags = null) {
  const stem = String(item?.name ?? "").replace(/\.[^.]+$/, "");
  return {
    title: tags?.title?.trim() || stem || item?.url || "",
    artist: tags?.artist?.trim() || tags?.albumArtist?.trim() || "",
    album: tags?.album?.trim() || "",
  };
}

/** Next items to show under "up next" (in play order), at most `max`. */
export function upNext(current, length, { order = null, repeat = "off", max = 8 } = {}) {
  const out = [];
  let i = current;
  for (let k = 0; k < Math.min(max, Math.max(0, length - 1)); k++) {
    i = nextIndex(i, 1, length, { repeat: repeat === "one" ? "all" : repeat, order });
    if (i < 0 || i === current) break;
    out.push(i);
  }
  return out;
}
