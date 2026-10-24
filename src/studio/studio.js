// ==========================================================================
// Photo Studio ("Fotoğraf Stüdyosu / Göz At"): folder tree + favourites,
// virtualised thumbnail grid with sort / filter / search / multi-select,
// viewer integration (folder session + filmstrip), info panel, editor,
// compare and batch dialogs. Markup root: #photo-studio-layer in index.html.
// ==========================================================================

import { convertFileSrc, dialogOpen, invoke, listen } from "../core/tauri.js";
import { isTextField } from "../ui/shortcuts.js";
import { createBatch } from "./batch.js";
import { createCompare } from "./compare.js";
import { createEditor } from "./editor.js";
import { createFilmstrip } from "./filmstrip.js";
import { createGrid } from "./grid.js";
import { createInfoPanel } from "./info-panel.js";
import { createMenu } from "./menu.js";
import {
  baseName, createSettings, nextFrame, dateInputToMs, emptySelection, filterItems, memoryStorage, parentDir, pathSegments,
  reconcileSelection, selectAll, selectClick, selectMove, selectedInOrder, sortItems, toggleFavorite,
} from "./logic.js";
import { createThumbService } from "./thumbs.js";

const dialogSave = globalThis.window?.__TAURI__?.dialog?.save
  ? (opts) => window.__TAURI__.dialog.save(opts) : undefined;

const STUDIO_ICON = '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z" clip-rule="evenodd"/></svg>';

function safeLocalStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem("vho.probe");
    return s;
  } catch {
    return memoryStorage();
  }
}

/**
 * Settings adapter shared by the studio: localStorage until the app's settings store is
 * plugged in (createPhotoStudio does that when app.settings exists).
 */
export const studioSettings = createSettings(safeLocalStorage());

const SORT_KEYS = ["name", "date", "size", "exifDate"];
const isPathList = (v) => Array.isArray(v?.paths) && v.paths.every((p) => typeof p === "string");

/** Registers the studio's persistent options in the app settings store (Settings > Fotoğraf). */
export function registerStudioSettings(appSettings) {
  const hidden = { control: "custom", render: (row) => { row.hidden = true; } };
  appSettings.register("photo", [
    { control: "heading", labelKey: "settings.headings.photoStudio" },
    {
      key: "photo.studio.sort", type: "enum", values: SORT_KEYS, default: "name", control: "select",
      labelKey: "settings.fields.studioSort",
      options: SORT_KEYS.map((v) => ({ value: v, labelKey: `settings.options.sort${v[0].toUpperCase()}${v.slice(1)}` })),
    },
    { key: "photo.studio.descending", type: "boolean", default: false, control: "toggle", labelKey: "settings.fields.studioDescending" },
    { key: "photo.studio.recursive", type: "boolean", default: false, control: "toggle", labelKey: "settings.fields.studioRecursive" },
    {
      key: "photo.studio.thumbSize", type: "number", min: 96, max: 320, integer: true, default: 168, control: "range",
      step: 8, unit: " px", labelKey: "settings.fields.studioThumbSize",
    },
    // Internal state (no visible control)
    { key: "photo.studio.infoOpen", type: "boolean", default: false, ...hidden },
    { key: "photo.studio.lastFolder", type: "string", default: "", maxLength: 4096, ...hidden },
    { key: "photo.studio.favorites", type: "object", default: { paths: [] }, validate: isPathList, ...hidden },
  ]);
}

/** createSettings() backend over the app settings store ("vho.studio.x" -> "photo.studio.x"). */
export function appSettingsStore(appSettings) {
  const key = (k) => k.replace(/^vho\.studio\./, "photo.studio.");
  const wrapped = (k) => key(k) === "photo.studio.favorites";
  return {
    get: (k) => (appSettings.has(key(k)) ? (wrapped(k) ? appSettings.get(key(k))?.paths : appSettings.get(key(k))) : undefined),
    set: (k, v) => appSettings.has(key(k)) && appSettings.set(key(k), wrapped(k) ? { paths: v } : v),
  };
}

/**
 * app: { dom, state, bus, toast, playlist, photo, video, loader, hud }  (resolved lazily)
 */
