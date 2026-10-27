//! Operation log for file-system changes made by the app (D1 rename / trash) and moves
//! found by scans (Plan 13/L02).
//!
//! A rename on disk and the SQLite update cannot be one atomic step. So:
//! 1. `begin` records the intent (`pending`) in its own transaction;
//! 2. the file is renamed / trashed;
//! 3. `finish_*` updates the media row (path, resume key, bookmarks) and marks the entry
//!    `done` in ONE transaction (or `fail` marks it `failed`).
//!
//! A crash between 2 and 3 leaves a `pending` entry; [`reconcile_pending`] (library start)
//! looks at the disk: old path gone and new path there = finish it, old path still there =
//! failed. Finished renames/moves also let a stale frontend document that still names the
//! old path / resume key be mapped to the new location ([`map_path`], [`map_key`]).

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::storage::identity::normalize_path;
use crate::storage::{Storage, StorageError, now_ms};

/// Finished operations kept for mapping stale documents (newest).
const OPS_KEPT: i64 = 5000;

/// A media item that changed location (sent to the frontend as `library-changed`).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub media_id: String,
    pub old_path: String,
    pub new_path: String,
    pub old_key: Option<String>,
    pub new_key: Option<String>,
}

/// The player's resume key of a local file: keep in sync with `resumeKey()` in
/// src/media/video-player.js (`vho_file_<name>_<size>`).
pub fn resume_key(name: &str, size: Option<i64>) -> String {
    format!("vho_file_{name}_{}", size.unwrap_or(0))
}

