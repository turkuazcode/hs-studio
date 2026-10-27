//! Incremental scan / reconciliation of library folders (Plan 13/L02).
//!
//! A scan walks the chosen directories (whole library folders or, for watcher events, a few
//! directories), compares the result with the `media` rows under them and writes only the
//! differences in short transactions ([`Storage::write_batches`]):
//!
//! * unchanged file (same size + mtime, present): no write at all — scanning the same folder
//!   twice costs one directory walk;
//! * new file: first matched against rows that disappeared (same volume + file id =
//!   proven move/rename, the UUID and everything attached to it is kept), otherwise inserted;
//!   a size+mtime look-alike is never merged (see `identity::match_moved`);
//! * vanished file: `missing` (kept with its favorites/ratings/tags; it may come back);
//!   `deleted` is only set by the D1 trash action ([`super::ops`]);
//! * unreachable library folder: when the volume / share itself is gone the folder and its
//!   items become `offline` (never `missing`); when only the folder is gone, `missing`.
//!
//! Safety limits: symbolic links / junctions are not followed (no loops), depth and file
//! count are bounded, access-denied directories are reported and their known items are left
//! alone, temporary/partial files are skipped. An interrupted or truncated walk never marks
//! anything missing; a cancelled write keeps every committed batch consistent.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::storage::identity::{Candidate, FileIdentity, MoveMatch, match_moved, normalize_path};
use crate::storage::{Storage, StorageError, now_ms};

use super::ops;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_depth: usize,
    pub max_files: usize,
}

impl Default for Limits {
    fn default() -> Self {
        // deep enough for any real photo/music tree; bounded memory for a whole-disk mistake
        Limits { max_depth: 48, max_files: 400_000 }
    }
}

const BATCH: usize = 500;
const ERRORS_KEPT: usize = 20;

const VIDEO_EXT: &[&str] = &[
    "mp4", "m4v", "mkv", "avi", "mov", "webm", "flv", "ts", "m2ts", "mts", "wmv", "mpg", "mpeg", "3gp", "ogv", "vob",
    "f4v", "divx", "rmvb", "rm", "asf",
];
const AUDIO_EXT: &[&str] =
    &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif", "ape", "wv", "alac", "mka", "dsf"];
const IMAGE_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "jxl", "dng", "cr2", "cr3", "nef",
    "arw", "orf", "rw2", "raf",
];

/// Media kind of a file name by extension; None = not a media file.
pub fn media_kind_of(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    if VIDEO_EXT.contains(&ext.as_str()) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext.as_str()) {
        Some("audio")
    } else if IMAGE_EXT.contains(&ext.as_str()) {
        Some("image")
    } else {
        None
    }
}

/// Hidden, temporary or system files the scan never indexes.
pub fn is_skipped_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.starts_with('.')
        || name.starts_with("~$")
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || [".tmp", ".part", ".partial", ".crdownload", ".download", ".!ut", ".temp"].iter().any(|e| lower.ends_with(e))
}

/// One directory to (re)check. `recursive = false`: only its direct files.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Dir {
    pub path: PathBuf,
    pub recursive: bool,
}

/// A library folder and the part of it to check.
#[derive(Debug, Clone)]
pub struct Target {
    pub folder_id: String,
    pub root: PathBuf,
    /// None = the whole folder.
    pub dirs: Option<Vec<Dir>>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub folders: usize,
    pub found: usize,
    pub added: usize,
    pub updated: usize,
    pub moved: usize,
    pub missing: usize,
    pub unchanged: usize,
    pub offline_folders: usize,
    pub missing_folders: usize,
    pub skipped_links: usize,
    pub denied: usize,
    pub tags_read: usize,
    pub truncated: bool,
    pub cancelled: bool,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
    /// (old path, new path, old resume key, new resume key) of detected moves/renames.
    #[serde(skip)]
    pub moves: Vec<ops::Moved>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "walk" | "write" | "tags"
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
}

/// What a file system walk found.
#[derive(Debug, Clone)]
pub struct Found {
    pub path: String,
    pub norm: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ns: Option<i64>,
}

/// Availability of a library folder's root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootState {
    Online,
    /// The folder is gone but its volume is there (deleted / renamed by the user).
    Missing,
    /// The volume / network share / removable disk is not reachable.
    Offline,
}

