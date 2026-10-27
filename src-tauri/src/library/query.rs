//! The shared library query (Plan 13/L02): video "continue watching", music views (L03),
//! photo studio ratings/tags and playlists all read media through here.
//!
//! Search is SQLite FTS5 over file name, title, artist, album and user tags (word prefix
//! match, diacritics folded). It is a text search, not a semantic / AI search.

use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Transaction, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::storage::identity::normalize_path;
use crate::storage::library::upsert_media;
use crate::storage::{StorageError, now_ms};

pub const PAGE_MAX: u32 = 500;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    /// "video" | "audio" | "image"; None = all kinds
    pub kind: Option<String>,
    /// "all" (default) | "continue" | "recentlyAdded" | "favorites" | "rated" | "mostPlayed" | "missing"
    pub view: Option<String>,
    pub search: Option<String>,
    pub folder_id: Option<String>,
    pub tag: Option<String>,
    pub min_rating: Option<u8>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    /// "name" (default) | "added" | "size" | "rating" | "played" | "track"
    pub sort: Option<String>,
    pub desc: bool,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub name: String,
    pub kind: String,
    pub size: Option<i64>,
    pub duration: Option<f64>,
    pub status: String,
    pub rating: Option<i64>,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub resume_key: Option<String>,
    pub resume_seconds: Option<f64>,
    pub folder_id: Option<String>,
    pub added_at: i64,
    pub play_count: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_no: Option<i64>,
    pub year: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub total: u64,
    pub offset: u32,
    pub items: Vec<Row>,
}

/// Resume key the player would use for a local file (see ops::resume_key).
const KEY_EXPR: &str = "COALESCE(m.resume_key, CASE WHEN m.path IS NOT NULL THEN 'vho_file_' || m.name || '_' || COALESCE(m.size, 0) END)";

/// FTS5 query from user text: every word must match as a prefix. Quotes make each word a
/// literal (no FTS syntax injection).
pub fn fts_query(text: &str) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| c.is_whitespace() || c == '"' || c.is_control())
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(16)
        .map(|w| format!("\"{}\"*", fold(w)))
        .collect();
    if words.is_empty() { None } else { Some(words.join(" ")) }
}

/// Case folding for tags and search words. Turkish İ and ı fold to i (the FTS index stores
/// names the same way), so "baris" finds "Barış" and "istanbul" finds "İstanbul".
pub fn fold(s: &str) -> String {
    s.trim().chars().flat_map(|c| if c == 'İ' || c == 'ı' { vec!['i'] } else { c.to_lowercase().collect() }).collect()
}

struct Built {
    from_where: String,
    args: Vec<Value>,
    order: String,
}

