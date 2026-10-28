//! Saved playlists and M3U / M3U8 / PLS import-export (Plan 05 §2, Plan 13/L02).
//!
//! * Reading: UTF-8 (BOM stripped), UTF-16 with BOM, otherwise Windows-1254/Latin-1 for old
//!   `.m3u` files; relative paths are resolved against the playlist's folder; `file://`
//!   URIs are decoded. Order is kept. Missing local files stay in the list (marked missing).
//! * Remote entries are kept as URLs and NEVER fetched, downloaded or executed here; only
//!   stream schemes are accepted (http(s), rtsp, rtmp, mms, ...). Anything else (javascript:,
//!   data:, smb scripts...) is skipped and reported.
//! * Writing: `.m3u8` UTF-8 without BOM, `.m3u` UTF-8 with BOM (so other players do not read
//!   it as ANSI), `.pls` UTF-8; paths relative to the playlist folder when on the same volume.
//! * Items reference the media identity (UUID), so a renamed/moved file keeps its place.

use std::path::{Component, Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::storage::library::upsert_media;
use crate::storage::{StorageError, now_ms};

/// Largest playlist file read (a playlist is text; anything bigger is not one).
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_ITEMS: usize = 100_000;

pub(crate) const URL_SCHEMES: &[&str] = &["http", "https", "rtsp", "rtsps", "rtmp", "rtmps", "rtp", "mms", "mmsh", "srt", "udp", "hls"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Entry {
    pub path: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    pub entries: Vec<Entry>,
    /// Lines that were not accepted (unsupported scheme), for the report.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    M3u,
    M3u8,
    Pls,
}

impl Format {
    pub fn from_path(p: &Path) -> Option<Format> {
        match p.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
            "m3u" => Some(Format::M3u),
            "m3u8" => Some(Format::M3u8),
            "pls" => Some(Format::Pls),
            _ => None,
        }
    }
}

/// Text of a playlist file: BOM-aware UTF-8/UTF-16, else UTF-8, else Windows-1254.
pub fn decode(bytes: &[u8]) -> String {
    let utf16 = |b: &[u8], le: bool| {
        let units: Vec<u16> =
            b.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(b) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(b, true);
    }
    if let Some(b) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(b, false);
    }
    crate::actions::tags::decode_text(bytes)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "scheme:" of a URL (2+ letters, so "C:" stays a drive).
fn scheme(s: &str) -> Option<String> {
    let (sch, _) = s.split_once(':')?;
    (sch.len() >= 2 && sch.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) && sch.chars().next()?.is_ascii_alphabetic())
        .then(|| sch.to_ascii_lowercase())
}

/// Lexically resolves `.` / `..` (no disk access).
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// One playlist line → entry (None = skipped, with the reason pushed to `skipped`).
fn entry_of(line: &str, base: &Path, skipped: &mut Vec<String>) -> Option<Entry> {
    let s = line.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(sch) = scheme(s) {
        if sch == "file" {
            let rest = s[5..].trim_start_matches('/');
            let local = percent_decode(rest);
            // file:///C:/x -> C:/x ; file:///home/x -> /home/x
            let p = if local.as_bytes().get(1) == Some(&b':') { local } else { format!("/{local}") };
            let p = if cfg!(windows) { p.replace('/', "\\") } else { p };
            return Some(Entry { path: Some(p), ..Default::default() });
        }
        if URL_SCHEMES.contains(&sch.as_str()) {
            return Some(Entry { url: Some(s.to_string()), ..Default::default() });
        }
        skipped.push(s.chars().take(200).collect());
        return None;
    }
    let native = if cfg!(windows) { s.replace('/', "\\") } else { s.replace('\\', "/") };
    let p = Path::new(&native);
    let full = if p.is_absolute() || (cfg!(windows) && (native.starts_with('\\') || native.as_bytes().get(1) == Some(&b':'))) {
        if cfg!(windows) && native.starts_with('\\') && !native.starts_with("\\\\") {
            // "\Music\a.mp3": root of the playlist's drive
            let drive: PathBuf = base.components().take(1).collect();
            drive.join(&native[1..])
        } else {
            p.to_path_buf()
        }
    } else {
        base.join(p)
    };
    Some(Entry { path: Some(lexical(&full).to_string_lossy().into_owned()), ..Default::default() })
}