/// Unix mount roots of removable / network media: an absent folder below them means the
/// medium is not mounted.
#[cfg(unix)]
const UNIX_MEDIA_ROOTS: &[&str] = &["/media/", "/mnt/", "/run/media/", "/Volumes/"];

pub fn root_state(root: &Path) -> RootState {
    if root.is_dir() {
        return RootState::Online;
    }
    #[cfg(windows)]
    {
        // drive letter ("X:\") or UNC share ("\\server\share\"): its availability decides
        let volume = root.ancestors().last().unwrap_or(root);
        if volume.is_dir() { RootState::Missing } else { RootState::Offline }
    }
    #[cfg(unix)]
    {
        let s = root.to_string_lossy();
        if UNIX_MEDIA_ROOTS.iter().any(|m| s.starts_with(m)) {
            // the mount point itself (e.g. /media/user/DISK) is absent or empty when unmounted
            let mount = root.ancestors().filter(|a| a.is_dir()).next();
            let empty = mount.and_then(|m| std::fs::read_dir(m).ok()).is_none_or(|mut r| r.next().is_none());
            if empty || !root.parent().is_some_and(Path::is_dir) {
                return RootState::Offline;
            }
        }
        RootState::Missing
    }
    #[cfg(not(any(windows, unix)))]
    {
        RootState::Offline
    }
}

fn mtime_ns(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).and_then(|d| i64::try_from(d.as_nanos()).ok())
}

struct Walk<'a> {
    limits: Limits,
    cancel: &'a AtomicBool,
    out: Vec<Found>,
    /// directories that could not be listed: their known items are not touched
    denied_dirs: Vec<String>,
    report: &'a mut ScanReport,
    seen_dirs: HashSet<String>,
}

impl Walk<'_> {
    fn error(&mut self, what: String) {
        if self.report.errors.len() < ERRORS_KEPT {
            self.report.errors.push(what);
        }
    }

    /// Walks `dir`; Err only when `dir` itself cannot be listed.
    fn walk(&mut self, dir: &Path, recursive: bool, progress: &mut dyn FnMut(Progress)) -> std::io::Result<()> {
        let mut stack = vec![(dir.to_path_buf(), 0usize)];
        let mut first = true;
        while let Some((d, depth)) = stack.pop() {
            if self.cancel.load(Ordering::Relaxed) {
                self.report.cancelled = true;
                return Ok(());
            }
            // the same directory twice (overlapping scopes) is listed once
            if !self.seen_dirs.insert(normalize_path(&d.to_string_lossy())) {
                continue;
            }
            let rd = match std::fs::read_dir(&d) {
                Ok(rd) => rd,
                Err(e) if first => return Err(e),
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::PermissionDenied {
                        self.report.denied += 1;
                    }
                    self.denied_dirs.push(normalize_path(&d.to_string_lossy()));
                    self.error(format!("{}: {e}", d.display()));
                    continue;
                }
            };
            first = false;
            for entry in rd {
                let Ok(entry) = entry else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_symlink() {
                    // symbolic links and junctions: never followed (no cycles, no escaping the folder)
                    self.report.skipped_links += 1;
                    continue;
                }
                if ft.is_dir() {
                    if recursive && !is_skipped_name(&name) {
                        if depth + 1 > self.limits.max_depth {
                            self.error(format!("{}: too deep, not scanned", entry.path().display()));
                            self.report.truncated = true;
                        } else {
                            stack.push((entry.path(), depth + 1));
                        }
                    }
                    continue;
                }
                if !ft.is_file() || is_skipped_name(&name) {
                    continue;
                }
                let Some(kind) = media_kind_of(&name) else { continue };
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() == 0 {
                    continue; // being written / placeholder
                }
                if self.out.len() >= self.limits.max_files {
                    self.report.truncated = true;
                    return Ok(());
                }
                let path = entry.path().to_string_lossy().into_owned();
                self.out.push(Found { norm: normalize_path(&path), path, name, kind, size: meta.len(), mtime_ns: mtime_ns(&meta) });
                if self.out.len() % 1000 == 0 {
                    progress(Progress { phase: "walk", done: self.out.len(), total: 0 });
                }
            }
        }
        Ok(())
    }
}

