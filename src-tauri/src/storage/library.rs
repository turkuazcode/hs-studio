//! Library document (recent files, resume positions, bookmarks, favorites) on top of the
//! shared schema, plus the one-time import of the pre-database JSON stores:
//!
//! * `library.json` (tauri-plugin-store, key "library"): recent list + resume positions;
//! * `settings.json` (key "settings"): `actions.favorites` (Plan 06 favorites).
//!
//! The import runs once (marker `meta.legacy_json_import`), in one transaction that is
//! verified before commit; the JSON files are copied to `backups/` first and never deleted.
//! An interrupted import leaves no marker and simply runs again on the next start.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::identity::{FileIdentity, normalize_path};
use super::{Storage, StorageError, backup_file, now_ms};

/// Same caps as src/core/library.js.
pub const RECENT_MAX: usize = 20;
pub const RESUME_MAX: usize = 500;
/// Upper bound for bookmarks of one file (the UI adds them one by one).
const BOOKMARKS_PER_FILE_MAX: usize = 500;

const IMPORT_KEY: &str = "legacy_json_import";
const LS_RESUME_KEY: &str = "legacy_localstorage_resume";
const LS_BOOKMARKS_KEY: &str = "legacy_localstorage_bookmarks";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentEntry {
    pub id: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub duration: f64,
    pub resume_key: String,
    pub thumb: String,
    pub opened_at: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Bookmark {
    pub time: f64,
    pub label: String,
}

/// The document exchanged with src/core/library.js (`resume` / `bookmarks` as ordered pairs).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryDoc {
    pub recent: Vec<RecentEntry>,
    pub resume: Vec<(String, f64)>,
    pub bookmarks: Vec<(String, Vec<Bookmark>)>,
    pub favorites: Vec<String>,
    /// localStorage resume positions already moved (older builds).
    pub legacy_migrated: bool,
    /// localStorage bookmarks (`vho_bm_*`) already moved.
    pub legacy_bookmarks_migrated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub recent: usize,
    pub resume: usize,
    pub favorites: usize,
    /// Copies of the JSON files made before the import.
    pub backups: Vec<String>,
    pub warnings: Vec<String>,
}

fn media_kind(kind: &str) -> &'static str {
    match kind {
        "audio" => "audio",
        "image" => "image",
        "video" => "video",
        _ => "other",
    }
}

/// Kind from the file extension (favorites carry only a path).
fn guess_kind(path: &str) -> &'static str {
    let ext = Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    const AUDIO: &[&str] = &["mp3", "flac", "wav", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif", "ape", "wv", "alac"];
    const IMAGE: &[&str] =
        &["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico", "tga", "dng", "cr2", "nef", "arw"];
    if AUDIO.contains(&ext.as_str()) {
        "audio"
    } else if IMAGE.contains(&ext.as_str()) {
        "image"
    } else {
        "video"
    }
}

