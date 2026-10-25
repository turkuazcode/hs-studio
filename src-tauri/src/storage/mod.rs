//! Shared SQLite storage (library.db) — Plan 13/L01.
//!
//! * One file `library.db` in the data folder (`platform::data_dir`, i.e. VHO_DATA_DIR in
//!   tests), next to settings.json. settings.json stays the settings store.
//! * Schema owner: [`migrations`]. Other modules (A02 jobs, L02 library) add tables by
//!   appending a migration there, never with their own `CREATE TABLE`.
//! * Connection model: one read/write connection behind a mutex ([`Storage::read`] /
//!   [`Storage::write`]); WAL journal, so a later background worker may open its own
//!   read-only connection with [`Storage::open_reader`]. Every write is one IMMEDIATE
//!   transaction; long scans use [`Storage::write_batches`] (short transactions).
//! * Safety: a versioned backup (SQLite online backup) before every schema migration and
//!   periodically; a corrupt database is moved aside (never deleted), the newest healthy
//!   backup is restored, otherwise a new database is created and re-filled from the old
//!   JSON files (which the import never deletes).
//!
//! Architecture note: docs/storage-schema.md.

pub mod identity;
pub mod library;
pub mod migrations;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode, OpenFlags, Transaction, TransactionBehavior};
use serde::Serialize;

pub const DB_FILE: &str = "library.db";
pub const BACKUP_DIR: &str = "backups";
/// Database backups kept (oldest removed first). JSON pre-import copies are never pruned.
const BACKUPS_KEPT: usize = 5;
/// A periodic safety backup when the newest one is older than this.
const PERIODIC_BACKUP_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

#[derive(Debug)]
pub enum StorageError {
    /// The database was written by a newer VHO (schema `db` > `app`); it is left untouched.
    SchemaNewer { db: u32, app: u32 },
    /// The applied history does not match this build's migration list.
    MigrationMismatch { version: u32, name: String },
    /// A migration failed and was rolled back.
    MigrationFailed { version: u32, detail: String },
    /// Corrupt and no healthy backup / new database could be created.
    Corrupt(String),
    /// Imported data did not verify; the import was rolled back.
    ImportVerify(String),
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Other(String),
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            StorageError::SchemaNewer { .. } => "schemaNewer",
            StorageError::MigrationMismatch { .. } => "migrationMismatch",
            StorageError::MigrationFailed { .. } => "migrationFailed",
            StorageError::Corrupt(_) => "corrupt",
            StorageError::ImportVerify(_) => "importVerify",
            StorageError::Sqlite(_) | StorageError::Io(_) | StorageError::Other(_) => "unavailable",
        }
    }

    /// The file is damaged (as opposed to locked, missing permission, newer schema...).
    fn is_corruption(&self) -> bool {
        match self {
            StorageError::Corrupt(_) => true,
            StorageError::Sqlite(e) => {
                matches!(e.sqlite_error_code(), Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase))
            }
            _ => false,
        }
    }
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StorageError::SchemaNewer { db, app } => {
                write!(f, "library.db schema v{db} is newer than this build (v{app}); not opened")
            }
            StorageError::MigrationMismatch { version, name } => write!(f, "migration history mismatch at v{version} ({name})"),
            StorageError::MigrationFailed { version, detail } => write!(f, "migration v{version} failed: {detail}"),
            StorageError::Corrupt(d) => write!(f, "library.db is corrupt: {d}"),
            StorageError::ImportVerify(d) => write!(f, "legacy import did not verify: {d}"),
            StorageError::Sqlite(e) => write!(f, "sqlite: {e}"),
            StorageError::Io(e) => write!(f, "io: {e}"),
            StorageError::Other(e) => f.write_str(e),
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e)
    }
}

/// Sent to the frontend as `{ code, message }`.
impl Serialize for StorageError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("StorageError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// How the database was opened (shown to the user only when something was repaired).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    pub schema_version: u32,
    pub app_schema_version: u32,
    pub created: bool,
    pub migrated: Vec<u32>,
    /// "backup" (restored from `restored_from`) or "fresh" (new database, re-imported).
    pub recovered: Option<String>,
    pub restored_from: Option<String>,
    /// Where the damaged file was moved.
    pub quarantined: Option<String>,
    /// Backup written during this open (before a migration / periodic).
    pub backup: Option<String>,
    pub imported: Option<library::ImportReport>,
}

pub struct Storage {
    conn: Mutex<Connection>,
    path: PathBuf,
    dir: PathBuf,
    pub report: OpenReport,
}

