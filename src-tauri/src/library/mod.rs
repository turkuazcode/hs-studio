//! Persistent media library (Plan 13/L02) on top of the shared storage (library.db).
//!
//! * [`folders`]: library folders ("Kütüphaneye ekle") and favorite folders.
//! * [`scan`]: incremental scan / reconciliation (the source of truth).
//! * [`watch`]: file system watcher (accelerator only).
//! * [`ops`]: operation log for D1 rename/trash and detected moves.
//! * [`query`]: the shared query (video / music / photo ratings+tags / FTS search).
//! * [`playlist`]: saved playlists, M3U/M3U8/PLS.
//!
//! Threads: one scan worker (jobs are merged and run one at a time, so the same folder is
//! never scanned twice concurrently), one debounce thread for watcher events and one timer
//! (periodic reconciliation, offline folders coming back). Commands run on the blocking pool;
//! nothing here runs on the UI thread.

pub mod folders;
pub mod ops;
pub mod playlist;
pub mod query;
pub mod scan;
pub mod watch;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::{Storage, StorageError, StorageState};

use scan::{Dir, Limits, ScanReport, Target};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// Use the file system watcher (reconciliation runs regardless).
    pub watch: bool,
    /// Periodic reconciliation of all library folders; 0 = only at start and on request.
    pub reconcile_minutes: u32,
}

impl Default for Options {
    fn default() -> Self {
        Options { watch: true, reconcile_minutes: 30 }
    }
}

enum Job {
    /// None = every library folder.
    Full(Option<Vec<String>>),
    Dirs(Vec<(PathBuf, Vec<Dir>)>),
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub last: Option<ScanReport>,
    pub watching: Vec<String>,
}

#[derive(Default)]
struct Inner {
    app: OnceLock<AppHandle>,
    storage: OnceLock<Arc<Storage>>,
    queue: Mutex<Vec<Job>>,
    wake: Condvar,
    cancel: AtomicBool,
    status: Mutex<Status>,
    watcher: Mutex<Option<watch::FolderWatcher>>,
    options: Mutex<Options>,
    start: Mutex<bool>,
}