pub fn parse(text: &str, format: Format, base: &Path) -> Parsed {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Parsed::default();
    if format == Format::Pls || text.trim_start().to_ascii_lowercase().starts_with("[playlist]") {
        // FileN / TitleN / LengthN, ordered by N
        let mut rows: std::collections::BTreeMap<u32, Entry> = Default::default();
        let mut has_file: std::collections::BTreeSet<u32> = Default::default();
        for line in text.lines() {
            let Some((k, v)) = line.split_once('=') else { continue };
            let k = k.trim().to_ascii_lowercase();
            let (field, n) = k.split_at(k.find(|c: char| c.is_ascii_digit()).unwrap_or(k.len()));
            let Ok(n) = n.parse::<u32>() else { continue };
            match field {
                "file" => {
                    if let Some(e) = entry_of(v, base, &mut out.skipped) {
                        let slot = rows.entry(n).or_default();
                        slot.path = e.path;
                        slot.url = e.url;
                        has_file.insert(n);
                    }
                }
                "title" => rows.entry(n).or_default().title = Some(v.trim().to_string()).filter(|t| !t.is_empty()),
                "length" => rows.entry(n).or_default().duration = v.trim().parse::<f64>().ok().filter(|d| *d > 0.0),
                _ => {}
            }
        }
        out.entries = rows.into_iter().filter(|(n, _)| has_file.contains(n)).map(|(_, e)| e).take(MAX_ITEMS).collect();
        return out;
    }
    let mut pending: Option<(Option<f64>, Option<String>)> = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(info) = l.strip_prefix("#EXTINF:") {
            let (dur, title) = info.split_once(',').unwrap_or((info, ""));
            // attributes (tvg-id="..") may follow the duration
            let dur = dur.split_whitespace().next().and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0);
            pending = Some((dur, Some(title.trim().to_string()).filter(|t| !t.is_empty())));
            continue;
        }
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if let Some(mut e) = entry_of(l, base, &mut out.skipped) {
            if let Some((d, t)) = pending.take() {
                e.duration = d;
                e.title = t;
            }
            out.entries.push(e);
            if out.entries.len() >= MAX_ITEMS {
                break;
            }
        } else {
            pending = None;
        }
    }
    out
}

/// `path` relative to `base` when both are on the same volume / root.
pub fn relative_to(base: &Path, path: &Path) -> Option<String> {
    let (base, path) = (lexical(base), lexical(path));
    let b: Vec<Component> = base.components().collect();
    let p: Vec<Component> = path.components().collect();
    let same_root = |x: &Component, y: &Component| match (x, y) {
        (Component::Prefix(a), Component::Prefix(b)) => a.as_os_str().to_string_lossy().eq_ignore_ascii_case(&b.as_os_str().to_string_lossy()),
        (a, b) => a == b,
    };
    if b.is_empty() || p.is_empty() || !same_root(&b[0], &p[0]) {
        return None;
    }
    let eq = |x: &Component, y: &Component| {
        if cfg!(windows) { x.as_os_str().to_string_lossy().to_lowercase() == y.as_os_str().to_string_lossy().to_lowercase() } else { x == y }
    };
    let common = b.iter().zip(&p).take_while(|(x, y)| eq(x, y)).count();
    let mut out = PathBuf::new();
    for _ in common..b.len() {
        out.push("..");
    }
    for c in &p[common..] {
        out.push(c.as_os_str());
    }
    Some(out.to_string_lossy().into_owned())
}

pub fn write(entries: &[Entry], format: Format, out: &Path, relative: bool) -> String {
    let base = out.parent().unwrap_or(Path::new(""));
    let loc = |e: &Entry| -> Option<String> {
        if let Some(u) = &e.url {
            return Some(u.clone());
        }
        let p = e.path.as_deref()?;
        Some(if relative { relative_to(base, Path::new(p)).unwrap_or_else(|| p.to_string()) } else { p.to_string() })
    };
    let clean = |s: &str| s.replace(['\r', '\n'], " ");
    let mut s = String::new();
    match format {
        Format::Pls => {
            s.push_str("[playlist]\r\n");
            let mut n = 0;
            for e in entries {
                let Some(l) = loc(e) else { continue };
                n += 1;
                s.push_str(&format!("File{n}={}\r\n", clean(&l)));
                if let Some(t) = &e.title {
                    s.push_str(&format!("Title{n}={}\r\n", clean(t)));
                }
                s.push_str(&format!("Length{n}={}\r\n", e.duration.map_or(-1, |d| d.round() as i64)));
            }
            s.push_str(&format!("NumberOfEntries={n}\r\nVersion=2\r\n"));
        }
        Format::M3u | Format::M3u8 => {
            if format == Format::M3u {
                s.push('\u{feff}');
            }
            s.push_str("#EXTM3U\r\n");
            for e in entries {
                let Some(l) = loc(e) else { continue };
                if e.title.is_some() || e.duration.is_some() {
                    let title = e.title.clone().or_else(|| e.path.as_deref().map(file_name)).unwrap_or_default();
                    s.push_str(&format!("#EXTINF:{},{}\r\n", e.duration.map_or(-1, |d| d.round() as i64), clean(&title)));
                }
                s.push_str(&clean(&l));
                s.push_str("\r\n");
            }
        }
    }
    s
}