fn basename(path: &str) -> String {
    path.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

pub fn begin(conn: &Connection, op: &str, old_path: &str, new_path: Option<&str>) -> rusqlite::Result<i64> {
    let media_id: Option<String> = conn
        .query_row("SELECT id FROM media WHERE path_norm = ?1", [normalize_path(old_path)], |r| r.get(0))
        .optional()?;
    conn.execute(
        "INSERT INTO media_ops (op, media_id, old_path, old_norm, new_path, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
        params![op, media_id, old_path, normalize_path(old_path), new_path, now_ms()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn fail(conn: &Connection, op_id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE media_ops SET state = 'failed', finished_at = ?2 WHERE id = ?1", params![op_id, now_ms()]).map(|_| ())
}

/// Moves the media row at `old_path` to `new_path` (UUID kept) and carries its resume
/// position / bookmarks to the new resume key. Returns None when the old path is unknown.
fn relocate(tx: &Transaction, old_path: &str, new_path: &str, now: i64) -> rusqlite::Result<Option<Moved>> {
    let old_norm = normalize_path(old_path);
    let new_norm = normalize_path(new_path);
    let row: Option<(String, String, Option<i64>, Option<String>)> = tx
        .query_row("SELECT id, name, size, resume_key FROM media WHERE path_norm = ?1", [&old_norm], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    let Some((id, old_name, size, stored_key)) = row else { return Ok(None) };
    if old_norm != new_norm {
        // nothing exists at the destination on disk (rename checked that): a row there is stale
        tx.execute("DELETE FROM media WHERE path_norm = ?1 AND id <> ?2", params![new_norm, id])?;
    }
    let new_name = basename(new_path);
    tx.execute(
        "UPDATE media SET path = ?2, path_norm = ?3, name = ?4, status = 'present', missing_since = NULL, updated_at = ?5 WHERE id = ?1",
        params![id, new_path, new_norm, new_name, now],
    )?;
    Ok(Some(move_keys(tx, &id, old_path, new_path, &old_name, &new_name, size, stored_key)?))
}

#[allow(clippy::too_many_arguments)]
fn move_keys(
    tx: &Transaction,
    id: &str,
    old_path: &str,
    new_path: &str,
    old_name: &str,
    new_name: &str,
    size: Option<i64>,
    stored_key: Option<String>,
) -> rusqlite::Result<Moved> {
    let mut moved = Moved { media_id: id.into(), old_path: old_path.into(), new_path: new_path.into(), ..Default::default() };
    if old_name == new_name {
        return Ok(moved); // a move keeps the name: the key does not change
    }
    let old_key = stored_key.filter(|k| !k.is_empty()).unwrap_or_else(|| resume_key(old_name, size));
    if !old_key.starts_with("vho_file_") {
        return Ok(moved);
    }
    let new_key = resume_key(new_name, size);
    // the new key wins only when it has no position of its own
    tx.execute(
        "UPDATE OR IGNORE resume_positions SET key = ?2, media_id = ?3 WHERE key = ?1",
        params![old_key, new_key, id],
    )?;
    tx.execute("DELETE FROM resume_positions WHERE key = ?1", [&old_key])?;
    tx.execute("UPDATE bookmarks SET file_key = ?2, media_id = ?3 WHERE file_key = ?1", params![old_key, new_key, id])?;
    tx.execute("UPDATE media SET resume_key = ?2 WHERE id = ?1 AND resume_key IS NOT NULL", params![id, new_key])?;
    moved.old_key = Some(old_key);
    moved.new_key = Some(new_key);
    Ok(moved)
}

/// A scan found the row `media_id` at a new location (the row is already updated).
pub fn record_move(tx: &Transaction, media_id: &str, old_path: &str, new_path: &str, now: i64) -> rusqlite::Result<Moved> {
    let (size, key): (Option<i64>, Option<String>) =
        tx.query_row("SELECT size, resume_key FROM media WHERE id = ?1", [media_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let moved = move_keys(tx, media_id, old_path, new_path, &basename(old_path), &basename(new_path), size, key)?;
    tx.execute(
        "INSERT INTO media_ops (op, media_id, old_path, old_norm, new_path, old_key, new_key, state, created_at, finished_at)
         VALUES ('move', ?1, ?2, ?3, ?4, ?5, ?6, 'done', ?7, ?7)",
        params![media_id, old_path, normalize_path(old_path), new_path, moved.old_key, moved.new_key, now],
    )?;
    Ok(moved)
}

pub fn finish_rename(tx: &Transaction, op_id: i64, old_path: &str, new_path: &str) -> rusqlite::Result<Option<Moved>> {
    let now = now_ms();
    let moved = relocate(tx, old_path, new_path, now)?;
    tx.execute(
        "UPDATE media_ops SET state = 'done', new_path = ?2, media_id = COALESCE(media_id, ?3), old_key = ?4, new_key = ?5, finished_at = ?6 WHERE id = ?1",
        params![
            op_id,
            new_path,
            moved.as_ref().map(|m| m.media_id.clone()),
            moved.as_ref().and_then(|m| m.old_key.clone()),
            moved.as_ref().and_then(|m| m.new_key.clone()),
            now
        ],
    )?;
    Ok(moved)
}

pub fn finish_trash(tx: &Transaction, op_id: i64, path: &str) -> rusqlite::Result<()> {
    let now = now_ms();
    tx.execute(
        "UPDATE media SET status = 'deleted', missing_since = COALESCE(missing_since, ?2), updated_at = ?2 WHERE path_norm = ?1",
        params![normalize_path(path), now],
    )?;
    tx.execute("UPDATE media_ops SET state = 'done', finished_at = ?2 WHERE id = ?1", params![op_id, now])?;
    Ok(())
}

/// Resolves pending operations left by a crash between the disk change and the database
/// update. Returns (finished, failed).
pub fn reconcile_pending(storage: &Storage) -> Result<(usize, usize, Vec<Moved>), StorageError> {
    let pending: Vec<(i64, String, String, Option<String>)> = storage.read(|c| {
        let mut s = c.prepare("SELECT id, op, old_path, new_path FROM media_ops WHERE state = 'pending' ORDER BY id")?;
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect()
    })?;
    let (mut done, mut failed, mut moves) = (0, 0, Vec::new());
    for (id, op, old, new) in pending {
        let old_there = Path::new(&old).exists();
        storage.write(|tx| {
            match (op.as_str(), new.as_deref()) {
                ("trash", _) if !old_there => {
                    finish_trash(tx, id, &old)?;
                    done += 1;
                }
                ("rename" | "move", Some(n)) if !old_there && Path::new(n).exists() => {
                    if let Some(m) = finish_rename(tx, id, &old, n)? {
                        moves.push(m);
                    }
                    done += 1;
                }
                _ => {
                    fail(tx, id)?;
                    failed += 1;
                }
            }
            Ok(())
        })?;
    }
    storage.write(|tx| {
        tx.execute(
            "DELETE FROM media_ops WHERE state <> 'pending' AND id <= (SELECT MAX(id) FROM media_ops) - ?1",
            [OPS_KEPT],
        )?;
        Ok(())
    })?;
    Ok((done, failed, moves))
}

/// The current path of a file the document still names by an old path (renamed/moved
/// meanwhile). None when the path is current (or unknown).
pub fn map_path(conn: &Connection, path: &str) -> rusqlite::Result<Option<String>> {
    let mut norm = normalize_path(path);
    let mut out = None;
    for _ in 0..8 {
        let present: bool = conn
            .query_row("SELECT 1 FROM media WHERE path_norm = ?1 AND status IN ('present', 'offline')", [&norm], |_| Ok(true))
            .optional()?
            .unwrap_or(false);
        if present {
            break;
        }
        let next: Option<String> = conn
            .query_row(
                "SELECT new_path FROM media_ops WHERE old_norm = ?1 AND state = 'done' AND op IN ('rename', 'move') AND new_path IS NOT NULL ORDER BY id DESC LIMIT 1",
                [&norm],
                |r| r.get(0),
            )
            .optional()?;
        match next {
            Some(n) if normalize_path(&n) != norm => {
                norm = normalize_path(&n);
                out = Some(n);
            }
            _ => break,
        }
    }
    Ok(out)
}

/// The current resume key for a key renamed meanwhile (see [`map_path`]).
pub fn map_key(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut cur = key.to_string();
    let mut out = None;
    for _ in 0..8 {
        let in_use: bool =
            conn.query_row("SELECT 1 FROM media WHERE resume_key = ?1", [&cur], |_| Ok(true)).optional()?.unwrap_or(false);
        if in_use {
            break;
        }
        let next: Option<String> = conn
            .query_row(
                "SELECT new_key FROM media_ops WHERE old_key = ?1 AND state = 'done' AND new_key IS NOT NULL ORDER BY id DESC LIMIT 1",
                [&cur],
                |r| r.get(0),
            )
            .optional()?;
        match next {
            Some(n) if n != cur => {
                cur = n.clone();
                out = Some(n);
            }
            _ => break,
        }
    }
    Ok(out)
}