/// Managed state (lib.rs). Started by the first library command.
#[derive(Default, Clone)]
pub struct LibraryState(Arc<Inner>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanEvent<'a> {
    state: &'a str,
    phase: &'a str,
    done: usize,
    total: usize,
    report: Option<&'a ScanReport>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedEvent<'a> {
    moves: &'a [ops::Moved],
    folders: bool,
}

fn storage_of(app: &AppHandle) -> Result<Arc<Storage>, String> {
    app.state::<StorageState>().get(|| crate::platform::data_dir(app)).map_err(|e| format!("[{}] {e}", e.code()))
}

impl LibraryState {
    /// Opens the storage and starts the worker threads once.
    fn ensure(&self, app: &AppHandle) -> Result<Arc<Storage>, String> {
        let storage = storage_of(app)?;
        let mut started = self.0.start.lock().unwrap_or_else(|e| e.into_inner());
        if *started {
            return Ok(storage);
        }
        *started = true;
        let _ = self.0.app.set(app.clone());
        let _ = self.0.storage.set(storage.clone());
        // operations interrupted by a crash, FTS consistency
        match ops::reconcile_pending(&storage) {
            Ok((_, _, moves)) if !moves.is_empty() => self.changed(&moves, false),
            Ok(_) => {}
            Err(e) => eprintln!("[library] pending operations: {e}"),
        }
        if let Err(e) = storage.read(query::check_fts) {
            eprintln!("[library] fts check: {e}");
        }
        let me = self.clone();
        std::thread::Builder::new().name("vho-library-scan".into()).spawn(move || me.worker()).map_err(|e| e.to_string())?;
        let me = self.clone();
        std::thread::Builder::new().name("vho-library-timer".into()).spawn(move || me.timer()).map_err(|e| e.to_string())?;
        Ok(storage)
    }

    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.0.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn changed(&self, moves: &[ops::Moved], folders: bool) {
        self.emit("library-changed", ChangedEvent { moves, folders });
    }

    fn push(&self, job: Job) {
        self.0.queue.lock().unwrap_or_else(|e| e.into_inner()).push(job);
        self.0.wake.notify_all();
    }

    fn worker(&self) {
        let Some(storage) = self.0.storage.get().cloned() else { return };
        loop {
            let jobs = {
                let mut q = self.0.queue.lock().unwrap_or_else(|e| e.into_inner());
                while q.is_empty() {
                    q = self.0.wake.wait(q).unwrap_or_else(|e| e.into_inner());
                }
                std::mem::take(&mut *q)
            };
            // let a burst of requests (watcher + button) settle into one pass
            std::thread::sleep(Duration::from_millis(50));
            let mut jobs = jobs;
            jobs.extend(std::mem::take(&mut *self.0.queue.lock().unwrap_or_else(|e| e.into_inner())));
            let targets = match self.targets(&storage, jobs) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[library] {e}");
                    continue;
                }
            };
            if targets.is_empty() {
                self.refresh_watch(&storage);
                continue;
            }
            self.0.cancel.store(false, Ordering::SeqCst);
            {
                let mut st = self.0.status.lock().unwrap_or_else(|e| e.into_inner());
                st.running = true;
                st.phase = "walk".into();
                st.done = 0;
                st.total = 0;
            }
            self.emit("library-scan", ScanEvent { state: "running", phase: "walk", done: 0, total: 0, report: None });
            let mut last_emit = Instant::now();
            let me = self.clone();
            let mut progress = |p: scan::Progress| {
                {
                    let mut st = me.0.status.lock().unwrap_or_else(|e| e.into_inner());
                    st.phase = p.phase.into();
                    st.done = p.done;
                    st.total = p.total;
                }
                if last_emit.elapsed() > Duration::from_millis(200) {
                    last_emit = Instant::now();
                    me.emit("library-scan", ScanEvent { state: "running", phase: p.phase, done: p.done, total: p.total, report: None });
                }
            };
            let result = scan::scan(&storage, &targets, Limits::default(), &self.0.cancel, &mut progress);
            let report = match result {
                Ok(r) => r,
                Err(e) => ScanReport { errors: vec![e.to_string()], ..Default::default() },
            };
            if !report.moves.is_empty() {
                self.changed(&report.moves, false);
            }
            {
                let mut st = self.0.status.lock().unwrap_or_else(|e| e.into_inner());
                st.running = false;
                st.last = Some(report.clone());
            }
            let state = if report.cancelled { "cancelled" } else { "done" };
            self.emit("library-scan", ScanEvent { state, phase: "", done: report.found, total: report.found, report: Some(&report) });
            self.refresh_watch(&storage);
        }
    }

    fn targets(&self, storage: &Storage, jobs: Vec<Job>) -> Result<Vec<Target>, StorageError> {
        let all = storage.read(folders::library_folders)?;
        let target = |f: &folders::Folder, dirs| Target { folder_id: f.id.clone(), root: PathBuf::from(&f.path), dirs };
        if jobs.iter().any(|j| matches!(j, Job::Full(None))) {
            return Ok(all.iter().map(|f| target(f, None)).collect());
        }
        let mut out: Vec<Target> = Vec::new();
        let mut full: Vec<String> = Vec::new();
        for j in &jobs {
            if let Job::Full(Some(ids)) = j {
                full.extend(ids.iter().cloned());
            }
        }
        for f in &all {
            if full.contains(&f.id) {
                out.push(target(f, None));
            }
        }
        for j in jobs {
            let Job::Dirs(list) = j else { continue };
            for (root, dirs) in list {
                let Some(f) = all.iter().find(|f| Path::new(&f.path) == root) else { continue };
                if full.contains(&f.id) {
                    continue;
                }
                match out.iter_mut().find(|t| t.folder_id == f.id) {
                    Some(Target { dirs: Some(existing), .. }) => {
                        for d in dirs {
                            if !existing.contains(&d) {
                                existing.push(d);
                            }
                        }
                    }
                    Some(_) => {}
                    None => out.push(target(f, Some(dirs))),
                }
            }
        }
        Ok(out)
    }

    /// Watches the online library folders (when the watcher is enabled).
    fn refresh_watch(&self, storage: &Storage) {
        let opts = *self.0.options.lock().unwrap_or_else(|e| e.into_inner());
        let mut w = self.0.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if !opts.watch {
            *w = None;
            self.0.status.lock().unwrap_or_else(|e| e.into_inner()).watching.clear();
            return;
        }
        if w.is_none() {
            let (tx, rx) = channel();
            match watch::start(tx) {
                Ok(fw) => {
                    *w = Some(fw);
                    let me = self.clone();
                    let _ = std::thread::Builder::new().name("vho-library-watch".into()).spawn(move || {
                        let roots_me = me.clone();
                        watch::debounce(
                            rx,
                            move || {
                                roots_me.0.watcher.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|w| w.roots().to_vec()).unwrap_or_default()
                            },
                            |batch| match batch {
                                watch::Batch::Dirs(d) if !d.is_empty() => me.push(Job::Dirs(d)),
                                watch::Batch::Dirs(_) => {}
                                watch::Batch::Full(None) => me.push(Job::Full(None)),
                                watch::Batch::Full(Some(roots)) => {
                                    let ids = me.ids_of_roots(&roots);
                                    me.push(Job::Full(Some(ids)));
                                }
                            },
                        );
                    });
                }
                Err(e) => {
                    eprintln!("[library] watcher unavailable: {e}");
                    return;
                }
            }
        }
        let roots: Vec<PathBuf> = storage
            .read(folders::library_folders)
            .unwrap_or_default()
            .into_iter()
            .filter(|f| f.status == "online")
            .map(|f| PathBuf::from(f.path))
            .collect();
        if let Some(fw) = w.as_mut() {
            fw.set_roots(&roots);
            self.0.status.lock().unwrap_or_else(|e| e.into_inner()).watching =
                fw.roots().iter().map(|r| r.to_string_lossy().into_owned()).collect();
        }
    }

    fn ids_of_roots(&self, roots: &[PathBuf]) -> Vec<String> {
        let Some(s) = self.0.storage.get() else { return vec![] };
        s.read(folders::library_folders)
            .unwrap_or_default()
            .into_iter()
            .filter(|f| roots.iter().any(|r| Path::new(&f.path) == r))
            .map(|f| f.id)
            .collect()
    }

    /// Start-up reconciliation, periodic reconciliation, offline folders coming back.
    fn timer(&self) {
        let Some(storage) = self.0.storage.get().cloned() else { return };
        std::thread::sleep(Duration::from_secs(2));
        self.push(Job::Full(None));
        let mut last_full = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(20));
            let opts = *self.0.options.lock().unwrap_or_else(|e| e.into_inner());
            if opts.reconcile_minutes > 0 && last_full.elapsed() >= Duration::from_secs(opts.reconcile_minutes as u64 * 60) {
                last_full = Instant::now();
                self.push(Job::Full(None));
                continue;
            }
            // a disk / share that came back, or a folder restored
            let back: Vec<String> = storage
                .read(folders::library_folders)
                .unwrap_or_default()
                .into_iter()
                .filter(|f| f.status != "online" && scan::root_state(Path::new(&f.path)) == scan::RootState::Online)
                .map(|f| f.id)
                .collect();
            // ... or one that went away while nothing was being scanned
            let gone: Vec<String> = storage
                .read(folders::library_folders)
                .unwrap_or_default()
                .into_iter()
                .filter(|f| f.status == "online" && scan::root_state(Path::new(&f.path)) != scan::RootState::Online)
                .map(|f| f.id)
                .collect();
            let ids: Vec<String> = back.into_iter().chain(gone).collect();
            if !ids.is_empty() {
                self.push(Job::Full(Some(ids)));
            }
        }
    }
}

