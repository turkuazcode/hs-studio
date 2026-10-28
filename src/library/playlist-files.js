// ==========================================================================
// Saved playlists and M3U / M3U8 / PLS files (Plan 05 §2, Plan 13/L02).
// The play-queue drawer gets one "⋯" button (save list, open a list file, export); saved
// lists are managed in the library's "Lists" tab. Importing a list never downloads or runs
// anything: stream URLs are only stored and played when the user picks them.
// ==========================================================================

import { t } from "../core/i18n.js";
import { dialogOpen, dialogSave } from "../core/tauri.js";
import { PLAYLIST_EXTENSIONS, playlistFileName, queueToEntries } from "../core/library-api.js";
import { createMenu } from "../studio/menu.js";

const FILTERS = () => [{ name: t("library.lists.fileType"), extensions: PLAYLIST_EXTENSIONS }];
const errText = (e) => String(e?.message ?? e).replace(/^\[[a-z-]+\]\s*/i, "");

export function createPlaylistFiles(app, api) {
  const toast = (m) => app.toast?.(m);
  const queue = () => app.state.get("playlist") ?? [];

  async function askName(value) {
    if (!app.dialogs?.prompt) return value;
    return app.dialogs.prompt({ id: "vho-playlist-name", title: t("library.lists.saveTitle"), label: t("library.lists.name"), value, okLabel: t("library.lists.save") });
  }

  /** Saves the current play queue as a library list. */
  async function saveQueue() {
    const entries = queueToEntries(queue());
    if (!entries.length) { toast(t("library.lists.queueEmpty")); return null; }
    const name = await askName(t("library.lists.defaultName"));
    if (!name) return null;
    try {
      const id = await api.savePlaylist(name, entries);
      toast(t("library.lists.saved", { name, n: entries.length }));
      return id;
    } catch (e) { toast(`⚠️ ${errText(e)}`); return null; }
  }

  async function pickListFile() {
    if (!dialogOpen) return null;
    const p = await dialogOpen({ multiple: false, filters: FILTERS() }).catch(() => null);
    return Array.isArray(p) ? p[0] : p;
  }

  /** Imports a list file into the library lists (order kept; missing files marked). */
  async function importFile(path) {
    const p = path ?? await pickListFile();
    if (!p) return null;
    try {
      const r = await api.importPlaylist(p);
      toast(t("library.lists.imported", { name: r.name, n: r.total, missing: r.missing }));
      if (r.skipped) toast(t("library.lists.skippedEntries", { n: r.skipped }));
      return r;
    } catch (e) { toast(`⚠️ ${errText(e)}`); return null; }
  }

  /** Opens a list file as the play queue without saving it. */
  async function openFile(openQueue, path) {
    const p = path ?? await pickListFile();
    if (!p) return false;
    try {
      const entries = await api.readPlaylist(p);
      return openQueue(entries.map((e) => ({ path: e.path, url: e.url, title: e.title })));
    } catch (e) { toast(`⚠️ ${errText(e)}`); return false; }
  }

  async function openSaved(id, openQueue) {
    const pl = await api.playlist(id).catch(() => null);
    if (!pl) return false;
    const missing = pl.items.filter((i) => i.missing).length;
    if (missing) toast(t("library.lists.missingItems", { n: missing }));
    return openQueue(pl.items.filter((i) => !i.missing), 0);
  }

  async function exportTo(defaultName, args) {
    if (!dialogSave) return null;
    const out = await dialogSave({ defaultPath: playlistFileName(defaultName), filters: FILTERS() }).catch(() => null);
    if (!out) return null;
    try {
      const n = await api.exportPlaylist(out, args);
      toast(t("library.lists.exported", { n }));
      return out;
    } catch (e) { toast(`⚠️ ${errText(e)}`); return null; }
  }
  const exportSaved = (info) => exportTo(info.name, { id: info.id });
  const exportQueue = () => {
    const items = queueToEntries(queue());
    if (!items.length) { toast(t("library.lists.queueEmpty")); return null; }
    return exportTo(t("library.lists.defaultName"), { items });
  };

  // "⋯" in the play-queue drawer
  const toolbar = document.querySelector("#playlist-drawer .playlist-toolbar");
  if (toolbar && api) {
    const btn = Object.assign(document.createElement("button"), { id: "btn-playlist-more", type: "button", className: "btn-ghost btn-sm", textContent: "⋯" });
    btn.title = t("library.lists.more");
    btn.dataset.i18nTitle = "library.lists.more";
    toolbar.append(btn);
    const menu = createMenu([
      { id: "saveQueue", get label() { return t("library.lists.saveQueue"); }, run: saveQueue, enabled: () => queue().some((i) => i.path || i.url) },
      { id: "openFile", get label() { return t("library.lists.openFile"); }, run: () => openFile((e, s) => app.libraryView?.openQueue(e, s)), enabled: () => !!dialogOpen },
      { id: "exportQueue", get label() { return t("library.lists.exportQueue"); }, run: exportQueue, enabled: () => !!dialogSave && queue().some((i) => i.path || i.url) },
      { id: "s1", separator: true },
      { id: "lists", get label() { return t("library.lists.manage"); }, run: () => app.libraryView?.show("lists") },
    ]);
    btn.addEventListener("click", (e) => (menu.isOpen ? menu.close() : menu.openFor(e.currentTarget)));
  }

  return { saveQueue, importFile, openFile, openSaved, exportSaved, exportQueue };
}
