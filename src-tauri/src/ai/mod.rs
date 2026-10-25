//! On-demand AI components (inference runtime + models): verifiable, cancellable management.
//!
//! Nothing is bundled with the app. Each component (see `manifest.rs`) is downloaded the first
//! time a feature needs it, from URLs pinned to an exact version/commit, and lives in
//! `<data>/ai/<id>/<version>/` (`<data>` = VHO_DATA_DIR for tests, else the app data dir).
//!
//! - Integrity: a file is handed to inference only after its full SHA-256 matched in this
//!   session; afterwards (size, mtime) changes trigger a new hash. Size alone is never trusted.
//! - One download job per component; any number of requests (`requestId`) follow it. A
//!   cancelled request leaves the others running; the job stops when nobody follows it.
//! - Downloads land in `.part` files in the same folder and get their final name only after the
//!   hash matched. Free space is checked before the first byte.
//! - Leases: a running job holds its components; removal of a leased component is refused.
//! - Errors carry a code (`error.rs`); the UI text comes from i18n.

pub mod download;
pub mod error;
pub mod manifest;
mod zip;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager as _};
use tokio::sync::watch;

use download::Policy;
use error::{AiError, AiResult, ErrorCode};
use manifest::{Component, Download, ExternalData};

/// Extra room kept free on the volume beyond the files being written.
const SPACE_MARGIN: u64 = 64 << 20;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Streaming SHA-256 of a file: (bytes, hex digest).
pub fn hash_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut n_total = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        n_total += n as u64;
    }
    Ok((n_total, hex(&h.finalize())))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Nothing on disk
    Missing,
    /// Some files present, some missing
    Partial,
    /// All files present with the right sizes, not hashed in this session yet
    Installed,
    /// All files hashed and correct in this session
    Ready,
    /// At least one file failed its hash (repair = install)
    Corrupt,
    /// A download / repair job is running
    Downloading,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    pub id: String,
    pub version: String,
    pub task: String,
    pub title: String,
    pub author: String,
    pub license: String,
    pub source: String,
    pub input: String,
    pub output: String,
    pub process_version: u32,
    pub tested_backends: Vec<String>,
    pub external_data: Vec<ExternalData>,
    pub state: State,
    /// Compatibility: files present (Installed or Ready)
    pub installed: bool,
    /// Bytes still to download for missing/damaged files
    pub download_bytes: u64,
    /// Full download size
    pub total_bytes: u64,
    /// Size on disk once installed
    pub disk_bytes: u64,
    /// Folder of the files (meaningful when installed)
    pub dir: String,
    pub bad_files: Vec<String>,
    pub progress: Option<Progress>,
    pub in_use: bool,
}

/// Progress event ("ai-download"). `requests` = request ids following this job right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: String,
    pub job: u64,
    pub requests: Vec<String>,
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acquired {
    pub lease: u64,
    pub status: ComponentStatus,
}

#[derive(Clone, Copy)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    ok: bool,
}

type DoneRx = watch::Receiver<Option<AiResult<()>>>;

struct Job {
    seq: u64,
    cancel: watch::Sender<bool>,
    done: DoneRx,
    subscribers: Mutex<Vec<String>>,
    progress: Mutex<Progress>,
}

#[derive(Default)]
struct Inner {
    stamps: HashMap<PathBuf, Stamp>,
    jobs: HashMap<String, Arc<Job>>,
    /// request id -> its own cancel switch
    requests: HashMap<String, watch::Sender<bool>>,
    /// lease -> component id
    leases: HashMap<u64, String>,
    next_lease: u64,
    next_job: u64,
    /// components being verified (remove refused meanwhile)
    verifying: HashSet<String>,
}

pub type Emit = Arc<dyn Fn(ProgressEvent) + Send + Sync>;
pub type FreeSpace = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

