//! Persistent job queue and recovery (Plan 11/A02).
//!
//! * Jobs live in library.db (tables of migration v2 `jobs`, owned by `storage::migrations`);
//!   specification: docs/jobs-api.md.
//! * One worker thread runs long jobs one after another ([`scheduler`]); adapters
//!   ([`adapters`]) wrap the existing runners: the D1 ffmpeg export and the photo batch.
//! * Cancel authority: the `photo::JobGuard` registry keyed by the job id (the same switch
//!   `media_job_cancel` / `photo_cancel` use); the export runner only kills its own child.
//! * After a crash / forced close, running jobs become `interrupted`; nothing resumes on its
//!   own. "Continue" re-validates the recipe, the pinned tool/model version and the source
//!   fingerprints; completed items are never repeated and a partial file never counts.

pub mod adapters;
pub mod external;
pub mod scheduler;
pub mod store;
#[cfg(test)]
mod tests;

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::storage::StorageError;
pub use scheduler::Scheduler;

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    Pausing,
    Paused,
    Cancelling,
    Cancelled,
    Completed,
    Failed,
    Interrupted,
}

impl JobState {
    pub const ALL: [JobState; 9] = [
        JobState::Queued,
        JobState::Running,
        JobState::Pausing,
        JobState::Paused,
        JobState::Cancelling,
        JobState::Cancelled,
        JobState::Completed,
        JobState::Failed,
        JobState::Interrupted,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Pausing => "pausing",
            JobState::Paused => "paused",
            JobState::Cancelling => "cancelling",
            JobState::Cancelled => "cancelled",
            JobState::Completed => "completed",
            JobState::Failed => "failed",
            JobState::Interrupted => "interrupted",
        }
    }

    pub fn parse(s: &str) -> Option<JobState> {
        JobState::ALL.into_iter().find(|st| st.as_str() == s)
    }

    /// No further transition without a new submission.
    pub fn is_terminal(self) -> bool {
        matches!(self, JobState::Completed | JobState::Cancelled)
    }

    /// Waiting for the user (continue / restart / remove).
    pub fn needs_decision(self) -> bool {
        matches!(self, JobState::Failed | JobState::Interrupted | JobState::Paused)
    }
}

pub mod item_state {
    pub const PENDING: &str = "pending";
    pub const COMPLETED: &str = "completed";
    pub const SKIPPED: &str = "skipped";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}

// ---------------------------------------------------------------------------
// Errors (sent as { code, message })
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
}

pub mod code {
    pub const STORAGE: &str = "storageUnavailable";
    pub const NOT_FOUND: &str = "notFound";
    pub const INVALID_STATE: &str = "invalidState";
    pub const INVALID_REQUEST: &str = "invalidRequest";
    pub const SOURCE_MISSING: &str = "sourceMissing";
    pub const SOURCE_CHANGED: &str = "sourceChanged";
    pub const MODEL_CHANGED: &str = "modelChanged";
    pub const RECIPE_CHANGED: &str = "recipeChanged";
    pub const DISK_FULL: &str = "diskFull";
    /// The output folder cannot be written (access denied by the OS)
    pub const PERMISSION: &str = "permissionDenied";
    pub const ITEMS_FAILED: &str = "itemsFailed";
    pub const NO_FFMPEG: &str = "noFfmpeg";
    pub const UNSUPPORTED: &str = "unsupported";
    pub const FAILED: &str = "failed";
    /// No webview runner for an AI job (page not loaded); continue runs it again
    pub const RUNNER_UNAVAILABLE: &str = "runnerUnavailable";
    /// AI inference: out of (GPU) memory on every backend / tile size
    pub const MEMORY: &str = "memory";
    /// AI inference: the model could not be loaded or run (not retried on the CPU)
    pub const MODEL_FAILED: &str = "modelFailed";
    /// Q04: the output folder / source is not one the user chose
    pub const PATH_NOT_GRANTED: &str = "pathNotGranted";
}

