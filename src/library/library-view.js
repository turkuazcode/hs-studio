// ==========================================================================
// Library view (Plan 13/L02): persistent library folders, separate Video / Music layouts
// and saved playlists. Minimal by design: a tab per media type, one search box, one view
// selector and a "⋯" menu; folder management lives in Settings > Library.
// The list is virtual (fixed row height) and paged from the backend query, so a library
// with 100k items renders only the visible rows; scans run in the backend and never block.
// Photos keep their own screen (Photo Studio), which uses the same ratings/tags query.
// ==========================================================================

import { formatTime } from "../core/format.js";
import { i18n, t } from "../core/i18n.js";
import { createLibraryApi, buildQuery, createPagedSource, stars, visibleRange } from "../core/library-api.js";
import { dialogOpen, invoke, listen } from "../core/tauri.js";
import { createMenu } from "../studio/menu.js";
import { h } from "../ui/action-dialogs.js";
import { createPlaylistFiles } from "./playlist-files.js";
import { registerLibrarySettings } from "./library-settings.js";

const ROW_H = 44;
const LIBRARY_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M3 3h3v14H3zM8 3h3v14H8zM13.2 3.6l2.9-.8 3.3 13.5-2.9.7z"/></svg>';

const VIEWS = {
  video: ["all", "continue", "recentlyAdded", "favorites", "missing"],
  audio: ["all", "recentlyAdded", "mostPlayed", "favorites", "missing"],
};

const dirOf = (p) => (p ? p.replace(/[\\/][^\\/]*$/, "") : "");

/**
 * app: { dom, state, bus, toast, loader, playlist, settings, shortcuts, settingsModal } (lazy)
 */