pub struct Manager {
    root: PathBuf,
    components: Vec<Component>,
    policy: Policy,
    emit: Emit,
    free_space: FreeSpace,
    inner: Mutex<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn stamp_of(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let m = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    Some((m.len(), m.modified().ok()))
}

async fn blocking<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> AiResult<R> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| AiError::new(ErrorCode::Io, e.to_string()))
}

impl Manager {
    pub fn new(root: PathBuf, components: Vec<Component>, policy: Policy, emit: Emit, free_space: FreeSpace) -> Arc<Self> {
        Arc::new(Self { root, components, policy, emit, free_space, inner: Mutex::new(Inner::default()) })
    }

    #[cfg(test)]
    pub fn components(&self) -> &[Component] {
        &self.components
    }

    fn find(&self, id: &str) -> AiResult<&Component> {
        self.components
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AiError::new(ErrorCode::UnknownComponent, format!("unknown component {id}")))
    }

    pub fn component_dir(&self, c: &Component) -> PathBuf {
        self.root.join(&c.id).join(&c.version)
    }

    // ----------------------------------------------------------------------------------
    // Verification cache
    // ----------------------------------------------------------------------------------

    /// Cached verdict for a file whose size/mtime did not change since it was hashed.
    fn cached(&self, path: &Path) -> Option<bool> {
        let (len, modified) = stamp_of(path)?;
        let s = *lock(&self.inner).stamps.get(path)?;
        (s.len == len && s.modified == modified).then_some(s.ok)
    }

    /// Full hash check (unless `use_cache` and the file is unchanged since its last check).
    async fn check_file(&self, path: PathBuf, sha256: &str, bytes: u64, use_cache: bool) -> AiResult<bool> {
        let Some((len, modified)) = stamp_of(&path) else { return Ok(false) };
        if len != bytes {
            return Ok(false);
        }
        if use_cache {
            if let Some(ok) = self.cached(&path) {
                return Ok(ok);
            }
        }
        let p = path.clone();
        let ok = match blocking(move || hash_file(&p)).await? {
            Ok((n, digest)) => n == bytes && digest == sha256,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(AiError::io("read", &e)),
        };
        lock(&self.inner).stamps.insert(path, Stamp { len, modified, ok });
        Ok(ok)
    }

    fn mark_verified(&self, path: &Path) {
        if let Some((len, modified)) = stamp_of(path) {
            lock(&self.inner).stamps.insert(path.to_path_buf(), Stamp { len, modified, ok: true });
        }
    }

    fn forget_under(&self, dir: &Path) {
        lock(&self.inner).stamps.retain(|p, _| !p.starts_with(dir));
    }

    // ----------------------------------------------------------------------------------
    // Status
    // ----------------------------------------------------------------------------------

    pub fn status(&self, id: &str) -> AiResult<ComponentStatus> {
        let c = self.find(id)?;
        let dir = self.component_dir(c);
        let (job, in_use) = {
            let inner = lock(&self.inner);
            (inner.jobs.get(id).cloned(), inner.leases.values().any(|v| v == id))
        };
        let mut present = 0usize;
        let mut verified = 0usize;
        let mut bad_files = vec![];
        let mut download_bytes = 0u64;
        for d in &c.downloads {
            let mut need = false;
            for f in d.outputs() {
                let path = dir.join(f.name);
                let size_ok = stamp_of(&path).is_some_and(|(len, _)| len == f.bytes);
                match (size_ok, self.cached(&path)) {
                    (true, Some(true)) => {
                        present += 1;
                        verified += 1;
                    }
                    (true, Some(false)) => {
                        present += 1;
                        bad_files.push(f.name.to_string());
                        need = true;
                    }
                    (true, None) => present += 1,
                    (false, _) => {
                        if path.exists() {
                            bad_files.push(f.name.to_string());
                        }
                        need = true;
                    }
                }
            }
            if need {
                download_bytes += d.bytes;
            }
        }
        let total_files = c.files().len();
        let state = if job.is_some() {
            State::Downloading
        } else if !bad_files.is_empty() {
            State::Corrupt
        } else if verified == total_files {
            State::Ready
        } else if present == total_files {
            State::Installed
        } else if present > 0 {
            State::Partial
        } else {
            State::Missing
        };
        Ok(ComponentStatus {
            id: c.id.clone(),
            version: c.version.clone(),
            task: c.task.clone(),
            title: c.title.clone(),
            author: c.author.clone(),
            license: c.license.clone(),
            source: c.source.clone(),
            input: c.input.clone(),
            output: c.output.clone(),
            process_version: c.process_version,
            tested_backends: c.tested_backends.clone(),
            external_data: c.external_data.clone(),
            installed: matches!(state, State::Installed | State::Ready),
            state,
            download_bytes,
            total_bytes: c.download_bytes(),
            disk_bytes: c.disk_bytes(),
            dir: dir.to_string_lossy().into_owned(),
            bad_files,
            progress: job.map(|j| lock(&j.progress).clone()),
            in_use,
        })
    }

    pub fn status_all(&self, ids: Option<Vec<String>>) -> AiResult<Vec<ComponentStatus>> {
        let ids = ids.unwrap_or_else(|| self.components.iter().map(|c| c.id.clone()).collect());
        ids.iter().map(|id| self.status(id)).collect()
    }

    /// Re-hashes every file of the component, ignoring the session cache.
    pub async fn verify(&self, id: &str) -> AiResult<ComponentStatus> {
        let c = self.find(id)?.clone();
        {
            let mut inner = lock(&self.inner);
            if inner.jobs.contains_key(id) || !inner.verifying.insert(id.to_string()) {
                return Err(AiError::new(ErrorCode::Busy, format!("{id} is being downloaded or verified")));
            }
        }
        let dir = self.component_dir(&c);
        let mut result = Ok(());
        for f in c.files() {
            if let Err(e) = self.check_file(dir.join(f.name), f.sha256, f.bytes, false).await {
                result = Err(e);
                break;
            }
        }
        lock(&self.inner).verifying.remove(id);
        result?;
        self.status(id)
    }

    // ----------------------------------------------------------------------------------
    // Leases (a running job holds its components)
    // ----------------------------------------------------------------------------------

    /// Verifies the component (full hash on first use in this session) and leases it.
    /// A damaged or missing file is never handed to inference.
    pub async fn acquire(&self, id: &str) -> AiResult<Acquired> {
        let c = self.find(id)?.clone();
        let dir = self.component_dir(&c);
        for f in c.files() {
            let path = dir.join(f.name);
            if !path.is_file() {
                return Err(AiError::new(ErrorCode::NotInstalled, format!("{id}: {} missing", f.name)));
            }
            if !self.check_file(path, f.sha256, f.bytes, true).await? {
                return Err(AiError::new(ErrorCode::Checksum, format!("{id}: {} damaged", f.name)));
            }
        }
        let lease = {
            let mut inner = lock(&self.inner);
            inner.next_lease += 1;
            let lease = inner.next_lease;
            inner.leases.insert(lease, id.to_string());
            lease
        };
        Ok(Acquired { lease, status: self.status(id)? })
    }

    pub fn release(&self, lease: u64) -> bool {
        lock(&self.inner).leases.remove(&lease).is_some()
    }

    // ----------------------------------------------------------------------------------
    // Removal
    // ----------------------------------------------------------------------------------

    pub fn remove(&self, id: &str) -> AiResult<ComponentStatus> {
        let c = self.find(id)?;
        {
            let inner = lock(&self.inner);
            if inner.jobs.contains_key(id) || inner.verifying.contains(id) {
                return Err(AiError::new(ErrorCode::Busy, format!("{id} is being downloaded or verified")));
            }
            if inner.leases.values().any(|v| v == id) {
                return Err(AiError::new(ErrorCode::InUse, format!("{id} is used by a running job")));
            }
        }
        let dir = self.root.join(&c.id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AiError::io("remove", &e)),
        }
        self.forget_under(&dir);
        self.status(id)
    }

    // ----------------------------------------------------------------------------------
    // Install (download / repair)
    // ----------------------------------------------------------------------------------

    /// Downloads whatever is missing or damaged. Requests for the same component share one
    /// job; `cancel(request_id)` stops only this request (and the job once nobody follows it).
    pub async fn install(self: &Arc<Self>, id: &str, request_id: &str) -> AiResult<ComponentStatus> {
        let c = self.find(id)?.clone();
        if c.license.trim().is_empty() || c.author.trim().is_empty() {
            return Err(AiError::new(ErrorCode::LicenseUnavailable, id.to_string()));
        }
        let (req_tx, mut req_rx) = watch::channel(false);
        let (job, mut done) = loop {
            let wait_for = {
                let mut inner = lock(&self.inner);
                if inner.requests.contains_key(request_id) {
                    return Err(AiError::new(ErrorCode::Busy, format!("request {request_id} already running")));
                }
                match inner.jobs.get(id).cloned() {
                    // A job nobody follows any more is finishing its cancellation: wait for it
                    Some(j) if *j.cancel.borrow() => Some(j.done.clone()),
                    Some(j) => {
                        lock(&j.subscribers).push(request_id.to_string());
                        inner.requests.insert(request_id.to_string(), req_tx.clone());
                        break (j.clone(), j.done.clone());
                    }
                    None => {
                        if inner.verifying.contains(id) {
                            return Err(AiError::new(ErrorCode::Busy, format!("{id} is being verified")));
                        }
                        let j = self.start_job(&mut inner, c.clone(), request_id);
                        inner.requests.insert(request_id.to_string(), req_tx.clone());
                        break (j.clone(), j.done.clone());
                    }
                }
            };
            if let Some(mut rx) = wait_for {
                let _ = rx.wait_for(|d| d.is_some()).await;
            }
        };

        let outcome = tokio::select! {
            r = done.wait_for(|d| d.is_some()) => match r {
                Ok(v) => v.clone().unwrap_or(Ok(())),
                Err(_) => Err(AiError::new(ErrorCode::Io, "download job vanished")),
            },
            _ = download::cancelled(&mut req_rx) => Err(AiError::new(ErrorCode::Cancelled, "request cancelled")),
        };

        let nobody_left = {
            let mut inner = lock(&self.inner);
            inner.requests.remove(request_id);
            let mut subs = lock(&job.subscribers);
            subs.retain(|r| r != request_id);
            subs.is_empty()
        };
        if nobody_left && outcome.as_ref().is_err_and(|e| e.code == ErrorCode::Cancelled) {
            let _ = job.cancel.send(true);
        }
        outcome?;
        self.status(id)
    }

    /// Cancels one request. Returns false when it is unknown (already finished).
    pub fn cancel(&self, request_id: &str) -> bool {
        match lock(&self.inner).requests.get(request_id) {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }

    fn start_job(self: &Arc<Self>, inner: &mut Inner, c: Component, request_id: &str) -> Arc<Job> {
        inner.next_job += 1;
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(None);
        let job = Arc::new(Job {
            seq: inner.next_job,
            cancel: cancel_tx,
            done: done_rx,
            subscribers: Mutex::new(vec![request_id.to_string()]),
            progress: Mutex::new(Progress { phase: "verify".into(), done: 0, total: c.download_bytes() }),
        });
        inner.jobs.insert(c.id.clone(), job.clone());
        let me = self.clone();
        let j = job.clone();
        tauri::async_runtime::spawn(async move {
            let r = me.run_install(&c, &j, cancel_rx).await;
            {
                let mut inner = lock(&me.inner);
                if inner.jobs.get(&c.id).is_some_and(|x| Arc::ptr_eq(x, &j)) {
                    inner.jobs.remove(&c.id);
                }
            }
            let _ = done_tx.send(Some(r));
        });
        job
    }

    fn report(&self, c: &Component, job: &Job, phase: &str, done: u64, total: u64) {
        {
            let mut p = lock(&job.progress);
            // Throttle: phase change, completion, or another 256 KiB
            if p.phase == phase && done != total && done.saturating_sub(p.done) < 256 * 1024 && done >= p.done {
                return;
            }
            *p = Progress { phase: phase.into(), done, total };
        }
        (self.emit)(ProgressEvent {
            id: c.id.clone(),
            job: job.seq,
            requests: lock(&job.subscribers).clone(),
            phase: phase.into(),
            done,
            total,
        });
    }

    /// Files of the previous layout (`ai/<id>/<file>`) move into the version folder; they are
    /// hashed like any other file before use. Leftover legacy parts are removed.
    fn migrate_legacy(&self, c: &Component, dir: &Path) {
        let base = self.root.join(&c.id);
        let Ok(entries) = std::fs::read_dir(&base) else { return };
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_file() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            let target = dir.join(&name);
            if c.files().iter().any(|f| f.name == name) && !target.exists() {
                let _ = std::fs::rename(&path, &target);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Other versions of the component (after an app update) and foreign files in its folder.
    fn cleanup(&self, c: &Component, dir: &Path) {
        let leased = lock(&self.inner).leases.values().any(|v| *v == c.id);
        if let (false, Ok(entries)) = (leased, std::fs::read_dir(self.root.join(&c.id))) {
            for e in entries.flatten() {
                if e.path().is_dir() && e.file_name().to_string_lossy() != c.version {
                    let _ = std::fs::remove_dir_all(e.path());
                    self.forget_under(&e.path());
                }
            }
        }
        let mut keep: HashSet<String> = c.files().iter().map(|f| f.name.to_string()).collect();
        for (i, d) in c.downloads.iter().enumerate() {
            keep.insert(d.part_name(i));
            keep.insert(format!("{}.json", d.part_name(i)));
            for x in &d.extract {
                keep.insert(format!("{}.part", x.name));
            }
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                if !keep.contains(&*e.file_name().to_string_lossy()) {
                    let p = e.path();
                    let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                }
            }
        }
    }

    fn free_bytes(&self, dir: &Path) -> Option<u64> {
        (self.free_space)(dir)
    }

    async fn run_install(&self, c: &Component, job: &Job, cancel: watch::Receiver<bool>) -> AiResult<()> {
        let dir = self.component_dir(c);
        std::fs::create_dir_all(&dir).map_err(|e| AiError::io("create component folder", &e))?;
        self.migrate_legacy(c, &dir);
        self.cleanup(c, &dir);

        // 1. What is missing or damaged (existing files are hashed, never trusted by size)
        let total_check: u64 = c.disk_bytes();
        let mut checked = 0u64;
        let mut needed: Vec<(usize, Vec<String>)> = vec![];
        for (i, d) in c.downloads.iter().enumerate() {
            let mut bad = vec![];
            for f in d.outputs() {
                if *cancel.borrow() {
                    return Err(AiError::new(ErrorCode::Cancelled, "cancelled"));
                }
                let path = dir.join(f.name);
                if !self.check_file(path.clone(), f.sha256, f.bytes, true).await? {
                    let _ = std::fs::remove_file(&path);
                    bad.push(f.name.to_string());
                }
                checked += f.bytes;
                self.report(c, job, "verify", checked, total_check);
            }
            if !bad.is_empty() {
                needed.push((i, bad));
            }
        }
        if needed.is_empty() {
            return Ok(());
        }

        // 2. Free space: remaining download + extracted archive files + margin
        let mut required = SPACE_MARGIN;
        for (i, bad) in &needed {
            let d = &c.downloads[*i];
            let have = std::fs::metadata(dir.join(d.part_name(*i))).map(|m| m.len()).unwrap_or(0).min(d.bytes);
            required += d.bytes - have;
            required += d.extract.iter().filter(|x| bad.contains(&x.name)).map(|x| x.bytes).sum::<u64>();
        }
        if let Some(free) = self.free_bytes(&dir) {
            if free < required {
                return Err(AiError::new(ErrorCode::DiskFull, format!("{required} bytes needed, {free} free")));
            }
        }

        // 3. Download (+ extract) each needed item
        let total: u64 = needed.iter().map(|(i, _)| c.downloads[*i].bytes).sum();
        let mut before = 0u64;
        for (i, bad) in &needed {
            let d: &Download = &c.downloads[*i];
            let part = dir.join(d.part_name(*i));
            let target = download::Target { url: &d.url, sha256: &d.sha256, bytes: d.bytes, part: part.clone() };
            let mut rx = cancel.clone();
            let mut on_progress = |have: u64| self.report(c, job, "download", before + have, total);
            download::fetch(&target, &self.policy, &mut rx, &mut on_progress).await?;

            if d.is_archive() {
                let r = self.extract_all(c, job, d, &part, &dir, bad, &cancel).await;
                download::discard(&part);
                r?;
            } else {
                let name = d.name.as_deref().unwrap_or_default();
                let final_path = dir.join(name);
                std::fs::rename(&part, &final_path).map_err(|e| AiError::io("rename", &e))?;
                self.mark_verified(&final_path);
            }
            before += d.bytes;
            self.report(c, job, "download", before, total);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn extract_all(
        &self,
        c: &Component,
        job: &Job,
        d: &Download,
        archive: &Path,
        dir: &Path,
        bad: &[String],
        cancel: &watch::Receiver<bool>,
    ) -> AiResult<()> {
        let items: Vec<_> = d.extract.iter().filter(|x| bad.contains(&x.name)).cloned().collect();
        let total: u64 = items.iter().map(|x| x.bytes).sum();
        let mut done = 0u64;
        self.report(c, job, "extract", 0, total);
        for x in items {
            let (archive, out) = (archive.to_path_buf(), dir.join(format!("{}.part", x.name)));
            let rx = cancel.clone();
            let x2 = x.clone();
            let out2 = out.clone();
            blocking(move || {
                let cancelled = || *rx.borrow();
                zip::extract(&archive, &x2.entry, &out2, x2.bytes, &x2.sha256, &cancelled, &mut |_| {})
            })
            .await??;
            let final_path = dir.join(&x.name);
            std::fs::rename(&out, &final_path).map_err(|e| {
                let _ = std::fs::remove_file(&out);
                AiError::io("rename", &e)
            })?;
            self.mark_verified(&final_path);
            done += x.bytes;
            self.report(c, job, "extract", done, total);
        }
        Ok(())
    }
}

// --------------------------------------------------------------------------------------
// Free disk space of the volume holding `path`
// --------------------------------------------------------------------------------------

#[cfg(windows)]
pub fn volume_free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(unix)]
pub fn volume_free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::statvfs(c.as_ptr(), &mut s) };
    #[allow(clippy::unnecessary_cast)]
    (r == 0).then(|| s.f_bavail as u64 * s.f_frsize as u64)
}

