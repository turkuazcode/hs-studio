// ==========================================================================
// Info panel: EXIF / file details, RGB + luminance histogram (from a 256 px
// thumbnail), all metadata, and the GPS map tab (lazy, online only).
// ==========================================================================

import { computeHistogram, infoRows } from "./logic.js";
import { createMapView } from "./map.js";

/** Untainted bitmap of a local file (fetch through the asset protocol). */
export async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** Draws a histogram into a canvas (luminance area + RGB lines). */
export function drawHistogram(canvas, hist) {
  const ctx = canvas.getContext("2d");
  const { width: W, height: H } = canvas;
  ctx.clearRect(0, 0, W, H);
  if (!hist?.count) return;
  // Square-root scale keeps dark/bright tails visible next to a big peak
  const scale = (v) => H - Math.sqrt(v / hist.max) * (H - 2);
  const path = (arr) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, scale(arr[i]));
    ctx.lineTo(W, H);
    ctx.closePath();
  };
  ctx.globalCompositeOperation = "source-over";
  path(hist.l);
  ctx.fillStyle = "rgba(226, 232, 240, 0.28)";
  ctx.fill();
  ctx.globalCompositeOperation = "lighter";
  for (const [arr, color] of [[hist.r, "rgba(244,63,94,0.55)"], [hist.g, "rgba(16,185,129,0.5)"], [hist.b, "rgba(59,130,246,0.55)"]]) {
    path(arr);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Histogram of an image bitmap, computed from a copy at most `max` px wide/high. */
export function histogramOf(bitmap, max = 256) {
  const s = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return computeHistogram(ctx.getImageData(0, 0, w, h).data);
}

/**
 * root: the #ps-info element. deps: { invoke, convertFileSrc, onClose }
 */
export function createInfoPanel(root, { invoke, convertFileSrc, onClose }) {
  const $ = (s) => root.querySelector(s);
  const rowsEl = $(".ps-info-rows");
  const allEl = $(".ps-info-all");
  const histCanvas = $(".ps-histogram");
  const mapEl = $(".ps-map");
  const mapNote = $(".ps-map-note");
  const mapTabBtn = $('[data-tab-btn="map"]');
  const titleEl = $(".ps-info-title");
  const map = createMapView(mapEl);

  let current = null; // { path, info }
  let tab = "info";
  let timer = 0;
  let token = 0;

  function setTab(name) {
    tab = name;
    for (const b of root.querySelectorAll("[data-tab-btn]")) b.classList.toggle("active", b.dataset.tabBtn === name);
    for (const p of root.querySelectorAll("[data-tab]")) p.hidden = p.dataset.tab !== name;
    if (name === "map") showMap();
  }

  function showMap() {
    const gps = current?.info?.exif?.gps;
    mapEl.hidden = true;
    if (!gps) {
      mapNote.textContent = "Bu fotoğrafta konum (GPS) bilgisi yok.";
      return;
    }
    if (!navigator.onLine) {
      mapNote.textContent = "Çevrimdışı: harita gösterilemiyor.";
      return;
    }
    mapNote.textContent = `${gps.latitude.toFixed(5)}, ${gps.longitude.toFixed(5)}`;
    mapEl.hidden = false;
    map.show(gps.latitude, gps.longitude).catch((e) => {
      mapEl.hidden = true;
      mapNote.textContent = `Harita yüklenemedi: ${e.message ?? e}`;
    });
  }

  function renderInfo(info) {
    const rows = infoRows(info);
    rowsEl.replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dd.title = v;
      return [dt, dd];
    }));
    const fields = info?.fields ?? [];
    allEl.replaceChildren(...fields.map((f) => {
      const tr = document.createElement("tr");
      const a = document.createElement("td");
      a.textContent = f.tag;
      a.title = `${f.group} / ${f.ifd} (${f.id})`;
      const b = document.createElement("td");
      b.textContent = f.value;
      tr.append(a, b);
      return tr;
    }));
    $(".ps-info-all-wrap").hidden = !fields.length;
    const hasGps = !!info?.exif?.gps;
    mapTabBtn.disabled = !hasGps;
    mapTabBtn.title = hasGps ? "Konumu haritada göster" : "Konum bilgisi yok";
    root.dataset.hasGps = hasGps ? "1" : "0";
    if (!hasGps && tab === "map") setTab("info");
    else if (tab === "map") showMap();
  }

  async function load(item, my) {
    if (!item || item.kind === "video") {
      renderInfo(item ? { name: item.name, size: item.size, format: item.ext } : null);
      drawHistogram(histCanvas, null);
      root.dataset.loaded = item?.path ?? "";
      return;
    }
    try {
      const info = await invoke("photo_info", { path: item.path });
      if (my !== token) return;
      current = { path: item.path, info };
      renderInfo(info);
    } catch (e) {
      if (my !== token) return;
      current = { path: item.path, info: null };
      renderInfo({ name: item.name, size: item.size, format: item.ext });
      rowsEl.append(Object.assign(document.createElement("dd"), { className: "ps-error", textContent: String(e).replace(/^\[[a-z-]+\]\s*/, "") }));
    }
    try {
      const t = await invoke("photo_thumb", { path: item.path, size: 256 });
      if (my !== token) return;
      const bmp = await loadBitmap(convertFileSrc(t.path));
      if (my !== token) return bmp.close();
      const hist = histogramOf(bmp);
      bmp.close();
      drawHistogram(histCanvas, hist);
      histCanvas.dataset.pixels = hist.count;
    } catch (e) {
      drawHistogram(histCanvas, null);
      histCanvas.dataset.pixels = "0";
    }
    if (my === token) root.dataset.loaded = item.path;
  }

  for (const b of root.querySelectorAll("[data-tab-btn]")) b.addEventListener("click", () => !b.disabled && setTab(b.dataset.tabBtn));
  $(".ps-info-close")?.addEventListener("click", () => onClose?.());
  window.addEventListener("online", () => tab === "map" && showMap());
  window.addEventListener("offline", () => tab === "map" && showMap());

  return {
    root,
    /** Shows `item` (debounced so fast keyboard navigation does not flood the backend). */
    show(item, { immediate = false } = {}) {
      clearTimeout(timer);
      const my = ++token;
      titleEl.textContent = item?.name ?? "Bilgi";
      if (!item) current = null;
      const run = () => load(item, my);
      if (immediate) run();
      else timer = setTimeout(run, 120);
    },
    setTab,
    get tab() { return tab; },
  };
}