// --------------------------------------------------------------------------------------
// D1 hooks (actions::file_rename / file_trash): operation log around the disk change
// --------------------------------------------------------------------------------------

/// Renames through `f` (the disk operation) with a pending → done/failed operation record,
/// moving the media identity, resume position and bookmarks to the new name.
pub fn tracked_rename(app: &AppHandle, path: &str, new_name: &str, f: impl FnOnce() -> Result<PathBuf, String>) -> Result<PathBuf, String> {
    let storage = storage_of(app).ok();
    let target = Path::new(path).parent().map(|d| d.join(new_name).to_string_lossy().into_owned());
    let op = storage.as_ref().and_then(|s| s.write(|tx| Ok(ops::begin(tx, "rename", path, target.as_deref())?)).ok());
    let result = f();
    if let (Some(s), Some(id)) = (storage, op) {
        let r = match &result {
            Ok(new_path) => s.write(|tx| Ok(ops::finish_rename(tx, id, path, &new_path.to_string_lossy())?)).map(|_| ()),
            Err(_) => s.write(|tx| Ok(ops::fail(tx, id)?)),
        };
        if let Err(e) = r {
            // the pending record stays; the next start reconciles it
            eprintln!("[library] rename record: {e}");
        }
    }
    result
}

/// Moves a file to the recycle bin through `f`; the media row becomes `deleted`.
pub fn tracked_trash(app: &AppHandle, path: &str, f: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let storage = storage_of(app).ok();
    let op = storage.as_ref().and_then(|s| s.write(|tx| Ok(ops::begin(tx, "trash", path, None)?)).ok());
    let result = f();
    if let (Some(s), Some(id)) = (storage, op) {
        let r = match &result {
            Ok(()) => s.write(|tx| Ok(ops::finish_trash(tx, id, path)?)),
            Err(_) => s.write(|tx| Ok(ops::fail(tx, id)?)),
        };
        if let Err(e) = r {
            eprintln!("[library] trash record: {e}");
        }
    }
    result
}