impl JobError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        JobError { code, message: message.into() }
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl Serialize for JobError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("JobError", 2)?;
        st.serialize_field("code", self.code)?;
        st.serialize_field("message", &self.message)?;
        st.end()
    }
}

impl From<StorageError> for JobError {
    fn from(e: StorageError) -> Self {
        JobError::new(code::STORAGE, e.to_string())
    }
}

impl From<rusqlite::Error> for JobError {
    fn from(e: rusqlite::Error) -> Self {
        JobError::new(code::STORAGE, e.to_string())
    }
}

/// Error code of a runner error string (`[cancelled] ...`, `[no-ffmpeg] ...`, OS messages).
pub fn classify_error(e: &str) -> &'static str {
    let lower = e.to_lowercase();
    if e.starts_with(crate::actions::ERR_NO_FFMPEG) {
        code::NO_FFMPEG
    } else if e.starts_with(crate::actions::ERR_UNSUPPORTED) {
        code::UNSUPPORTED
    } else if lower.contains("no space left") || lower.contains("not enough space") || lower.contains("disk full")
        || lower.contains("os error 112") || lower.contains("yeterli alan yok")
    {
        code::DISK_FULL
    } else if lower.contains("access is denied") || lower.contains("permission denied") || lower.contains("erişim engellendi")
        || lower.contains("os error 5)") || lower.contains("os error 13)")
    {
        code::PERMISSION
    } else {
        code::FAILED
    }
}

// ---------------------------------------------------------------------------
// Snapshots and events
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub title: String,
    pub attempt_id: Option<String>,
    pub attempts: i64,
    pub seq: i64,
    pub stage: String,
    /// completed + skipped items
    pub done: i64,
    /// items; None = unknown
    pub total: Option<i64>,
    /// progress inside the current item (0..1); None = unknown (no fake percentage)
    pub fraction: Option<f64>,
    pub failed: i64,
    pub skipped: i64,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub resume_block: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobItem {
    pub idx: i64,
    pub input_path: String,
    pub state: String,
    pub attempt_id: Option<String>,
    pub reserved_path: Option<String>,
    pub output_path: Option<String>,
    pub output_bytes: Option<i64>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEvent {
    pub idx: i64,
    pub state: String,
    pub output_path: Option<String>,
    pub error_code: Option<String>,
}

/// `job-event`: every state/progress/item change. `seq` grows strictly per job.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub job_id: String,
    pub attempt_id: Option<String>,
    pub item_id: Option<i64>,
    pub seq: i64,
    pub job: JobSnapshot,
    pub item: Option<ItemEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelPin {
    pub id: String,
    pub version: String,
}

// ---------------------------------------------------------------------------
// Source fingerprint and recipe hash
// ---------------------------------------------------------------------------

const SAMPLE: u64 = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub mtime_ns: i64,
    /// sha256(size ‖ first 1 MiB ‖ middle 1 MiB ‖ last 1 MiB), whole file below 3 MiB
    pub sample: String,
}

pub fn fingerprint(path: &Path) -> std::io::Result<Fingerprint> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    if !meta.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file"));
    }
    let size = meta.len();
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos().min(i64::MAX as u128) as i64);
    let mut h = Sha256::new();
    h.update(size.to_le_bytes());
    let mut buf = vec![0u8; SAMPLE as usize];
    let mut take = |f: &mut std::fs::File, at: u64, len: u64, h: &mut Sha256| -> std::io::Result<()> {
        f.seek(SeekFrom::Start(at))?;
        let mut left = len as usize;
        while left > 0 {
            let n = f.read(&mut buf[..left.min(SAMPLE as usize)])?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            left -= n;
        }
        Ok(())
    };
    if size <= 3 * SAMPLE {
        take(&mut f, 0, size, &mut h)?;
    } else {
        take(&mut f, 0, SAMPLE, &mut h)?;
        take(&mut f, size / 2 - SAMPLE / 2, SAMPLE, &mut h)?;
        take(&mut f, size - SAMPLE, SAMPLE, &mut h)?;
    }
    Ok(Fingerprint { size, mtime_ns, sample: crate::ai::hex(&h.finalize()) })
}

