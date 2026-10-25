// ==========================================================================
// Library storage backends for createLibrary() (library.js).
//
// In the app the library document lives in library.db (SQLite, Rust side: src-tauri/src/
// storage, docs/storage-schema.md). The first load opens/migrates the database and imports
// library.json + settings favorites once. When the database cannot be used (written by a
// newer VHO, unrecoverable damage, no backend) the library keeps working on the JSON store.
// ==========================================================================

import { t } from "./i18n.js";

/** Database adapter: { load, save, status } over the library_load / library_save commands. */
export function sqliteLibraryAdapter(invoke) {
  const a = {
    status: null,
    async load() {
      const { doc, report } = await invoke("library_load");
      a.status = { backend: "sqlite", report };
      return {
        version: 1,
        recent: doc.recent ?? [],
        resume: Object.fromEntries(doc.resume ?? []),
        bookmarks: Object.fromEntries(doc.bookmarks ?? []),
        favorites: doc.favorites ?? [],
        legacyMigrated: doc.legacyMigrated === true,
        legacyBookmarksMigrated: doc.legacyBookmarksMigrated === true,
      };
    },
    async save(doc) {
      await invoke("library_save", {
        doc: {
          recent: doc.recent ?? [],
          // insertion order matters (oldest resume position is dropped first)
          resume: Object.entries(doc.resume ?? {}),
          bookmarks: Object.entries(doc.bookmarks ?? {}),
          favorites: doc.favorites ?? [],
          legacyMigrated: doc.legacyMigrated === true,
          legacyBookmarksMigrated: doc.legacyBookmarksMigrated === true,
        },
      });
    },
  };
  return a;
}

/**
 * Uses `primary` unless its load fails; then `fallback` serves load and every save of this
 * session (the failing database is not written). status: { backend, error?, report? }.
 */
export function fallbackAdapter(primary, fallback, name = "json") {
  let active = primary;
  const a = {
    status: null,
    async load() {
      try {
        const doc = await primary.load();
        a.status = primary.status ?? { backend: "primary" };
        return doc;
      } catch (e) {
        console.error("[library] database unavailable, using the JSON store", e);
        active = fallback;
        a.status = { backend: name, error: typeof e?.code === "string" ? e.code : "unavailable", message: String(e?.message ?? e) };
        return fallback.load();
      }
    },
    save: (doc) => active.save(doc),
  };
  return a;
}

/** i18n key of the one-time notice for a storage status (null = nothing to say). */
export function storageNoticeKey(status) {
  if (!status) return null;
  if (status.error === "schemaNewer") return "storage.schemaNewer";
  if (status.error) return "storage.unavailable";
  const recovered = status.report?.recovered;
  if (recovered === "backup") return "storage.recoveredBackup";
  if (recovered === "fresh") return "storage.recoveredFresh";
  return null;
}

/** The app's library backend: library.db when the backend is there, else the JSON store. */
export function appLibraryAdapter(invoke, jsonAdapter) {
  return invoke ? fallbackAdapter(sqliteLibraryAdapter(invoke), jsonAdapter) : jsonAdapter;
}

/** Shows the storage notice once (after boot: toasts and translations are ready). */
export function announceStorageStatus(app) {
  const key = storageNoticeKey(app.library?.status);
  if (key) app.toast?.(t(key));
  return key;
}
