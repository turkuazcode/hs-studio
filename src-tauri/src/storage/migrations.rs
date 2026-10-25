//! Schema migrations of library.db: the single owner of the database schema.
//!
//! Every schema change is one entry in [`MIGRATIONS`], applied in order, each in its own
//! IMMEDIATE transaction together with its `schema_migrations` row and `PRAGMA user_version`.
//! An interrupted migration therefore rolls back completely and is simply re-run on the next
//! start. Applied migrations are never edited: a change is always a new entry.
//!
//! Adding tables from another module (A02 job queue, L02 library scan, ...): append a
//! `Migration { version: <last + 1>, name: "...", up: MigrationStep::Sql(...) }` here. Do not
//! create a second migration system or run `CREATE TABLE` outside this list.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

use super::{StorageError, now_ms};

/// One forward step of the schema.
pub struct Migration {
    /// 1, 2, 3, ... without gaps; stored in `schema_migrations.version` and `user_version`.
    pub version: u32,
    /// Stable identifier; compared against the database so an edited history is detected.
    pub name: &'static str,
    pub up: MigrationStep,
}

#[derive(Clone, Copy)]
pub enum MigrationStep {
    /// Plain SQL (may contain several statements).
    Sql(&'static str),
    /// Data migration that needs Rust code (runs inside the migration transaction).
    #[allow(dead_code)] // first user: a later data migration (L02/A02)
    Rust(fn(&Transaction) -> rusqlite::Result<()>),
}

/// v1: shared core tables (Plan 13/L01). Times are Unix milliseconds (UTC) unless noted.
const V1_CORE: &str = r#"
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,             -- UUID
  path        TEXT NOT NULL,
  path_norm   TEXT NOT NULL UNIQUE,         -- identity::normalize_path
  volume_id   TEXT,
  watched     INTEGER NOT NULL DEFAULT 0,   -- persistent library folder (L02)
  favorite    INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,
  last_scan_at INTEGER
);