fn basename(path: &str) -> String {
    path.rsplit(['\\', '/']).find(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// Finds or creates the media row of a local path or URL and returns its UUID.
/// The path spelling is updated; the identity (UUID) never changes for the same location.
pub fn upsert_media(
    conn: &Connection,
    path: Option<&str>,
    url: Option<&str>,
    kind: Option<&str>,
    name: Option<&str>,
) -> Result<String, StorageError> {
    let now = now_ms();
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        let norm = normalize_path(path);
        let found: Option<String> =
            conn.query_row("SELECT id FROM media WHERE path_norm = ?1", [&norm], |r| r.get(0)).optional()?;
        if let Some(id) = found {
            // a file marked missing/deleted that is opened again from that path is back (L02)
            let back = Path::new(path).is_file();
            conn.execute(
                "UPDATE media SET path = ?2, name = COALESCE(?3, name), kind = COALESCE(?4, kind), updated_at = ?5,
                   status = CASE WHEN ?6 AND status IN ('missing', 'deleted') THEN 'present' ELSE status END,
                   missing_since = CASE WHEN ?6 AND status IN ('missing', 'deleted') THEN NULL ELSE missing_since END
                 WHERE id = ?1",
                params![id, path, name, kind.map(media_kind), now, back],
            )?;
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let ident = FileIdentity::of(path).unwrap_or_default();
        conn.execute(
            "INSERT INTO media (id, path, path_norm, kind, name, size, mtime_ns, volume_id, file_id, added_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                path,
                norm,
                kind.map(media_kind).unwrap_or_else(|| guess_kind(path)),
                name.map(str::to_string).unwrap_or_else(|| basename(path)),
                ident.size.map(|s| s as i64),
                ident.mtime_ns,
                ident.volume_id,
                ident.file_id,
                now
            ],
        )?;
        return Ok(id);
    }
    let url = url.filter(|u| !u.is_empty()).ok_or_else(|| StorageError::Other("media needs a path or a URL".into()))?;
    let found: Option<String> = conn.query_row("SELECT id FROM media WHERE url = ?1", [url], |r| r.get(0)).optional()?;
    if let Some(id) = found {
        conn.execute(
            "UPDATE media SET name = COALESCE(?2, name), kind = COALESCE(?3, kind), updated_at = ?4 WHERE id = ?1",
            params![id, name, kind.map(media_kind), now],
        )?;
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO media (id, url, kind, name, added_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, url, kind.map(media_kind).unwrap_or("video"), name.unwrap_or(url), now],
    )?;
    Ok(id)
}

fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map(|_| ())
}

const MEDIA_BY_RESUME_KEY: &str = "(SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) END FROM media WHERE resume_key = ?1)";