fn build(q: &Query) -> Built {
    let mut w: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();
    let view = q.view.as_deref().unwrap_or("all");
    let arg = |v: Value, args: &mut Vec<Value>| {
        args.push(v);
        format!("?{}", args.len())
    };
    // scope: library items, except personal lists that also hold files opened once
    if !matches!(view, "favorites" | "rated" | "continue") && q.folder_id.is_none() {
        w.push("m.in_library = 1".into());
    }
    w.push(if view == "missing" { "m.status = 'missing'".into() } else { "m.status IN ('present', 'offline')".into() });
    if let Some(k) = q.kind.as_deref().filter(|k| ["video", "audio", "image", "other"].contains(k)) {
        let a = arg(Value::Text(k.into()), &mut args);
        w.push(format!("m.kind = {a}"));
    }
    if let Some(f) = &q.folder_id {
        let a = arg(Value::Text(f.clone()), &mut args);
        w.push(format!("m.folder_id = {a}"));
    }
    match view {
        "continue" => w.push("r.seconds IS NOT NULL".into()),
        "favorites" => w.push("m.favorite = 1".into()),
        "rated" => w.push("m.rating >= 4".into()),
        "mostPlayed" => w.push("m.play_count > 0".into()),
        _ => {}
    }
    if let Some(min) = q.min_rating.filter(|r| *r > 0) {
        let a = arg(Value::Integer(min.min(5) as i64), &mut args);
        w.push(format!("m.rating >= {a}"));
    }
    if let Some(t) = q.tag.as_deref().map(fold).filter(|t| !t.is_empty()) {
        let a = arg(Value::Text(t), &mut args);
        w.push(format!("EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id = m.id AND t.tag_norm = {a})"));
    }
    for (col, v) in [("COALESCE(a.album_artist, a.artist)", &q.artist), ("a.album", &q.album), ("a.genre", &q.genre)] {
        if let Some(v) = v {
            if v.is_empty() {
                w.push(format!("COALESCE({col}, '') = ''"));
            } else {
                let a = arg(Value::Text(v.clone()), &mut args);
                w.push(format!("{col} = {a} COLLATE NOCASE"));
            }
        }
    }
    if let Some(fts) = q.search.as_deref().and_then(fts_query) {
        let a = arg(Value::Text(fts), &mut args);
        w.push(format!("m.rowid IN (SELECT rowid FROM media_fts WHERE media_fts MATCH {a})"));
    }
    let dir = if q.desc { "DESC" } else { "ASC" };
    let order = match (view, q.sort.as_deref().unwrap_or("")) {
        ("continue", "") => "r.updated_at DESC, m.name COLLATE NOCASE".to_string(),
        ("recentlyAdded", "") => "m.added_at DESC, m.name COLLATE NOCASE".to_string(),
        ("mostPlayed", "") => "m.play_count DESC, m.last_played_at DESC".to_string(),
        ("favorites", "") => "m.favorited_at, m.rowid".to_string(),
        (_, "added") => format!("m.added_at {dir}, m.name COLLATE NOCASE"),
        (_, "size") => format!("m.size {dir}, m.name COLLATE NOCASE"),
        (_, "rating") => format!("COALESCE(m.rating, 0) {dir}, m.name COLLATE NOCASE"),
        (_, "played") => format!("m.last_played_at {dir}, m.name COLLATE NOCASE"),
        (_, "track") => format!(
            "a.album_artist COLLATE NOCASE {dir}, a.album COLLATE NOCASE {dir}, a.disc_no, a.track_no, m.name COLLATE NOCASE"
        ),
        _ => format!("m.name COLLATE NOCASE {dir}, m.path"),
    };
    let from_where = format!(
        "FROM media m LEFT JOIN audio_tags a ON a.media_id = m.id LEFT JOIN resume_positions r ON r.key = {KEY_EXPR} WHERE {}",
        w.join(" AND ")
    );
    Built { from_where, args, order }
}

fn tags_of(conn: &Connection, ids: &[String]) -> rusqlite::Result<HashMap<String, Vec<String>>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in ids.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut s =
            conn.prepare(&format!("SELECT media_id, tag FROM media_tags WHERE media_id IN ({marks}) ORDER BY tag COLLATE NOCASE"))?;
        let rows = s.query_map(params_from_iter(chunk.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows {
            let (id, tag) = r?;
            out.entry(id).or_default().push(tag);
        }
    }
    Ok(out)
}