-- One row per known media item. The UUID is the identity; the path is just its current
-- location (it changes on rename/move). Streams (URLs) have no path.
CREATE TABLE media (
  id           TEXT PRIMARY KEY,            -- UUID v4, never reused
  path         TEXT,
  path_norm    TEXT UNIQUE,
  url          TEXT UNIQUE,
  folder_id    TEXT REFERENCES folders(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video', 'audio', 'image', 'other')),
  name         TEXT NOT NULL,
  -- identity helpers (identity.rs): volume+file id when the platform has them, size+mtime
  -- only as a fast pre-filter, content_hash for ambiguous moves
  size         INTEGER,
  mtime_ns     INTEGER,
  volume_id    TEXT,
  file_id      TEXT,
  content_hash TEXT,
  duration     REAL,
  width        INTEGER,
  height       INTEGER,
  -- capture time: camera local wall-clock time as written (ISO "YYYY-MM-DDTHH:MM:SS[.fff]"),
  -- the UTC offset in minutes only when known (NULL = unknown, never assumed UTC),
  -- taken_utc only when the offset is known
  taken_local      TEXT,
  taken_offset_min INTEGER,
  taken_utc        INTEGER,
  rating       INTEGER CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  favorite     INTEGER NOT NULL DEFAULT 0,
  favorited_at INTEGER,
  thumb        TEXT,                        -- small preview (data URL) or cache file path
  resume_key   TEXT,                        -- key of resume_positions used by the player
  status       TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'missing', 'offline', 'deleted')),
  added_at     INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (path IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX media_file_identity ON media(volume_id, file_id);
CREATE INDEX media_size_mtime ON media(size, mtime_ns);
CREATE INDEX media_resume_key ON media(resume_key);
CREATE INDEX media_favorite ON media(favorite) WHERE favorite = 1;

-- Start screen "recent" list (order = position).
CREATE TABLE recent (
  media_id  TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  opened_at INTEGER NOT NULL
);

-- Player resume positions. The key is the player's resume key (name+size or URL), so it
-- survives even when no media row exists; media_id links it when known.
CREATE TABLE resume_positions (
  key        TEXT PRIMARY KEY,
  media_id   TEXT REFERENCES media(id) ON DELETE SET NULL,
  seconds    REAL NOT NULL CHECK (seconds > 0),
  seq        INTEGER NOT NULL,              -- insertion order (oldest dropped first)
  updated_at INTEGER NOT NULL
);

CREATE TABLE audio_tags (
  media_id      TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  title         TEXT,
  artist        TEXT,
  album         TEXT,
  album_artist  TEXT,
  genre         TEXT,
  year          INTEGER,
  track_no      INTEGER,
  track_total   INTEGER,
  disc_no       INTEGER,
  disc_total    INTEGER,
  -- ReplayGain as read from the file tags (dB / linear sample peak); not EBU R128 LUFS
  rg_track_gain REAL,
  rg_track_peak REAL,
  rg_album_gain REAL,
  rg_album_peak REAL,
  read_at       INTEGER NOT NULL
);

CREATE TABLE playlists (
  id         TEXT PRIMARY KEY,              -- UUID
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_items (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
  path        TEXT,                         -- kept for missing / imported entries
  url         TEXT,
  title       TEXT,
  PRIMARY KEY (playlist_id, position)
);

-- Video bookmarks. file_key = the player's resume key of the file.
CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY,
  file_key   TEXT NOT NULL,
  media_id   TEXT REFERENCES media(id) ON DELETE SET NULL,
  time       REAL NOT NULL CHECK (time >= 0),
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX bookmarks_file_key ON bookmarks(file_key, time);

-- Files derived from a media item (exports, AI outputs, sidecars). Thumbnails/caches stay
-- files on disk; only their path is recorded here.
CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,              -- UUID
  media_id   TEXT REFERENCES media(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  params     TEXT,                          -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX artifacts_media ON artifacts(media_id);
"#;

/// v3: persistent library (Plan 13/L02): library folders state, tags, operation log for
/// file-system changes, FTS5 index over name / title / artist / album / tags.
///
/// The FTS index is kept in sync by triggers, so every writer (L01 `upsert_media`, scans,
/// D1 rename hooks, tag edits) updates it in the same transaction. Its rowid is the rowid of
/// the `media` row (`media_id` is stored too; [`crate::library::query::rebuild_fts`] repairs
/// the index should rowids ever change, e.g. after a manual VACUUM).
const V3_LIBRARY: &str = r#"
ALTER TABLE folders ADD COLUMN status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'missing'));
ALTER TABLE folders ADD COLUMN file_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN scan_error TEXT;

-- in_library: found by a scan of a library folder (an item that was only opened once is 0)
ALTER TABLE media ADD COLUMN in_library INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN missing_since INTEGER;
ALTER TABLE media ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media ADD COLUMN last_played_at INTEGER;
CREATE INDEX media_folder_status ON media(folder_id, status);
CREATE INDEX media_library_kind ON media(kind, added_at) WHERE in_library = 1;
CREATE INDEX media_rated ON media(rating) WHERE rating > 0;

-- User tags (photo studio / library). tag = as typed, tag_norm = folded for matching.
CREATE TABLE media_tags (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  tag_norm TEXT NOT NULL,
  PRIMARY KEY (media_id, tag_norm)
);
CREATE INDEX media_tags_norm ON media_tags(tag_norm);

-- File-system operations are not atomic with SQLite: an operation is recorded 'pending'
-- before the rename/trash, finished in the same transaction as the media update, and a
-- pending entry left by a crash is reconciled on the next start (old/new path checked).
-- Finished renames/moves also let a stale frontend document (old path / resume key) be
-- mapped to the new location.
CREATE TABLE media_ops (
  id          INTEGER PRIMARY KEY,
  op          TEXT NOT NULL CHECK (op IN ('rename', 'move', 'trash')),
  media_id    TEXT,
  old_path    TEXT NOT NULL,
  old_norm    TEXT NOT NULL,
  new_path    TEXT,
  old_key     TEXT,
  new_key     TEXT,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX media_ops_state ON media_ops(state);
CREATE INDEX media_ops_old ON media_ops(old_norm);

CREATE VIRTUAL TABLE media_fts USING fts5(
  media_id UNINDEXED, name, title, artist, album, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO media_fts (rowid, media_id, name, title, artist, album, tags)
  SELECT m.rowid, m.id, replace(replace(m.name, 'ı', 'i'), 'İ', 'i'), replace(replace(a.title, 'ı', 'i'), 'İ', 'i'), replace(replace(a.artist, 'ı', 'i'), 'İ', 'i'), replace(replace(a.album, 'ı', 'i'), 'İ', 'i'),
         replace(replace((SELECT group_concat(tag, ' ') FROM media_tags t WHERE t.media_id = m.id), 'ı', 'i'), 'İ', 'i')
  FROM media m LEFT JOIN audio_tags a ON a.media_id = m.id;

CREATE TRIGGER media_fts_insert AFTER INSERT ON media BEGIN
  INSERT INTO media_fts (rowid, media_id, name, title, artist, album, tags)
  VALUES (new.rowid, new.id, replace(replace(new.name, 'ı', 'i'), 'İ', 'i'), NULL, NULL, NULL, NULL);
END;
CREATE TRIGGER media_fts_delete AFTER DELETE ON media BEGIN
  DELETE FROM media_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER media_fts_name AFTER UPDATE OF name ON media BEGIN
  UPDATE media_fts SET name = replace(replace(new.name, 'ı', 'i'), 'İ', 'i') WHERE rowid = new.rowid;
END;
CREATE TRIGGER media_fts_audio_insert AFTER INSERT ON audio_tags BEGIN
  UPDATE media_fts SET title = replace(replace(new.title, 'ı', 'i'), 'İ', 'i'), artist = replace(replace(new.artist, 'ı', 'i'), 'İ', 'i'), album = replace(replace(new.album, 'ı', 'i'), 'İ', 'i')
  WHERE rowid = (SELECT rowid FROM media WHERE id = new.media_id);
END;
CREATE TRIGGER media_fts_audio_update AFTER UPDATE ON audio_tags BEGIN
  UPDATE media_fts SET title = replace(replace(new.title, 'ı', 'i'), 'İ', 'i'), artist = replace(replace(new.artist, 'ı', 'i'), 'İ', 'i'), album = replace(replace(new.album, 'ı', 'i'), 'İ', 'i')
  WHERE rowid = (SELECT rowid FROM media WHERE id = new.media_id);
END;
CREATE TRIGGER media_fts_audio_delete AFTER DELETE ON audio_tags BEGIN
  UPDATE media_fts SET title = NULL, artist = NULL, album = NULL
  WHERE rowid = (SELECT rowid FROM media WHERE id = old.media_id);
END;
CREATE TRIGGER media_fts_tag_insert AFTER INSERT ON media_tags BEGIN
  UPDATE media_fts SET tags = replace(replace((SELECT group_concat(tag, ' ') FROM media_tags WHERE media_id = new.media_id), 'ı', 'i'), 'İ', 'i')
  WHERE rowid = (SELECT rowid FROM media WHERE id = new.media_id);
END;
CREATE TRIGGER media_fts_tag_delete AFTER DELETE ON media_tags BEGIN
  UPDATE media_fts SET tags = replace(replace((SELECT group_concat(tag, ' ') FROM media_tags WHERE media_id = old.media_id), 'ı', 'i'), 'İ', 'i')
  WHERE rowid = (SELECT rowid FROM media WHERE id = old.media_id);
END;
"#;

/// The ordered schema history. Append only.
///
/// MERGE NOTE (L02 branch): version 2 belongs to A02 ("jobs", another branch). Until that
/// branch is merged this list carries a no-op stand-in so the list stays contiguous; the
/// integrator replaces the stand-in with A02's real `Migration { version: 2, name: "jobs" }`.
/// Its name deliberately differs from "jobs": a test database that applied the stand-in is
/// refused with `migrationMismatch` by the merged build instead of silently skipping A02.
pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "core", up: MigrationStep::Sql(V1_CORE) },
    Migration { version: 2, name: "jobs-pending-merge", up: MigrationStep::Sql("SELECT 1") },
    Migration { version: 3, name: "library", up: MigrationStep::Sql(V3_LIBRARY) },
];

/// Highest schema version this build understands.
#[allow(dead_code)] // diagnostics / A02 tests
pub fn latest_version() -> u32 {
    MIGRATIONS.last().map_or(0, |m| m.version)
}

const BOOTSTRAP: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  app_version TEXT NOT NULL
)";