/// Reads the whole library document.
pub fn load_doc(conn: &Connection) -> rusqlite::Result<LibraryDoc> {
    let mut doc = LibraryDoc::default();
    let mut s = conn.prepare(
        "SELECT m.path, m.url, m.name, m.kind, m.duration, m.resume_key, m.thumb, r.opened_at
         FROM recent r JOIN media m ON m.id = r.media_id ORDER BY r.position",
    )?;
    doc.recent = s
        .query_map([], |r| {
            let path: Option<String> = r.get(0)?;
            let url: Option<String> = r.get(1)?;
            let kind: String = r.get(3)?;
            Ok(RecentEntry {
                id: path.clone().or_else(|| url.clone()).unwrap_or_default(),
                url: if path.is_some() { None } else { url },
                path,
                name: r.get(2)?,
                kind: if kind == "other" { "video".into() } else { kind },
                duration: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                resume_key: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                thumb: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                opened_at: r.get::<_, i64>(7)? as f64,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut s = conn.prepare("SELECT key, seconds FROM resume_positions ORDER BY seq")?;
    doc.resume = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let mut s = conn.prepare("SELECT file_key, time, label FROM bookmarks ORDER BY file_key, time, id")?;
    let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, Bookmark { time: r.get(1)?, label: r.get(2)? })))?;
    for row in rows {
        let (key, b) = row?;
        match doc.bookmarks.last_mut() {
            Some((k, list)) if *k == key => list.push(b),
            _ => doc.bookmarks.push((key, vec![b])),
        }
    }
    let mut s = conn.prepare(
        "SELECT path FROM media WHERE favorite = 1 AND path IS NOT NULL ORDER BY favorited_at, rowid",
    )?;
    doc.favorites = s.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    doc.legacy_migrated = meta_get(conn, LS_RESUME_KEY)?.is_some();
    doc.legacy_bookmarks_migrated = meta_get(conn, LS_BOOKMARKS_KEY)?.is_some();
    Ok(doc)
}

/// Replaces the library document (call inside one transaction: `Storage::write`).
/// Media rows are kept (their UUIDs stay stable); only list membership changes.
pub fn save_doc(conn: &Connection, doc: &LibraryDoc) -> Result<(), StorageError> {
    let now = now_ms();
    // L02: a document written before it heard of a rename/move (old path / resume key) is
    // mapped to the current location instead of re-creating the old one
    let doc = &remap_moved(conn, doc)?;

    conn.execute("DELETE FROM recent", [])?;
    let mut seen = HashSet::new();
    for e in &doc.recent {
        if seen.len() >= RECENT_MAX * 5 {
            break;
        }
        let id = match upsert_media(conn, e.path.as_deref(), e.url.as_deref().or(Some(&e.id)), Some(&e.kind), Some(&e.name)) {
            Ok(id) => id,
            Err(StorageError::Other(_)) => continue, // neither path nor URL
            Err(err) => return Err(err),
        };
        if !seen.insert(id.clone()) {
            continue; // the same file under two spellings
        }
        conn.execute(
            "UPDATE media SET duration = CASE WHEN ?2 > 0 THEN ?2 ELSE duration END,
                              thumb = COALESCE(NULLIF(?3, ''), thumb),
                              resume_key = COALESCE(NULLIF(?4, ''), resume_key)
             WHERE id = ?1",
            params![id, e.duration, e.thumb, e.resume_key],
        )?;
        let opened = if e.opened_at.is_finite() && e.opened_at > 0.0 { e.opened_at as i64 } else { 0 };
        conn.execute("INSERT INTO recent (media_id, position, opened_at) VALUES (?1, ?2, ?3)", params![id, (seen.len() - 1) as i64, opened])?;
    }

    conn.execute("DELETE FROM resume_positions", [])?;
    let valid: Vec<_> =
        doc.resume.iter().filter(|(k, s)| !k.is_empty() && s.is_finite() && *s > 0.0).collect();
    let skip = valid.len().saturating_sub(RESUME_MAX);
    for (seq, (key, seconds)) in valid.into_iter().skip(skip).enumerate() {
        conn.execute(
            &format!(
                "INSERT INTO resume_positions (key, media_id, seconds, seq, updated_at) VALUES (?1, {MEDIA_BY_RESUME_KEY}, ?2, ?3, ?4)
                 ON CONFLICT(key) DO UPDATE SET seconds = excluded.seconds, seq = excluded.seq"
            ),
            params![key, seconds, seq as i64, now],
        )?;
    }

    conn.execute("DELETE FROM bookmarks", [])?;
    for (key, list) in &doc.bookmarks {
        if key.is_empty() {
            continue;
        }
        for b in list.iter().filter(|b| b.time.is_finite() && b.time >= 0.0).take(BOOKMARKS_PER_FILE_MAX) {
            conn.execute(
                &format!(
                    "INSERT INTO bookmarks (file_key, media_id, time, label, created_at) VALUES (?1, {MEDIA_BY_RESUME_KEY}, ?2, ?3, ?4)"
                ),
                params![key, b.time, b.label, now],
            )?;
        }
    }

    // favorites: keep the first favorited_at of an existing favorite, append new ones in order
    let old: HashMap<String, i64> = {
        let mut s = conn.prepare("SELECT id, favorited_at FROM media WHERE favorite = 1")?;
        s.query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))))?.collect::<Result<_, _>>()?
    };
    conn.execute("UPDATE media SET favorite = 0, favorited_at = NULL WHERE favorite = 1", [])?;
    for (i, path) in doc.favorites.iter().filter(|p| !p.is_empty()).enumerate() {
        let id = upsert_media(conn, Some(path), None, None, None)?;
        let at = old.get(&id).copied().unwrap_or(now + i as i64);
        conn.execute("UPDATE media SET favorite = 1, favorited_at = ?2 WHERE id = ?1", params![id, at])?;
    }

    if doc.legacy_migrated {
        meta_set(conn, LS_RESUME_KEY, &now.to_string())?;
    }
    if doc.legacy_bookmarks_migrated {
        meta_set(conn, LS_BOOKMARKS_KEY, &now.to_string())?;
    }
    Ok(())
}