/// A `media` row as the scan needs it.
#[derive(Debug, Clone)]
struct Known {
    id: String,
    path: String,
    norm: String,
    name: String,
    size: Option<u64>,
    mtime_ns: Option<i64>,
    status: String,
    folder_id: Option<String>,
    in_library: bool,
    volume_id: Option<String>,
    file_id: Option<String>,
    content_hash: Option<String>,
}

const KNOWN_COLS: &str =
    "id, path, path_norm, name, size, mtime_ns, status, folder_id, in_library, volume_id, file_id, content_hash";

fn known_row(r: &rusqlite::Row) -> rusqlite::Result<Known> {
    Ok(Known {
        id: r.get(0)?,
        path: r.get(1)?,
        norm: r.get(2)?,
        name: r.get(3)?,
        size: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
        mtime_ns: r.get(5)?,
        status: r.get(6)?,
        folder_id: r.get(7)?,
        in_library: r.get::<_, i64>(8)? != 0,
        volume_id: r.get(9)?,
        file_id: r.get(10)?,
        content_hash: r.get(11)?,
    })
}

const SEP: char = std::path::MAIN_SEPARATOR;

/// `[prefix, end)` range of normalized paths strictly below `dir_norm`.
pub fn prefix_range(dir_norm: &str) -> (String, String) {
    let mut prefix = dir_norm.to_string();
    if !prefix.ends_with(SEP) {
        prefix.push(SEP);
    }
    let mut end = prefix.clone();
    end.pop();
    end.push(char::from_u32(SEP as u32 + 1).expect("ascii"));
    (prefix, end)
}

fn known_under(conn: &Connection, dir_norm: &str, recursive: bool) -> rusqlite::Result<Vec<Known>> {
    let (prefix, end) = prefix_range(dir_norm);
    let mut s = conn.prepare_cached(&format!(
        "SELECT {KNOWN_COLS} FROM media WHERE path_norm >= ?1 AND path_norm < ?2 AND path IS NOT NULL"
    ))?;
    let rows = s.query_map([&prefix, &end], known_row)?;
    let mut out = Vec::new();
    for r in rows {
        let k = r?;
        if recursive || !k.norm[prefix.len()..].contains(SEP) {
            out.push(k);
        }
    }
    Ok(out)
}

fn under(norm: &str, dir_norm: &str) -> bool {
    let (prefix, _) = prefix_range(dir_norm);
    norm.starts_with(&prefix)
}