fn configure(conn: &Connection) -> Result<(), StorageError> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    // WAL: readers do not block the writer; FULL sync: committed data survives a power cut
    let _: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

fn quick_check(conn: &Connection) -> Result<(), StorageError> {
    let mut stmt = conn.prepare("PRAGMA quick_check")?;
    let rows: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    if rows.len() == 1 && rows[0] == "ok" { Ok(()) } else { Err(StorageError::Corrupt(rows.join("; "))) }
}

/// Opens and verifies an existing or new database file.
fn open_checked(path: &Path) -> Result<Connection, StorageError> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    quick_check(&conn)?;
    Ok(conn)
}

fn sidecars(path: &Path) -> [PathBuf; 2] {
    let s = path.as_os_str().to_owned();
    let with = |ext: &str| {
        let mut p = s.clone();
        p.push(ext);
        PathBuf::from(p)
    };
    [with("-wal"), with("-shm")]
}

impl Storage {
    /// Opens `dir/library.db`: recovery, backup, migrations, one-time legacy JSON import.
    pub fn open(dir: &Path) -> Result<Storage, StorageError> {
        Self::open_with(dir, migrations::MIGRATIONS)
    }

    fn open_with(dir: &Path, list: &[migrations::Migration]) -> Result<Storage, StorageError> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(DB_FILE);
        let mut report = OpenReport { app_schema_version: list.last().map_or(0, |m| m.version), ..Default::default() };
        report.created = !path.exists();

        let mut conn = match open_checked(&path) {
            Ok(c) => c,
            Err(e) if e.is_corruption() => Self::recover(dir, &path, &mut report, list)?,
            Err(e) => return Err(e),
        };

        let current = migrations::current_version(&conn)?;
        let pending = migrations::pending(&conn, list)?; // SchemaNewer: untouched
        if !pending.is_empty() && current >= 1 {
            report.backup = Some(backup_to(&conn, dir, current, "pre-migration")?.to_string_lossy().into_owned());
        }
        report.migrated = migrations::migrate(&mut conn, list)?;
        report.schema_version = migrations::current_version(&conn)?;