/// Keys that never belong to the recipe (ids of this run, internal fields).
const VOLATILE_KEYS: &[&str] = &["jobId", "requestId"];

fn canonical_into(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().filter(|k| !VOLATILE_KEYS.contains(&k.as_str())).collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                canonical_into(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_into(x, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Canonical JSON (sorted keys, volatile ids removed).
pub fn canonical_json(v: &Value) -> String {
    let mut s = String::new();
    canonical_into(v, &mut s);
    s
}

/// SHA-256 hex of the canonical request + kind + schema version.
pub fn recipe_hash(kind: &str, schema_version: u32, request: &Value) -> String {
    let mut h = Sha256::new();
    h.update(format!("{kind}\n{schema_version}\n").as_bytes());
    h.update(canonical_json(request).as_bytes());
    crate::ai::hex(&h.finalize())
}

// ---------------------------------------------------------------------------
// Environment (Tauri side; tests use their own)
// ---------------------------------------------------------------------------

pub trait JobEnv: Send + Sync {
    fn emit(&self, ev: &JobEvent);
    /// Current version of a tool/model a job pinned (None = not available).
    fn model_version(&self, id: &str) -> Option<String>;
    fn free_space(&self, dir: &Path) -> Option<u64>;
    /// Tests only: pause between writing an item's temp file and placing it.
    fn item_delay(&self) -> Option<Duration> {
        None
    }
    /// A new output file (the webview may show it).
    fn on_output(&self, _path: &Path) {}
    /// Webview runner messages (`job-run`, `job-stop`) of external jobs (AI, A03).
    fn emit_runner(&self, _event: &str, _payload: &Value) {}
    /// Default output folder of AI results (inside the app data, not the user's folders).
    fn results_dir(&self) -> Option<PathBuf> {
        None
    }
}

struct TauriEnv {
    app: AppHandle,
}

fn test_mode() -> bool {
    crate::platform::data_dir_override().is_some()
}

fn test_env(name: &str) -> Option<String> {
    test_mode().then(|| std::env::var(name).ok()).flatten().filter(|v| !v.is_empty())
}

impl JobEnv for TauriEnv {
    fn emit(&self, ev: &JobEvent) {
        let _ = self.app.emit("job-event", ev);
    }

    fn model_version(&self, id: &str) -> Option<String> {
        match id {
            "ffmpeg" => test_env("VHO_JOBS_TEST_MODEL_VERSION").or_else(|| crate::actions::ffmpeg::tools_info().version),
            _ if id.starts_with("ai:") => external::resolve_pin(id, |c| crate::ai::component_version(&self.app, c)),
            _ => None,
        }
    }

    fn emit_runner(&self, event: &str, payload: &Value) {
        let _ = self.app.emit(event, payload);
    }

    fn results_dir(&self) -> Option<PathBuf> {
        let dir = crate::platform::data_dir(&self.app).ok()?.join("ai-results");
        std::fs::create_dir_all(&dir).ok()?;
        let _ = self.app.asset_protocol_scope().allow_directory(&dir, true);
        Some(dir)
    }

    fn free_space(&self, dir: &Path) -> Option<u64> {
        crate::ai::volume_free_bytes(dir)
    }

    fn item_delay(&self) -> Option<Duration> {
        test_env("VHO_JOBS_TEST_ITEM_DELAY_MS").and_then(|v| v.parse().ok()).map(Duration::from_millis)
    }

    fn on_output(&self, path: &Path) {
        let _ = self.app.asset_protocol_scope().allow_file(path);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

static SCHEDULER: OnceLock<Result<Arc<Scheduler>, JobError>> = OnceLock::new();

/// Opened on first use (after the storage); recovery of interrupted jobs runs here.
fn scheduler(app: &AppHandle) -> Result<Arc<Scheduler>, JobError> {
    SCHEDULER
        .get_or_init(|| {
            let state = app.state::<crate::storage::StorageState>();
            let storage = state
                .get(|| crate::platform::data_dir(app))
                .map_err(|e| JobError::new(code::STORAGE, e.to_string()))?;
            let env: Arc<dyn JobEnv> = Arc::new(TauriEnv { app: app.clone() });
            let s = Scheduler::open(storage, env, adapters::all())?;
            s.start_worker();
            Ok(s)
        })
        .clone()
}

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&Scheduler) -> Result<T, JobError> + Send + 'static,
) -> Result<T, JobError> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = scheduler(&app)?;
        f(&s)
    })
        .await
        .map_err(|e| JobError::new(code::FAILED, e.to_string()))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub kind: String,
    pub request: Value,
    pub title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    pub job: JobSnapshot,
    pub items: Vec<JobItem>,
}

