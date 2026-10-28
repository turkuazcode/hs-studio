//! Queue worker: one long job at a time, recovery at start, validation before every attempt,
//! item bookkeeping for adapters ([`RunCtx`]). See docs/jobs-api.md.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::Value;

use super::store::{self, JobRow};
use super::{
    ItemEvent, JobError, JobEnv, JobEvent, JobItem, JobSnapshot, JobState, ModelPin, code, fingerprint, item_state, recipe_hash,
};
use crate::storage::identity::normalize_path;
use crate::storage::{Storage, StorageError, now_ms};

/// Terminal jobs kept as history (older ones are pruned at start).
const HISTORY_KEPT: i64 = 50;
/// Progress events at most this often (state/item events are never throttled).
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// Name of a job's temp dir inside an output folder.
pub const TEMP_PREFIX: &str = ".vho-job-";

/// What an adapter needs to know to queue a request.
pub struct Planned {
    pub title: String,
    pub inputs: Vec<PathBuf>,
    pub model: Option<ModelPin>,
}

pub trait Adapter: Send + Sync {
    fn kind(&self) -> &'static str;
    /// Version of the request JSON; a stored job with another version is not continued.
    fn schema_version(&self) -> u32;
    fn plan(&self, request: &Value, env: &dyn JobEnv) -> Result<Planned, JobError>;
    /// Runs the pending items through `ctx`. Job-level errors (no ffmpeg, invalid request) are
    /// returned; item errors are recorded with `ctx.fail_item`.
    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError>;
}

pub struct Scheduler {
    storage: Arc<Storage>,
    env: Arc<dyn JobEnv>,
    adapters: Vec<Arc<dyn Adapter>>,
    wake: (Mutex<bool>, Condvar),
    /// Stop requests (cancel or pause) of queued/running jobs; the DB state says which.
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
    shutdown: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn not_found(id: &str) -> JobError {
    JobError::new(code::NOT_FOUND, format!("job {id} not found"))
}

fn invalid_state(id: &str, st: JobState) -> JobError {
    JobError::new(code::INVALID_STATE, format!("job {id} is {}", st.as_str()))
}

/// Removes a job temp dir, but only one of ours (named `.vho-job-<id8>`).
fn remove_temp_dir(job_id: &str, path: &str) {
    let p = Path::new(path);
    let ours = p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == temp_dir_name(job_id));
    if ours {
        let _ = std::fs::remove_dir_all(p);
    }
}

pub fn temp_dir_name(job_id: &str) -> String {
    format!("{TEMP_PREFIX}{}", job_id.chars().filter(|c| *c != '-').take(8).collect::<String>())
}

impl Scheduler {
    /// Opens the queue on an open storage: recovery of jobs a crash / forced close left
    /// running, cleanup of their temp dirs, history pruning.
    pub fn open(storage: Arc<Storage>, env: Arc<dyn JobEnv>, adapters: Vec<Arc<dyn Adapter>>) -> Result<Arc<Self>, JobError> {
        let s = Arc::new(Scheduler {
            storage,
            env,
            adapters,
            wake: (Mutex::new(false), Condvar::new()),
            stops: Mutex::new(HashMap::new()),
            shutdown: AtomicBool::new(false),
        });
        s.recover()?;
        Ok(s)
    }