pub fn query(conn: &Connection, q: &Query) -> rusqlite::Result<Page> {
    let b = build(q);
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) {}", b.from_where), params_from_iter(b.args.iter()), |r| r.get(0))?;
    let limit = if q.limit == 0 { 100 } else { q.limit.min(PAGE_MAX) };
    let sql = format!(
        "SELECT m.id, m.path, m.url, m.name, m.kind, m.size, m.duration, m.status, m.rating, m.favorite, {KEY_EXPR}, r.seconds,
                m.folder_id, m.added_at, m.play_count, a.title, a.artist, a.album, a.track_no, a.year
         {} ORDER BY {} LIMIT {limit} OFFSET {}",
        b.from_where, b.order, q.offset
    );
    let mut s = conn.prepare(&sql)?;
    let mut items: Vec<Row> = s
        .query_map(params_from_iter(b.args.iter()), |r| {
            Ok(Row {
                id: r.get(0)?,
                path: r.get(1)?,
                url: r.get(2)?,
                name: r.get(3)?,
                kind: r.get(4)?,
                size: r.get(5)?,
                duration: r.get(6)?,
                status: r.get(7)?,
                rating: r.get(8)?,
                favorite: r.get::<_, i64>(9)? != 0,
                tags: Vec::new(),
                resume_key: r.get(10)?,
                resume_seconds: r.get(11)?,
                folder_id: r.get(12)?,
                added_at: r.get(13)?,
                play_count: r.get(14)?,
                title: r.get(15)?,
                artist: r.get(16)?,
                album: r.get(17)?,
                track_no: r.get(18)?,
                year: r.get(19)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let mut tags = tags_of(conn, &ids)?;
    for i in &mut items {
        i.tags = tags.remove(&i.id).unwrap_or_default();
    }
    Ok(Page { total: total as u64, offset: q.offset, items })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// "" = unknown (no tag)
    pub name: String,
    pub count: i64,
    /// album groups: the album artist (or the single track artist)
    pub artist: Option<String>,
    pub year: Option<i64>,
}

/// Music groups for L03: by "artist" | "album" | "genre" (present library audio only).
pub fn music_groups(conn: &Connection, by: &str, search: Option<&str>) -> rusqlite::Result<Vec<Group>> {
    let (key, extra) = match by {
        "album" => ("COALESCE(a.album, '')", "COALESCE(a.album_artist, MIN(a.artist)), MAX(a.year)"),
        "genre" => ("COALESCE(a.genre, '')", "NULL, NULL"),
        _ => ("COALESCE(a.album_artist, a.artist, '')", "NULL, NULL"),
    };
    let mut args: Vec<Value> = Vec::new();
    let mut w = "m.kind = 'audio' AND m.in_library = 1 AND m.status IN ('present', 'offline')".to_string();
    if let Some(f) = search.and_then(fts_query) {
        args.push(Value::Text(f));
        w.push_str(" AND m.rowid IN (SELECT rowid FROM media_fts WHERE media_fts MATCH ?1)");
    }
    let group_by = if by == "album" { format!("{key}, COALESCE(a.album_artist, '')") } else { key.to_string() };
    let sql = format!(
        "SELECT {key} AS k, COUNT(*), {extra} FROM media m LEFT JOIN audio_tags a ON a.media_id = m.id WHERE {w}
         GROUP BY {group_by} ORDER BY k = '', k COLLATE NOCASE"
    );
    let mut s = conn.prepare(&sql)?;
    s.query_map(params_from_iter(args.iter()), |r| Ok(Group { name: r.get(0)?, count: r.get(1)?, artist: r.get(2)?, year: r.get(3)? }))?
        .collect()
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub path: String,
    pub rating: Option<i64>,
    pub favorite: bool,
    pub tags: Vec<String>,
}

/// Rating / favorite / tags of files by path (photo studio grid). Unknown files are omitted.
pub fn meta_by_paths(conn: &Connection, paths: &[String]) -> rusqlite::Result<Vec<Meta>> {
    let mut out = Vec::new();
    let mut ids = Vec::new();
    let mut s = conn.prepare_cached("SELECT id, rating, favorite FROM media WHERE path_norm = ?1")?;
    for p in paths {
        if let Some((id, rating, fav)) = s
            .query_row([normalize_path(p)], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i64>(2)?)))
            .optional()?
        {
            let tagged: bool = conn
                .query_row("SELECT 1 FROM media_tags WHERE media_id = ?1 LIMIT 1", [&id], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if rating.is_none() && fav == 0 && !tagged {
                continue;
            }
            ids.push(id);
            out.push(Meta { path: p.clone(), rating, favorite: fav != 0, tags: Vec::new() });
        }
    }
    let mut tags = tags_of(conn, &ids)?;
    for (m, id) in out.iter_mut().zip(ids) {
        m.tags = tags.remove(&id).unwrap_or_default();
    }
    Ok(out)
}

/// Sets the 0–5 star rating (0 = none) of files; rows are created for files not yet known.
pub fn set_rating(tx: &Transaction, paths: &[String], rating: u8) -> Result<usize, StorageError> {
    let r = if rating == 0 { None } else { Some(rating.min(5) as i64) };
    for p in paths {
        let id = upsert_media(tx, Some(p), None, None, None)?;
        tx.execute("UPDATE media SET rating = ?2, updated_at = ?3 WHERE id = ?1", params![id, r, now_ms()])?;
    }
    Ok(paths.len())
}

/// Adds / removes user tags (case-insensitive; the first spelling is kept).
pub fn set_tags(tx: &Transaction, paths: &[String], add: &[String], remove: &[String]) -> Result<usize, StorageError> {
    let add: Vec<(String, String)> = add
        .iter()
        .map(|t| t.trim().chars().filter(|c| !c.is_control()).take(64).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| (fold(&t), t))
        .collect();
    let remove: Vec<String> = remove.iter().map(|t| fold(t)).filter(|t| !t.is_empty()).collect();
    for p in paths {
        let id = upsert_media(tx, Some(p), None, None, None)?;
        for (norm, tag) in &add {
            tx.execute("INSERT OR IGNORE INTO media_tags (media_id, tag, tag_norm) VALUES (?1, ?2, ?3)", params![id, tag, norm])?;
        }
        for norm in &remove {
            tx.execute("DELETE FROM media_tags WHERE media_id = ?1 AND tag_norm = ?2", params![id, norm])?;
        }
    }
    Ok(paths.len())
}

/// All tags with their use count (suggestions).
pub fn all_tags(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut s = conn.prepare(
        "SELECT MIN(t.tag), COUNT(*) FROM media_tags t JOIN media m ON m.id = t.media_id AND m.status <> 'deleted'
         GROUP BY t.tag_norm ORDER BY COUNT(*) DESC, MIN(t.tag) COLLATE NOCASE LIMIT 500",
    )?;
    s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

/// Counts a play (smart lists "most played"); unknown files are not added.
pub fn mark_played(tx: &Transaction, path: &str) -> Result<bool, StorageError> {
    let n = tx.execute(
        "UPDATE media SET play_count = play_count + 1, last_played_at = ?2 WHERE path_norm = ?1",
        params![normalize_path(path), now_ms()],
    )?;
    Ok(n > 0)
}

/// Rebuilds the FTS index when it does not match `media` (e.g. rowids changed by a VACUUM).
/// Returns true when it was rebuilt.
pub fn check_fts(conn: &Connection) -> rusqlite::Result<bool> {
    let (n_media, n_fts, bad): (i64, i64, i64) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM media), (SELECT COUNT(*) FROM media_fts),
                (SELECT COUNT(*) FROM media m JOIN media_fts f ON f.rowid = m.rowid WHERE f.media_id <> m.id)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if n_media == n_fts && bad == 0 {
        return Ok(false);
    }
    rebuild_fts(conn)?;
    Ok(true)
}

pub fn rebuild_fts(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM media_fts;
         INSERT INTO media_fts (rowid, media_id, name, title, artist, album, tags)
           SELECT m.rowid, m.id, replace(replace(m.name, 'ı', 'i'), 'İ', 'i'), replace(replace(a.title, 'ı', 'i'), 'İ', 'i'), replace(replace(a.artist, 'ı', 'i'), 'İ', 'i'), replace(replace(a.album, 'ı', 'i'), 'İ', 'i'),
                  replace(replace((SELECT group_concat(tag, ' ') FROM media_tags t WHERE t.media_id = m.id), 'ı', 'i'), 'İ', 'i')
           FROM media m LEFT JOIN audio_tags a ON a.media_id = m.id;",
    )
}