fn file_name(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}

// ------------------------------------------------------------------- database

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub name: String,
    pub count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub duration: Option<f64>,
    pub media_id: Option<String>,
    pub kind: Option<String>,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub items: Vec<Item>,
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Info>> {
    let mut s = conn.prepare(
        "SELECT p.id, p.name, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id), p.updated_at
         FROM playlists p ORDER BY p.name COLLATE NOCASE, p.created_at",
    )?;
    s.query_map([], |r| Ok(Info { id: r.get(0)?, name: r.get(1)?, count: r.get(2)?, updated_at: r.get(3)? }))?.collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Playlist>> {
    let Some(name) = conn.query_row("SELECT name FROM playlists WHERE id = ?1", [id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(None);
    };
    let mut s = conn.prepare(
        "SELECT COALESCE(m.path, i.path), COALESCE(m.url, i.url), i.title, m.duration, i.media_id, m.kind, m.status
         FROM playlist_items i LEFT JOIN media m ON m.id = i.media_id WHERE i.playlist_id = ?1 ORDER BY i.position",
    )?;
    let items = s
        .query_map([id], |r| {
            let path: Option<String> = r.get(0)?;
            let status: Option<String> = r.get(6)?;
            Ok(Item {
                missing: path.as_deref().is_some_and(|p| status.as_deref() == Some("deleted") || !Path::new(p).exists()),
                path,
                url: r.get(1)?,
                title: r.get(2)?,
                duration: r.get(3)?,
                media_id: r.get(4)?,
                kind: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(Some(Playlist { id: id.into(), name, items }))
}

/// Creates (id None) or replaces a playlist. Existing local files are linked to their media
/// identity; missing files and streams are stored by path / URL.
pub fn save(tx: &Transaction, id: Option<&str>, name: &str, entries: &[Entry]) -> Result<String, StorageError> {
    let now = now_ms();
    let name = name.trim().chars().take(200).collect::<String>();
    let name = if name.is_empty() { "Playlist".to_string() } else { name };
    let id = match id {
        Some(id) => {
            if tx.execute("UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now])? == 0 {
                return Err(StorageError::Other("[not-found] playlist".into()));
            }
            tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [id])?;
            id.to_string()
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", params![id, name, now])?;
            id
        }
    };
    for (pos, e) in entries.iter().take(MAX_ITEMS).enumerate() {
        let path = e.path.as_deref().filter(|p| !p.is_empty());
        let url = e.url.as_deref().filter(|u| !u.is_empty());
        if path.is_none() && url.is_none() {
            continue;
        }
        let media_id = match (path, url) {
            (Some(p), _) if Path::new(p).is_file() => Some(upsert_media(tx, Some(p), None, None, None)?),
            (None, Some(u)) => Some(upsert_media(tx, None, Some(u), None, e.title.as_deref())?),
            _ => None,
        };
        tx.execute(
            "INSERT INTO playlist_items (playlist_id, position, media_id, path, url, title) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, pos as i64, media_id, path, url, e.title],
        )?;
    }
    Ok(id)
}

pub fn delete(tx: &Transaction, id: &str) -> rusqlite::Result<bool> {
    Ok(tx.execute("DELETE FROM playlists WHERE id = ?1", [id])? > 0)
}

pub fn read_file(path: &Path) -> Result<Parsed, String> {
    let format = Format::from_path(path).ok_or("[unsupported] playlist format")?;
    let meta = std::fs::metadata(path).map_err(|e| format!("[not-found] {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("[too-large] playlist file".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) && !(bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF])) {
        return Err("[unsupported] binary file".into());
    }
    let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(parse(&decode(&bytes), format, &base))
}

pub fn write_file(entries: &[Entry], out: &Path, relative: bool) -> Result<usize, String> {
    let format = Format::from_path(out).ok_or("[unsupported] playlist format")?;
    let text = write(entries, format, out, relative);
    crate::photo::write_atomic(out, text.as_bytes())?;
    Ok(entries.len())
}

impl From<&Item> for Entry {
    fn from(i: &Item) -> Entry {
        Entry { path: i.path.clone(), url: i.url.clone(), title: i.title.clone(), duration: i.duration }
    }
}