/// All jobs (newest first). Also the first call that opens the queue and recovers it.
#[tauri::command]
pub async fn jobs_list(app: AppHandle) -> Result<Vec<JobSnapshot>, JobError> {
    blocking(app, |s| s.list()).await
}

#[tauri::command]
pub async fn jobs_get(app: AppHandle, id: String) -> Result<JobDetail, JobError> {
    blocking(app, move |s| Ok(JobDetail { job: s.snapshot(&id)?, items: s.items(&id)? })).await
}

#[tauri::command]
pub async fn jobs_submit(app: AppHandle, job: SubmitRequest) -> Result<JobSnapshot, JobError> {
    let app2 = app.clone();
    blocking(app, move |s| {
        require_job_targets(&app2, &job.kind, &job.request)?;
        s.submit(&job.kind, job.request, job.title)
    })
    .await
}

/// Q04: where a queued job writes (the same rules as the direct commands). AI jobs write into
/// the app's own result folder; their copy is checked by `jobs_output_copy`.
fn require_job_targets(app: &AppHandle, kind: &str, request: &Value) -> Result<(), JobError> {
    let denied = |e: String| JobError::new(code::PATH_NOT_GRANTED, e);
    let invalid = |e: serde_json::Error| JobError::new(code::INVALID_REQUEST, e.to_string());
    match kind {
        "export" => {
            let req: crate::actions::ffmpeg::JobRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
            crate::actions::require_export_target(app, &req).map_err(denied)
        }
        "photo-batch" => {
            let job: crate::photo::ops::BatchJob = serde_json::from_value(request.clone()).map_err(invalid)?;
            crate::photo::require_batch_targets(app, &job).map_err(denied)
        }
        // A05: without `output.dir` the result goes to the app's result folder
        "photo-enhance" => {
            let req: adapters::EnhanceRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
            match &req.output.dir {
                Some(d) => crate::grants::require(app, Path::new(d), crate::grants::Access::IntoFolder).map_err(denied),
                None => Ok(()),
            }
        }
        // full result next to the source (or the chosen folder); the preview goes to the app's folder
        "video-enhance" => {
            let req: adapters::VideoEnhanceRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
            match req.target_dir() {
                Some(d) => crate::grants::require(app, &d, crate::grants::Access::IntoFolder).map_err(denied),
                None => Ok(()),
            }
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn jobs_cancel(app: AppHandle, id: String) -> Result<JobSnapshot, JobError> {
    blocking(app, move |s| s.cancel(&id)).await
}

#[tauri::command]
pub async fn jobs_pause(app: AppHandle, id: String) -> Result<JobSnapshot, JobError> {
    blocking(app, move |s| s.pause(&id)).await
}

/// mode: "continue" (validated, completed items kept) | "restart" (everything again)
#[tauri::command]
pub async fn jobs_resume(app: AppHandle, id: String, mode: String) -> Result<JobSnapshot, JobError> {
    blocking(app, move |s| match mode.as_str() {
        "continue" => s.resume_continue(&id),
        "restart" => s.restart(&id),
        _ => Err(JobError::new(code::INVALID_REQUEST, format!("unknown mode {mode}"))),
    })
    .await
}

#[tauri::command]
pub async fn jobs_remove(app: AppHandle, id: String) -> Result<bool, JobError> {
    blocking(app, move |s| s.remove(&id)).await
}

/// A04: copy of a completed item's output next to its source (no overwrite); returns the path.
#[tauri::command]
pub async fn jobs_output_copy(app: AppHandle, id: String, idx: i64, dir: Option<String>) -> Result<String, JobError> {
    let app2 = app.clone();
    blocking(app, move |s| {
        // Q04: the copy goes into the given folder or next to the source: the user's folder
        let target = match &dir {
            Some(d) => PathBuf::from(d),
            None => s.output_source_dir(&id, idx)?,
        };
        crate::grants::require(&app2, &target, crate::grants::Access::IntoFolder).map_err(|e| JobError::new(code::PATH_NOT_GRANTED, e))?;
        s.copy_output(&id, idx, dir.map(PathBuf::from))
    })
    .await
}

#[tauri::command]
pub async fn jobs_clear_finished(app: AppHandle) -> Result<usize, JobError> {
    blocking(app, |s| s.clear_finished()).await
}

/// Folder of a path (helper shared by adapters).
pub(crate) fn parent_dir(p: &Path) -> PathBuf {
    p.parent().map(Path::to_path_buf).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Webview runner of AI jobs (A03, see external.rs)
// ---------------------------------------------------------------------------

/// The page (re)loaded and runs these job kinds; runs of an earlier page are lost.
#[tauri::command]
pub async fn jobs_runner_ready(app: AppHandle, kinds: Vec<String>) -> Result<(), JobError> {
    external::runner_ready(&kinds);
    // opening the queue here also recovers it and starts the worker
    blocking(app, |_| Ok(())).await
}

#[tauri::command]
pub async fn jobs_ext_begin(job_id: String, attempt_id: String, idx: i64) -> Result<(), JobError> {
    run_blocking(move || external::begin(&job_id, &attempt_id, idx)).await
}

#[tauri::command]
pub fn jobs_ext_progress(job_id: String, attempt_id: String, fraction: Option<f64>) -> Result<(), JobError> {
    external::send(&job_id, &attempt_id, external::Msg::Progress { fraction })
}

#[tauri::command]
pub async fn jobs_ext_fail(job_id: String, attempt_id: String, idx: i64, code: String, detail: String) -> Result<(), JobError> {
    run_blocking(move || external::fail(&job_id, &attempt_id, idx, code, detail)).await
}

#[tauri::command]
pub fn jobs_ext_done(job_id: String, attempt_id: String) -> Result<(), JobError> {
    external::send(&job_id, &attempt_id, external::Msg::Done)
}

/// Raw RGBA body (binary IPC, no base64); headers `x-job-id`, `x-attempt-id`, `x-idx`,
/// `x-width`, `x-height`. Returns the final output path.
#[tauri::command]
pub async fn jobs_ext_output(request: tauri::ipc::Request<'_>) -> Result<String, JobError> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let bad = || JobError::new(code::INVALID_REQUEST, "missing x-job-id / x-attempt-id / x-idx / x-width / x-height");
    let job_id = header("x-job-id").ok_or_else(bad)?;
    let attempt_id = header("x-attempt-id").ok_or_else(bad)?;
    let num = |k: &str| header(k).and_then(|v| v.parse::<i64>().ok()).ok_or_else(bad);
    let (idx, width, height) = (num("x-idx")?, num("x-width")?, num("x-height")?);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(JobError::new(code::INVALID_REQUEST, "expected a binary body"));
    };
    let rgba = bytes.clone();
    run_blocking(move || external::output(&job_id, &attempt_id, idx, width as u32, height as u32, rgba)).await
}

async fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, JobError> + Send + 'static) -> Result<T, JobError> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| JobError::new(code::FAILED, e.to_string()))?
}