enum Change {
    Insert { found: Found, ident: FileIdentity, folder_id: String },
    Touch { id: String, found: Found, ident: Option<FileIdentity>, folder_id: String, content_changed: bool },
    Move { known: Known, found: Found, ident: FileIdentity, folder_id: String },
    Missing { id: String },
    FolderState { folder_id: String, status: &'static str },
}

fn set_folder_status(tx: &Transaction, folder_id: &str, status: &str, now: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE folders SET status = ?2 WHERE id = ?1", params![folder_id, status])?;
    let media_status = if status == "offline" { "offline" } else { "missing" };
    if status != "online" {
        tx.execute(
            "UPDATE media SET status = ?2, missing_since = COALESCE(missing_since, ?3), updated_at = ?3
             WHERE folder_id = ?1 AND status IN ('present', 'offline', 'missing') AND status <> ?2",
            params![folder_id, media_status, now],
        )?;
    }
    Ok(())
}

fn apply(tx: &Transaction, change: Change, now: i64, audio: &mut Vec<String>, moves: &mut Vec<ops::Moved>) -> Result<(), StorageError> {
    match change {
        Change::Insert { found, ident, folder_id } => {
            let id = uuid::Uuid::new_v4().to_string();
            // ON CONFLICT: a row appeared meanwhile (e.g. the file was opened while scanning)
            tx.execute(
                "INSERT INTO media (id, path, path_norm, folder_id, kind, name, size, mtime_ns, volume_id, file_id,
                                    in_library, status, added_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, 'present', ?11, ?11)
                 ON CONFLICT(path_norm) DO UPDATE SET path = excluded.path, folder_id = excluded.folder_id,
                   size = excluded.size, mtime_ns = excluded.mtime_ns, in_library = 1, status = 'present',
                   missing_since = NULL, updated_at = excluded.updated_at",
                params![
                    id, found.path, found.norm, folder_id, found.kind, found.name, found.size as i64, found.mtime_ns,
                    ident.volume_id, ident.file_id, now
                ],
            )?;
            if found.kind == "audio" {
                let real: String = tx.query_row("SELECT id FROM media WHERE path_norm = ?1", [&found.norm], |r| r.get(0))?;
                audio.push(real);
            }
        }
        Change::Touch { id, found, ident, folder_id, content_changed } => {
            tx.execute(
                "UPDATE media SET path = ?2, name = ?3, size = ?4, mtime_ns = ?5, folder_id = ?6, in_library = 1,
                   status = 'present', missing_since = NULL, updated_at = ?7,
                   volume_id = COALESCE(?8, volume_id), file_id = COALESCE(?9, file_id),
                   content_hash = CASE WHEN ?10 THEN NULL ELSE content_hash END
                 WHERE id = ?1",
                params![
                    id, found.path, found.name, found.size as i64, found.mtime_ns, folder_id, now,
                    ident.as_ref().and_then(|i| i.volume_id.clone()),
                    ident.as_ref().and_then(|i| i.file_id.clone()),
                    content_changed
                ],
            )?;
            if found.kind == "audio" && content_changed {
                audio.push(id);
            }
        }
        Change::Move { known, found, ident, folder_id } => {
            // a stale row at the destination (cannot normally exist: it was not seen there)
            tx.execute("DELETE FROM media WHERE path_norm = ?1 AND id <> ?2", params![found.norm, known.id])?;
            tx.execute(
                "UPDATE media SET path = ?2, path_norm = ?3, name = ?4, size = ?5, mtime_ns = ?6, folder_id = ?7,
                   in_library = 1, status = 'present', missing_since = NULL, updated_at = ?8,
                   volume_id = ?9, file_id = ?10
                 WHERE id = ?1",
                params![
                    known.id, found.path, found.norm, found.name, found.size as i64, found.mtime_ns, folder_id, now,
                    ident.volume_id, ident.file_id
                ],
            )?;
            let moved = ops::record_move(tx, &known.id, &known.path, &found.path, now)?;
            moves.push(moved);
            if found.kind == "audio" && known.mtime_ns != found.mtime_ns {
                audio.push(known.id);
            }
        }
        Change::Missing { id } => {
            tx.execute(
                "UPDATE media SET status = 'missing', missing_since = COALESCE(missing_since, ?2), updated_at = ?2
                 WHERE id = ?1 AND status IN ('present', 'offline')",
                params![id, now],
            )?;
        }
        Change::FolderState { folder_id, status } => set_folder_status(tx, &folder_id, status, now)?,
    }
    Ok(())
}

/// Missing rows of the library that a new file may be (moves between folders / missed
/// watcher events). Bounded: a huge pile of missing rows only loses move detection.
fn missing_candidates(conn: &Connection) -> rusqlite::Result<Vec<Known>> {
    let mut s = conn.prepare(&format!(
        "SELECT {KNOWN_COLS} FROM media WHERE status = 'missing' AND path IS NOT NULL ORDER BY missing_since DESC LIMIT 20000"
    ))?;
    s.query_map([], known_row)?.collect()
}

fn candidate(k: &Known) -> Candidate {
    Candidate {
        media_id: k.id.clone(),
        name: k.name.clone(),
        size: k.size,
        mtime_ns: k.mtime_ns,
        volume_id: k.volume_id.clone(),
        file_id: k.file_id.clone(),
        content_hash: k.content_hash.clone(),
    }
}