/// Applies finished renames/moves (operation log, L02) to a stale document.
fn remap_moved(conn: &Connection, doc: &LibraryDoc) -> Result<LibraryDoc, StorageError> {
    use crate::library::ops::{map_key, map_path};
    let mut d = doc.clone();
    for e in &mut d.recent {
        if let Some(p) = e.path.as_deref() {
            if let Some(n) = map_path(conn, p)? {
                e.id = n.clone();
                e.name = basename(&n);
                e.path = Some(n);
                if let Some(k) = map_key(conn, &e.resume_key)? {
                    e.resume_key = k;
                }
            }
        }
    }
    for p in &mut d.favorites {
        if let Some(n) = map_path(conn, p)? {
            *p = n;
        }
    }
    let mut resume = Vec::with_capacity(d.resume.len());
    for (k, v) in d.resume {
        let k = map_key(conn, &k)?.unwrap_or(k);
        resume.retain(|(old, _): &(String, f64)| *old != k);
        resume.push((k, v));
    }
    d.resume = resume;
    let mut bookmarks: Vec<(String, Vec<Bookmark>)> = Vec::with_capacity(d.bookmarks.len());
    for (k, list) in d.bookmarks {
        let k = map_key(conn, &k)?.unwrap_or(k);
        match bookmarks.iter_mut().find(|(old, _)| *old == k) {
            Some((_, l)) if l.is_empty() => *l = list,
            Some(_) => {}
            None => bookmarks.push((k, list)),
        }
    }
    d.bookmarks = bookmarks;
    Ok(d)
}

// --------------------------------------------------------------------------------------
// One-time import of the JSON stores
// --------------------------------------------------------------------------------------