#[cfg(not(any(windows, unix)))]
pub fn volume_free_bytes(_path: &Path) -> Option<u64> {
    None
}

// --------------------------------------------------------------------------------------
// Tauri glue
// --------------------------------------------------------------------------------------

static MANAGER: OnceLock<Arc<Manager>> = OnceLock::new();

/// Test instances (VHO_DATA_DIR) only: extra `test-*` components and a fake free space.
fn test_mode() -> bool {
    crate::platform::data_dir_override().is_some()
}

fn manager(app: &AppHandle) -> AiResult<Arc<Manager>> {
    if let Some(m) = MANAGER.get() {
        return Ok(m.clone());
    }
    let root = match crate::platform::data_dir_override() {
        Some(d) => d.join("ai"),
        None => app.path().app_data_dir().map_err(|e| AiError::new(ErrorCode::Io, e.to_string()))?.join("ai"),
    };
    std::fs::create_dir_all(&root).map_err(|e| AiError::io("create ai folder", &e))?;

    let test_json = test_mode()
        .then(|| std::env::var_os("VHO_AI_TEST_MANIFEST"))
        .flatten()
        .and_then(|p| std::fs::read_to_string(p).ok());
    let (components, problems) = manifest::load(test_json.as_deref());
    for p in problems {
        eprintln!("[ai] manifest entry rejected: {p}");
    }
    let mut policy = Policy::default();
    let mut free_space: FreeSpace = Arc::new(volume_free_bytes);
    if test_mode() {
        let env_u64 = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok());
        if let Some(ms) = env_u64("VHO_AI_TEST_STALL_MS") {
            policy.stall_timeout = std::time::Duration::from_millis(ms);
        }
        if let Some(ms) = env_u64("VHO_AI_TEST_BACKOFF_MS") {
            policy.backoff = std::time::Duration::from_millis(ms);
        }
        if let Some(free) = env_u64("VHO_AI_TEST_FREE_BYTES") {
            free_space = Arc::new(move |_: &Path| Some(free));
        }
    }
    let handle = app.clone();
    let emit: Emit = Arc::new(move |ev| {
        let _ = handle.emit("ai-download", ev);
    });
    let m = Manager::new(root, components, policy, emit, free_space);
    let _ = MANAGER.set(m);
    Ok(MANAGER.get().expect("set above").clone())
}