/// Scans `targets` (one combined pass, so a file moved between two of them is recognised).
pub fn scan(
    storage: &Storage,
    targets: &[Target],
    limits: Limits,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<ScanReport, StorageError> {
    let started = Instant::now();
    let mut report = ScanReport { folders: targets.len(), ..Default::default() };
    let now = now_ms();
    let mut changes: Vec<Change> = Vec::new();
    // found files and known rows of every reachable target, by normalized path
    let mut found_all: Vec<(Found, String)> = Vec::new();
    let mut known_all: HashMap<String, Known> = HashMap::new();
    let mut gone_scopes: Vec<(String, bool)> = Vec::new(); // dirs whose unseen known rows are gone
    let mut denied: Vec<String> = Vec::new();
    let mut touched_folders: Vec<(String, usize)> = Vec::new();

    for t in targets {
        match root_state(&t.root) {
            RootState::Online => {}
            state => {
                let status = if state == RootState::Offline { "offline" } else { "missing" };
                if state == RootState::Offline {
                    report.offline_folders += 1;
                } else {
                    report.missing_folders += 1;
                }
                changes.push(Change::FolderState { folder_id: t.folder_id.clone(), status });
                continue;
            }
        }
        let dirs = t.dirs.clone().unwrap_or_else(|| vec![Dir { path: t.root.clone(), recursive: true }]);
        let mut walk = Walk {
            limits,
            cancel,
            out: Vec::new(),
            denied_dirs: Vec::new(),
            report: &mut report,
            seen_dirs: HashSet::new(),
        };
        for d in &dirs {
            if !d.path.starts_with(&t.root) && normalize_path(&d.path.to_string_lossy()) != normalize_path(&t.root.to_string_lossy()) {
                continue; // outside this folder
            }
            let dn = normalize_path(&d.path.to_string_lossy());
            match walk.walk(&d.path, d.recursive, progress) {
                Ok(()) => gone_scopes.push((dn.clone(), d.recursive)),
                // a sub directory that no longer exists: everything known below it is gone
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => gone_scopes.push((dn.clone(), true)),
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::PermissionDenied {
                        walk.report.denied += 1;
                    }
                    walk.denied_dirs.push(dn.clone());
                    walk.error(format!("{}: {e}", d.path.display()));
                }
            }
            for k in storage.read(|c| known_under(c, &dn, d.recursive))? {
                known_all.entry(k.norm.clone()).or_insert(k);
            }
        }
        let Walk { out, denied_dirs, .. } = walk;
        denied.extend(denied_dirs);
        touched_folders.push((t.folder_id.clone(), out.len()));
        found_all.extend(out.into_iter().map(|f| (f, t.folder_id.clone())));
        if report.cancelled {
            break;
        }
    }
    report.found = found_all.len();
    if report.cancelled {
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(report);
    }

    // diff
    let found_norms: HashSet<&str> = found_all.iter().map(|(f, _)| f.norm.as_str()).collect();
    let mut new_files = Vec::new();
    for (f, folder_id) in &found_all {
        match known_all.get(&f.norm) {
            Some(k) => {
                let same = k.size == Some(f.size) && k.mtime_ns == f.mtime_ns;
                let ok = same && k.status == "present" && k.in_library && k.folder_id.as_deref() == Some(folder_id) && k.path == f.path;
                if ok {
                    report.unchanged += 1;
                } else {
                    // platform id only when it was never read (cheap metadata open)
                    let ident = if k.file_id.is_none() || !same { FileIdentity::of(&f.path) } else { None };
                    changes.push(Change::Touch {
                        id: k.id.clone(),
                        found: f.clone(),
                        ident,
                        folder_id: folder_id.clone(),
                        content_changed: !same,
                    });
                    report.updated += 1;
                }
            }
            None => new_files.push((f.clone(), folder_id.clone())),
        }
    }
    let incomplete = report.truncated;
    let gone: Vec<Known> = if incomplete {
        Vec::new() // a truncated walk must not declare anything missing
    } else {
        known_all
            .values()
            .filter(|k| !found_norms.contains(k.norm.as_str()))
            .filter(|k| gone_scopes.iter().any(|(d, rec)| under(&k.norm, d) && (*rec || !k.norm[prefix_range(d).0.len()..].contains(SEP))))
            .filter(|k| !denied.iter().any(|d| under(&k.norm, d)))
            .filter(|k| k.status != "deleted")
            .cloned()
            .collect()
    };
    let mut gone_left: HashMap<String, Known> = gone.into_iter().map(|k| (k.id.clone(), k)).collect();

    if !new_files.is_empty() {
        let mut pool: Vec<Known> = gone_left.values().cloned().collect();
        if !incomplete {
            for k in storage.read(missing_candidates)? {
                if !gone_left.contains_key(&k.id) && !found_norms.contains(k.norm.as_str()) {
                    pool.push(k);
                }
            }
        }
        let mut cands: Vec<Candidate> = pool.iter().map(candidate).collect();
        let by_id: HashMap<String, Known> = pool.into_iter().map(|k| (k.id.clone(), k)).collect();
        for (i, (f, folder_id)) in new_files.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                break;
            }
            let ident = FileIdentity::of(&f.path).unwrap_or_else(|| FileIdentity {
                path_norm: f.norm.clone(),
                size: Some(f.size),
                mtime_ns: f.mtime_ns,
                ..Default::default()
            });
            let matched = if cands.is_empty() { MoveMatch::None } else { match_moved(&ident, None, &cands) };
            match matched {
                MoveMatch::Same(id) => {
                    cands.retain(|c| c.media_id != id);
                    gone_left.remove(&id);
                    let known = by_id.get(&id).cloned().expect("candidate from pool");
                    changes.push(Change::Move { known, found: f, ident, folder_id });
                    report.moved += 1;
                }
                // unproven look-alikes are new files; the old row stays missing
                MoveMatch::Ambiguous(_) | MoveMatch::None => {
                    changes.push(Change::Insert { found: f, ident, folder_id });
                    report.added += 1;
                }
            }
            if i % 1000 == 999 {
                progress(Progress { phase: "walk", done: report.found, total: report.found });
            }
        }
    }
    if report.cancelled {
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(report);
    }
    for k in gone_left.into_values() {
        if k.status != "missing" {
            changes.push(Change::Missing { id: k.id });
            report.missing += 1;
        }
    }
    for (folder_id, _) in &touched_folders {
        changes.push(Change::FolderState { folder_id: folder_id.clone(), status: "online" });
    }

    // write in short transactions; a cancel between batches keeps every committed batch
    let total = changes.len();
    let mut audio = Vec::new();
    let mut moves = Vec::new();
    let mut done = 0usize;
    let write = storage.write_batches(changes, BATCH, |tx, c| {
        if done % BATCH == 0 {
            progress(Progress { phase: "write", done, total });
            if cancel.load(Ordering::Relaxed) {
                return Err(StorageError::Other("cancelled".into()));
            }
        }
        done += 1;
        apply(tx, c, now, &mut audio, &mut moves)
    });
    match write {
        Ok(_) => {}
        Err(StorageError::Other(m)) if m == "cancelled" => {
            report.cancelled = true;
        }
        Err(e) => return Err(e),
    }
    report.moves = moves;
    if !report.cancelled {
        storage.write(|tx| {
            for (folder_id, _) in &touched_folders {
                tx.execute(
                    "UPDATE folders SET last_scan_at = ?2, scan_error = ?3,
                       file_count = (SELECT COUNT(*) FROM media WHERE folder_id = ?1 AND status = 'present')
                     WHERE id = ?1",
                    params![folder_id, now, report.errors.first()],
                )?;
            }
            Ok(())
        })?;
        report.tags_read = read_audio_tags(storage, &audio, cancel, progress)?;
    }
    report.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// Text tags of audio files (title/artist/album... for music views and FTS). Cover art is
