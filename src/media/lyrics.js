// ==========================================================================
// LRC lyrics (pure, unit tested): `.lrc` side files and embedded (USLT) lyrics.
//   [ti:Title] [ar:Artist] [offset:+250]       metadata
//   [00:12.34]line   [01:02:03.5]...           time stamps (mm:ss, mm:ss.xx, mm:ss:xx, h:mm:ss)
//   [00:10.00][00:40.00]chorus                 one line, several stamps
//   <00:12.50>word                             enhanced (word) stamps are stripped
// Positive offset (ms) shows the lyrics earlier.
// ==========================================================================

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?(?::(\d{1,2})(?:[.:](\d{1,3}))?)?\]/g;
const META = /^\[([a-z#]+):(.*)\]$/i;

/** "12" -> 0.12, "5" -> 0.5, "345" -> 0.345 (fraction digits). */
const frac = (s) => (s ? Number(`0.${s}`) : 0);

function stampSeconds(m) {
  // [mm:ss.xx] or [h:mm:ss.xx]
  if (m[4] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[4]) + frac(m[5]);
  return Number(m[1]) * 60 + Number(m[2]) + frac(m[3]);
}

/**
 * text -> { synced, lines: [{ time, text }] (sorted), meta: { ti, ar, al, offset... }, plain }.
 * Unsynced text: synced = false, lines = [{ time: null, text }] one per line.
 */
export function parseLrc(text) {
  const meta = {};
  const timed = [];
  const plainLines = [];
  for (const raw of String(text ?? "").replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const metaHit = line.match(META);
    if (metaHit && !/^\d/.test(metaHit[1])) {
      meta[metaHit[1].toLowerCase()] = metaHit[2].trim();
      continue;
    }
    STAMP.lastIndex = 0;
    const times = [];
    let m;
    let rest = line;
    // stamps are at the start of the line (one or more)
    while ((m = STAMP.exec(line)) && m.index === line.length - rest.length) {
      times.push(stampSeconds(m));
      rest = line.slice(STAMP.lastIndex);
    }
    const body = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").replace(/\s{2,}/g, " ").trim();
    if (times.length) for (const t of times) timed.push({ time: t, text: body });
    else plainLines.push(raw.replace(/\s+$/, ""));
  }
  const offset = Number(meta.offset);
  if (Number.isFinite(offset) && offset !== 0) {
    for (const l of timed) l.time = Math.max(0, l.time - offset / 1000);
  }
  if (timed.length) {
    timed.sort((a, b) => a.time - b.time);
    return { synced: true, lines: timed, meta, plain: timed.map((l) => l.text).join("\n") };
  }
  // trim leading/trailing empty lines of plain lyrics
  while (plainLines.length && !plainLines[0].trim()) plainLines.shift();
  while (plainLines.length && !plainLines.at(-1).trim()) plainLines.pop();
  return { synced: false, lines: plainLines.map((t) => ({ time: null, text: t })), meta, plain: plainLines.join("\n") };
}

/** Index of the line shown at time t (last line with time <= t), -1 before the first. */
export function lineIndexAt(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Seconds -> "[mm:ss.xx]" (writing LRC). */
export function formatStamp(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const mm = Math.floor(cs / 6000), ss = Math.floor((cs % 6000) / 100), xx = cs % 100;
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(xx).padStart(2, "0")}]`;
}