// --------------------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------------------

type Res<T> = Result<T, String>;

async fn run<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&LibraryState, &Storage) -> Result<T, StorageError> + Send + 'static,
) -> Res<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LibraryState>().inner().clone();
        let storage = state.ensure(&app)?;
        f(&state, &storage).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_folders(app: AppHandle) -> Res<Vec<folders::Folder>> {
    run(app, |_, s| Ok(s.read(folders::library_folders)?)).await
}

/// "Kütüphaneye ekle": adds a persistent library folder and scans it.
#[tauri::command]
pub async fn library_add_folder(app: AppHandle, path: String) -> Res<folders::AddResult> {
    run(app, move |st, s| {
        let r = s.write(|tx| folders::add(tx, &path))?;
        if r.status != "covered" {
            st.push(Job::Full(Some(vec![r.folder.id.clone()])));
        }
        st.changed(&[], true);
        Ok(r)
    })
    .await
}

#[tauri::command]
pub async fn library_remove_folder(app: AppHandle, id: String) -> Res<usize> {
    run(app, move |st, s| {
        st.0.cancel.store(true, Ordering::SeqCst);
        let n = s.write(|tx| folders::remove(tx, &id))?;
        st.refresh_watch(s);
        st.changed(&[], true);
        Ok(n)
    })
    .await
}