export function createLibraryView(app) {
  const api = createLibraryApi(invoke);
  const playlists = createPlaylistFiles(app, api);
  if (!api) return { api: null, playlists, show() {}, hide() {}, get isOpen() { return false; } };

  // ------------------------------------------------------------- markup
  const tabs = ["video", "audio", "lists"];
  const tabBtns = tabs.map((k) => h("button", {
    type: "button", class: "lib-tab", role: "tab", "data-tab": k, "data-i18n": `library.tabs.${k}`, text: t(`library.tabs.${k}`),
  }));
  const search = h("input", {
    id: "lib-search", class: "ps-input lib-search", type: "search", spellcheck: false,
    placeholder: t("library.search"), "data-i18n-placeholder": "library.search",
  });
  const viewSel = h("select", { id: "lib-view", class: "ps-select", "aria-label": t("library.viewLabel") });
  const moreBtn = h("button", { id: "lib-more", type: "button", class: "ps-btn", text: "⋯", title: t("library.more"), "data-i18n-title": "library.more" });
  const closeBtn = h("button", { id: "lib-close", type: "button", class: "ps-btn", text: "✕", title: t("common.close"), "data-i18n-title": "common.close" });
  const status = h("div", { id: "lib-status", class: "lib-status", role: "status", "aria-live": "polite" });
  const list = h("div", { id: "lib-list", class: "lib-list", tabIndex: 0, role: "listbox", "aria-label": t("library.title") });
  const spacer = h("div", { class: "lib-spacer" });
  const rowsEl = h("div", { class: "lib-rows" });
  list.append(spacer, rowsEl);
  const emptyText = h("p", { class: "lib-empty-text" });
  const emptyAdd = h("button", { type: "button", id: "lib-empty-add", class: "btn-primary btn-sm", "data-i18n": "library.addFolder", text: t("library.addFolder") });
  const empty = h("div", { id: "lib-empty", class: "lib-empty", hidden: true }, emptyText, emptyAdd);
  const listsEl = h("div", { id: "lib-playlists", class: "lib-playlists", hidden: true });
  const root = h("section", { id: "library", class: "lib-root", hidden: true, "aria-label": t("library.title") },
    h("header", { class: "lib-header" },
      h("h2", { class: "lib-title", "data-i18n": "library.title", text: t("library.title") }),
      h("div", { class: "lib-tabs", role: "tablist" }, tabBtns),
      search, viewSel, moreBtn, closeBtn),
    status, list, empty, listsEl);
  const layer = h("div", { id: "library-layer", class: "ps-layer lib-layer" }, root);
  (document.getElementById("viewport") ?? document.body).append(layer);

  // ------------------------------------------------------------- state
  let tab = "video";
  let view = "all";
  let source = null;
  let rendered = "";
  let focus = -1;
  let folderCount = null;
  let scanning = null; // { phase, done }
  let raf = 0;

  function fillViews() {
    const opts = VIEWS[tab] ?? [];
    viewSel.replaceChildren(...opts.map((v) => h("option", { value: v, text: t(`library.views.${v}`) })));
    if (!opts.includes(view)) view = "all";
    viewSel.value = view;
  }

  function setTab(k) {
    tab = k;
    for (const b of tabBtns) b.setAttribute("aria-selected", String(b.dataset.tab === k));
    const isList = k === "lists";
    viewSel.hidden = isList;
    search.hidden = isList;
    list.hidden = isList;
    listsEl.hidden = !isList;
    root.dataset.tab = k;
    if (isList) {
      empty.hidden = true;
      renderPlaylists();
    } else {
      fillViews();
      if (!root.hidden) requery();
    }
  }

  // ------------------------------------------------------- virtual list
  function requery() {
    source?.dispose();
    focus = -1;
    rendered = "";
    list.scrollTop = 0;
    const q = buildQuery({ kind: tab, view, search: search.value });
    const s = createPagedSource((offset, limit) => api.query({ ...q, offset, limit }), { onLoad: () => { if (source === s) schedule(); } });
    source = s;
    root.dataset.loading = "1";
    s.load(0).then(() => {
      if (source !== s) return;
      root.dataset.loading = "0";
      root.dataset.total = String(s.total ?? 0);
      updateEmpty();
      schedule();
    }).catch((e) => {
      root.dataset.loading = "0";
      status.textContent = `⚠️ ${String(e?.message ?? e).replace(/^\[[a-z-]+\]\s*/i, "")}`;
    });
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderRows(); });
  }

  function rowEl(item, i) {
    const r = h("div", { class: `lib-row status-${item.status}${i === focus ? " focused" : ""}`, role: "option", "data-index": i, "data-id": item.id, "aria-selected": String(i === focus) });
    r.style.top = `${i * ROW_H}px`;
    const badge = item.status === "offline" ? h("span", { class: "lib-badge", text: t("library.status.offline") })
      : item.status === "missing" ? h("span", { class: "lib-badge warn", text: t("library.status.missing") }) : null;
    if (tab === "audio") {
      r.append(
        h("span", { class: "lib-cell lib-name", title: item.path ?? "" }, item.title || item.name, badge),
        h("span", { class: "lib-cell lib-sub", text: item.artist ?? "" }),
        h("span", { class: "lib-cell lib-sub", text: item.album ?? "" }),
        h("span", { class: "lib-cell lib-num", text: item.duration ? formatTime(item.duration) : "" }));
    } else {
      const resume = item.resumeSeconds ? t("library.resumeAt", { time: formatTime(item.resumeSeconds) }) : "";
      r.append(
        h("span", { class: "lib-cell lib-name", title: item.path ?? "" }, item.name, badge),
        h("span", { class: "lib-cell lib-sub", text: dirOf(item.path) }),
        h("span", { class: "lib-cell lib-sub", text: [stars(item.rating), resume].filter(Boolean).join(" · ") }),
        h("span", { class: "lib-cell lib-num", text: item.duration ? formatTime(item.duration) : "" }));
    }
    return r;
  }

  function renderRows() {
    if (!source || tab === "lists") return;
    const total = source.total ?? 0;
    spacer.style.height = `${total * ROW_H}px`;
    const { start, end } = visibleRange(list.scrollTop, list.clientHeight || 600, ROW_H, total);
    const out = [];
    let missingRows = false;
    for (let i = start; i < end; i++) {
      const item = source.get(i);
      if (item) out.push(rowEl(item, i));
      else missingRows = true;
    }
    const key = `${start}:${end}:${focus}:${out.length}`;
    if (key === rendered && !missingRows) return;
    rendered = missingRows ? "" : key;
    rowsEl.replaceChildren(...out);
    list.dataset.rendered = String(out.length);
  }
  list.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(list);

  function updateEmpty() {
    const total = source?.total ?? 0;
    const noFolders = folderCount === 0;
    empty.hidden = total > 0 || tab === "lists";
    emptyAdd.hidden = !noFolders;
    emptyText.textContent = noFolders ? t("library.empty.noFolders")
      : search.value.trim() ? t("library.empty.noMatch") : t("library.empty.none");
    renderStatus();
  }

  function renderStatus() {
    const parts = [];
    if (source?.total != null && tab !== "lists") parts.push(t("library.count", { n: source.total }));
    if (scanning) parts.push(scanning.phase === "tags" ? t("library.scan.tags") : t("library.scan.running", { n: scanning.done }));
    status.textContent = parts.join(" · ");
  }

  // ----------------------------------------------------------- opening
  /** Opens entries ({ path | url, name }) as the play queue, starting at `start`. */
  async function openQueue(entries, start = 0) {
    const paths = entries.filter((e) => e.path).map((e) => e.path);
    const prepared = paths.length ? await invoke("prepare_media", { paths }).catch(() => []) : [];
    const byPath = new Map(prepared.map((p) => [p.path, p]));
    const items = [];
    let startIndex = 0;
    entries.forEach((e, i) => {
      if (i === start) startIndex = items.length;
      if (e.path) {
        const p = byPath.get(e.path);
        if (p) items.push({ path: p.path, name: p.name, size: p.size, isImage: e.kind === "image" });
      } else if (e.url) {
        items.push({ url: e.url, name: e.title || e.url, isImage: false });
      }
    });
    if (!items.length) {
      app.toast?.(t("library.toast.nothingToPlay"));
      return false;
    }
    app.photo?.toggleSlideshow?.(false, { silent: true });
    app.state.set("playlist", items);
    app.state.set("currentPlaylistIndex", -1);
    hide();
    app.playlist.play(Math.min(startIndex, items.length - 1));
    return true;
  }

  function activate(i) {
    const item = source?.get(i);
    if (!item?.path || item.status !== "present") {
      if (item) app.toast?.(t(item.status === "offline" ? "library.toast.offline" : "library.toast.missing", { name: item.name }));
      return;
    }
    if (tab === "audio") {
      // the album/list continues from the chosen track (rows already loaded)
      const rows = [];
      for (let k = i; k < Math.min(source.total, i + 200); k++) {
        const r = source.get(k);
        if (!r) break;
        if (r.status === "present") rows.push({ path: r.path, kind: r.kind });
      }
      openQueue(rows, 0);
    } else {
      openQueue([{ path: item.path, kind: item.kind }]);
    }
  }

  list.addEventListener("click", (e) => {
    const r = e.target.closest(".lib-row");
    if (!r) return;
    focus = Number(r.dataset.index);
    rendered = "";
    schedule();
  });
  list.addEventListener("dblclick", (e) => {
    const r = e.target.closest(".lib-row");
    if (r) activate(Number(r.dataset.index));
  });
  list.addEventListener("keydown", (e) => {
    const total = source?.total ?? 0;
    if (!total) return;
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_H));
    const move = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -total, End: total }[e.key];
    if (move !== undefined) {
      focus = Math.max(0, Math.min(total - 1, (focus < 0 ? 0 : focus) + move));
      const top = focus * ROW_H;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight;
      rendered = "";
      schedule();
      e.preventDefault();
    } else if (e.key === "Enter" && focus >= 0) {
      activate(focus);
      e.preventDefault();
    }
  });

  // --------------------------------------------------------- playlists tab
  async function renderPlaylists() {
    const head = h("div", { class: "lib-pl-actions" },
      h("button", { type: "button", id: "lib-pl-import", class: "ps-btn", text: t("library.lists.import"), onclick: () => playlists.importFile().then(renderPlaylists) }),
      h("button", { type: "button", id: "lib-pl-save-queue", class: "ps-btn", text: t("library.lists.saveQueue"), onclick: () => playlists.saveQueue().then(renderPlaylists) }));
    let infos = [];
    try { infos = await api.playlists(); } catch (e) { console.warn("library_playlists", e); }
    const rows = infos.map((p) => h("div", { class: "lib-pl-row", "data-id": p.id },
      h("span", { class: "lib-cell lib-name", text: p.name }),
      h("span", { class: "lib-cell lib-sub", text: t("library.lists.count", { n: p.count }) }),
      h("button", { type: "button", class: "ps-btn lib-pl-open", text: t("library.lists.play"), onclick: () => playlists.openSaved(p.id, openQueue) }),
      h("button", { type: "button", class: "ps-btn lib-pl-export", text: t("library.lists.export"), onclick: () => playlists.exportSaved(p) }),
      h("button", { type: "button", class: "ps-btn lib-pl-delete", text: "✕", title: t("library.lists.delete"), onclick: async () => { await api.deletePlaylist(p.id); renderPlaylists(); } })));
    listsEl.replaceChildren(head, ...(rows.length ? rows : [h("p", { class: "lib-empty-text", text: t("library.lists.empty") })]));
  }

  // ---------------------------------------------------------- folders / menu
  async function addFolder() {
    if (!dialogOpen) return;
    const picked = await dialogOpen({ directory: true, multiple: false }).catch(() => null);
    const p = Array.isArray(picked) ? picked[0] : picked;
    if (!p) return;
    try {
      const r = await api.addFolder(p);
      app.toast?.(t(`library.toast.folder.${r.status}`, { name: r.folder.path }));
      await refreshFolders();
    } catch (e) {
      app.toast?.(`⚠️ ${String(e?.message ?? e).replace(/^\[[a-z-]+\]\s*/i, "")}`);
    }
  }
  emptyAdd.addEventListener("click", addFolder);

  async function refreshFolders() {
    try {
      const f = await api.folders();
      folderCount = f.length;
      const off = f.filter((x) => x.status !== "online").length;
      root.dataset.offline = String(off);
    } catch { folderCount = null; }
    updateEmpty();
  }

  const menu = createMenu([
    { id: "addFolder", get label() { return t("library.addFolder"); }, run: addFolder, enabled: () => !!dialogOpen },
    { id: "rescan", get label() { return t("library.rescan"); }, run: () => api.rescan().catch(() => {}) },
    { id: "cancelScan", get label() { return t("library.cancelScan"); }, run: () => api.cancelScan().catch(() => {}), enabled: () => !!scanning },
    { id: "s1", separator: true },
    { id: "settings", get label() { return t("library.settings"); }, run: () => app.settingsModal?.open("library"), enabled: () => !!app.settingsModal },
  ]);
  moreBtn.addEventListener("click", (e) => (menu.isOpen ? menu.close() : menu.openFor(e.currentTarget)));

  // ---------------------------------------------------------- controls
  for (const b of tabBtns) b.addEventListener("click", () => setTab(b.dataset.tab));
  viewSel.addEventListener("change", () => { view = viewSel.value; requery(); });
  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(requery, 150); });
  closeBtn.addEventListener("click", () => hide());
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (menu.isOpen) menu.close();
      else hide();
      e.preventDefault();
    }
    e.stopPropagation(); // player shortcuts stay off while the library is open
  });

  // ---------------------------------------------------------- backend events
  listen?.("library-scan", (e) => {
    const p = e.payload ?? {};
    scanning = p.state === "running" ? { phase: p.phase, done: p.done } : null;
    root.dataset.scanning = scanning ? "1" : "0";
    if (p.report) root.dataset.lastScan = JSON.stringify({ found: p.report.found, added: p.report.added, moved: p.report.moved, missing: p.report.missing, offline: p.report.offlineFolders });
    if (!scanning && !root.hidden) { refreshFolders(); if (tab !== "lists") requery(); }
    else renderStatus();
  });
  listen?.("library-changed", (e) => {
    for (const m of e.payload?.moves ?? []) app.library?.applyMove?.(m);
    if (e.payload?.folders) refreshFolders();
  });
  // play counts (smart lists) for files the player opened
  app.bus?.on?.("media:loaded", ({ kind } = {}) => {
    if (kind === "image") return;
    const item = app.state.get("playlist")[app.state.get("currentPlaylistIndex")];
    if (item?.path) api.markPlayed(item.path).catch(() => {});
  });
  i18n.onChange?.(() => { fillViews(); rendered = ""; schedule(); renderStatus(); });

  // ---------------------------------------------------------- show / hide
  function show(k = tab) {
    root.hidden = false;
    layer.classList.add("open");
    document.body.classList.add("lib-open");
    app.dom?.dropZone?.classList.remove("visible");
    app.studio?.isOpen && app.studio.hide();
    refreshFolders();
    setTab(k);
    requestAnimationFrame(() => (k === "lists" ? listsEl : list).focus({ preventScroll: true }));
  }
  function hide() {
    menu.close();
    root.hidden = true;
    layer.classList.remove("open");
    document.body.classList.remove("lib-open");
    if (app.state.get("currentMediaType") === "none") app.dom?.dropZone?.classList.add("visible");
  }

  // entry points: start screen, shortcut, settings
  const startBtn = h("button", { id: "btn-open-library", type: "button", class: "btn-secondary" });
  startBtn.innerHTML = `${LIBRARY_ICON} <span data-i18n="library.entry">${t("library.entry")}</span>`;
  startBtn.addEventListener("click", () => show());
  app.dom?.dropZone?.querySelector(".drop-actions")?.append(startBtn);
  app.shortcuts?.register?.({
    id: "library", scope: "global", keys: ["Ctrl+Shift+KeyL"], labelKey: "shortcuts.actions.library",
    run: () => (root.hidden ? show() : hide()),
  });
  registerLibrarySettings(app, api);
  // watcher / reconciliation options; this also starts the library worker (start-up reconciliation)
  const applyOptions = () => api.setOptions({
    watch: app.settings?.get("library.watch") !== false,
    reconcileMinutes: Number(app.settings?.get("library.reconcileMinutes") ?? 30),
  }).catch((e) => console.warn("library_set_options", e));
  (app.settings?.ready ?? Promise.resolve()).then(applyOptions);
  app.settings?.subscribe?.("library.watch", applyOptions);
  app.settings?.subscribe?.("library.reconcileMinutes", applyOptions);

  setTab("video");
  return {
    api, playlists, show, hide, openQueue, refreshFolders,
    get isOpen() { return !root.hidden; },
    get total() { return source?.total ?? null; },
  };
}