/// not read here (the tag editor does that on demand).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct AudioMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    pub disc: Option<u32>,
    pub disc_total: Option<u32>,
    pub rg_track_gain: Option<f64>,
    pub rg_track_peak: Option<f64>,
    pub rg_album_gain: Option<f64>,
    pub rg_album_peak: Option<f64>,
    pub duration: Option<f64>,
}

/// "-6.20 dB" / "0.988" -> number.
fn parse_rg(s: Option<&str>) -> Option<f64> {
    let t = s?.trim().trim_end_matches("dB").trim_end_matches("db").trim();
    t.parse::<f64>().ok().filter(|v| v.is_finite())
}

pub fn read_audio_meta(path: &Path) -> Option<AudioMeta> {
    use lofty::config::ParseOptions;
    use lofty::prelude::*;
    use lofty::tag::ItemKey;
    let file = lofty::probe::Probe::open(path).ok()?.options(ParseOptions::new().read_cover_art(false)).read().ok()?;
    let mut m = AudioMeta { duration: Some(file.properties().duration().as_secs_f64()).filter(|d| *d > 0.0), ..Default::default() };
    if let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) {
        let text = |k: &ItemKey| tag.get_string(k).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
        m.title = tag.title().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        m.artist = tag.artist().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        m.album = tag.album().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        m.genre = tag.genre().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        m.album_artist = text(&ItemKey::AlbumArtist);
        m.year = tag.year();
        m.track = tag.track();
        m.track_total = tag.track_total();
        m.disc = tag.disk();
        m.disc_total = tag.disk_total();
        m.rg_track_gain = parse_rg(text(&ItemKey::ReplayGainTrackGain).as_deref());
        m.rg_track_peak = parse_rg(text(&ItemKey::ReplayGainTrackPeak).as_deref());
        m.rg_album_gain = parse_rg(text(&ItemKey::ReplayGainAlbumGain).as_deref());
        m.rg_album_peak = parse_rg(text(&ItemKey::ReplayGainAlbumPeak).as_deref());
    }
    Some(m)
}