/// Schema version recorded in the database (0 = empty / new file).
pub fn current_version(conn: &Connection) -> Result<u32, StorageError> {
    let has_table: bool = conn
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'", [], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if !has_table {
        let user_version: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        return Ok(user_version);
    }
    let v: Option<u32> = conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0))?;
    Ok(v.unwrap_or(0))
}

/// Versions that `migrate` would apply (empty when up to date).
pub fn pending(conn: &Connection, list: &[Migration]) -> Result<Vec<u32>, StorageError> {
    let current = current_version(conn)?;
    let latest = list.last().map_or(0, |m| m.version);
    if current > latest {
        return Err(StorageError::SchemaNewer { db: current, app: latest });
    }
    Ok(list.iter().filter(|m| m.version > current).map(|m| m.version).collect())
}

/// Applies the pending migrations of `list` in order. Returns the applied versions.
///
/// A database written by a newer build (higher version) is refused with
/// [`StorageError::SchemaNewer`] and left untouched: no silent downgrade.
pub fn migrate(conn: &mut Connection, list: &[Migration]) -> Result<Vec<u32>, StorageError> {
    validate_list(list)?;
    conn.execute_batch(BOOTSTRAP)?;
    let latest = list.last().map_or(0, |m| m.version);
    let current = current_version(conn)?;
    if current > latest {
        return Err(StorageError::SchemaNewer { db: current, app: latest });
    }
    // An edited/renamed history is a programming error; do not build on top of it
    {
        let mut stmt = conn.prepare("SELECT version, name FROM schema_migrations ORDER BY version")?;
        let applied = stmt.query_map([], |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)))?;
        for row in applied {
            let (version, name) = row?;
            match list.iter().find(|m| m.version == version) {
                Some(m) if m.name == name => {}
                _ => return Err(StorageError::MigrationMismatch { version, name }),
            }
        }
    }
    let mut applied = Vec::new();
    for m in list.iter().filter(|m| m.version > current) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match &m.up {
            MigrationStep::Sql(sql) => tx.execute_batch(sql),
            MigrationStep::Rust(f) => f(&tx),
        }
        .map_err(|e| StorageError::MigrationFailed { version: m.version, detail: e.to_string() })?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (?1, ?2, ?3, ?4)",
            params![m.version, m.name, now_ms(), env!("CARGO_PKG_VERSION")],
        )?;
        tx.pragma_update(None, "user_version", m.version)?;
        tx.commit()?;
        applied.push(m.version);
    }
    Ok(applied)
}