/// A JSON object read as ordered (key, value) pairs; anything else reads as empty.
#[derive(Default)]
struct Ordered(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Ordered, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Ordered(out))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut s: A) -> Result<Ordered, A::Error> {
                while s.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(Ordered::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// library.json read only for the resume object, in file order (serde_json::Value sorts keys).
#[derive(Deserialize)]
struct ResumeFile {
    library: ResumeInner,
}

#[derive(Deserialize)]
struct ResumeInner {
    #[serde(default)]
    resume: Ordered,
}

/// Same rules as `sanitizeRecent` in src/core/library.js.
fn sanitize_recent(list: Option<&Value>) -> Vec<RecentEntry> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for e in list.and_then(Value::as_array).into_iter().flatten() {
        let Some(o) = e.as_object() else { continue };
        let (Some(id), Some(name)) = (o.get("id").and_then(Value::as_str), o.get("name").and_then(Value::as_str)) else {
            continue;
        };
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
        let kind = s("type").filter(|t| ["video", "audio", "image"].contains(&t.as_str())).unwrap_or_else(|| "video".into());
        let path = s("path");
        out.push(RecentEntry {
            id: id.to_string(),
            url: if path.is_some() { None } else { s("url").or_else(|| Some(id.to_string())) },
            path,
            name: name.to_string(),
            kind,
            duration: o.get("duration").and_then(Value::as_f64).filter(|d| d.is_finite()).unwrap_or(0.0),
            resume_key: s("resumeKey").unwrap_or_default(),
            thumb: s("thumb").unwrap_or_default(),
            opened_at: o.get("openedAt").and_then(Value::as_f64).filter(|d| d.is_finite()).unwrap_or(0.0),
        });
        if out.len() >= RECENT_MAX {
            break;
        }
    }
    out
}

fn read_json(path: &Path, warnings: &mut Vec<String>) -> Option<Vec<u8>> {
    if !path.is_file() {
        return None;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // one retry: the settings store may be writing the file right now
    for attempt in 0..2 {
        match std::fs::read(path) {
            Ok(bytes) if serde_json::from_slice::<Value>(&bytes).is_ok() => return Some(bytes),
            Ok(_) if attempt == 0 => std::thread::sleep(std::time::Duration::from_millis(250)),
            Ok(_) => warnings.push(format!("{name}: not valid JSON, skipped (a copy is in backups)")),
            Err(e) if attempt == 0 => {
                let _ = e;
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => warnings.push(format!("{name}: {e}")),
        }
    }
    None
}

/// Reads library.json + settings.json of `dir` into a document (missing files = empty).
pub fn read_legacy(dir: &Path, warnings: &mut Vec<String>) -> LibraryDoc {
    let mut doc = LibraryDoc::default();
    if let Some(bytes) = read_json(&dir.join("library.json"), warnings) {
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let lib = v.get("library");
        doc.recent = sanitize_recent(lib.and_then(|l| l.get("recent")));
        // resume keeps its insertion order (oldest first = dropped first)
        let pairs: Vec<(String, Value)> = match serde_json::from_slice::<ResumeFile>(&bytes) {
            Ok(f) => f.library.resume.0,
            Err(_) => lib
                .and_then(|l| l.get("resume"))
                .and_then(Value::as_object)
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
        };
        doc.resume =
            pairs.into_iter().filter_map(|(k, v)| v.as_f64().filter(|t| t.is_finite() && *t > 0.0).map(|t| (k, t))).collect();
        doc.legacy_migrated = lib.and_then(|l| l.get("legacyMigrated")).and_then(Value::as_bool) == Some(true);
    }
    if let Some(bytes) = read_json(&dir.join("settings.json"), warnings) {
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let paths = v.pointer("/settings/values/actions.favorites/paths").and_then(Value::as_array);
        let mut seen = HashSet::new();
        doc.favorites = paths
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|p| !p.is_empty() && seen.insert(normalize_path(p)))
            .map(str::to_string)
            .collect();
    }
    doc
}

/// Current DB content first, legacy entries that are not there yet after it.
fn merge(current: LibraryDoc, legacy: &LibraryDoc) -> LibraryDoc {
    let mut out = current;
    let norm = |e: &RecentEntry| e.path.as_deref().map(normalize_path).unwrap_or_else(|| e.id.clone());
    let have: HashSet<String> = out.recent.iter().map(norm).collect();
    for e in &legacy.recent {
        if out.recent.len() < RECENT_MAX && !have.contains(&norm(e)) {
            out.recent.push(e.clone());
        }
    }
    let have: HashSet<String> = out.resume.iter().map(|(k, _)| k.clone()).collect();
    let mut resume: Vec<_> = legacy.resume.iter().filter(|(k, _)| !have.contains(k)).cloned().collect();
    resume.append(&mut out.resume); // DB values are newer: they stay last (dropped last)
    out.resume = resume;
    let have: HashSet<String> = out.favorites.iter().map(|p| normalize_path(p)).collect();
    out.favorites.extend(legacy.favorites.iter().filter(|p| !have.contains(&normalize_path(p))).cloned());
    out.legacy_migrated |= legacy.legacy_migrated;
    out
}

/// Every legacy item that should be in the database is there with the same value.
fn verify(expected: &LibraryDoc, legacy: &LibraryDoc, got: &LibraryDoc) -> Result<(), StorageError> {
    let norm = |e: &RecentEntry| e.path.as_deref().map(normalize_path).unwrap_or_else(|| e.id.clone());
    let got_recent: HashSet<String> = got.recent.iter().map(norm).collect();
    for e in expected.recent.iter().filter(|e| legacy.recent.contains(e)) {
        if !got_recent.contains(&norm(e)) {
            return Err(StorageError::ImportVerify(format!("recent entry missing: {}", e.name)));
        }
    }
    let got_resume: HashMap<&str, f64> = got.resume.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    let kept = expected.resume.len().saturating_sub(RESUME_MAX);
    for (k, v) in expected.resume.iter().skip(kept) {
        if got_resume.get(k.as_str()) != Some(v) {
            return Err(StorageError::ImportVerify(format!("resume position missing: {k}")));
        }
    }
    let got_fav: HashSet<String> = got.favorites.iter().map(|p| normalize_path(p)).collect();
    for p in &legacy.favorites {
        if !got_fav.contains(&normalize_path(p)) {
            return Err(StorageError::ImportVerify(format!("favorite missing: {p}")));
        }
    }
    if legacy.legacy_migrated && !got.legacy_migrated {
        return Err(StorageError::ImportVerify("legacyMigrated flag lost".into()));
    }
    Ok(())
}

/// One-time import of library.json / settings.json favorites (None when already done).
pub fn import_legacy(storage: &Storage, dir: &Path) -> Result<Option<ImportReport>, StorageError> {
    if storage.read(|c| meta_get(c, IMPORT_KEY))?.is_some() {
        return Ok(None);
    }
    let mut report = ImportReport::default();
    let legacy = read_legacy(dir, &mut report.warnings);
    for name in ["library.json", "settings.json"] {
        if let Some(p) = backup_file(dir, &dir.join(name))? {
            report.backups.push(p.to_string_lossy().into_owned());
        }
    }
    report.recent = legacy.recent.len();
    report.resume = legacy.resume.len();
    report.favorites = legacy.favorites.len();
    let marker = serde_json::to_string(&report).unwrap_or_default();
    storage.write(|tx| {
        let current = load_doc(tx)?;
        let expected = merge(current, &legacy);
        save_doc(tx, &expected)?;
        verify(&expected, &legacy, &load_doc(tx)?)?;
        meta_set(tx, IMPORT_KEY, &marker)?;
        Ok(())
    })?;
    Ok(Some(report))
}

#[cfg(test)]
mod tests {
    use super::super::{DB_FILE, Storage, list_backups, tests::temp_dir};
    use super::*;
    use serde_json::json;

    /// Synthetic "old format" data as written by the pre-database builds.
    fn write_old_format(dir: &Path) -> (Value, Value) {
        let lib = json!({ "library": {
            "version": 1,
            "recent": [
                { "id": "C:\\Videolar\\Tatil ğüş.mp4", "path": "C:\\Videolar\\Tatil ğüş.mp4", "name": "Tatil ğüş.mp4", "type": "video",
                  "duration": 125.5, "resumeKey": "vho_file_Tatil ğüş.mp4_1000", "thumb": "data:image/jpeg;base64,AAA", "openedAt": 1700000002000u64 },
                { "id": "https://example.invalid/live.m3u8", "url": "https://example.invalid/live.m3u8", "name": "live.m3u8", "type": "video",
                  "duration": 0, "resumeKey": "vho_url_https://example.invalid/live.m3u8", "thumb": "", "openedAt": 1700000001000u64 },
                { "id": "C:\\Foto\\a.jpg", "path": "C:\\Foto\\a.jpg", "name": "a.jpg", "type": "image", "duration": 0, "resumeKey": "", "thumb": "", "openedAt": 1700000000000u64 },
                { "broken": true },
                { "id": "C:\\Foto\\a.jpg", "name": "duplicate" }
            ],
            // insertion order: z first, a last (not alphabetical)
            "resume": {}, // written below in file order (json! would sort the keys)
            "legacyMigrated": true
        }});
        let settings = json!({ "settings": { "version": 1, "values": {
            "sleep.pcSleep": false,
            "actions.favorites": { "paths": ["C:\\Muzik\\şarkı.mp3", "C:\\Videolar\\Tatil ğüş.mp4", ""] }
        }}});
        let text = serde_json::to_string_pretty(&lib).unwrap().replace(
            "\"resume\": {}",
            r#""resume": { "vho_file_z.mkv_1": 30.5, "vho_file_Tatil ğüş.mp4_1000": 61.2, "bad": -1, "vho_file_a.mkv_2": 9 }"#,
        );
        assert!(text.contains("vho_file_z.mkv_1"));
        std::fs::write(dir.join("library.json"), text).unwrap();
        std::fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(&settings).unwrap()).unwrap();
        (lib, settings)
    }

    #[test]
    fn imports_old_library_and_favorites_once() {
        let dir = temp_dir("import");
        write_old_format(&dir);
        let lib_before = std::fs::read(dir.join("library.json")).unwrap();
        let set_before = std::fs::read(dir.join("settings.json")).unwrap();

        let s = Storage::open(&dir).unwrap();
        let rep = s.report.imported.clone().expect("imported");
        assert_eq!((rep.recent, rep.resume, rep.favorites), (3, 3, 2));
        assert_eq!(rep.backups.len(), 2);
        for b in &rep.backups {
            let b = Path::new(b);
            assert!(b.exists());
            let orig = if b.file_name().unwrap().to_string_lossy().starts_with("library") { &lib_before } else { &set_before };
            assert_eq!(&std::fs::read(b).unwrap(), orig, "backup is a byte copy");
        }
        let doc = s.read(load_doc).unwrap();
        assert_eq!(doc.recent.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Tatil ğüş.mp4", "live.m3u8", "a.jpg"]);
        assert_eq!(doc.recent[0].duration, 125.5);
        assert_eq!(doc.recent[0].thumb, "data:image/jpeg;base64,AAA");
        assert_eq!(doc.recent[0].opened_at, 1700000002000.0);
        assert_eq!(doc.recent[1].url.as_deref(), Some("https://example.invalid/live.m3u8"));
        assert_eq!(doc.recent[1].path, None);
        assert_eq!(doc.recent[2].kind, "image");
        assert_eq!(
            doc.resume,
            vec![
                ("vho_file_z.mkv_1".to_string(), 30.5),
                ("vho_file_Tatil ğüş.mp4_1000".to_string(), 61.2),
                ("vho_file_a.mkv_2".to_string(), 9.0)
            ],
            "insertion order kept, invalid dropped"
        );
        assert_eq!(doc.favorites, ["C:\\Muzik\\şarkı.mp3", "C:\\Videolar\\Tatil ğüş.mp4"]);
        assert!(doc.legacy_migrated);
        // the favorite video and the recent video are one media row
        let n: i64 = s.read(|c| c.query_row("SELECT COUNT(*) FROM media", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 4);
        // resume linked to its media row through the resume key
        let linked: Option<String> = s
            .read(|c| c.query_row("SELECT media_id FROM resume_positions WHERE key = 'vho_file_Tatil ğüş.mp4_1000'", [], |r| r.get(0)))
            .unwrap();
        assert!(linked.is_some());
        drop(s);

        // old files untouched
        assert_eq!(std::fs::read(dir.join("library.json")).unwrap(), lib_before);
        assert_eq!(std::fs::read(dir.join("settings.json")).unwrap(), set_before);

        // re-run: idempotent, no second import, no duplicates even if the JSON changes later
        let mut changed: Value = serde_json::from_slice(&lib_before).unwrap();
        changed["library"]["recent"] = json!([]);
        std::fs::write(dir.join("library.json"), serde_json::to_vec(&changed).unwrap()).unwrap();
        let s = Storage::open(&dir).unwrap();
        assert!(s.report.imported.is_none());
        let again = s.read(load_doc).unwrap();
        assert_eq!(again, doc);
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn interrupted_import_leaves_no_marker_and_reruns() {
        let dir = temp_dir("interrupt");
        write_old_format(&dir);
        let s = Storage::open(&dir).unwrap();
        // the state a crash inside the import transaction leaves: schema, no data, no marker
        // (SQLite rolls the open transaction back on the next open)
        s.write(|tx| {
            tx.execute("DELETE FROM meta", [])?;
            tx.execute("DELETE FROM recent", [])?;
            tx.execute("DELETE FROM resume_positions", [])?;
            tx.execute("UPDATE media SET favorite = 0", [])?;
            Ok(())
        })
        .unwrap();
        // a failing import transaction must not leave partial rows
        let r = s.write(|tx| {
            save_doc(tx, &read_legacy(&dir, &mut Vec::new()))?;
            Err::<(), _>(StorageError::Other("power cut".into()))
        });
        assert!(r.is_err());
        let n: i64 = s.read(|c| c.query_row("SELECT COUNT(*) FROM recent", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 0, "rolled back");
        drop(s);
        // next start runs the import again (marker absent) and completes it
        let s = Storage::open(&dir).unwrap();
        let rep = s.report.imported.clone().expect("re-run");
        assert_eq!(rep.recent, 3);
        assert_eq!(s.read(load_doc).unwrap().recent.len(), 3);
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_or_broken_json_is_not_fatal() {
        let dir = temp_dir("broken");
        std::fs::write(dir.join("library.json"), b"{ \"library\": { \"recent\": [ trunc").unwrap();
        let s = Storage::open(&dir).unwrap();
        let rep = s.report.imported.clone().unwrap();
        assert_eq!(rep.recent, 0);
        assert!(rep.warnings.iter().any(|w| w.contains("library.json")));
        assert_eq!(rep.backups.len(), 1, "broken file still copied");
        drop(s);
        std::fs::remove_dir_all(&dir).ok();

        // no files at all (new install): empty import, marker set
        let dir = temp_dir("nofiles");
        let s = Storage::open(&dir).unwrap();
        assert_eq!(s.report.imported.clone().unwrap(), ImportReport::default());
        drop(s);
        assert!(Storage::open(&dir).unwrap().report.imported.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_db_without_backup_reimports_json() {
        let dir = temp_dir("reimport");
        write_old_format(&dir);
        drop(Storage::open(&dir).unwrap());
        // remove the periodic backup so recovery has to start fresh
        for b in list_backups(&dir) {
            std::fs::remove_file(b).unwrap();
        }
        std::fs::write(dir.join(DB_FILE), vec![0x42u8; 8192]).unwrap();
        let _ = std::fs::remove_file(dir.join(format!("{DB_FILE}-wal")));
        let s = Storage::open(&dir).unwrap();
        assert_eq!(s.report.recovered.as_deref(), Some("fresh"));
        assert_eq!(s.report.imported.as_ref().unwrap().recent, 3, "re-indexed from the kept JSON");
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_and_load_roundtrip_keeps_identity() {
        let dir = temp_dir("roundtrip");
        let s = Storage::open(&dir).unwrap();
        let entry = |p: &str, n: &str| RecentEntry {
            id: p.into(),
            path: Some(p.into()),
            name: n.into(),
            kind: "video".into(),
            resume_key: format!("vho_file_{n}_1"),
            opened_at: 5.0,
            ..Default::default()
        };
        let mut doc = LibraryDoc {
            recent: vec![entry("C:\\v\\b.mp4", "b.mp4"), entry("C:\\v\\a.mp4", "a.mp4")],
            resume: vec![("vho_file_b.mp4_1".into(), 12.0)],
            bookmarks: vec![("vho_file_b.mp4_1".into(), vec![Bookmark { time: 3.0, label: "".into() }, Bookmark { time: 9.5, label: "x".into() }])],
            favorites: vec!["C:\\v\\a.mp4".into()],
            legacy_migrated: true,
            legacy_bookmarks_migrated: true,
        };
        s.write(|tx| save_doc(tx, &doc)).unwrap();
        let id_of = |s: &Storage, p: &str| -> String {
            s.read(|c| c.query_row("SELECT id FROM media WHERE path = ?1", [p], |r| r.get(0))).unwrap()
        };
        let id_a = id_of(&s, "C:\\v\\a.mp4");
        assert_eq!(s.read(load_doc).unwrap(), doc);
        // reorder, drop one recent, add a favorite: UUIDs stay
        doc.recent.reverse();
        doc.recent.pop();
        doc.favorites.push("C:\\v\\b.mp4".into());
        s.write(|tx| save_doc(tx, &doc)).unwrap();
        assert_eq!(s.read(load_doc).unwrap(), doc);
        assert_eq!(id_of(&s, "C:\\v\\a.mp4"), id_a);
        let bm_linked: i64 = s
            .read(|c| c.query_row("SELECT COUNT(*) FROM bookmarks WHERE media_id IS NOT NULL", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(bm_linked, 2);
        // the resume list is capped like the frontend
        doc.resume = (0..RESUME_MAX + 7).map(|i| (format!("k{i}"), 1.0 + i as f64)).collect();
        s.write(|tx| save_doc(tx, &doc)).unwrap();
        let r = s.read(load_doc).unwrap().resume;
        assert_eq!(r.len(), RESUME_MAX);
        assert_eq!(r[0].0, "k7", "oldest dropped first");
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deserializes_frontend_doc() {
        let d: LibraryDoc = serde_json::from_value(json!({
            "recent": [{ "id": "u", "url": "u", "name": "n", "type": "audio", "duration": 1, "resumeKey": "", "thumb": "", "openedAt": 1.5e12 }],
            "resume": [["k", 2.5]],
            "bookmarks": [["k", [{ "time": 1, "label": "" }]]],
            "favorites": [],
            "legacyMigrated": true,
            "unknownField": 1
        }))
        .unwrap();
        assert_eq!(d.recent[0].kind, "audio");
        assert_eq!(d.resume, vec![("k".to_string(), 2.5)]);
        assert!(d.legacy_migrated && !d.legacy_bookmarks_migrated);
    }
}