pub fn store_audio_meta(tx: &Transaction, media_id: &str, m: &AudioMeta, now: i64) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO audio_tags (media_id, title, artist, album, album_artist, genre, year, track_no, track_total, disc_no,
                                 disc_total, rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, read_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(media_id) DO UPDATE SET title = excluded.title, artist = excluded.artist, album = excluded.album,
           album_artist = excluded.album_artist, genre = excluded.genre, year = excluded.year,
           track_no = excluded.track_no, track_total = excluded.track_total, disc_no = excluded.disc_no,
           disc_total = excluded.disc_total, rg_track_gain = excluded.rg_track_gain, rg_track_peak = excluded.rg_track_peak,
           rg_album_gain = excluded.rg_album_gain, rg_album_peak = excluded.rg_album_peak, read_at = excluded.read_at",
        params![
            media_id, m.title, m.artist, m.album, m.album_artist, m.genre, m.year, m.track, m.track_total, m.disc,
            m.disc_total, m.rg_track_gain, m.rg_track_peak, m.rg_album_gain, m.rg_album_peak, now
        ],
    )?;
    if let Some(d) = m.duration {
        tx.execute("UPDATE media SET duration = ?2 WHERE id = ?1", params![media_id, d])?;
    }
    Ok(())
}

fn read_audio_tags(
    storage: &Storage,
    ids: &[String],
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Progress),
) -> Result<usize, StorageError> {
    let mut n = 0;
    for (i, chunk) in ids.chunks(100).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        progress(Progress { phase: "tags", done: i * 100, total: ids.len() });
        // file reads outside the lock, one short write per chunk
        let mut read = Vec::new();
        for id in chunk {
            let path: Option<String> =
                storage.read(|c| c.query_row("SELECT path FROM media WHERE id = ?1", [id], |r| r.get(0)).optional())?.flatten();
            if let Some(m) = path.and_then(|p| read_audio_meta(Path::new(&p))) {
                read.push((id.clone(), m));
            }
        }
        let now = now_ms();
        n += read.len();
        storage.write(|tx| {
            for (id, m) in &read {
                store_audio_meta(tx, id, m, now)?;
            }
            Ok(())
        })?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_skipped_names() {
        assert_eq!(media_kind_of("a.MKV"), Some("video"));
        assert_eq!(media_kind_of("şarkı.flac"), Some("audio"));
        assert_eq!(media_kind_of("IMG_1.HEIC"), Some("image"));
        assert_eq!(media_kind_of("notes.txt"), None);
        assert_eq!(media_kind_of("noext"), None);
        for n in ["~$doc.mp4", ".hidden.mp4", "video.mp4.part", "Thumbs.db", "x.crdownload", "a.TMP"] {
            assert!(is_skipped_name(n), "{n}");
        }
        assert!(!is_skipped_name("film.mp4"));
    }

    #[test]
    fn prefix_range_is_strictly_below() {
        let (p, e) = prefix_range(&normalize_path(&std::env::temp_dir().join("lib").to_string_lossy()));
        assert!(p.ends_with(SEP));
        let child = format!("{p}a{SEP}b.mp4");
        assert!(child >= p && child < e);
        let sibling = format!("{}x{SEP}c.mp4", &p[..p.len() - 1]); // ".../libx/c.mp4"
        assert!(!(sibling >= p && sibling < e));
    }

    #[test]
    fn replaygain_text_parses() {
        assert_eq!(parse_rg(Some("-6.20 dB")), Some(-6.2));
        assert_eq!(parse_rg(Some(" 0.988 ")), Some(0.988));
        assert_eq!(parse_rg(Some("loud")), None);
        assert_eq!(parse_rg(None), None);
    }
}
