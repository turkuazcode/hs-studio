// ==========================================================================
// Photo studio: pure helpers (no DOM, unit tested in tests/unit/studio.test.mjs).
// Sorting / filtering / search, batch rename preview, selection, virtual grid
// window math, histogram, colour adjustment + sharpen (same formulas as the
// backend's ops.rs), crop geometry, undo/redo history, settings adapter.
// ==========================================================================

/**
 * Runs `fn` on the next animation frame, or after `ms` when frames are throttled
 * (background / occluded window), whichever comes first. Returns a cancel function.
 */
export function nextFrame(fn, ms = 34) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  const raf = globalThis.requestAnimationFrame?.(run);
  const timer = setTimeout(run, ms);
  return () => { done = true; clearTimeout(timer); if (raf) globalThis.cancelAnimationFrame?.(raf); };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** "C:\\a\\b.jpg" -> "b.jpg" (both separators). */
export const baseName = (p = "") => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

/** Parent folder ("" for a root). Keeps "C:\\" as a root. */
export function parentDir(p = "") {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return "";
  const parent = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  return parent || "/";
}

/** File name without its extension. */
export function stemOf(name = "") {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Breadcrumb segments of a folder: [{ name, path }]. */
export function pathSegments(dir = "") {
  const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  const out = [];
  let acc = dir.startsWith("/") ? "" : "";
  parts.forEach((part, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(part)) acc = part + "\\";
    else if (i === 0 && dir.startsWith("/")) acc = "/" + part;
    else acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    out.push({ name: part, path: acc });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sorting, filtering, search
// ---------------------------------------------------------------------------

const isDigit = (c) => c >= "0" && c <= "9";

/** Natural, case-insensitive order ("IMG_2" < "IMG_10"); same rules as scan.rs natural_cmp. */
export function naturalCompare(a, b) {
  let i = 0, j = 0;
  while (true) {
    if (i >= a.length && j >= b.length) return 0;
    if (i >= a.length) return -1;
    if (j >= b.length) return 1;
    const x = a[i], y = b[j];
    if (isDigit(x) && isDigit(y)) {
      let na = "", nb = "";
      while (i < a.length && isDigit(a[i])) na += a[i++];
      while (j < b.length && isDigit(b[j])) nb += b[j++];
      const ta = na.replace(/^0+/, ""), tb = nb.replace(/^0+/, "");
      if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
      if (ta !== tb) return ta < tb ? -1 : 1;
      if (na.length !== nb.length) return na.length < nb.length ? -1 : 1;
    } else {
      const lx = x.toLowerCase(), ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
      i++;
      j++;
    }
  }
}

/** Capture date (EXIF) or modification time, in ms. */
export const itemDate = (it) => it.exifDate ?? it.mtime ?? 0;

export const SORT_KEYS = ["name", "date", "size", "exifDate"];

const byName = (a, b) => naturalCompare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** New array sorted like the backend (ties by name, then path). */
export function sortItems(items, key = "name", descending = false) {
  const cmp = {
    name: byName,
    date: (a, b) => (a.mtime - b.mtime) || byName(a, b),
    size: (a, b) => (a.size - b.size) || byName(a, b),
    exifDate: (a, b) => (itemDate(a) - itemDate(b)) || byName(a, b),
  }[key] ?? byName;
  const out = items.slice().sort(cmp);
  if (descending) out.reverse();
  return out;
}

/**
 * Search key: Turkish-aware lower case with dotted/dotless i merged, so "img" finds
 * "IMG_1" and "istanbul" finds "İstanbul" ("I" -> "ı" -> "i", "İ" -> "i").
 */
export const searchFold = (s = "") => s.toLocaleLowerCase("tr").replace(/ı/g, "i");

/** "YYYY-MM-DD" (input type=date) -> local midnight ms; endOfDay -> 23:59:59.999. */
export function dateInputToMs(value, endOfDay = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * filter: { type: "all"|"photo"|"image"|"raw"|"heif"|"video", from, to (ms or null), query }.
 * EXIF dates are "camera wall clock as UTC"; they are compared as local wall-clock times.
 */
export function filterItems(items, { type = "all", from = null, to = null, query = "" } = {}) {
  const q = searchFold(query.trim());
  const tz = (ms) => ms + new Date(ms).getTimezoneOffset() * 60000;
  return items.filter((it) => {
    if (type === "photo" && it.kind === "video") return false;
    if (type !== "all" && type !== "photo" && it.kind !== type) return false;
    if (from != null || to != null) {
      const d = it.exifDate != null ? tz(it.exifDate) : it.mtime;
      if (from != null && d < from) return false;
      if (to != null && d > to) return false;
    }
    if (q && !searchFold(it.name).includes(q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Batch rename preview (mirror of ops.rs render_name / format_ext)
// ---------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** ms -> "YYYYMMDD_HHMMSS" in UTC (EXIF dates are already wall-clock-as-UTC). */
export function dateToken(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * Expands a name template for item number `index`: {name} {ext} {counter} {counter:N} {date}.
 * `dateMs` is the EXIF date or mtime; for mtime the backend uses UTC as well.
 */
export function renderName(template, item, index, counterStart = 1) {
  const stem = stemOf(item.name);
  const ext = (item.ext ?? item.name.split(".").pop() ?? "").toLowerCase();
  const tpl = template.trim() ? template : "{name}";
  const out = tpl.replace(/\{([^{}]*)\}/g, (whole, token) => {
    const [name, arg = ""] = token.split(":");
    switch (name) {
      case "name": return stem;
      case "ext": return ext;
      case "counter": {
        const width = Math.min(parseInt(arg, 10) || 0, 12);
        return String(counterStart + index).padStart(width, "0");
      }
      case "date": return dateToken(item.exifDate ?? item.mtime ?? 0);
      default: return whole;
    }
  });
  // eslint-disable-next-line no-control-regex
  const cleaned = out.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/\.+$/, "");
  return cleaned || stem;
}

export const OUTPUT_FORMATS = ["same", "jpeg", "png", "webp", "avif"];

/** Output extension (ops.rs resolve_format + format_ext). */
export function outputExt(format, srcExt) {
  const ext = (srcExt ?? "").toLowerCase();
  let f = format;
  if (f === "same") {
    f = ext === "png" ? "png" : ext === "webp" ? "webp" : ext === "avif" ? "avif"
      : (ext === "tif" || ext === "tiff") ? "tiff" : (ext === "bmp" || ext === "dib") ? "bmp" : "jpeg";
  }
  switch (f) {
    case "jpeg": return ["jpg", "jpeg", "jpe", "jfif"].includes(ext) ? ext : "jpg";
    case "tiff": return ext === "tif" || ext === "tiff" ? ext : "tif";
    default: return f;
  }
}

/**
 * Preview rows for a batch: [{ from, to }]. Names repeated inside the batch get " (n)"
 * like the backend's "rename" conflict mode (existing files on disk are not known here).
 */
export function batchPreview(items, { nameTemplate = "{name}", counterStart = 1, format = "same" } = {}) {
  const taken = new Set();
  return items.map((it, i) => {
    const base = renderName(nameTemplate, it, i, counterStart);
    const ext = outputExt(format, it.ext);
    let n = 0, to;
    do {
      to = n === 0 ? `${base}.${ext}` : `${base} (${n}).${ext}`;
      n++;
    } while (taken.has(to.toLowerCase()));
    taken.add(to.toLowerCase());
    return { from: it.name, to };
  });
}

// ---------------------------------------------------------------------------
// Selection (click / Ctrl / Shift / keyboard), keyed by path
// ---------------------------------------------------------------------------

/** { selected: Set<path>, anchor: index, focus: index } */
export const emptySelection = () => ({ selected: new Set(), anchor: -1, focus: -1 });

const rangeSet = (paths, a, b) => new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1));

/** Mouse click on `index` of `paths` (current view order). */
export function selectClick(sel, index, { ctrl = false, shift = false } = {}, paths) {
  if (index < 0 || index >= paths.length) return sel;
  if (shift && sel.anchor >= 0) {
    const range = rangeSet(paths, sel.anchor, index);
    const selected = ctrl ? new Set([...sel.selected, ...range]) : range;
    return { selected, anchor: sel.anchor, focus: index };
  }
  if (ctrl) {
    const selected = new Set(sel.selected);
    if (selected.has(paths[index])) selected.delete(paths[index]);
    else selected.add(paths[index]);
    return { selected, anchor: index, focus: index };
  }
  return { selected: new Set([paths[index]]), anchor: index, focus: index };
}

/** Arrow / Home / End navigation: moves focus by `delta` (clamped); Shift extends from the anchor. */
export function selectMove(sel, delta, { shift = false, ctrl = false } = {}, paths) {
  if (!paths.length) return sel;
  const from = sel.focus < 0 ? (delta > 0 ? -1 : paths.length) : sel.focus;
  const focus = Math.max(0, Math.min(paths.length - 1, from + delta));
  if (shift) {
    const anchor = sel.anchor < 0 ? focus : sel.anchor;
    return { selected: rangeSet(paths, anchor, focus), anchor, focus };
  }
  if (ctrl) return { ...sel, focus };
  return { selected: new Set([paths[focus]]), anchor: focus, focus };
}

export const selectAll = (paths, sel = emptySelection()) =>
  ({ selected: new Set(paths), anchor: sel.anchor < 0 ? 0 : sel.anchor, focus: sel.focus < 0 ? 0 : sel.focus });

/** Selected paths in view order. */
export const selectedInOrder = (sel, paths) => paths.filter((p) => sel.selected.has(p));

/** Keeps only paths still present (after filtering / rescans); remaps anchor/focus by path. */
export function reconcileSelection(sel, oldPaths, newPaths) {
  const present = new Set(newPaths);
  const selected = new Set([...sel.selected].filter((p) => present.has(p)));
  const remap = (i) => (i >= 0 && i < oldPaths.length ? newPaths.indexOf(oldPaths[i]) : -1);
  return { selected, anchor: remap(sel.anchor), focus: remap(sel.focus) };
}

// ---------------------------------------------------------------------------
// Virtual grid window
// ---------------------------------------------------------------------------

/**
 * Which items to render for a scroll position.
 * { count, width, height, scrollTop, cellWidth, cellHeight, gap, overscan (rows) } ->
 * { cols, rows, totalHeight, start, end (exclusive), firstRow, lastRow }
 */
export function gridWindow({ count, width, height, scrollTop = 0, cellWidth, cellHeight, gap = 0, overscan = 2 }) {
  const cols = Math.max(1, Math.floor((width + gap) / (cellWidth + gap)));
  const rows = Math.ceil(count / cols);
  const rowH = cellHeight + gap;
  const totalHeight = rows > 0 ? rows * rowH - gap : 0;
  if (!count) return { cols, rows: 0, totalHeight: 0, start: 0, end: 0, firstRow: 0, lastRow: -1 };
  const firstRow = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const lastRow = Math.min(rows - 1, Math.floor((scrollTop + Math.max(0, height)) / rowH) + overscan);
  return { cols, rows, totalHeight, start: firstRow * cols, end: Math.min(count, (lastRow + 1) * cols), firstRow, lastRow };
}

/** scrollTop that brings item `index` fully into view (or the current one if visible). */
export function scrollToShow(index, { cols, cellHeight, gap = 0, height, scrollTop }) {
  const rowH = cellHeight + gap;
  const top = Math.floor(index / cols) * rowH;
  if (top < scrollTop) return top;
  if (top + cellHeight > scrollTop + height) return top + cellHeight - height;
  return scrollTop;
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

/**
 * RGBA bytes -> { r, g, b, l: Uint32Array(256), max, count }. Transparent pixels are
 * skipped; `step` samples every n-th pixel. Luma uses Rec. 709 weights.
 */
export function computeHistogram(data, step = 1) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  let count = 0;
  const stride = 4 * Math.max(1, step | 0);
  for (let i = 0; i + 3 < data.length; i += stride) {
    if (data[i + 3] === 0) continue;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    count++;
  }
  let max = 0;
  for (let k = 0; k < 256; k++) max = Math.max(max, r[k], g[k], b[k], l[k]);
  return { r, g, b, l, max, count };
}

// ---------------------------------------------------------------------------
// Colour adjustments + sharpen (identical to ops.rs Op::Adjust / Op::Sharpen)
// ---------------------------------------------------------------------------

export const NEUTRAL_ADJUST = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, temperature: 0 });

const clampN = (v) => Math.max(-100, Math.min(100, Number(v) || 0)) / 100;
// Rust's f32::round rounds half away from zero; for the non-negative values used here
// Math.round matches, negative values are clamped to 0 anyway.
const to8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const f32 = Math.fround;

/** Factors for adjustPixel (computed once per image). */
export function adjustFactors({ brightness = 0, contrast = 0, saturation = 0, temperature = 0 } = {}) {
  return {
    warm: f32(clampN(temperature) * 0.15),
    bright: f32(1 + clampN(brightness)),
    contrast: f32(1 + clampN(contrast)),
    sat: f32(1 + clampN(saturation)),
  };
}

export const isNeutralAdjust = (a) =>
  !a || ["brightness", "contrast", "saturation", "temperature"].every((k) => !Number(a[k]));

/** [r,g,b] -> [r,g,b] with factors from adjustFactors. */
export function adjustPixel([r, g, b], f) {
  r = f32(r * f32(1 + f.warm));
  b = f32(b * f32(1 - f.warm));
  r = f32(r * f.bright); g = f32(g * f.bright); b = f32(b * f.bright);
  r = f32(f32(r - 127.5) * f.contrast + 127.5);
  g = f32(f32(g - 127.5) * f.contrast + 127.5);
  b = f32(f32(b - 127.5) * f.contrast + 127.5);
  if (f.sat !== 1) {
    const l = f32(f32(f32(0.2126 * r) + f32(0.7152 * g)) + f32(0.0722 * b));
    r = f32(l + f32(r - l) * f.sat);
    g = f32(l + f32(g - l) * f.sat);
    b = f32(l + f32(b - l) * f.sat);
  }
  return [to8(r), to8(g), to8(b)];
}

/** In-place adjustment of RGBA bytes (canvas ImageData.data). */
export function adjustImageData(data, adjust) {
  if (isNeutralAdjust(adjust)) return data;
  const f = adjustFactors(adjust);
  // 256-entry tables would ignore the saturation coupling; per pixel is fast enough for previews
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = adjustPixel([data[i], data[i + 1], data[i + 2]], f);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return data;
}

/** 3x3 Laplacian sharpen of RGBA bytes (alpha untouched); returns a new array. */
export function sharpenImageData(data, width, height, amount) {
  const k = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  if (k <= 0) return data;
  const out = new Uint8ClampedArray(data);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * stride, down = Math.min(height - 1, y + 1) * stride, cur = y * stride;
    for (let x = 0; x < width; x++) {
      const l = Math.max(0, x - 1) * 4, r = Math.min(width - 1, x + 1) * 4, o = x * 4;
      for (let c = 0; c < 3; c++) {
        const v = data[cur + o + c];
        const lap = 4 * v - data[up + o + c] - data[down + o + c] - data[cur + l + c] - data[cur + r + c];
        out[cur + o + c] = to8(v + k * lap);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edit model: orientation, normalised crop, history, backend ops
// ---------------------------------------------------------------------------

/** Crop ratio presets (null = free, "orig" = image ratio). */
export const CROP_RATIOS = [
  { id: "free", label: "Serbest", ratio: null },
  { id: "orig", label: "Orijinal", ratio: "orig" },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

export const initialEdit = () => ({
  rotation: 0, flipH: false, flipV: false, crop: null,
  adjust: { ...NEUTRAL_ADJUST }, sharpen: 0,
});

export const isEditIdentity = (e) =>
  !e.rotation && !e.flipH && !e.flipV && !e.crop && isNeutralAdjust(e.adjust) && !e.sharpen;

/** Size of the image after rotating by `rotation` degrees. */
export const rotatedSize = (w, h, rotation) => (rotation % 180 ? { w: h, h: w } : { w, h });

/** Normalised crop rect {x,y,w,h} transformed by a 90° CW rotation of the image. */
export const cropRotateCW = (c) => c && ({ x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w });
export const cropFlipH = (c) => c && ({ ...c, x: 1 - c.x - c.w });
export const cropFlipV = (c) => c && ({ ...c, y: 1 - c.y - c.h });

/** Edit state after a 90° step (delta = 90 or -90); the crop follows the image. */
export function editRotate(e, delta) {
  let crop = e.crop;
  const steps = ((delta / 90) % 4 + 4) % 4;
  for (let i = 0; i < steps; i++) crop = cropRotateCW(crop);
  // Mirrors swap their axis meaning when the image turns by 90°
  const swap = steps % 2 === 1;
  return {
    ...e,
    rotation: (e.rotation + delta + 360) % 360,
    flipH: swap ? e.flipV : e.flipH,
    flipV: swap ? e.flipH : e.flipV,
    crop,
  };
}

export const editFlip = (e, axis) => axis === "horizontal"
  ? { ...e, flipH: !e.flipH, crop: cropFlipH(e.crop) }
  : { ...e, flipV: !e.flipV, crop: cropFlipV(e.crop) };

/** Clamps a normalised rect into [0,1] with a minimum size. */
export function clampCrop(c, min = 0.01) {
  const w = Math.max(min, Math.min(1, c.w)), h = Math.max(min, Math.min(1, c.h));
  return { x: Math.max(0, Math.min(1 - w, c.x)), y: Math.max(0, Math.min(1 - h, c.y)), w, h };
}

/**
 * Largest centred crop with pixel aspect `ratio` inside an image of size (W,H), as a
 * normalised rect. ratio null -> whole image.
 */
export function cropForRatio(ratio, W, H) {
  if (!ratio || !W || !H) return { x: 0, y: 0, w: 1, h: 1 };
  let w = W, h = W / ratio;
  if (h > H) { h = H; w = H * ratio; }
  return { x: (1 - w / W) / 2, y: (1 - h / H) / 2, w: w / W, h: h / H };
}

/**
 * Resizes a normalised crop by dragging one corner to (px, py) (normalised), keeping the
 * opposite corner fixed and, if given, the pixel `ratio` of an image of size (W,H).
 */
export function dragCropCorner(c, corner, px, py, ratio, W, H, min = 0.02) {
  const right = c.x + c.w, bottom = c.y + c.h;
  const fx = corner.includes("w") ? right : c.x; // fixed x
  const fy = corner.includes("n") ? bottom : c.y; // fixed y
  px = Math.max(0, Math.min(1, px));
  py = Math.max(0, Math.min(1, py));
  let w = Math.max(min, Math.abs(px - fx)), h = Math.max(min, Math.abs(py - fy));
  if (ratio && W && H) {
    const r = ratio * H / W; // ratio in normalised units
    if (w / h > r) w = h * r; else h = w / r;
  }
  const x = corner.includes("w") ? fx - w : fx;
  const y = corner.includes("n") ? fy - h : fy;
  const maxW = corner.includes("w") ? fx : 1 - fx, maxH = corner.includes("n") ? fy : 1 - fy;
  if (w > maxW || h > maxH) {
    const s = Math.min(maxW / w, maxH / h);
    return dragCropCorner(c, corner, fx + Math.sign(px - fx || 1) * w * s, fy + Math.sign(py - fy || 1) * h * s, ratio, W, H, min);
  }
  return { x, y, w, h };
}

/**
 * photo_batch ops for an edit of an image whose upright size is (W,H).
 * Order: rotate, flips, crop (pixels of the rotated image), adjust, sharpen.
 */
export function editToOps(e, W, H) {
  const ops = [];
  if (e.rotation) ops.push({ op: "rotate", degrees: e.rotation });
  if (e.flipH) ops.push({ op: "flip", axis: "horizontal" });
  if (e.flipV) ops.push({ op: "flip", axis: "vertical" });
  if (e.crop) {
    const { w: RW, h: RH } = rotatedSize(W, H, e.rotation);
    const r = cropPixels(e.crop, RW, RH);
    if (r.x || r.y || r.width !== RW || r.height !== RH) ops.push({ op: "crop", ...r });
  }
  if (!isNeutralAdjust(e.adjust)) {
    ops.push({ op: "adjust", ...Object.fromEntries(Object.entries(e.adjust).map(([k, v]) => [k, Number(v) || 0])) });
  }
  if (e.sharpen > 0) ops.push({ op: "sharpen", amount: Number(e.sharpen) });
  return ops;
}

/** Normalised rect -> integer pixel rect inside (W,H). */
export function cropPixels(c, W, H) {
  const x = Math.max(0, Math.min(W - 1, Math.round(c.x * W)));
  const y = Math.max(0, Math.min(H - 1, Math.round(c.y * H)));
  const width = Math.max(1, Math.min(W - x, Math.round(c.w * W)));
  const height = Math.max(1, Math.min(H - y, Math.round(c.h * H)));
  return { x, y, width, height };
}

/** Undo/redo stack of immutable states. */
export function createHistory(initial, limit = 100) {
  let past = [], future = [], present = initial;
  return {
    get state() { return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    push(next) {
      if (JSON.stringify(next) === JSON.stringify(present)) return present;
      past.push(present);
      if (past.length > limit) past.shift();
      present = next;
      future = [];
      return present;
    },
    undo() {
      if (!past.length) return present;
      future.push(present);
      present = past.pop();
      return present;
    },
    redo() {
      if (!future.length) return present;
      past.push(present);
      present = future.pop();
      return present;
    },
    reset(state) { past = []; future = []; present = state; return present; },
  };
}

// ---------------------------------------------------------------------------
// Info panel formatting
// ---------------------------------------------------------------------------

const fmtNum = (v, digits = 1) => Number(v).toFixed(digits).replace(/\.0+$/, "").replace(".", ",");

/** "2024-05-17T14:30:05" -> "17.05.2024 14:30:05" */
export function formatExifDate(s, offset) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s ?? "");
  if (!m) return s ?? "";
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}${offset ? ` (UTC${offset})` : ""}`;
}

/** Bytes -> "2,4 MB" / "512 KB" / "100 B". */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1024 ** 3) return `${fmtNum(n / 1024 ** 3, 2)} GB`;
  if (n >= 1024 ** 2) return `${fmtNum(n / 1024 ** 2, 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** PhotoInfo (photo_info) -> [[label, value]] rows for the info panel. Empty values skipped. */
export function infoRows(info) {
  if (!info) return [];
  const ex = info.exif ?? {};
  const camera = [ex.make, ex.model].filter(Boolean).join(" ").replace(/^(\S+) \1 /i, "$1 ");
  const exposure = [
    ex.exposureTime ? `${ex.exposureTime} sn` : "",
    ex.fNumber ? `f/${fmtNum(ex.fNumber)}` : "",
    ex.iso ? `ISO ${ex.iso}` : "",
    ex.exposureBias ? `${ex.exposureBias > 0 ? "+" : ""}${fmtNum(ex.exposureBias)} EV` : "",
  ].filter(Boolean).join(" · ");
  const focal = ex.focalLength
    ? `${fmtNum(ex.focalLength)} mm${ex.focalLength35mm ? ` (35 mm: ${ex.focalLength35mm} mm)` : ""}` : "";
  const gps = ex.gps ? `${ex.gps.latitude.toFixed(5)}, ${ex.gps.longitude.toFixed(5)}${ex.gps.altitude != null ? ` · ${Math.round(ex.gps.altitude)} m` : ""}` : "";
  const rows = [
    ["Dosya", info.name],
    ["Biçim", (info.format ?? "").toUpperCase()],
    ["Boyutlar", info.width && info.height ? `${info.width} × ${info.height} (${fmtNum(info.width * info.height / 1e6)} MP)` : ""],
    ["Dosya boyutu", formatBytes(info.size)],
    ["Çekim tarihi", formatExifDate(ex.dateTaken, ex.dateTakenOffset)],
    ["Kamera", camera],
    ["Lens", ex.lens],
    ["Pozlama", exposure],
    ["Odak uzaklığı", focal],
    ["Flaş", ex.flash === "fired" ? "Patladı" : ex.flash === "off" ? "Patlamadı" : ""],
    ["Yazılım", ex.software],
    ["Sanatçı", ex.artist],
    ["Telif", ex.copyright],
    ["Konum", gps],
  ];
  return rows.filter(([, v]) => v != null && v !== "");
}

// ---------------------------------------------------------------------------
// Settings adapter (localStorage now; B2's settings store can be plugged in later)
// ---------------------------------------------------------------------------

/** In-memory backend with the Storage API subset we use (tests / private mode). */
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/**
 * Tiny JSON settings adapter: get(key, fallback) / set(key, value).
 * `backend` is either a Storage-like object (getItem/setItem) or an object with
 * get(key)/set(key, value) (e.g. a future settings store); switch with use().
 */
export function createSettings(backend, prefix = "vho.studio.") {
  let b = backend;
  const isStore = () => typeof b?.get === "function" && typeof b?.set === "function" && typeof b?.getItem !== "function";
  return {
    get(key, fallback) {
      try {
        if (isStore()) {
          const v = b.get(prefix + key);
          return v === undefined || v === null ? fallback : v;
        }
        const raw = b?.getItem(prefix + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (isStore()) b.set(prefix + key, value);
        else b?.setItem(prefix + key, JSON.stringify(value));
      } catch { /* quota / private mode: settings are best effort */ }
      return value;
    },
    /** Switches the storage backend (e.g. to the settings store once it exists). */
    use(next) { b = next; },
  };
}

/** Adds or removes a folder in the favourites list (no duplicates, keeps order). */
export function toggleFavorite(list, path) {
  const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();
  return list.some((p) => norm(p) === norm(path)) ? list.filter((p) => norm(p) !== norm(path)) : [...list, path];
}

// ---------------------------------------------------------------------------
// Compare mode: shared zoom/pan
// ---------------------------------------------------------------------------

/** Zoom around a point (relative to the pane centre), like the photo viewer. */
export function zoomAt(view, factor, ox = 0, oy = 0, min = 0.1, max = 16) {
  const zoom = Math.max(min, Math.min(max, view.zoom * factor));
  const k = zoom / view.zoom;
  if (zoom <= 1) return { zoom, x: 0, y: 0 };
  return { zoom, x: ox - (ox - view.x) * k, y: oy - (oy - view.y) * k };
}

/** Grid columns for 2-4 panes. */
export const compareColumns = (n) => (n <= 3 ? n : 2);

/** Filmstrip: index range [start, end) of `visible` items centred on `current`. */
export function stripWindow(current, count, visible) {
  if (count <= visible) return { start: 0, end: count };
  let start = Math.max(0, current - Math.floor(visible / 2));
  start = Math.min(start, count - visible);
  return { start, end: start + visible };
}
