//! Library folders ("Kütüphaneye ekle": persistent, scanned) and favorite folders (photo
//! studio). One `folders` row per folder carries both flags. Viewing a folder once in the
//! photo studio or opening a file never adds it to the library.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::storage::identity::normalize_path;
use crate::storage::{StorageError, now_ms};

use super::scan::prefix_range;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub path: String,
    pub watched: bool,
    pub favorite: bool,
    /// online | offline | missing
    pub status: String,
    pub file_count: i64,
    pub last_scan_at: Option<i64>,
    pub scan_error: Option<String>,
}

const COLS: &str = "id, path, watched, favorite, status, file_count, last_scan_at, scan_error";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: r.get(0)?,
        path: r.get(1)?,
        watched: r.get::<_, i64>(2)? != 0,
        favorite: r.get::<_, i64>(3)? != 0,
        status: r.get(4)?,
        file_count: r.get(5)?,
        last_scan_at: r.get(6)?,
        scan_error: r.get(7)?,
    })
}

pub fn library_folders(conn: &Connection) -> rusqlite::Result<Vec<Folder>> {
    let mut s = conn.prepare(&format!("SELECT {COLS} FROM folders WHERE watched = 1 ORDER BY path COLLATE NOCASE"))?;
    s.query_map([], row)?.collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Folder>> {
    conn.query_row(&format!("SELECT {COLS} FROM folders WHERE id = ?1"), [id], row).optional()
}

/// Finds or creates the folder row of `path` (already [`clean`]ed; flags untouched for an
/// existing row).
fn ensure(tx: &Transaction, path: &str) -> rusqlite::Result<String> {
    let norm = normalize_path(path);
    if let Some(id) = tx.query_row("SELECT id FROM folders WHERE path_norm = ?1", [&norm], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO folders (id, path, path_norm, watched, favorite, added_at) VALUES (?1, ?2, ?3, 0, 0, ?4)",
        params![id, path, norm, now_ms()],
    )?;
    Ok(id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    /// "added" | "exists" (already a library folder) | "covered" (inside one)
    pub status: String,
    pub folder: Folder,
    /// Library folders inside the new one: merged into it (no longer separate).
    pub merged: Vec<String>,
}

/// Display form of a folder path: no trailing separator except for a drive / file system root.
fn clean(path: &str) -> String {
    let t = path.trim();
    let stripped = t.trim_end_matches(['\\', '/']);
    if stripped.is_empty() || stripped.ends_with(':') { format!("{stripped}{}", std::path::MAIN_SEPARATOR) } else { stripped.to_string() }
}

pub fn add(tx: &Transaction, path: &str) -> Result<AddResult, StorageError> {
    let path = clean(path);
    if !Path::new(&path).is_dir() {
        return Err(StorageError::Other(format!("[not-found] {path}")));
    }
    let norm = normalize_path(&path);
    // an existing library folder that contains this one
    for f in library_folders(tx)? {
        let fnorm = normalize_path(&f.path);
        if fnorm == norm {
            return Ok(AddResult { status: "exists".into(), folder: f, merged: vec![] });
        }
        if norm.starts_with(&prefix_range(&fnorm).0) {
            return Ok(AddResult { status: "covered".into(), folder: f, merged: vec![] });
        }
    }
    let id = ensure(tx, &path)?;
    tx.execute("UPDATE folders SET path = ?2, watched = 1, status = 'online' WHERE id = ?1", params![id, path])?;
    // library folders below the new one are merged into it (their items move on the next scan)
    let (lo, hi) = prefix_range(&norm);
    let merged: Vec<String> = {
        let mut s = tx.prepare("SELECT id FROM folders WHERE watched = 1 AND path_norm >= ?1 AND path_norm < ?2")?;
        s.query_map([&lo, &hi], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    for m in &merged {
        tx.execute("UPDATE folders SET watched = 0 WHERE id = ?1", [m])?;
        tx.execute("UPDATE media SET folder_id = ?2 WHERE folder_id = ?1", params![m, id])?;
    }
    let folder = get(tx, &id)?.expect("inserted");
    Ok(AddResult { status: "added".into(), folder, merged })
}

/// Removes a folder from the library (files on disk untouched). Index rows without user
/// data are dropped; favorites / ratings / tags / list entries / resume links are kept.
pub fn remove(tx: &Transaction, id: &str) -> Result<usize, StorageError> {
    tx.execute("UPDATE folders SET watched = 0 WHERE id = ?1", [id])?;
    let dropped = tx.execute(
        "DELETE FROM media WHERE folder_id = ?1 AND favorite = 0 AND rating IS NULL
           AND NOT EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = media.id)
           AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.media_id = media.id)
           AND NOT EXISTS (SELECT 1 FROM playlist_items p WHERE p.media_id = media.id)
           AND NOT EXISTS (SELECT 1 FROM resume_positions p WHERE p.media_id = media.id)
           AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.media_id = media.id)",
        [id],
    )?;
    tx.execute("UPDATE media SET in_library = 0, folder_id = NULL WHERE folder_id = ?1", [id])?;
    tx.execute("DELETE FROM folders WHERE id = ?1 AND favorite = 0", [id])?;
    Ok(dropped)
}

/// Favorite folders (photo studio), in the order they were added.
pub fn favorites(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut s = conn.prepare("SELECT path FROM folders WHERE favorite = 1 ORDER BY added_at, rowid")?;
    s.query_map([], |r| r.get(0))?.collect()
}

pub fn set_favorite(tx: &Transaction, path: &str, on: bool) -> Result<(), StorageError> {
    let path = clean(path);
    if on {
        let id = ensure(tx, &path)?;
        // order of favorites = order of favoriting (after every existing one, even within the same
        // millisecond as an import that stamped now + i)
        tx.execute(
            "UPDATE folders SET favorite = 1, added_at = CASE WHEN favorite = 1 THEN added_at \
             ELSE MAX(?2, (SELECT COALESCE(MAX(added_at), 0) + 1 FROM folders WHERE favorite = 1)) END WHERE id = ?1",
            params![id, now_ms()],
        )?;
    } else {
        let norm = normalize_path(&path);
        tx.execute("UPDATE folders SET favorite = 0 WHERE path_norm = ?1", [&norm])?;
        tx.execute("DELETE FROM folders WHERE path_norm = ?1 AND watched = 0 AND favorite = 0", [&norm])?;
    }
    Ok(())
}

const STUDIO_FAVORITES_KEY: &str = "legacy_studio_favorites";

/// One-time move of the photo studio favorites (`photo.studio.favorites` setting, given by
/// the frontend). Returns false when it was done before.
pub fn import_studio_favorites(tx: &Transaction, paths: &[String]) -> Result<bool, StorageError> {
    let done: bool =
        tx.query_row("SELECT 1 FROM meta WHERE key = ?1", [STUDIO_FAVORITES_KEY], |_| Ok(true)).optional()?.unwrap_or(false);
    if done {
        return Ok(false);
    }
    let base = now_ms();
    for (i, p) in paths.iter().filter(|p| !p.trim().is_empty()).enumerate() {
        let id = ensure(tx, &clean(p))?;
        tx.execute("UPDATE folders SET favorite = 1, added_at = ?2 WHERE id = ?1 AND favorite = 0", params![id, base + i as i64])?;
    }
    tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", params![STUDIO_FAVORITES_KEY, paths.len().to_string()])?;
    Ok(true)
}