fn allow_dir(app: &AppHandle, st: &ComponentStatus) -> AiResult<()> {
    app.asset_protocol_scope().allow_directory(&st.dir, true).map_err(|e| AiError::new(ErrorCode::Io, e.to_string()))
}

/// Status of one component (cheap: sizes + this session's hash verdicts).
#[tauri::command]
pub fn ai_status(app: AppHandle, id: String) -> AiResult<ComponentStatus> {
    manager(&app)?.status(&id)
}

/// Status of the given components, or of every component in the manifest.
#[tauri::command]
pub fn ai_status_all(app: AppHandle, ids: Option<Vec<String>>) -> AiResult<Vec<ComponentStatus>> {
    manager(&app)?.status_all(ids)
}

/// Downloads / repairs a component (progress: "ai-download" events carrying `requests`).
#[tauri::command]
pub async fn ai_install(app: AppHandle, id: String, request_id: Option<String>) -> AiResult<ComponentStatus> {
    let m = manager(&app)?;
    let request_id = request_id.unwrap_or_else(|| {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        format!("auto-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    });
    m.install(&id, &request_id).await
}

#[tauri::command]
pub fn ai_cancel_download(app: AppHandle, request_id: String) -> AiResult<bool> {
    Ok(manager(&app)?.cancel(&request_id))
}

/// Full re-hash of every file (Settings > AI models > Verify).
#[tauri::command]
pub async fn ai_verify(app: AppHandle, id: String) -> AiResult<ComponentStatus> {
    manager(&app)?.verify(&id).await
}

#[tauri::command]
pub fn ai_remove(app: AppHandle, id: String) -> AiResult<ComponentStatus> {
    manager(&app)?.remove(&id)
}

/// Verified + leased component for a job (its folder becomes readable for the webview).
#[tauri::command]
pub async fn ai_acquire(app: AppHandle, id: String) -> AiResult<Acquired> {
    let a = manager(&app)?.acquire(&id).await?;
    allow_dir(&app, &a.status)?;
    Ok(a)
}

#[tauri::command]
pub fn ai_release(app: AppHandle, lease: u64) -> AiResult<bool> {
    Ok(manager(&app)?.release(lease))
}