        let mut storage = Storage { conn: Mutex::new(conn), path, dir: dir.to_path_buf(), report };
        storage.report.imported = library::import_legacy(&storage, dir)?;
        if storage.report.backup.is_none() && storage.backup_is_due() {
            storage.report.backup = storage.backup_now("periodic").ok().map(|p| p.to_string_lossy().into_owned());
        }
        Ok(storage)
    }

    /// Moves the damaged file aside and restores the newest healthy backup (or starts empty).
    fn recover(
        dir: &Path,
        path: &Path,
        report: &mut OpenReport,
        list: &[migrations::Migration],
    ) -> Result<Connection, StorageError> {
        let stamp = now_ms();
        let quarantine = dir.join(format!("{DB_FILE}.corrupt-{stamp}"));
        std::fs::rename(path, &quarantine)?;
        for (side, suffix) in sidecars(path).iter().zip(["-wal", "-shm"]) {
            if side.exists() {
                let _ = std::fs::rename(side, dir.join(format!("{DB_FILE}.corrupt-{stamp}{suffix}")));
            }
        }
        report.quarantined = Some(quarantine.to_string_lossy().into_owned());
        let latest = list.last().map_or(0, |m| m.version);
        for backup in list_backups(dir) {
            if std::fs::copy(&backup, path).is_err() {
                continue;
            }
            match open_checked(path) {
                Ok(c) if migrations::current_version(&c).is_ok_and(|v| v <= latest) => {
                    report.recovered = Some("backup".into());
                    report.restored_from = Some(backup.to_string_lossy().into_owned());
                    return Ok(c);
                }
                Ok(c) => drop(c),
                Err(_) => {}
            }
            let _ = std::fs::remove_file(path);
            for side in sidecars(path) {
                let _ = std::fs::remove_file(side);
            }
        }
        report.recovered = Some("fresh".into());
        report.created = true;
        open_checked(path).map_err(|e| StorageError::Corrupt(format!("cannot create a new database: {e}")))
    }

    #[allow(dead_code)] // API for A02/L02 (diagnostics, reader connections)
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` on the shared connection (reads; no transaction).
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, StorageError> {
        Ok(f(&self.lock())?)
    }

    /// Runs `f` in one IMMEDIATE transaction; any error rolls everything back.
    pub fn write<T>(&self, f: impl FnOnce(&Transaction) -> Result<T, StorageError>) -> Result<T, StorageError> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Large imports/scans: `batch` items per transaction, so the lock is released between
    /// batches and an interruption keeps every completed batch consistent.
    /// Returns the number of items written.
    #[allow(dead_code)] // API for L02 scans / A02 queue
    pub fn write_batches<I>(
        &self,
        items: impl IntoIterator<Item = I>,
        batch: usize,
        mut f: impl FnMut(&Transaction, I) -> Result<(), StorageError>,
    ) -> Result<usize, StorageError> {
        let mut it = items.into_iter().peekable();
        let mut n = 0;
        while it.peek().is_some() {
            n += self.write(|tx| {
                let mut k = 0;
                for item in it.by_ref().take(batch.max(1)) {
                    f(tx, item)?;
                    k += 1;
                }
                Ok(k)
            })?;
        }
        Ok(n)
    }

    /// A separate read-only connection (e.g. for a worker thread). WAL lets it read while the
    /// main connection writes.
    #[allow(dead_code)] // API for A02/L02 workers
    pub fn open_reader(&self) -> Result<Connection, StorageError> {
        let c = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        c.busy_timeout(Duration::from_secs(5))?;
        Ok(c)
    }

    /// Versioned online backup into `backups/` (consistent even while in use).
    pub fn backup_now(&self, reason: &str) -> Result<PathBuf, StorageError> {
        let conn = self.lock();
        let v = migrations::current_version(&conn)?;
        backup_to(&conn, &self.dir, v, reason)
    }

    fn backup_is_due(&self) -> bool {
        let has_data = self
            .read(|c| c.query_row("SELECT EXISTS (SELECT 1 FROM media) OR EXISTS (SELECT 1 FROM resume_positions)", [], |r| r.get::<_, bool>(0)))
            .unwrap_or(false);
        if !has_data {
            return false;
        }
        let newest = list_backups(&self.dir).into_iter().next().and_then(|p| p.metadata().ok()?.modified().ok());
        newest.is_none_or(|t| t.elapsed().is_ok_and(|age| age > PERIODIC_BACKUP_AGE))
    }
}

/// `backups/library-v{version}-{unix ms}.db`, newest first.
pub fn list_backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(i64, PathBuf)> = std::fs::read_dir(dir.join(BACKUP_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = name.strip_prefix("library-v")?.strip_suffix(".db")?;
            let (_, ts) = stem.split_once('-')?;
            Some((ts.split('-').next()?.parse().ok()?, e.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

fn backup_to(conn: &Connection, dir: &Path, version: u32, reason: &str) -> Result<PathBuf, StorageError> {
    let bdir = dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&bdir)?;
    let mut stamp = now_ms();
    let mut dest = bdir.join(format!("library-v{version}-{stamp}-{reason}.db"));
    while dest.exists() {
        stamp += 1;
        dest = bdir.join(format!("library-v{version}-{stamp}-{reason}.db"));
    }
    let tmp = dest.with_extension("db.part");
    {
        let mut out = Connection::open(&tmp)?;
        let b = rusqlite::backup::Backup::new(conn, &mut out)?;
        b.run_to_completion(256, Duration::from_millis(0), None)?;
        drop(b);
        // a self-contained file (no -wal next to it)
        let _: String = out.pragma_update_and_check(None, "journal_mode", "DELETE", |r| r.get(0))?;
        quick_check(&out)?;
    }
    std::fs::rename(&tmp, &dest)?;
    for old in list_backups(dir).into_iter().skip(BACKUPS_KEPT) {
        let _ = std::fs::remove_file(old);
    }
    Ok(dest)
}

/// Copies a legacy JSON file into `backups/` before it is imported (never pruned).
fn backup_file(dir: &Path, file: &Path) -> Result<Option<PathBuf>, StorageError> {
    if !file.is_file() {
        return Ok(None);
    }
    let bdir = dir.join(BACKUP_DIR);
    std::fs::create_dir_all(&bdir)?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dest = bdir.join(format!("{name}.{}.pre-db.bak", now_ms()));
    std::fs::copy(file, &dest)?;
    Ok(Some(dest))
}

// --------------------------------------------------------------------------------------
// Tauri side: lazily opened shared instance + commands
// --------------------------------------------------------------------------------------

/// Managed state: the database is opened on first use (from the frontend's first
/// `library_load`), so start-up never waits for it. A failed open is remembered for the
/// session; the frontend then keeps working on the JSON store.
#[derive(Default)]
pub struct StorageState(Mutex<Option<Result<Arc<Storage>, Arc<StorageError>>>>);

impl StorageState {
    pub fn get(&self, dir: impl FnOnce() -> Result<PathBuf, String>) -> Result<Arc<Storage>, Arc<StorageError>> {
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            let opened = dir().map_err(StorageError::Other).and_then(|d| Storage::open(&d));
            if let Err(e) = &opened {
                eprintln!("[storage] {e}");
            }
            *slot = Some(opened.map(Arc::new).map_err(Arc::new));
        }
        slot.as_ref().expect("set above").clone()
    }
}

/// Serializable wrapper for an `Arc<StorageError>`.
#[derive(Debug)]
pub struct SharedError(Arc<StorageError>);

impl Serialize for SharedError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(s)
    }
}

impl From<StorageError> for SharedError {
    fn from(e: StorageError) -> Self {
        SharedError(Arc::new(e))
    }
}

fn storage(app: &tauri::AppHandle) -> Result<Arc<Storage>, SharedError> {
    use tauri::Manager;
    let state = app.state::<StorageState>();
    state.get(|| crate::platform::data_dir(app)).map_err(SharedError)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, SharedError> + Send + 'static,
) -> Result<T, SharedError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| SharedError::from(StorageError::Other(e.to_string())))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLoad {
    doc: library::LibraryDoc,
    report: OpenReport,
}

/// Library document for src/core/library.js (recent, resume, bookmarks, favorites).
#[tauri::command]
pub async fn library_load(app: tauri::AppHandle) -> Result<LibraryLoad, SharedError> {
    blocking(move || {
        let s = storage(&app)?;
        let doc = s.read(library::load_doc)?;
        Ok(LibraryLoad { doc, report: s.report.clone() })
    })
    .await
}

/// Replaces the library document in one transaction.
#[tauri::command]
pub async fn library_save(app: tauri::AppHandle, doc: library::LibraryDoc) -> Result<(), SharedError> {
    blocking(move || {
        let s = storage(&app)?;
        s.write(|tx| library::save_doc(tx, &doc))?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vho-storage-{tag}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn empty_install_creates_schema_without_backup() {
        let dir = temp_dir("empty");
        let s = Storage::open(&dir).unwrap();
        assert!(s.report.created);
        assert_eq!(s.report.schema_version, migrations::latest_version());
        assert!(s.report.backup.is_none() && s.report.recovered.is_none());
        assert!(dir.join(DB_FILE).exists());
        drop(s);
        // second start: nothing to do
        let s = Storage::open(&dir).unwrap();
        assert!(!s.report.created && s.report.migrated.is_empty() && s.report.imported.is_none());
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_makes_a_versioned_backup_first() {
        use migrations::{Migration, MigrationStep::Sql};
        let v1 = [Migration { version: 1, name: "core", up: migrations::MIGRATIONS[0].up }];
        let dir = temp_dir("backup");
        let s = Storage::open_with(&dir, &v1).unwrap();
        s.write(|tx| Ok(tx.execute("INSERT INTO meta VALUES ('probe', 'kept')", [])?)).unwrap();
        drop(s);
        let v2 = [
            Migration { version: 1, name: "core", up: migrations::MIGRATIONS[0].up },
            Migration { version: 2, name: "jobs", up: Sql("CREATE TABLE jobs (id TEXT PRIMARY KEY)") },
        ];
        let s = Storage::open_with(&dir, &v2).unwrap();
        assert_eq!(s.report.migrated, vec![2]);
        let backup = PathBuf::from(s.report.backup.clone().expect("backup before migration"));
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("library-v1-"));
        // the backup is a complete v1 database with the data
        let b = Connection::open(&backup).unwrap();
        assert_eq!(migrations::current_version(&b).unwrap(), 1);
        let v: String = b.query_row("SELECT value FROM meta WHERE key = 'probe'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "kept");
        drop((b, s));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn newer_schema_is_not_opened_or_changed() {
        use migrations::{Migration, MigrationStep::Sql};
        let dir = temp_dir("newer");
        let v2 = [
            Migration { version: 1, name: "core", up: migrations::MIGRATIONS[0].up },
            Migration { version: 2, name: "future", up: Sql("CREATE TABLE future (x)") },
        ];
        drop(Storage::open_with(&dir, &v2).unwrap());
        let before = std::fs::read(dir.join(DB_FILE)).unwrap();
        let err = Storage::open_with(&dir, &v2[..1]).err().expect("must refuse");
        assert!(matches!(err, StorageError::SchemaNewer { db: 2, app: 1 }), "{err:?}");
        assert_eq!(err.code(), "schemaNewer");
        assert_eq!(std::fs::read(dir.join(DB_FILE)).unwrap(), before, "file untouched");
        assert!(!dir.join(BACKUP_DIR).exists() || list_backups(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn corrupt(path: &Path) {
        // overwrite the header and the first pages
        let mut bytes = std::fs::read(path).unwrap();
        for b in bytes.iter_mut().take(4096) {
            *b = 0x5a;
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn checkpoint(s: &Storage) {
        s.read(|c| c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))).unwrap();
    }

    #[test]
    fn corrupt_db_is_quarantined_and_restored_from_backup() {
        let dir = temp_dir("corrupt");
        let s = Storage::open(&dir).unwrap();
        s.write(|tx| Ok(tx.execute("INSERT INTO meta VALUES ('probe', 'from-backup')", [])?)).unwrap();
        s.backup_now("test").unwrap();
        s.write(|tx| Ok(tx.execute("UPDATE meta SET value = 'after-backup' WHERE key = 'probe'", [])?)).unwrap();
        checkpoint(&s);
        drop(s);
        corrupt(&dir.join(DB_FILE));

        let s = Storage::open(&dir).unwrap();
        assert_eq!(s.report.recovered.as_deref(), Some("backup"));
        let q = PathBuf::from(s.report.quarantined.clone().unwrap());
        assert!(q.exists(), "damaged file kept for inspection");
        let v: String = s.read(|c| c.query_row("SELECT value FROM meta WHERE key = 'probe'", [], |r| r.get(0))).unwrap();
        assert_eq!(v, "from-backup");
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_db_without_backup_starts_fresh() {
        let dir = temp_dir("fresh");
        std::fs::write(dir.join(DB_FILE), b"this is not a database at all, just text..........").unwrap();
        let s = Storage::open(&dir).unwrap();
        assert_eq!(s.report.recovered.as_deref(), Some("fresh"));
        assert!(PathBuf::from(s.report.quarantined.clone().unwrap()).exists());
        assert_eq!(s.report.schema_version, migrations::latest_version());
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_backups_are_skipped() {
        let dir = temp_dir("badbackup");
        let s = Storage::open(&dir).unwrap();
        s.write(|tx| Ok(tx.execute("INSERT INTO meta VALUES ('probe', 'old-good')", [])?)).unwrap();
        s.backup_now("a").unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let newest = s.backup_now("b").unwrap();
        checkpoint(&s);
        drop(s);
        corrupt(&newest);
        corrupt(&dir.join(DB_FILE));
        let s = Storage::open(&dir).unwrap();
        assert_eq!(s.report.recovered.as_deref(), Some("backup"));
        assert!(!s.report.restored_from.as_deref().unwrap().ends_with(&*newest.file_name().unwrap().to_string_lossy()));
        drop(s);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backups_are_pruned_and_batches_commit_separately() {
        let dir = temp_dir("prune");
        let s = Storage::open(&dir).unwrap();
        for i in 0..(BACKUPS_KEPT + 3) {
            s.backup_now(&format!("n{i}")).unwrap();
        }
        assert_eq!(list_backups(&dir).len(), BACKUPS_KEPT);

        // batch 3 fails: batches 1-2 stay, nothing of batch 3
        let r = s.write_batches(0..10, 4, |tx, i| {
            if i == 9 {
                return Err(StorageError::Other("stop".into()));
            }
            tx.execute("INSERT INTO meta VALUES (?1, 'x')", [format!("k{i}")])?;
            Ok(())
        });
        assert!(r.is_err());
        let n: u32 = s.read(|c| c.query_row("SELECT COUNT(*) FROM meta WHERE key LIKE 'k%'", [], |r| r.get(0))).unwrap();
        assert_eq!(n, 8);
        // a reader connection sees committed data
        let rd = s.open_reader().unwrap();
        let n: u32 = rd.query_row("SELECT COUNT(*) FROM meta WHERE key LIKE 'k%'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 8);
        drop((rd, s));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn error_serializes_with_code() {
        let e = serde_json::to_value(StorageError::SchemaNewer { db: 3, app: 1 }).unwrap();
        assert_eq!(e["code"], "schemaNewer");
        assert!(e["message"].as_str().unwrap().contains("v3"));
    }
}