/// Manual reconciliation (all folders or one).
#[tauri::command]
pub async fn library_rescan(app: AppHandle, folder_id: Option<String>) -> Res<()> {
    run(app, move |st, _| {
        st.push(Job::Full(folder_id.map(|id| vec![id])));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn library_scan_cancel(app: AppHandle) -> Res<()> {
    run(app, |st, _| {
        st.0.cancel.store(true, Ordering::SeqCst);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn library_status(app: AppHandle) -> Res<Status> {
    run(app, |st, _| Ok(st.0.status.lock().unwrap_or_else(|e| e.into_inner()).clone())).await
}

#[tauri::command]
pub async fn library_set_options(app: AppHandle, options: Options) -> Res<()> {
    run(app, move |st, s| {
        *st.0.options.lock().unwrap_or_else(|e| e.into_inner()) = options;
        st.refresh_watch(s);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn library_query(app: AppHandle, query: query::Query) -> Res<query::Page> {
    run(app, move |_, s| Ok(s.read(|c| query::query(c, &query))?)).await
}

#[tauri::command]
pub async fn library_music_groups(app: AppHandle, by: String, search: Option<String>) -> Res<Vec<query::Group>> {
    run(app, move |_, s| Ok(s.read(|c| query::music_groups(c, &by, search.as_deref()))?)).await
}

#[tauri::command]
pub async fn library_media_meta(app: AppHandle, paths: Vec<String>) -> Res<Vec<query::Meta>> {
    run(app, move |_, s| Ok(s.read(|c| query::meta_by_paths(c, &paths))?)).await
}

#[tauri::command]
pub async fn library_set_rating(app: AppHandle, paths: Vec<String>, rating: u8) -> Res<usize> {
    run(app, move |_, s| s.write(|tx| query::set_rating(tx, &paths, rating))).await
}

#[tauri::command]
pub async fn library_set_tags(app: AppHandle, paths: Vec<String>, add: Vec<String>, remove: Vec<String>) -> Res<usize> {
    run(app, move |_, s| s.write(|tx| query::set_tags(tx, &paths, &add, &remove))).await
}

#[tauri::command]
pub async fn library_tags(app: AppHandle) -> Res<Vec<(String, i64)>> {
    run(app, |_, s| Ok(s.read(query::all_tags)?)).await
}

#[tauri::command]
pub async fn library_mark_played(app: AppHandle, path: String) -> Res<bool> {
    run(app, move |_, s| s.write(|tx| query::mark_played(tx, &path))).await
}

#[tauri::command]
pub async fn library_folder_favorites(app: AppHandle) -> Res<Vec<String>> {
    run(app, |_, s| Ok(s.read(folders::favorites)?)).await
}

#[tauri::command]
pub async fn library_set_folder_favorite(app: AppHandle, path: String, on: bool) -> Res<Vec<String>> {
    run(app, move |_, s| {
        s.write(|tx| folders::set_favorite(tx, &path, on))?;
        Ok(s.read(folders::favorites)?)
    })
    .await
}

/// One-time move of the photo studio's favorite folders from the settings store.
#[tauri::command]
pub async fn library_import_folder_favorites(app: AppHandle, paths: Vec<String>) -> Res<Vec<String>> {
    run(app, move |_, s| {
        s.write(|tx| folders::import_studio_favorites(tx, &paths))?;
        Ok(s.read(folders::favorites)?)
    })
    .await
}

#[tauri::command]
pub async fn library_playlists(app: AppHandle) -> Res<Vec<playlist::Info>> {
    run(app, |_, s| Ok(s.read(playlist::list)?)).await
}

#[tauri::command]
pub async fn library_playlist_get(app: AppHandle, id: String) -> Res<Option<playlist::Playlist>> {
    run(app, move |_, s| Ok(s.read(|c| playlist::get(c, &id))?)).await
}

#[tauri::command]
pub async fn library_playlist_save(app: AppHandle, id: Option<String>, name: String, items: Vec<playlist::Entry>) -> Res<String> {
    run(app, move |_, s| s.write(|tx| playlist::save(tx, id.as_deref(), &name, &items))).await
}

#[tauri::command]
pub async fn library_playlist_delete(app: AppHandle, id: String) -> Res<bool> {
    run(app, move |_, s| s.write(|tx| Ok(playlist::delete(tx, &id)?))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub id: String,
    pub name: String,
    pub total: usize,
    pub missing: usize,
    pub streams: usize,
    pub skipped: usize,
}

/// Imports a playlist file into a saved list (remote URLs are stored, never fetched).
#[tauri::command]
pub async fn library_playlist_import(app: AppHandle, path: String) -> Res<ImportResult> {
    run(app, move |_, s| {
        let parsed = playlist::read_file(Path::new(&path)).map_err(StorageError::Other)?;
        let name = Path::new(&path).file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let id = s.write(|tx| playlist::save(tx, None, &name, &parsed.entries))?;
        let missing = parsed.entries.iter().filter(|e| e.path.as_deref().is_some_and(|p| !Path::new(p).is_file())).count();
        let streams = parsed.entries.iter().filter(|e| e.url.is_some()).count();
        Ok(ImportResult { id, name, total: parsed.entries.len(), missing, streams, skipped: parsed.skipped.len() })
    })
    .await
}

/// Reads a playlist file without saving it (open as the current queue).
#[tauri::command]
pub async fn library_playlist_read(path: String) -> Res<Vec<playlist::Entry>> {
    tauri::async_runtime::spawn_blocking(move || playlist::read_file(Path::new(&path)).map(|p| p.entries))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes a saved list (`id`) or the given items to an M3U/M3U8/PLS file.
#[tauri::command]
pub async fn library_playlist_export(
    app: AppHandle,
    path: String,
    id: Option<String>,
    items: Option<Vec<playlist::Entry>>,
    relative: Option<bool>,
) -> Res<usize> {
    run(app, move |_, s| {
        let entries: Vec<playlist::Entry> = match (id, items) {
            (Some(id), _) => s
                .read(|c| playlist::get(c, &id))?
                .ok_or_else(|| StorageError::Other("[not-found] playlist".into()))?
                .items
                .iter()
                .map(playlist::Entry::from)
                .collect(),
            (None, Some(items)) => items,
            _ => Vec::new(),
        };
        playlist::write_file(&entries, Path::new(&path), relative.unwrap_or(true)).map_err(StorageError::Other)
    })
    .await
}

#[cfg(test)]
mod tests;