export function createPhotoStudio(app) {
  const { dom, state } = app;
  const layer = document.getElementById("photo-studio-layer");
  if (!layer) return null;
  const $ = (id) => document.getElementById(id);
  const root = $("photo-studio");
  const gridEl = $("ps-grid");
  const emptyEl = $("ps-empty");
  const statusEl = $("ps-status");
  const crumbEl = $("ps-breadcrumb");
  const treeEl = $("ps-tree");
  const favsEl = $("ps-favorites");
  const infoEl = $("ps-info");
  const contentEl = root.querySelector(".ps-content");
  const viewport = $("viewport");
  const settings = studioSettings;
  if (app.settings?.register && !app.settings.has("photo.studio.sort")) {
    registerStudioSettings(app.settings);
    settings.use(appSettingsStore(app.settings));
  }

  const thumbs = createThumbService({ invoke, listen, convertFileSrc });

  // ------------------------------------------------------------------ state
  let dir = "";
  let items = [];               // scan order
  let view = [];                // filtered + sorted
  let paths = [];
  let sel = emptySelection();
  let scanId = "";
  let seq = 0;
  let backendOrder = true;      // view order == scan order (no client re-sort needed)
  let sortKey = settings.get("sort", "name");
  let descending = settings.get("descending", false);
  let recursive = settings.get("recursive", false);
  let filter = { type: "all", from: null, to: null, query: "" };
  let scanStarted = 0;
  let firstPaintDone = false;
  let viewRaf = 0;
  let dirty = false;            // folder changed on disk (save / batch): rescan on show
  let session = null;           // viewer session: items opened from the grid

  // ------------------------------------------------------------ components
  const grid = createGrid(gridEl, {
    thumbs,
    onActivate: (i) => openIndex(i),
    onPointerSelect: (i, e) => {
      sel = i < 0 ? emptySelection() : selectClick(sel, i, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }, paths);
      syncSelection();
    },
    onRender: () => {
      if (!firstPaintDone && view.length && gridEl.querySelector(".ps-cell")) {
        firstPaintDone = true;
        gridEl.dataset.firstPaintMs = Math.round(performance.now() - scanStarted);
      }
    },
  });
  grid.setCellSize(settings.get("thumbSize", 168));

  const info = createInfoPanel(infoEl, { invoke, convertFileSrc, onClose: () => setInfoVisible(false) });

  const editor = createEditor($("ps-editor"), {
    invoke, convertFileSrc, dialogSave, toast: app.toast,
    onSaved: (r, mode, item) => {
      thumbs.forget(item.path);
      if (r.output) thumbs.forget(r.output);
      dirty = true;
      if (!root.hidden) rescan(r.output);
    },
    onClose: () => restoreFocus(),
  });

  const compare = createCompare($("ps-compare"), { invoke, convertFileSrc, onClose: () => restoreFocus() });

  const batch = createBatch($("ps-batch"), {
    invoke, listen, dialogOpen, toast: app.toast,
    onDone: (s) => {
      for (const r of s.results) {
        thumbs.forget(r.input);
        if (r.output) thumbs.forget(r.output);
      }
      dirty = true;
      if (!root.hidden) rescan();
    },
  });

  const filmstrip = createFilmstrip(viewport, {
    thumbs,
    onPick: (i) => app.playlist.play(i),
  });

  // ----------------------------------------------------------- scanning
  listen?.("photo-scan-page", (e) => {
    const p = e.payload;
    if (p.scanId !== scanId) return;
    items.splice(p.offset, p.items.length, ...p.items);
    scheduleView();
  });
  listen?.("photo-scan-progress", (e) => {
    const p = e.payload;
    if (p.scanId !== scanId) return;
    statusEl.textContent = p.phase === "exif" ? `Çekim tarihleri okunuyor… ${p.done} / ${p.total}` : `Taranıyor… ${p.done} dosya`;
  });

  async function openFolder(path, { focusPath = null, keepScroll = false } = {}) {
    if (!invoke || !path) return;
    if (scanId) invoke("photo_cancel", { id: scanId }).catch(() => {});
    const id = `studio-scan-${++seq}`;
    scanId = id;
    dir = path;
    dirty = false;
    settings.set("lastFolder", dir);
    items = [];
    backendOrder = true;
    firstPaintDone = false;
    scanStarted = performance.now();
    gridEl.dataset.loading = "1";
    gridEl.dataset.total = "";
    gridEl.dataset.firstPaintMs = "";
    gridEl.dataset.dir = dir;
    const oldPaths = paths;
    if (!keepScroll) sel = emptySelection();
    view = [];
    paths = [];
    grid.setItems([], { keepScroll });
    renderBreadcrumb();
    renderFavorites();
    markTree();
    emptyEl.hidden = true;
    statusEl.textContent = "Taranıyor…";
    try {
      const s = await invoke("photo_scan", {
        dir,
        options: { scanId: id, sort: sortKey, descending, includeVideos: true, recursive, pageSize: 500, exifDates: sortKey === "exifDate" },
      });
      if (id !== scanId) return;
      applyView({ reset: false });
      gridEl.dataset.total = items.length;
      gridEl.dataset.scanMs = Math.round(performance.now() - scanStarted);
      gridEl.dataset.loading = "0";
      if (keepScroll) {
        sel = reconcileSelection(sel, oldPaths, paths);
        syncSelection();
      }
      if (focusPath) focusOn(focusPath);
      if (!items.length) showEmpty(s.folders.length ? "Bu klasörde fotoğraf yok. Soldaki ağaçtan bir alt klasör seçin." : "Bu klasörde fotoğraf veya video yok.");
      updateStatus(s.elapsedMs);
    } catch (e) {
      if (id !== scanId) return;
      gridEl.dataset.loading = "0";
      showEmpty(`Klasör açılamadı: ${String(e).replace(/^\[[a-z-]+\]\s*/, "")}`);
      statusEl.textContent = "";
    }
  }

  const rescan = (focusPath) => dir && openFolder(dir, { keepScroll: true, focusPath: focusPath ?? paths[sel.focus] });

  function showEmpty(text) {
    emptyEl.hidden = false;
    emptyEl.querySelector(".ps-empty-text").textContent = text;
  }

  function scheduleView() {
    if (viewRaf) return;
    viewRaf = nextFrame(() => {
      viewRaf = 0;
      applyView({ reset: false });
    });
  }

  /** Recomputes the view; reset = order/filter changed (cells rebuilt, scroll to top). */
  function applyView({ reset = true } = {}) {
    const oldPaths = paths;
    let v = filterItems(items, filter);
    if (!backendOrder) v = sortItems(v, sortKey, descending);
    view = v;
    paths = view.map((i) => i.path);
    if (reset) {
      sel = reconcileSelection(sel, oldPaths, paths);
      grid.setItems(view);
    } else {
      grid.refresh(view);
    }
    if (view.length) emptyEl.hidden = true;
    syncSelection();
    updateStatus();
  }

  function updateStatus(scanMs) {
    const n = view.length, total = items.length;
    const imgs = view.filter((i) => i.kind !== "video").length;
    const parts = [n === total ? `${n} öğe` : `${n} / ${total} öğe`];
    if (n - imgs) parts.push(`${imgs} fotoğraf, ${n - imgs} video`);
    if (sel.selected.size) parts.push(`${sel.selected.size} seçili`);
    if (scanMs != null) parts.push(`${scanMs} ms`);
    statusEl.textContent = parts.join(" · ");
    gridEl.dataset.count = n;
  }

  // ---------------------------------------------------------- selection
  const selectedItems = () => {
    const set = sel.selected;
    return view.filter((i) => set.has(i.path));
  };
  const focusedItem = () => view[sel.focus] ?? null;

  function syncSelection() {
    grid.setSelection(sel.selected, sel.focus);
    gridEl.dataset.selected = sel.selected.size;
    gridEl.dataset.focus = sel.focus;
    const chosen = selectedItems();
    const photos = chosen.filter((i) => i.kind !== "video");
    $("ps-act-open").disabled = !focusedItem();
    $("ps-act-edit").disabled = !(focusedItem() && focusedItem().kind !== "video");
    $("ps-act-compare").disabled = photos.length < 2 || photos.length > 4;
    $("ps-act-batch").disabled = !photos.length;
    if (!infoEl.hidden && infoEl.parentElement === contentEl) info.show(focusedItem());
    updateStatus();
  }

  function focusOn(path) {
    const i = paths.indexOf(path);
    if (i < 0) return;
    sel = { selected: new Set([path]), anchor: i, focus: i };
    syncSelection();
    grid.reveal(i);
  }

  function restoreFocus() {
    if (!root.hidden) gridEl.focus({ preventScroll: true });
  }

  // ------------------------------------------------------- viewer session
  function openIndex(i) {
    const it = view[i];
    if (!it) return;
    if (it.kind === "video") {
      session = null;
      state.set("playlist", [{ path: it.path, name: it.name, size: it.size, isImage: false }]);
      hide();
      app.playlist.play(0);
      return;
    }
    const photos = view.filter((x) => x.kind !== "video");
    const list = photos.map((x) => ({
      path: x.path, name: x.name, size: x.size, isImage: true, studio: true, kind: x.kind, ext: x.ext, browserNative: x.browserNative,
    }));
    session = { dir, list };
    state.set("playlist", list);
    app.photo.toggleSlideshow(false, { silent: true });
    hide();
    app.playlist.play(photos.indexOf(it));
  }

  const inSession = () => !!session && state.get("playlist") === session.list;

  app.bus.on("media:loading", ({ item }) => {
    if (item?.studio && inSession()) {
      const index = state.get("currentPlaylistIndex");
      filmstrip.show(session.list, index);
      viewerButtons(true);
      if (!infoEl.hidden && infoEl.parentElement === viewport) info.show(item);
    } else {
      filmstrip.hide();
      viewerButtons(false);
      if (infoEl.parentElement === viewport) setInfoVisible(false);
    }
  });

  // Buttons injected into the existing photo HUD (shown only for folder sessions / local files)
  const hudRight = dom.photoHud?.querySelector(".photo-hud-right");
  const hudLeft = dom.photoHud?.querySelector(".photo-hud-left");
  const mkHudBtn = (id, title, html) => Object.assign(document.createElement("button"), { id, className: "hud-btn", title, innerHTML: html });
  const backBtn = mkHudBtn("ps-back-to-studio", "Stüdyoya dön (Esc)", '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M3 4h6v6H3zM11 4h6v6h-6zM3 12h6v4H3zM11 12h6v4h-6z"/></svg>');
  const editBtn = mkHudBtn("ps-viewer-edit", "Düzenle", '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M13.6 2.6a2 2 0 012.8 2.8l-9 9L4 15l.6-3.4 9-9zM3 17h14v1.5H3z"/></svg>');
  const infoBtn = mkHudBtn("ps-viewer-info", "Ayrıntılar: EXIF, histogram, harita", '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor"><path d="M3 3h14v14H3V3zm2 10v2h2v-2H5zm4-4v6h2V9H9zm4-3v9h2V6h-2z"/></svg>');
  // Slim viewer toolbar: back + edit visible, the rest behind "⋯" (UI principles)
  const viewerMoreBtn = mkHudBtn("ps-viewer-more", "Diğer", "⋯");
  viewerMoreBtn.classList.add("ps-hud-more");
  hudLeft?.prepend(backBtn);
  hudRight?.append(editBtn, viewerMoreBtn);
  const viewerMenu = createMenu([
    { id: "info", label: "Ayrıntılar (EXIF, histogram, harita)", run: () => infoBtn.click() },
    { id: "studio", label: "Klasörde göster (Fotoğraf Stüdyosu)", run: () => backToStudio() },
    { id: "rotateLeft", label: "Sola döndür", run: () => dom.btnPhotoRotateLeft?.click() },
    { id: "settings", label: "Fotoğraf ayarları…", run: () => app.settingsModal?.open("photo"), enabled: () => !!app.settingsModal },
  ]);
  viewerMoreBtn.addEventListener("click", () => (viewerMenu.isOpen ? viewerMenu.close() : viewerMenu.openFor(viewerMoreBtn)));
  function viewerButtons(on) {
    backBtn.hidden = !on;
    const cur = state.get("playlist")[state.get("currentPlaylistIndex")];
    const local = !!(cur?.path && cur.isImage);
    editBtn.hidden = !local;
    viewerMoreBtn.hidden = !local;
  }
  viewerButtons(false);
  backBtn.addEventListener("click", () => backToStudio());
  editBtn.addEventListener("click", () => {
    const cur = state.get("playlist")[state.get("currentPlaylistIndex")];
    if (cur?.path) editor.open({ ...cur, ext: cur.ext ?? cur.name.split(".").pop().toLowerCase(), browserNative: cur.browserNative ?? true });
  });
  infoBtn.addEventListener("click", () => {
    if (infoEl.parentElement === viewport && !infoEl.hidden) return setInfoVisible(false);
    viewport.append(infoEl);
    infoEl.classList.add("ps-info-float");
    infoEl.hidden = false;
    info.show(state.get("playlist")[state.get("currentPlaylistIndex")], { immediate: true });
  });

  function backToStudio() {
    const cur = state.get("playlist")[state.get("currentPlaylistIndex")];
    show({ focusPath: cur?.path });
  }

  // ------------------------------------------------------------- info panel
  function setInfoVisible(on) {
    if (infoEl.parentElement !== contentEl) {
      infoEl.classList.remove("ps-info-float");
      contentEl.append(infoEl);
      if (!on) { infoEl.hidden = true; return; }
    }
    infoEl.hidden = !on;
    settings.set("infoOpen", on);
    $("ps-act-info").classList.toggle("active", on);
    if (on) info.show(focusedItem(), { immediate: true });
  }

  // -------------------------------------------------------------- tree
  function treeNode(entry) {
    const li = document.createElement("li");
    li.className = "ps-tree-node";
    li.dataset.path = entry.path;
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-expanded", "false");
    const row = document.createElement("div");
    row.className = "ps-tree-row";
    const tog = Object.assign(document.createElement("button"), { className: "ps-tree-toggle", title: "Aç / kapat", textContent: "▸" });
    const label = Object.assign(document.createElement("button"), { className: "ps-tree-label", textContent: entry.name, title: entry.path });
    row.append(tog, label);
    li.append(row);
    return li;
  }

  async function toggleNode(li, open = li.getAttribute("aria-expanded") !== "true") {
    li.setAttribute("aria-expanded", String(open));
    li.querySelector(".ps-tree-toggle").textContent = open ? "▾" : "▸";
    let ul = li.querySelector(":scope > ul");
    if (!open) { if (ul) ul.hidden = true; return; }
    if (ul) { ul.hidden = false; return; }
    ul = document.createElement("ul");
    ul.className = "ps-tree-children";
    li.append(ul);
    try {
      const dirs = await invoke("photo_list_dirs", { dir: li.dataset.path });
      ul.replaceChildren(...dirs.map(treeNode));
      if (!dirs.length) li.querySelector(".ps-tree-toggle").classList.add("leaf");
      markTree();
    } catch {
      li.querySelector(".ps-tree-toggle").classList.add("leaf");
    }
  }

  async function loadTreeRoots() {
    if (!invoke || treeEl.childElementCount) return;
    try {
      const roots = await invoke("photo_list_dirs", {});
      treeEl.replaceChildren(...roots.map(treeNode));
      markTree();
    } catch (e) {
      console.warn("photo_list_dirs", e);
    }
  }

  const sameDir = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

  function markTree() {
    for (const li of treeEl.querySelectorAll(".ps-tree-node")) {
      li.classList.toggle("current", !!dir && sameDir(li.dataset.path, dir));
    }
  }

  treeEl.addEventListener("click", (e) => {
    const li = e.target.closest(".ps-tree-node");
    if (!li) return;
    if (e.target.closest(".ps-tree-toggle")) toggleNode(li);
    else if (e.target.closest(".ps-tree-label")) {
      openFolder(li.dataset.path);
      if (li.getAttribute("aria-expanded") !== "true") toggleNode(li, true);
    }
  });

  // ---------------------------------------------------- favourites & crumbs
  function renderFavorites() {
    const favs = settings.get("favorites", []);
    favsEl.replaceChildren(...favs.map((p) => {
      const li = document.createElement("li");
      li.className = "ps-fav" + (dir && sameDir(p, dir) ? " current" : "");
      li.dataset.path = p;
      const open = Object.assign(document.createElement("button"), { className: "ps-fav-open", textContent: baseName(p) || p, title: p });
      const rm = Object.assign(document.createElement("button"), { className: "ps-fav-remove", textContent: "✕", title: "Favorilerden çıkar" });
      li.append(open, rm);
      return li;
    }));
    if (!favs.length) {
      favsEl.append(Object.assign(document.createElement("li"), { className: "ps-fav-empty", textContent: "Klasörü ☆ ile favorilere ekleyin" }));
    }
    const star = $("ps-fav-toggle");
    const isFav = !!dir && favs.some((p) => sameDir(p, dir));
    star.textContent = isFav ? "★" : "☆";
    star.classList.toggle("active", isFav);
    star.title = isFav ? "Favorilerden çıkar" : "Favorilere ekle";
    star.disabled = !dir;
  }

  favsEl.addEventListener("click", (e) => {
    const li = e.target.closest(".ps-fav");
    if (!li) return;
    if (e.target.closest(".ps-fav-remove")) {
      settings.set("favorites", toggleFavorite(settings.get("favorites", []), li.dataset.path));
      renderFavorites();
    } else openFolder(li.dataset.path);
  });

  function renderBreadcrumb() {
    const segs = pathSegments(dir);
    crumbEl.replaceChildren(...segs.flatMap((s, i) => {
      const b = Object.assign(document.createElement("button"), { className: "ps-crumb", textContent: s.name, title: s.path });
      b.dataset.path = s.path;
      return i ? [Object.assign(document.createElement("span"), { className: "ps-crumb-sep", textContent: "›" }), b] : [b];
    }));
    $("ps-up").disabled = !parentDir(dir);
  }
  crumbEl.addEventListener("click", (e) => {
    const b = e.target.closest(".ps-crumb");
    if (b) openFolder(b.dataset.path);
  });

  // ------------------------------------------------------------- toolbar
  $("ps-sort").value = sortKey;
  $("ps-sort-dir").textContent = descending ? "↓" : "↑";
  $("ps-recursive").checked = recursive;
  $("ps-zoom").value = settings.get("thumbSize", 168);

  function applySort(key) {
    sortKey = key;
    $("ps-sort").value = key;
    settings.set("sort", sortKey);
    const needExif = sortKey === "exifDate" && items.some((i) => i.kind !== "video" && i.exifDate === undefined);
    if (needExif) return openFolder(dir, { keepScroll: false });
    backendOrder = false;
    applyView();
  }
  $("ps-sort").addEventListener("change", (e) => applySort(e.target.value));

  /** Options changed in the Settings window (or loaded after start-up). */
  function applyPrefs() {
    const s = settings.get("sort", "name"), d = !!settings.get("descending", false);
    const r = !!settings.get("recursive", false), z = Number(settings.get("thumbSize", 168));
    if (d !== descending) {
      descending = d;
      $("ps-sort-dir").textContent = d ? "↓" : "↑";
      backendOrder = false;
      if (s === sortKey) applyView();
    }
    if (s !== sortKey) applySort(s);
    if (r !== recursive) {
      recursive = r;
      $("ps-recursive").checked = r;
      if (dir) openFolder(dir);
    }
    if (String(z) !== $("ps-zoom").value) {
      $("ps-zoom").value = z;
      grid.setCellSize(z);
    }
  }
  if (app.settings?.subscribe) {
    app.settings.ready?.then(applyPrefs).catch(() => {});
    for (const k of ["sort", "descending", "recursive", "thumbSize"]) app.settings.subscribe(`photo.studio.${k}`, () => applyPrefs());
  }
  $("ps-sort-dir").addEventListener("click", (e) => {
    descending = !descending;
    settings.set("descending", descending);
    e.currentTarget.textContent = descending ? "↓" : "↑";
    backendOrder = false;
    applyView();
  });
  $("ps-filter-type").addEventListener("change", (e) => { filter = { ...filter, type: e.target.value }; applyView(); });
  $("ps-date-from").addEventListener("change", (e) => { filter = { ...filter, from: dateInputToMs(e.target.value) }; applyView(); });
  $("ps-date-to").addEventListener("change", (e) => { filter = { ...filter, to: dateInputToMs(e.target.value, true) }; applyView(); });
  let searchTimer = 0;
  $("ps-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filter = { ...filter, query: e.target.value }; applyView(); }, 120);
  });
  $("ps-recursive").addEventListener("change", (e) => {
    recursive = e.target.checked;
    settings.set("recursive", recursive);
    if (dir) openFolder(dir);
  });
  $("ps-zoom").addEventListener("input", (e) => {
    grid.setCellSize(Number(e.target.value));
    settings.set("thumbSize", Number(e.target.value));
  });
  $("ps-up").addEventListener("click", () => parentDir(dir) && openFolder(parentDir(dir)));
  $("ps-fav-toggle").addEventListener("click", () => {
    if (!dir) return;
    settings.set("favorites", toggleFavorite(settings.get("favorites", []), dir));
    renderFavorites();
  });
  const pickFolder = async () => {
    if (!dialogOpen) return;
    const picked = await dialogOpen({ directory: true, multiple: false, defaultPath: dir || undefined }).catch(() => null);
    const p = Array.isArray(picked) ? picked[0] : picked;
    if (p) openFolder(p);
  };
  $("ps-pick-folder").addEventListener("click", pickFolder);
  emptyEl.querySelector(".ps-empty-pick")?.addEventListener("click", pickFolder);

  $("ps-act-open").addEventListener("click", () => openIndex(sel.focus));
  $("ps-act-edit").addEventListener("click", () => focusedItem() && editor.open(focusedItem()));
  $("ps-act-compare").addEventListener("click", () => {
    const photos = selectedItems().filter((i) => i.kind !== "video");
    if (photos.length >= 2 && photos.length <= 4) compare.open(photos);
    else app.toast("Karşılaştırma için 2-4 fotoğraf seçin");
  });
  $("ps-act-batch").addEventListener("click", () => {
    const photos = selectedItems().filter((i) => i.kind !== "video");
    if (photos.length) batch.open(photos);
  });
  $("ps-act-info").addEventListener("click", () => setInfoVisible(infoEl.hidden || infoEl.parentElement !== contentEl));
  $("ps-close").addEventListener("click", () => hide());

  // Filters: closed by default; the button shows when a filter is active
  const filtersEl = $("ps-filters");
  const filterBtn = $("ps-filter-toggle");
  filterBtn.addEventListener("click", () => {
    filtersEl.hidden = !filtersEl.hidden;
    filterBtn.classList.toggle("active", !filtersEl.hidden);
  });
  const markFilter = () => filterBtn.classList.toggle("has-filter", filter.type !== "all" || filter.from != null || filter.to != null || recursive);
  for (const id of ["ps-filter-type", "ps-date-from", "ps-date-to", "ps-recursive"]) $(id).addEventListener("change", markFilter);

  // "⋯" menu and right-click on the grid: everything that is not used all the time
  const cmd = (id) => () => $(id).click();
  const can = (id) => () => !$(id).disabled;
  const studioMenu = createMenu([
    { id: "open", label: "Aç", run: cmd("ps-act-open"), enabled: can("ps-act-open") },
    { id: "edit", label: "Düzenle", run: cmd("ps-act-edit"), enabled: can("ps-act-edit") },
    { id: "compare", label: "Karşılaştır (2-4 fotoğraf)", run: cmd("ps-act-compare"), enabled: can("ps-act-compare") },
    { id: "batch", label: "Toplu işlem…", run: cmd("ps-act-batch"), enabled: can("ps-act-batch") },
    { id: "s1", separator: true },
    { id: "info", label: "Bilgi paneli (EXIF, histogram, harita)", run: cmd("ps-act-info") },
    { id: "selectAll", label: "Tümünü seç", run: () => { sel = selectAll(paths, sel); syncSelection(); }, enabled: () => paths.length > 0 },
    { id: "pick", label: "Klasör seç…", run: () => pickFolder(), enabled: () => !!dialogOpen },
    { id: "settings", label: "Fotoğraf ayarları…", run: () => app.settingsModal?.open("photo"), enabled: () => !!app.settingsModal },
  ]);
  $("ps-more").addEventListener("click", (e) => (studioMenu.isOpen ? studioMenu.close() : studioMenu.openFor(e.currentTarget)));
  gridEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation(); // not the app-wide context menu
    const c = e.target.closest(".ps-cell");
    if (c) {
      const i = Number(c.dataset.index);
      if (!sel.selected.has(paths[i])) {
        sel = selectClick(sel, i, {}, paths);
        syncSelection();
      }
    }
    studioMenu.openAt(e.clientX, e.clientY);
  });

  // ------------------------------------------------------------ keyboard
  function gridKey(e) {
    const cols = grid.columns;
    const opts = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const move = (d) => { sel = selectMove(sel, d, opts, paths); syncSelection(); grid.reveal(sel.focus); };
    switch (e.key) {
      case "ArrowRight": move(1); break;
      case "ArrowLeft": move(-1); break;
      case "ArrowDown": move(cols); break;
      case "ArrowUp": move(-cols); break;
      case "PageDown": move(cols * grid.visibleRows); break;
      case "PageUp": move(-cols * grid.visibleRows); break;
      case "Home": move(-paths.length); break;
      case "End": move(paths.length); break;
      case "Enter": openIndex(sel.focus); break;
      case " ":
        if (opts.ctrl && sel.focus >= 0) { sel = selectClick(sel, sel.focus, { ctrl: true }, paths); syncSelection(); }
        else if (sel.focus >= 0) openIndex(sel.focus);
        break;
      case "Backspace": if (parentDir(dir)) openFolder(parentDir(dir)); break;
      case "Escape":
        if (sel.selected.size) { sel = emptySelection(); syncSelection(); } else hide();
        break;
      default: {
        const k = e.key.toLowerCase();
        if (opts.ctrl && k === "a") { sel = selectAll(paths, sel); syncSelection(); break; }
        if (opts.ctrl && k === "f") { $("ps-search").focus(); break; }
        if (!opts.ctrl && k === "i") { $("ps-act-info").click(); break; }
        if (!opts.ctrl && k === "e") { $("ps-act-edit").click(); break; }
        return false;
      }
    }
    return true;
  }

  window.addEventListener("keydown", (e) => {
    if (studioMenu.isOpen || viewerMenu.isOpen) {
      // The menu handles its own arrow keys; Esc closes it from anywhere
      if (e.key === "Escape") {
        studioMenu.close();
        viewerMenu.close();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const overlay = [editor, compare, batch].find((x) => x.isOpen);
    if (overlay) {
      if (overlay.handleKey(e)) e.preventDefault();
      e.stopPropagation(); // no viewer / video shortcuts underneath
      return;
    }
    if (!root.hidden) {
      if (isTextField(e.target)) {
        // Typing is left alone (global shortcuts ignore text fields); Esc leaves the field
        if (e.key === "Escape") { e.target.blur(); gridEl.focus(); e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (e.code === "KeyF" && !e.ctrlKey) return; // fullscreen stays global
      if (gridKey(e)) e.preventDefault();
      e.stopPropagation();
      return;
    }
  }, true);

  // Viewer opened from the studio: Esc goes back to the grid (B2 shortcut table: Escape chain)
  const viewerEscape = () => {
    if (!root.hidden || !inSession() || state.get("currentMediaType") !== "image") return false;
    backToStudio();
    return true;
  };
  if (app.shortcuts?.onEscape) app.shortcuts.onEscape(viewerEscape);
  else window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !isTextField(e.target)) viewerEscape(); });

  // Entry points in the central shortcut table (Settings > Kısayollar, F1 help)
  app.shortcuts?.register?.({
    id: "photoStudio", scope: "global", keys: ["Ctrl+Shift+KeyO"], labelKey: "shortcuts.actions.photoStudio",
    run: () => (root.hidden ? show() : hide()),
  });
  app.shortcuts?.register?.({
    id: "photoEdit", scope: "photo", keys: ["Ctrl+KeyE"], labelKey: "shortcuts.actions.photoEdit",
    run: () => { if (!editBtn.hidden) editBtn.click(); },
  });

  // Address bar: type / paste a folder path (pencil button next to the breadcrumb)
  const pathForm = Object.assign(document.createElement("form"), { className: "ps-path-form", hidden: true });
  const pathInput = Object.assign(document.createElement("input"), {
    id: "ps-path", className: "ps-input ps-path", type: "text", spellcheck: false, placeholder: "Klasör yolu yazın ve Enter",
  });
  pathForm.append(pathInput);
  const pathBtn = Object.assign(document.createElement("button"), { id: "ps-path-edit", className: "ps-btn", title: "Yolu yaz / yapıştır", textContent: "✎" });
  crumbEl.after(pathForm, pathBtn);
  const closePath = () => { pathForm.hidden = true; crumbEl.hidden = false; };
  pathBtn.addEventListener("click", () => {
    crumbEl.hidden = true;
    pathForm.hidden = false;
    pathInput.value = dir;
    pathInput.focus();
    pathInput.select();
  });
  pathForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const p = pathInput.value.trim().replace(/^"(.*)"$/, "$1");
    closePath();
    if (p) openFolder(p);
  });
  pathInput.addEventListener("blur", () => setTimeout(closePath, 0));

  // ------------------------------------------------------- show / hide
  function show({ focusPath = null } = {}) {
    root.hidden = false;
    layer.classList.add("open");
    document.body.classList.add("ps-open");
    dom.dropZone?.classList.remove("visible");
    if (dom.video && !dom.video.paused) dom.video.pause();
    app.photo?.toggleSlideshow(false, { silent: true });
    filmstrip.hide();
    if (infoEl.parentElement !== contentEl) setInfoVisible(settings.get("infoOpen", false));
    $("btn-photo-studio")?.classList.add("active");
    loadTreeRoots();
    renderFavorites();
    const last = settings.get("lastFolder", "");
    if (!dir && last) openFolder(last, { focusPath });
    else if (dirty && dir) openFolder(dir, { keepScroll: true, focusPath });
    else if (!dir) showEmpty("Göz atmak için soldan bir klasör seçin.");
    else if (focusPath) focusOn(focusPath);
    nextFrame(() => { grid.renderNow(); gridEl.focus({ preventScroll: true }); });
  }

  function hide() {
    if (editor.isOpen && !editor.close()) return;
    compare.close();
    batch.close();
    root.hidden = true;
    layer.classList.remove("open");
    document.body.classList.remove("ps-open");
    $("btn-photo-studio")?.classList.remove("active");
    if (state.get("currentMediaType") === "none") dom.dropZone?.classList.add("visible");
  }

  // -------------------------------------------- entry points (titlebar, start)
  const titleBtn = Object.assign(document.createElement("button"), {
    id: "btn-photo-studio", className: "titlebar-action-btn", title: "Fotoğraf Stüdyosu: klasöre göz at",
    innerHTML: `${STUDIO_ICON}<span>Fotoğraflar</span>`,
  });
  dom.titlebar?.querySelector(".titlebar-actions")?.prepend(titleBtn);
  titleBtn.addEventListener("click", () => (root.hidden ? show() : hide()));

  const startBtn = Object.assign(document.createElement("button"), {
    id: "btn-open-studio", className: "btn-secondary", innerHTML: `${STUDIO_ICON} Klasöre Göz At`,
  });
  dom.dropZone?.querySelector(".drop-actions")?.append(startBtn);
  startBtn.addEventListener("click", () => show());

  return {
    show, hide, openFolder,
    get isOpen() { return !root.hidden; },
    get dir() { return dir; },
    get view() { return view; },
    get selection() { return selectedInOrder(sel, paths); },
    settings,
    thumbs,
  };
}