    fn recover(&self) -> Result<(), JobError> {
        let dirs = self.storage.write(|tx| {
            let now = now_ms();
            // running / pausing -> interrupted: their running items go back to pending
            tx.execute(
                "UPDATE job_items SET state = 'pending', reserved_path = NULL, reserved_norm = NULL
                 WHERE state = 'running' AND job_id IN (SELECT id FROM jobs WHERE state IN ('running', 'pausing'))",
                [],
            )?;
            tx.execute(
                "UPDATE jobs SET state = 'interrupted', stage = 'interrupted', fraction = NULL, seq = seq + 1, updated_at = ?1
                 WHERE state IN ('running', 'pausing')",
                [now],
            )?;
            // cancelling -> cancelled
            tx.execute(
                "UPDATE job_items SET state = 'cancelled', reserved_path = NULL, reserved_norm = NULL
                 WHERE state IN ('running', 'pending') AND job_id IN (SELECT id FROM jobs WHERE state = 'cancelling')",
                [],
            )?;
            tx.execute(
                "UPDATE jobs SET state = 'cancelled', stage = 'cancelled', fraction = NULL, seq = seq + 1, updated_at = ?1,
                   finished_at = ?1 WHERE state = 'cancelling'",
                [now],
            )?;
            // nothing runs now: every reservation and temp dir is stale
            tx.execute("UPDATE job_items SET reserved_path = NULL, reserved_norm = NULL WHERE reserved_norm IS NOT NULL", [])?;
            let dirs = store::temp_dirs(tx, None)?;
            // history
            tx.execute(
                "DELETE FROM jobs WHERE state IN ('completed', 'cancelled') AND id NOT IN (
                   SELECT id FROM jobs WHERE state IN ('completed', 'cancelled') ORDER BY created_at DESC LIMIT ?1)",
                [HISTORY_KEPT],
            )?;
            Ok(dirs)
        })?;
        self.cleanup_temp(dirs);
        Ok(())
    }

    /// Removes job temp dirs; a dir that could not be removed (locked) stays registered and
    /// is tried again at the next start.
    fn cleanup_temp(&self, dirs: Vec<(String, String)>) {
        let mut gone = Vec::new();
        for (job, dir) in dirs {
            remove_temp_dir(&job, &dir);
            if !Path::new(&dir).exists() {
                gone.push((job, dir));
            }
        }
        if gone.is_empty() {
            return;
        }
        let _ = self.storage.write(|tx| {
            for (job, dir) in &gone {
                tx.execute("DELETE FROM job_temp_dirs WHERE job_id = ?1 AND path = ?2", params![job, dir])?;
            }
            Ok(())
        });
    }

    pub fn start_worker(self: &Arc<Self>) {
        let me = self.clone();
        let _ = std::thread::Builder::new().name("vho-jobs".into()).spawn(move || {
            while !me.shutdown.load(Ordering::Relaxed) {
                match me.run_next() {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(e) => eprintln!("[jobs] {e}"),
                }
                let (m, cv) = &me.wake;
                let mut woken = lock(m);
                if !*woken {
                    woken = cv.wait_timeout(woken, Duration::from_secs(5)).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
                }
                *woken = false;
            }
        });
    }

    fn notify(&self) {
        let (m, cv) = &self.wake;
        *lock(m) = true;
        cv.notify_all();
    }

    #[allow(dead_code)] // tests / future app shutdown hook
    pub fn stop_worker(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        self.notify();
    }

    fn adapter(&self, kind: &str) -> Result<Arc<dyn Adapter>, JobError> {
        self.adapters
            .iter()
            .find(|a| a.kind() == kind)
            .cloned()
            .ok_or_else(|| JobError::new(code::INVALID_REQUEST, format!("unknown job kind {kind}")))
    }

    fn stop_flag(&self, id: &str) -> Arc<AtomicBool> {
        lock(&self.stops).entry(id.to_string()).or_default().clone()
    }

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    #[cfg(test)]
    pub fn storage_for_tests(&self) -> &Storage {
        &self.storage
    }

    pub fn list(&self) -> Result<Vec<JobSnapshot>, JobError> {
        Ok(self.storage.read(store::list)?)
    }

    pub fn snapshot(&self, id: &str) -> Result<JobSnapshot, JobError> {
        self.storage.read(|c| store::snapshot(c, id))?.ok_or_else(|| not_found(id))
    }

    pub fn items(&self, id: &str) -> Result<Vec<JobItem>, JobError> {
        Ok(self.storage.read(|c| store::items(c, id))?)
    }

    fn row(&self, id: &str) -> Result<JobRow, JobError> {
        self.storage.read(|c| store::row(c, id))?.ok_or_else(|| not_found(id))
    }

    /// Runs `f` + a new event number in one transaction, then emits the event.
    fn change<T>(
        &self,
        id: &str,
        item: Option<i64>,
        f: impl FnOnce(&Transaction) -> Result<T, JobError>,
    ) -> Result<(T, JobSnapshot), JobError> {
        let mut err = None;
        let res = self.storage.write(|tx| {
            let out = match f(tx) {
                Ok(v) => v,
                Err(e) => {
                    err = Some(e);
                    return Err(StorageError::Other("rolled back".into()));
                }
            };
            store::bump(tx, id)?;
            let snap = store::snapshot(tx, id)?.ok_or_else(|| StorageError::Other(format!("job {id} vanished")))?;
            let item_ev = match item {
                Some(idx) => tx
                    .query_row(
                        "SELECT state, output_path, error_code FROM job_items WHERE job_id = ?1 AND idx = ?2",
                        params![id, idx],
                        |r| Ok(ItemEvent { idx, state: r.get(0)?, output_path: r.get(1)?, error_code: r.get(2)? }),
                    )
                    .optional()?,
                None => None,
            };
            Ok((out, snap, item_ev))
        });
        if let Some(e) = err {
            return Err(e);
        }
        let (out, snap, item_ev) = res?;
        self.env.emit(&JobEvent {
            job_id: snap.id.clone(),
            attempt_id: snap.attempt_id.clone(),
            item_id: item,
            seq: snap.seq,
            job: snap.clone(),
            item: item_ev,
        });
        Ok((out, snap))
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    pub fn submit(&self, kind: &str, mut request: Value, title: Option<String>) -> Result<JobSnapshot, JobError> {
        let adapter = self.adapter(kind)?;
        if let Some(o) = request.as_object_mut() {
            o.remove("jobId");
        }
        let planned = adapter.plan(&request, &*self.env)?;
        if planned.inputs.is_empty() {
            return Err(JobError::new(code::INVALID_REQUEST, "no input files"));
        }
        let mut fps = Vec::with_capacity(planned.inputs.len());
        for p in &planned.inputs {
            let fp = fingerprint(p)
                .map_err(|e| JobError::new(code::SOURCE_MISSING, format!("{}: {e}", p.file_name().unwrap_or_default().to_string_lossy())))?;
            fps.push(fp);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let hash = recipe_hash(kind, adapter.schema_version(), &request);
        let model = planned.model.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default());
        let text = request.to_string();
        let title = title.filter(|t| !t.trim().is_empty()).unwrap_or(planned.title);
        let total = planned.inputs.len() as i64;
        let (_, snap) = self.change(&id, None, |tx| {
            let now = now_ms();
            tx.execute(
                "INSERT INTO jobs (id, kind, schema_version, state, title, request, recipe_hash, model, total, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![id, kind, adapter.schema_version(), title, text, hash, model, total, now],
            )?;
            for (i, (p, fp)) in planned.inputs.iter().zip(&fps).enumerate() {
                let path = p.to_string_lossy();
                let media: Option<String> = tx
                    .query_row("SELECT id FROM media WHERE path_norm = ?1", [normalize_path(&path)], |r| r.get(0))
                    .optional()?;
                tx.execute(
                    "INSERT INTO job_items (job_id, idx, input_path, input_size, input_mtime_ns, input_fp, media_id, state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
                    params![id, i as i64, path, fp.size as i64, fp.mtime_ns, fp.sample, media],
                )?;
            }
            Ok(())
        })?;
        self.notify();
        Ok(snap)
    }

    pub fn cancel(&self, id: &str) -> Result<JobSnapshot, JobError> {
        let flag = self.stop_flag(id);
        flag.store(true, Ordering::SeqCst);
        // not running: cancelled right away
        let (done, snap) = self.change(id, None, |tx| {
            let ok = store::cas_state(
                tx,
                id,
                &[JobState::Queued, JobState::Paused, JobState::Interrupted, JobState::Failed],
                JobState::Cancelled,
            )?;
            if ok {
                tx.execute(
                    "UPDATE job_items SET state = 'cancelled', reserved_path = NULL, reserved_norm = NULL
                     WHERE job_id = ?1 AND state IN ('pending', 'running')",
                    [id],
                )?;
                tx.execute("UPDATE jobs SET stage = 'cancelled', finished_at = ?2, fraction = NULL WHERE id = ?1", params![id, now_ms()])?;
                let summary = store::summary(tx, id, true, 0)?;
                tx.execute("UPDATE jobs SET result = ?2 WHERE id = ?1", params![id, summary.to_string()])?;
                return Ok(true);
            }
            if store::cas_state(tx, id, &[JobState::Running, JobState::Pausing], JobState::Cancelling)? {
                tx.execute("UPDATE jobs SET stage = 'cancelling' WHERE id = ?1", [id])?;
                return Ok(false);
            }
            let st = store::row(tx, id)?.ok_or_else(|| not_found(id))?.state;
            if st == JobState::Cancelling { Ok(false) } else { Err(invalid_state(id, st)) }
        })
        .inspect_err(|_| {
            lock(&self.stops).remove(id);
        })?;
        if done {
            lock(&self.stops).remove(id);
        } else {
            // one cancel authority: the shared job registry (also used by media_job_cancel)
            crate::photo::cancel(id);
        }
        Ok(snap)
    }

    pub fn pause(&self, id: &str) -> Result<JobSnapshot, JobError> {
        let (running, snap) = self.change(id, None, |tx| {
            if store::cas_state(tx, id, &[JobState::Queued], JobState::Paused)? {
                tx.execute("UPDATE jobs SET stage = 'paused' WHERE id = ?1", [id])?;
                return Ok(false);
            }
            if store::cas_state(tx, id, &[JobState::Running], JobState::Pausing)? {
                tx.execute("UPDATE jobs SET stage = 'pausing' WHERE id = ?1", [id])?;
                return Ok(true);
            }
            let st = store::row(tx, id)?.ok_or_else(|| not_found(id))?.state;
            if matches!(st, JobState::Pausing | JobState::Paused) { Ok(false) } else { Err(invalid_state(id, st)) }
        })?;
        if running {
            self.stop_flag(id).store(true, Ordering::SeqCst);
            crate::photo::cancel(id);
        }
        Ok(snap)
    }

    /// "Continue": completed items stay; failed/cancelled ones are tried again. The worker
    /// validates recipe, pinned model and sources before anything runs.
    pub fn resume_continue(&self, id: &str) -> Result<JobSnapshot, JobError> {
        let row = self.row(id)?;
        if !row.state.needs_decision() {
            return Err(invalid_state(id, row.state));
        }
        if let Some(block) = &row.resume_block {
            return Err(JobError::new(
                match block.as_str() {
                    code::SOURCE_CHANGED => code::SOURCE_CHANGED,
                    code::SOURCE_MISSING => code::SOURCE_MISSING,
                    code::MODEL_CHANGED => code::MODEL_CHANGED,
                    _ => code::RECIPE_CHANGED,
                },
                "continuing is blocked; restart the job",
            ));
        }
        lock(&self.stops).remove(id);
        let (_, snap) = self.change(id, None, |tx| {
            if !store::cas_state(tx, id, &[JobState::Interrupted, JobState::Paused, JobState::Failed], JobState::Queued)? {
                return Err(invalid_state(id, row.state));
            }
            tx.execute(
                "UPDATE job_items SET state = 'pending', error_code = NULL, error_detail = NULL, reserved_path = NULL, reserved_norm = NULL
                 WHERE job_id = ?1 AND state IN ('failed', 'cancelled', 'running')",
                [id],
            )?;
            tx.execute(
                "UPDATE jobs SET stage = 'queued', error_code = NULL, error_detail = NULL, fraction = NULL, finished_at = NULL WHERE id = ?1",
                [id],
            )?;
            Ok(())
        })?;
        self.notify();
        Ok(snap)
    }

    /// "Restart": every item again with a fresh fingerprint and model pin. Earlier outputs
    /// stay on disk (new outputs get free names).
    pub fn restart(&self, id: &str) -> Result<JobSnapshot, JobError> {
        let row = self.row(id)?;
        if !(row.state.needs_decision() || row.state == JobState::Cancelled) {
            return Err(invalid_state(id, row.state));
        }
        let adapter = self.adapter(&row.kind)?;
        if adapter.schema_version() != row.schema_version {
            return Err(JobError::new(code::RECIPE_CHANGED, "the job was created by another VHO version; submit it again"));
        }
        let planned = adapter.plan(&row.request, &*self.env)?;
        let mut fps = Vec::new();
        for p in &planned.inputs {
            fps.push(fingerprint(p).map_err(|e| JobError::new(code::SOURCE_MISSING, format!("{}: {e}", p.display())))?);
        }
        let model = planned.model.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default());
        let hash = recipe_hash(&row.kind, adapter.schema_version(), &row.request);
        lock(&self.stops).remove(id);
        let (_, snap) = self.change(id, None, |tx| {
            if !store::cas_state(
                tx,
                id,
                &[JobState::Interrupted, JobState::Paused, JobState::Failed, JobState::Cancelled],
                JobState::Queued,
            )? {
                return Err(invalid_state(id, row.state));
            }
            tx.execute("DELETE FROM job_items WHERE job_id = ?1", [id])?;
            tx.execute("DELETE FROM job_checkpoints WHERE job_id = ?1", [id])?;
            for (i, (p, fp)) in planned.inputs.iter().zip(&fps).enumerate() {
                tx.execute(
                    "INSERT INTO job_items (job_id, idx, input_path, input_size, input_mtime_ns, input_fp, state)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
                    params![id, i as i64, p.to_string_lossy(), fp.size as i64, fp.mtime_ns, fp.sample],
                )?;
            }
            tx.execute(
                "UPDATE jobs SET stage = 'queued', error_code = NULL, error_detail = NULL, resume_block = NULL, fraction = NULL,
                   finished_at = NULL, result = NULL, model = ?2, recipe_hash = ?3, total = ?4 WHERE id = ?1",
                params![id, model, hash, planned.inputs.len() as i64],
            )?;
            Ok(())
        })?;
        self.notify();
        Ok(snap)
    }

    pub fn remove(&self, id: &str) -> Result<bool, JobError> {
        let row = self.row(id)?;
        if !(row.state.is_terminal() || row.state.needs_decision()) {
            return Err(invalid_state(id, row.state));
        }
        let dirs = self.storage.read(|c| store::temp_dirs(c, Some(id)))?;
        self.cleanup_temp(dirs);
        self.storage.write(|tx| Ok(tx.execute("DELETE FROM jobs WHERE id = ?1", [id])?))?;
        lock(&self.stops).remove(id);
        Ok(true)
    }

    /// Copies a completed item's output next to its source (or into `dir`) without
    /// overwriting anything (A04 "save a copy"). The file comes from the queue's own record,
    /// never from a path the UI sends.
    /// Folder of the source of a completed item (default target of `copy_output`).
    pub fn output_source_dir(&self, id: &str, idx: i64) -> Result<PathBuf, JobError> {
        let input: String = self
            .storage
            .read(|c| {
                c.query_row(
                    "SELECT input_path FROM job_items WHERE job_id = ?1 AND idx = ?2 AND state = 'completed'",
                    params![id, idx],
                    |r| r.get(0),
                )
                .optional()
            })?
            .ok_or_else(|| JobError::new(code::INVALID_STATE, "no completed output"))?;
        Ok(super::parent_dir(Path::new(&input)))
    }

    pub fn copy_output(&self, id: &str, idx: i64, dir: Option<PathBuf>) -> Result<String, JobError> {
        let (input, output): (String, Option<String>) = self
            .storage
            .read(|c| {
                c.query_row(
                    "SELECT input_path, output_path FROM job_items WHERE job_id = ?1 AND idx = ?2 AND state = 'completed'",
                    params![id, idx],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
            })?
            .ok_or_else(|| JobError::new(code::INVALID_STATE, "no completed output"))?;
        let output = PathBuf::from(output.ok_or_else(|| JobError::new(code::INVALID_STATE, "no completed output"))?);
        let size = std::fs::metadata(&output).map_err(|e| JobError::new(code::NOT_FOUND, e.to_string()))?.len();
        let dir = dir.unwrap_or_else(|| super::parent_dir(Path::new(&input)));
        if let Some(free) = self.env.free_space(&dir) {
            if free < size + (16 << 20) {
                return Err(JobError::new(code::DISK_FULL, format!("{} MiB free", free >> 20)));
            }
        }
        let target = dir.join(output.file_name().unwrap_or_default());
        let part = dir.join(format!(".vho-copy-{}.part", uuid::Uuid::new_v4().simple()));
        let io = |e: std::io::Error| JobError::new(super::classify_error(&e.to_string()), e.to_string());
        std::fs::copy(&output, &part).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            io(e)
        })?;
        let placed = crate::actions::files::place_no_clobber(&part, &target).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            JobError::new(code::FAILED, e)
        })?;
        self.env.on_output(&placed);
        Ok(placed.to_string_lossy().into_owned())
    }

    /// Removes completed and cancelled jobs (output files stay).
    pub fn clear_finished(&self) -> Result<usize, JobError> {
        Ok(self.storage.write(|tx| Ok(tx.execute("DELETE FROM jobs WHERE state IN ('completed', 'cancelled')", [])?))?)
    }

    // -----------------------------------------------------------------------
    // Worker
    // -----------------------------------------------------------------------

    /// Runs the next queued job to its end. Returns false when the queue is empty.
    pub fn run_next(&self) -> Result<bool, JobError> {
        let Some(id) = self.storage.read(store::next_queued)? else { return Ok(false) };
        // registered before the claim: a cancel arriving at any time reaches the runner
        let guard = crate::photo::JobGuard::register(&id);
        let stop = self.stop_flag(&id);
        let attempt = uuid::Uuid::new_v4().to_string();
        let claimed = self.change(&id, None, |tx| {
            if !store::cas_state(tx, &id, &[JobState::Queued], JobState::Running)? {
                return Ok(false);
            }
            tx.execute(
                "UPDATE jobs SET attempt_id = ?2, attempts = attempts + 1, stage = 'validating', started_at = ?3, fraction = NULL
                 WHERE id = ?1",
                params![id, attempt, now_ms()],
            )?;
            Ok(true)
        });
        match claimed {
            Ok((true, _)) => {}
            Ok((false, _)) => return Ok(true), // cancelled/paused meanwhile
            Err(e) if e.code == code::NOT_FOUND => return Ok(true),
            Err(e) => return Err(e),
        }
        let started = Instant::now();
        let row = self.row(&id)?;
        let outcome = match self.adapter(&row.kind) {
            Err(e) => Err(e),
            Ok(adapter) => match self.validate(&row, &*adapter) {
                Err(e) => Err(e),
                Ok(pending) => {
                    let ctx = RunCtx {
                        sched: self,
                        job_id: &id,
                        attempt_id: &attempt,
                        kind: adapter.kind(),
                        request: &row.request,
                        model: row.model.as_deref(),
                        pending,
                        cancelled: Box::new(|| guard.cancelled() || stop.load(Ordering::SeqCst)),
                        last_progress: Mutex::new(None),
                    };
                    let _ = self.change(&id, None, |tx| {
                        tx.execute("UPDATE jobs SET stage = 'running' WHERE id = ?1", [&id])?;
                        Ok(())
                    });
                    adapter.run(&ctx)
                }
            },
        };
        let stopped = guard.cancelled() || stop.load(Ordering::SeqCst);
        self.finish(&id, outcome, stopped, started.elapsed().as_millis() as i64)?;
        lock(&self.stops).remove(&id);
        drop(guard);
        Ok(true)
    }

    /// Recipe, pinned model and source fingerprints of the pending items.
    fn validate(&self, row: &JobRow, adapter: &dyn Adapter) -> Result<Vec<store::PendingRow>, JobError> {
        let block = |c: &'static str, m: String| JobError::new(c, m);
        if adapter.schema_version() != row.schema_version
            || recipe_hash(&row.kind, row.schema_version, &row.request) != row.recipe_hash
            || serde_json::from_str::<Value>(&row.request_text).is_err()
        {
            return Err(block(code::RECIPE_CHANGED, "recipe changed".into()));
        }
        if let Some(pin) = row.model.as_deref().and_then(|m| serde_json::from_str::<ModelPin>(m).ok()) {
            let now = self.env.model_version(&pin.id);
            if now.as_deref() != Some(pin.version.as_str()) {
                return Err(block(
                    code::MODEL_CHANGED,
                    format!("{}: {} -> {}", pin.id, pin.version, now.unwrap_or_else(|| "missing".into())),
                ));
            }
        }
        let pending = self.storage.read(|c| store::pending(c, &row.id))?;
        for p in &pending {
            let name = Path::new(&p.path).file_name().unwrap_or_default().to_string_lossy().into_owned();
            let fp = fingerprint(Path::new(&p.path)).map_err(|e| block(code::SOURCE_MISSING, format!("{name}: {e}")))?;
            let same = Some(fp.size as i64) == p.size && Some(fp.mtime_ns) == p.mtime_ns && Some(&fp.sample) == p.fp.as_ref();
            if !same {
                return Err(block(code::SOURCE_CHANGED, name));
            }
        }
        Ok(pending)
    }

    fn finish(&self, id: &str, outcome: Result<(), JobError>, stopped: bool, elapsed_ms: i64) -> Result<(), JobError> {
        let (dirs, _) = self.change(id, None, |tx| {
            let st = store::row(tx, id)?.ok_or_else(|| not_found(id))?.state;
            let now = now_ms();
            let validation_error = outcome.as_ref().err().map(|e| e.code).filter(|c| {
                matches!(*c, code::SOURCE_CHANGED | code::SOURCE_MISSING | code::MODEL_CHANGED | code::RECIPE_CHANGED)
            });
            let (to, err): (JobState, Option<(&str, String)>) = if st == JobState::Pausing {
                (JobState::Paused, None)
            } else if st == JobState::Cancelling || (stopped && st == JobState::Running) {
                (JobState::Cancelled, None)
            } else if let Err(e) = &outcome {
                (JobState::Failed, Some((e.code, e.message.clone())))
            } else if store::count_items(tx, id, item_state::FAILED)? > 0 {
                let first: Option<String> = tx
                    .query_row(
                        "SELECT error_detail FROM job_items WHERE job_id = ?1 AND state = 'failed' ORDER BY idx LIMIT 1",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .flatten();
                (JobState::Failed, Some((code::ITEMS_FAILED, first.unwrap_or_default())))
            } else if store::count_items(tx, id, item_state::PENDING)? > 0 {
                // the runner returned with work left (should not happen): keep it resumable
                (JobState::Interrupted, None)
            } else {
                (JobState::Completed, None)
            };
            match to {
                JobState::Cancelled => {
                    tx.execute(
                        "UPDATE job_items SET state = 'cancelled' WHERE job_id = ?1 AND state IN ('pending', 'running')",
                        [id],
                    )?;
                }
                _ => {
                    tx.execute("UPDATE job_items SET state = 'pending' WHERE job_id = ?1 AND state = 'running'", [id])?;
                }
            }
            tx.execute("UPDATE job_items SET reserved_path = NULL, reserved_norm = NULL WHERE job_id = ?1", [id])?;
            let summary = store::summary(tx, id, to == JobState::Cancelled, elapsed_ms)?;
            let finished = matches!(to, JobState::Completed | JobState::Cancelled | JobState::Failed).then_some(now);
            tx.execute(
                "UPDATE jobs SET state = ?2, stage = ?2, fraction = NULL, result = ?3, error_code = ?4, error_detail = ?5,
                   resume_block = ?6, finished_at = ?7 WHERE id = ?1",
                params![
                    id,
                    to.as_str(),
                    summary.to_string(),
                    err.as_ref().map(|e| e.0),
                    err.as_ref().map(|e| e.1.clone()),
                    validation_error,
                    finished
                ],
            )?;
            Ok(store::temp_dirs(tx, Some(id))?)
        })?;
        self.cleanup_temp(dirs);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Adapter context
// ---------------------------------------------------------------------------

/// Item bookkeeping for one attempt. Every method persists first, then emits.
pub struct RunCtx<'a> {
    sched: &'a Scheduler,
    pub job_id: &'a str,
    pub attempt_id: &'a str,
    pub kind: &'static str,
    pub request: &'a Value,
    /// Pinned tool/model versions of the job (JSON `{id, version}`)
    pub model: Option<&'a str>,
    /// Items this attempt must do (completed ones are not here).
    pub pending: Vec<store::PendingRow>,
    cancelled: Box<dyn Fn() -> bool + Send + Sync + 'a>,
    last_progress: Mutex<Option<Instant>>,
}

impl RunCtx<'_> {
    /// Cancel or pause was requested (through the shared job registry or the queue).
    pub fn cancelled(&self) -> bool {
        (self.cancelled)()
    }

    pub fn env(&self) -> &dyn JobEnv {
        &*self.sched.env
    }

    pub fn begin_item(&self, idx: i64) -> Result<(), JobError> {
        self.sched.change(self.job_id, Some(idx), |tx| {
            tx.execute(
                "UPDATE job_items SET state = 'running', attempt_id = ?3, started_at = ?4, error_code = NULL, error_detail = NULL
                 WHERE job_id = ?1 AND idx = ?2",
                params![self.job_id, idx, self.attempt_id, now_ms()],
            )?;
            tx.execute("UPDATE jobs SET fraction = NULL WHERE id = ?1", [self.job_id])?;
            Ok(())
        })?;
        Ok(())
    }

    /// Reserves the final name of an item: `wanted`, or `stem (n).ext` when that file exists
    /// or another item/job reserved it. `allow_existing`: the user chose to overwrite.
    pub fn reserve(&self, idx: i64, wanted: &Path, allow_existing: bool) -> Result<PathBuf, JobError> {
        let dir = super::parent_dir(wanted);
        let stem = wanted.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = wanted.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
        for n in 1..10_000u32 {
            let p = if n == 1 {
                wanted.to_path_buf()
            } else {
                let base = format!("{stem} ({n})");
                if ext.is_empty() { dir.join(base) } else { dir.join(format!("{base}.{ext}")) }
            };
            if p.exists() && !(allow_existing && n == 1) {
                continue;
            }
            let path = p.to_string_lossy().into_owned();
            let ok = self.sched.storage.write(|tx| {
                match tx.execute(
                    "UPDATE job_items SET reserved_path = ?3, reserved_norm = ?4 WHERE job_id = ?1 AND idx = ?2",
                    params![self.job_id, idx, path, normalize_path(&path)],
                ) {
                    Ok(_) => Ok(true),
                    Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => Ok(false),
                    Err(e) => Err(e.into()),
                }
            })?;
            if ok {
                return Ok(p);
            }
        }
        Err(JobError::new(code::FAILED, "no free output name"))
    }

    /// The job's own temp dir inside `out_dir` (registered before it is created).
    pub fn temp_dir(&self, out_dir: &Path) -> Result<PathBuf, JobError> {
        let dir = out_dir.join(temp_dir_name(self.job_id));
        let path = dir.to_string_lossy().into_owned();
        self.sched.storage.write(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO job_temp_dirs (job_id, path, created_at) VALUES (?1, ?2, ?3)",
                params![self.job_id, path, now_ms()],
            )?;
            Ok(())
        })?;
        std::fs::create_dir_all(&dir).map_err(|e| JobError::new(code::FAILED, format!("temp dir: {e}")))?;
        #[cfg(windows)]
        hide(&dir);
        Ok(dir)
    }

    /// Progress inside the current item (throttled; None = unknown).
    pub fn progress(&self, fraction: Option<f64>) {
        {
            let mut last = lock(&self.last_progress);
            if last.is_some_and(|t| t.elapsed() < PROGRESS_EVERY) && fraction.is_some_and(|f| f < 1.0) {
                return;
            }
            *last = Some(Instant::now());
        }
        let _ = self.sched.change(self.job_id, None, |tx| {
            tx.execute("UPDATE jobs SET fraction = ?2 WHERE id = ?1", params![self.job_id, fraction.map(|f| f.clamp(0.0, 1.0))])?;
            Ok(())
        });
    }

    /// Free space check before an item (skipped when unknown).
    pub fn check_space(&self, dir: &Path, needed: u64) -> Result<(), JobError> {
        match self.env().free_space(dir) {
            Some(free) if free < needed => Err(JobError::new(
                code::DISK_FULL,
                format!("{} MiB free, {} MiB needed", free >> 20, needed.div_ceil(1 << 20)),
            )),
            _ => Ok(()),
        }
    }

    /// The final file exists and is complete: item done, artifact recorded (same transaction).
    pub fn complete_item(&self, idx: i64, output: &Path, bytes: u64) -> Result<(), JobError> {
        self.complete_item_with(idx, output, bytes, Value::Null)
    }

    /// Like `complete_item`; `extra` (an object) is merged into the artifact record (A04:
    /// recipe, pinned models, source fingerprint, output size / colour / alpha / metadata).
    pub fn complete_item_with(&self, idx: i64, output: &Path, bytes: u64, extra: Value) -> Result<(), JobError> {
        let ok = std::fs::metadata(output).is_ok_and(|m| m.is_file() && m.len() > 0);
        if !ok {
            return self.fail_item(idx, code::FAILED, "output missing or empty");
        }
        let out = output.to_string_lossy().into_owned();
        self.sched.change(self.job_id, Some(idx), |tx| {
            let now = now_ms();
            tx.execute(
                "UPDATE job_items SET state = 'completed', output_path = ?3, output_bytes = ?4, reserved_path = NULL,
                   reserved_norm = NULL, finished_at = ?5 WHERE job_id = ?1 AND idx = ?2",
                params![self.job_id, idx, out, bytes as i64, now],
            )?;
            let media: Option<String> = tx.query_row("SELECT media_id FROM job_items WHERE job_id = ?1 AND idx = ?2", params![self.job_id, idx], |r| r.get(0))?;
            let mut params_v = serde_json::json!({ "attemptId": self.attempt_id, "idx": idx });
            if let (Some(p), Value::Object(e)) = (params_v.as_object_mut(), extra) {
                p.extend(e);
            }
            let params_json = params_v.to_string();
            tx.execute(
                "INSERT INTO artifacts (id, media_id, kind, path, params, created_at, job_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![uuid::Uuid::new_v4().to_string(), media, self.kind, out, params_json, now, self.job_id],
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO job_checkpoints (job_id, kind, key, attempt_id, data, created_at) VALUES (?1, 'item', ?2, ?3, ?4, ?5)",
                params![self.job_id, idx.to_string(), self.attempt_id, serde_json::json!({ "output": out, "bytes": bytes }).to_string(), now],
            )?;
            tx.execute("UPDATE jobs SET fraction = NULL WHERE id = ?1", [self.job_id])?;
            Ok(())
        })?;
        self.env().on_output(output);
        Ok(())
    }

    /// `conflict: skip` and the output existed.
    pub fn skip_item(&self, idx: i64, output: Option<&Path>) -> Result<(), JobError> {
        let out = output.map(|p| p.to_string_lossy().into_owned());
        self.sched.change(self.job_id, Some(idx), |tx| {
            tx.execute(
                "UPDATE job_items SET state = 'skipped', output_path = ?3, reserved_path = NULL, reserved_norm = NULL, finished_at = ?4
                 WHERE job_id = ?1 AND idx = ?2",
                params![self.job_id, idx, out, now_ms()],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    pub fn fail_item(&self, idx: i64, code: &str, detail: &str) -> Result<(), JobError> {
        self.sched.change(self.job_id, Some(idx), |tx| {
            tx.execute(
                "UPDATE job_items SET state = 'failed', error_code = ?3, error_detail = ?4, reserved_path = NULL, reserved_norm = NULL,
                   finished_at = ?5 WHERE job_id = ?1 AND idx = ?2",
                params![self.job_id, idx, code, detail, now_ms()],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    /// The item was stopped (cancel/pause) before finishing: not done, not counted.
    pub fn release_item(&self, idx: i64) -> Result<(), JobError> {
        self.sched.change(self.job_id, Some(idx), |tx| {
            tx.execute(
                "UPDATE job_items SET state = 'pending', reserved_path = NULL, reserved_norm = NULL WHERE job_id = ?1 AND idx = ?2",
                params![self.job_id, idx],
            )?;
            Ok(())
        })?;
        Ok(())
    }
}

#[cfg(windows)]
fn hide(dir: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, SetFileAttributesW};
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN);
    }
}
