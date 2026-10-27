// ==========================================================================
// Library backend API (Plan 13/L02): library folders, the shared media query (paged, FTS),
// ratings / tags, favorite folders and saved playlists. Thin wrappers over the Rust
// commands (src-tauri/src/library) plus pure helpers used by the views and unit tests.
// ==========================================================================

/** Rows per query page (the backend caps a page at 500). */
export const PAGE_SIZE = 200;

/** Playlist file formats VHO reads and writes. */
export const PLAYLIST_EXTENSIONS = ["m3u8", "m3u", "pls"];

/** null when the backend is not there (browser / tests). */
export function createLibraryApi(invoke) {
  if (!invoke) return null;
  const call = (cmd, args) => invoke(cmd, args);
  return {
    folders: () => call("library_folders"),
    addFolder: (path) => call("library_add_folder", { path }),
    removeFolder: (id) => call("library_remove_folder", { id }),
    rescan: (folderId = null) => call("library_rescan", { folderId }),
    cancelScan: () => call("library_scan_cancel"),
    status: () => call("library_status"),
    setOptions: (options) => call("library_set_options", { options }),
    query: (query) => call("library_query", { query }),
    musicGroups: (by, search = null) => call("library_music_groups", { by, search }),
    mediaMeta: (paths) => call("library_media_meta", { paths }),
    setRating: (paths, rating) => call("library_set_rating", { paths, rating }),
    setTags: (paths, add = [], remove = []) => call("library_set_tags", { paths, add, remove }),
    tags: () => call("library_tags"),
    markPlayed: (path) => call("library_mark_played", { path }),
    folderFavorites: () => call("library_folder_favorites"),
    setFolderFavorite: (path, on) => call("library_set_folder_favorite", { path, on }),
    importFolderFavorites: (paths) => call("library_import_folder_favorites", { paths }),
    playlists: () => call("library_playlists"),
    playlist: (id) => call("library_playlist_get", { id }),
    savePlaylist: (name, items, id = null) => call("library_playlist_save", { id, name, items }),
    deletePlaylist: (id) => call("library_playlist_delete", { id }),
    importPlaylist: (path) => call("library_playlist_import", { path }),
    readPlaylist: (path) => call("library_playlist_read", { path }),
    exportPlaylist: (path, { id = null, items = null, relative = true } = {}) =>
      call("library_playlist_export", { path, id, items, relative }),
  };
}

/**
 * Page cache for a virtual list: get(index) returns a row or undefined (and loads its page
 * in the background); `onLoad(page)` fires when a page arrives. A new query = a new source,
 * so stale answers of an older query are ignored by construction.
 */
export function createPagedSource(fetchPage, { pageSize = PAGE_SIZE, onLoad = () => {}, maxPages = 50 } = {}) {
  const pages = new Map(); // page -> rows
  const loading = new Map(); // page -> promise
  let total = null;
  let disposed = false;

  function load(page) {
    if (pages.has(page) || loading.has(page)) return loading.get(page) ?? Promise.resolve(pages.get(page));
    const p = Promise.resolve(fetchPage(page * pageSize, pageSize))
      .then((res) => {
        loading.delete(page);
        if (disposed) return null;
        total = res.total;
        pages.set(page, res.items);
        // keep memory bounded on huge libraries: drop the pages farthest away
        if (pages.size > maxPages) {
          const far = [...pages.keys()].sort((a, b) => Math.abs(b - page) - Math.abs(a - page))[0];
          pages.delete(far);
        }
        onLoad(page);
        return res.items;
      })
      .catch((e) => {
        loading.delete(page);
        throw e;
      });
    loading.set(page, p);
    return p;
  }

  return {
    load,
    get(index) {
      const page = Math.floor(index / pageSize);
      const rows = pages.get(page);
      if (!rows) {
        load(page).catch(() => {});
        return undefined;
      }
      return rows[index - page * pageSize];
    },
    get total() { return total; },
    get loadedPages() { return [...pages.keys()]; },
    dispose() { disposed = true; },
  };
}

/** Index range of rows to render for a scroll position (plus overscan). */
export function visibleRange(scrollTop, viewportHeight, rowHeight, total, overscan = 8) {
  if (!total || rowHeight <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { start: Math.min(start, end), end };
}

/** Library query of a tab + view + search (shared by the video / music views). */
export function buildQuery({ kind, view = "all", search = "", sort = "", desc = false } = {}) {
  const q = { kind, view, desc };
  const s = search.trim();
  if (s) q.search = s;
  if (sort) q.sort = sort;
  if (kind === "audio" && !sort && view === "all") q.sort = "track";
  return q;
}

/** Playlist items from the current play queue ({ path | url, name }). */
export function queueToEntries(queue) {
  return (queue ?? [])
    .filter((i) => i && (i.path || i.url))
    .map((i) => (i.path ? { path: i.path, title: null } : { url: i.url, title: i.name ?? null }));
}

/** Default file name for an exported list ("Yol listesi.m3u8"); unsafe characters removed. */
export function playlistFileName(name, ext = "m3u8") {
  const base = String(name ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().slice(0, 120) || "playlist";
  return `${base}.${PLAYLIST_EXTENSIONS.includes(ext) ? ext : "m3u8"}`;
}

/** Five-star text for a rating (0/none = ""). */
export const stars = (rating) => (rating > 0 ? "★".repeat(Math.min(5, rating)) : "");

/** Parses "a, b; c" tag input into a clean, de-duplicated list (case-insensitive). */
export function parseTags(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? "").split(/[,;\n]/)) {
    const tag = raw.trim().slice(0, 64);
    const key = tag.toLocaleLowerCase("tr");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