fn validate_list(list: &[Migration]) -> Result<(), StorageError> {
    for (i, m) in list.iter().enumerate() {
        if m.version != i as u32 + 1 {
            return Err(StorageError::MigrationMismatch { version: m.version, name: m.name.to_string() });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "foreign_keys", true).unwrap();
        c
    }

    fn tables(c: &Connection) -> Vec<String> {
        let mut s = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap();
        s.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn registry_is_contiguous_and_first_set_complete() {
        validate_list(MIGRATIONS).unwrap();
        let mut c = mem();
        assert_eq!(migrate(&mut c, MIGRATIONS).unwrap(), (1..=latest_version()).collect::<Vec<_>>());
        let t = tables(&c);
        for name in [
            "schema_migrations", "meta", "folders", "media", "audio_tags", "playlists", "playlist_items", "bookmarks",
            "artifacts", "recent", "resume_positions", "media_tags", "media_ops", "media_fts",
        ] {
            assert!(t.contains(&name.to_string()), "missing table {name}: {t:?}");
        }
        assert_eq!(current_version(&c).unwrap(), latest_version());
        let uv: u32 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
        assert_eq!(uv, latest_version());
    }

    #[test]
    fn rerun_is_a_no_op() {
        let mut c = mem();
        migrate(&mut c, MIGRATIONS).unwrap();
        assert!(migrate(&mut c, MIGRATIONS).unwrap().is_empty());
        let n: u32 = c.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(n, latest_version());
    }

    const EXTRA: &[Migration] = &[
        Migration { version: 1, name: "a", up: MigrationStep::Sql("CREATE TABLE a (x INTEGER)") },
        Migration { version: 2, name: "b", up: MigrationStep::Sql("CREATE TABLE b (y INTEGER); INSERT INTO a VALUES (1)") },
    ];

    #[test]
    fn later_module_appends_a_migration() {
        // e.g. A02 adding jobs tables: same runner, next version
        let mut c = mem();
        migrate(&mut c, &EXTRA[..1]).unwrap();
        assert_eq!(migrate(&mut c, EXTRA).unwrap(), vec![2]);
        assert!(tables(&c).contains(&"b".to_string()));
    }

    #[test]
    fn failing_migration_rolls_back_completely() {
        const BAD: &[Migration] = &[
            Migration { version: 1, name: "a", up: MigrationStep::Sql("CREATE TABLE a (x INTEGER)") },
            // creates a table, inserts, then fails: none of it may remain
            Migration {
                version: 2,
                name: "b",
                up: MigrationStep::Sql("CREATE TABLE b (y INTEGER); INSERT INTO a VALUES (7); SELECT * FROM no_such_table"),
            },
        ];
        let mut c = mem();
        let err = migrate(&mut c, BAD).unwrap_err();
        assert!(matches!(err, StorageError::MigrationFailed { version: 2, .. }), "{err:?}");
        assert_eq!(current_version(&c).unwrap(), 1);
        assert!(!tables(&c).contains(&"b".to_string()));
        let n: u32 = c.query_row("SELECT COUNT(*) FROM a", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        // the fixed build applies it on the next start
        assert_eq!(migrate(&mut c, EXTRA).unwrap(), vec![2]);
    }

    #[test]
    fn rust_step_runs_in_the_transaction() {
        fn fill(tx: &Transaction) -> rusqlite::Result<()> {
            tx.execute("INSERT INTO a VALUES (42)", []).map(|_| ())
        }
        let list = [
            Migration { version: 1, name: "a", up: MigrationStep::Sql("CREATE TABLE a (x INTEGER)") },
            Migration { version: 2, name: "fill", up: MigrationStep::Rust(fill) },
        ];
        let mut c = mem();
        migrate(&mut c, &list).unwrap();
        let x: i64 = c.query_row("SELECT x FROM a", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42);
    }

    #[test]
    fn newer_schema_is_refused_untouched() {
        let mut c = mem();
        migrate(&mut c, EXTRA).unwrap();
        let err = migrate(&mut c, &EXTRA[..1]).unwrap_err();
        assert!(matches!(err, StorageError::SchemaNewer { db: 2, app: 1 }), "{err:?}");
        assert!(matches!(pending(&c, &EXTRA[..1]), Err(StorageError::SchemaNewer { .. })));
        assert_eq!(current_version(&c).unwrap(), 2);
    }

    #[test]
    fn edited_history_is_detected() {
        let mut c = mem();
        migrate(&mut c, &EXTRA[..1]).unwrap();
        let renamed = [Migration { version: 1, name: "renamed", up: MigrationStep::Sql("SELECT 1") }];
        assert!(matches!(migrate(&mut c, &renamed), Err(StorageError::MigrationMismatch { version: 1, .. })));
        let gap = [Migration { version: 2, name: "x", up: MigrationStep::Sql("SELECT 1") }];
        assert!(matches!(migrate(&mut c, &gap), Err(StorageError::MigrationMismatch { .. })));
    }

    #[test]
    fn v1_constraints() {
        let mut c = mem();
        migrate(&mut c, MIGRATIONS).unwrap();
        // a media row needs a path or a URL; an unknown kind is rejected
        assert!(c.execute("INSERT INTO media (id, name, added_at, updated_at) VALUES ('x', 'n', 0, 0)", []).is_err());
        assert!(
            c.execute("INSERT INTO media (id, path, kind, name, added_at, updated_at) VALUES ('x', 'p', 'doc', 'n', 0, 0)", [])
                .is_err()
        );
        c.execute("INSERT INTO media (id, path, name, added_at, updated_at) VALUES ('m', 'p', 'n', 0, 0)", []).unwrap();
        c.execute("INSERT INTO recent (media_id, position, opened_at) VALUES ('m', 0, 0)", []).unwrap();
        c.execute("DELETE FROM media WHERE id = 'm'", []).unwrap();
        let n: u32 = c.query_row("SELECT COUNT(*) FROM recent", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "recent rows follow their media row (foreign keys on)");
    }
}
