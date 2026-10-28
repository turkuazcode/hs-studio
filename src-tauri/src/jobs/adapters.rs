//! Queue adapters around the existing runners: the D1 ffmpeg export (`actions::ffmpeg::run_job`)
//! and the photo batch (`photo::ops::process_file_with`). Neither runner is duplicated; the
//! adapters add name reservation, the job's temp dir, no-clobber placement and item records.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rayon::prelude::*;
use serde_json::Value;

use super::scheduler::{Adapter, Planned, RunCtx};
use super::{JobEnv, JobError, ModelPin, classify_error, code, parent_dir};
use crate::actions::ffmpeg::{self, JobRequest};
use crate::actions::files::{place_no_clobber, unique_path};
use crate::photo::ERR_CANCELLED;
use crate::photo::ops::{self, BatchJob, Conflict};

pub fn all() -> Vec<Arc<dyn Adapter>> {
    let mut v: Vec<Arc<dyn Adapter>> =
        vec![Arc::new(ExportAdapter), Arc::new(PhotoBatchAdapter), Arc::new(PhotoEnhanceAdapter), Arc::new(VideoEnhanceAdapter)];
    for kind in super::external::AI_KINDS {
        v.push(Arc::new(super::external::ExternalAdapter::new(kind)));
    }
    v
}

fn invalid(e: impl std::fmt::Display) -> JobError {
    JobError::new(code::INVALID_REQUEST, e.to_string())
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Writes and flushes to disk (a completed item must survive a power cut).
fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = std::fs::File::create(path).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    f.write_all(bytes).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    f.sync_all().map_err(|e| format!("Dosya yazılamadı: {e}"))
}

// ---------------------------------------------------------------------------
// D1 export (one item)
// ---------------------------------------------------------------------------

pub struct ExportAdapter;

/// Minimum free space before an export starts (ffmpeg failing on a full disk is reported as
/// `diskFull` as well).
const EXPORT_MIN_FREE: u64 = 64 << 20;

impl Adapter for ExportAdapter {
    fn kind(&self) -> &'static str {
        "export"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn plan(&self, request: &Value, env: &dyn JobEnv) -> Result<Planned, JobError> {
        let req: JobRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
        let input = PathBuf::from(&req.input);
        if !input.is_file() {
            return Err(JobError::new(code::SOURCE_MISSING, file_name(&input)));
        }
        if req.output.as_deref().is_some_and(|o| Path::new(o) == input) {
            return Err(invalid("output would replace the source"));
        }
        let model = env.model_version("ffmpeg").map(|version| ModelPin { id: "ffmpeg".into(), version });
        Ok(Planned { title: file_name(&input), inputs: vec![input], model })
    }

    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let mut req: JobRequest = serde_json::from_value(ctx.request.clone()).map_err(invalid)?;
        for item in &ctx.pending {
            if ctx.cancelled() {
                return Ok(());
            }
            ctx.begin_item(item.idx)?;
            match export_item(ctx, item.idx, &mut req) {
                Ok(()) => {}
                Err(e) if e.code == code::NO_FFMPEG => {
                    ctx.fail_item(item.idx, e.code, &e.message)?;
                    return Err(e);
                }
                Err(e) => ctx.fail_item(item.idx, e.code, &e.message)?,
            }
        }
        Ok(())
    }
}

fn export_item(ctx: &RunCtx<'_>, idx: i64, req: &mut JobRequest) -> Result<(), JobError> {
    let input = PathBuf::from(&req.input);
    // the same name the direct runner would choose, then reserved for this job
    let (wanted, allow_existing) = match &req.output {
        Some(o) => (PathBuf::from(o), true), // chosen in a save dialog that asked about overwriting
        None => {
            let tools = ffmpeg::locate().map_err(|e| JobError::new(code::NO_FFMPEG, e))?;
            let info = ffmpeg::probe_with(&tools, &input).map_err(|e| JobError::new(classify_error(&e), e))?;
            let plan = ffmpeg::plan(&req.kind, &info, &input).map_err(|e| JobError::new(classify_error(&e), e))?;
            let dir = req.output_dir.as_deref().map(PathBuf::from).unwrap_or_else(|| parent_dir(&input));
            std::fs::create_dir_all(&dir).map_err(|e| JobError::new(code::FAILED, format!("Klasör oluşturulamadı: {e}")))?;
            let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "vho".into());
            (unique_path(&dir, &stem, &plan.suffix, &plan.ext, |p| p.exists()), false)
        }
    };
    let reserved = ctx.reserve(idx, &wanted, allow_existing)?;
    let out_dir = parent_dir(&reserved);
    ctx.check_space(&out_dir, EXPORT_MIN_FREE)?;
    let temp = ctx.temp_dir(&out_dir)?;
    req.output = Some(reserved.to_string_lossy().into_owned());
    req.temp_dir = Some(temp);
    req.no_clobber = !allow_existing;

    let (tx, rx) = std::sync::mpsc::channel::<f64>();
    let result = std::thread::scope(|s| {
        let runner = s.spawn(|| {
            ffmpeg::run_job(req, &|| ctx.cancelled(), move |p| {
                let _ = tx.send(p);
            })
        });
        for p in rx {
            ctx.progress(Some(p));
        }
        runner.join().unwrap_or_else(|_| Err("ffmpeg runner panicked".into()))
    });
    match result {
        Ok(r) => ctx.complete_item(idx, Path::new(&r.output), r.size),
        Err(e) if e.starts_with(ERR_CANCELLED) => ctx.release_item(idx),
        Err(e) => Err(JobError::new(classify_error(&e), e)),
    }
}

// ---------------------------------------------------------------------------
// Photo batch (one item per file; resumes at the file boundary)
// ---------------------------------------------------------------------------

pub struct PhotoBatchAdapter;

impl Adapter for PhotoBatchAdapter {
    fn kind(&self) -> &'static str {
        "photo-batch"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn plan(&self, request: &Value, _env: &dyn JobEnv) -> Result<Planned, JobError> {
        let job: BatchJob = serde_json::from_value(request.clone()).map_err(invalid)?;
        if job.files.is_empty() {
            return Err(invalid("no files"));
        }
        let inputs: Vec<PathBuf> = job.files.iter().map(PathBuf::from).collect();
        let title = if inputs.len() == 1 { file_name(&inputs[0]) } else { String::new() };
        Ok(Planned { title, inputs, model: None })
    }

    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let job: BatchJob = serde_json::from_value(ctx.request.clone()).map_err(invalid)?;
        let reserved = Mutex::new(HashSet::<PathBuf>::new());
        // half of the cores: playback and the UI stay responsive while a batch runs
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get()).div_ceil(2).max(1);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("vho-job-photo-{i}"))
            .build()
            .map_err(|e| JobError::new(code::FAILED, e.to_string()))?;
        pool.install(|| {
            ctx.pending.par_iter().for_each(|item| {
                if ctx.cancelled() {
                    return; // stays pending (cancel/pause decides)
                }
                if let Err(e) = photo_item(ctx, &job, item.idx, Path::new(&item.path), &reserved) {
                    let _ = ctx.fail_item(item.idx, e.code, &e.message);
                }
            });
        });
        Ok(())
    }
}

fn photo_item(ctx: &RunCtx<'_>, job: &BatchJob, idx: i64, src: &Path, reserved: &Mutex<HashSet<PathBuf>>) -> Result<(), JobError> {
    ctx.begin_item(idx)?;
    let size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    let dir = job.output.dir.as_deref().map(PathBuf::from).unwrap_or_else(|| parent_dir(src));
    ctx.check_space(&dir, size.saturating_mul(2) + (16 << 20))?;
    let overwrite = job.output.conflict == Conflict::Overwrite;
    let writer = |target: &Path, bytes: &[u8]| -> Result<PathBuf, String> {
        let final_name = ctx.reserve(idx, target, overwrite).map_err(|e| e.message)?;
        let temp = ctx.temp_dir(&parent_dir(&final_name)).map_err(|e| e.message)?;
        let part = temp.join(format!("{idx}.part"));
        write_synced(&part, bytes)?;
        if let Some(d) = ctx.env().item_delay() {
            std::thread::sleep(d);
        }
        if overwrite {
            std::fs::rename(&part, &final_name).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
            Ok(final_name)
        } else {
            place_no_clobber(&part, &final_name)
        }
    };
    let outcome = ops::process_file_with(src, idx as usize, &job.ops, &job.output, reserved, &writer);
    match (&outcome.output, outcome.ok, outcome.skipped) {
        (out, true, true) => ctx.skip_item(idx, out.as_deref().map(Path::new)),
        (Some(out), true, false) => ctx.complete_item(idx, Path::new(out), outcome.bytes.unwrap_or(0)),
        _ => {
            let e = outcome.error.unwrap_or_else(|| "failed".into());
            Err(JobError::new(classify_error(&e), e))
        }
    }
}

// ---------------------------------------------------------------------------
// Faithful photo enhance (A05; `photo::enhance`, no model)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnhanceRequest {
    pub input: String,
    #[serde(default)]
    pub params: crate::photo::enhance::EnhanceParams,
    #[serde(default)]
    pub output: super::external::AiOutput,
}

pub struct PhotoEnhanceAdapter;

impl Adapter for PhotoEnhanceAdapter {
    fn kind(&self) -> &'static str {
        "photo-enhance"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn plan(&self, request: &Value, _env: &dyn JobEnv) -> Result<Planned, JobError> {
        let req: EnhanceRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
        req.params.validated().map_err(invalid)?;
        let input = PathBuf::from(&req.input);
        if !input.is_file() {
            return Err(JobError::new(code::SOURCE_MISSING, file_name(&input)));
        }
        Ok(Planned { title: file_name(&input), inputs: vec![input], model: None })
    }

    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let req: EnhanceRequest = serde_json::from_value(ctx.request.clone()).map_err(invalid)?;
        for item in &ctx.pending {
            if ctx.cancelled() {
                return Ok(());
            }
            ctx.begin_item(item.idx)?;
            match enhance_item(ctx, &req, item.idx) {
                Ok(()) => {}
                Err(e) if e.message.starts_with(ERR_CANCELLED) => ctx.release_item(item.idx)?,
                Err(e) => ctx.fail_item(item.idx, e.code, &e.message)?,
            }
        }
        Ok(())
    }
}

/// decode (upright, source colour space) -> enhance -> A04 encoding (EXIF policy, alpha,
/// orientation 1, source ICC kept since the pixels are still in its space) -> reserved name in
/// the result folder (or the given folder), never overwriting.
fn enhance_item(ctx: &RunCtx<'_>, req: &EnhanceRequest, idx: i64) -> Result<(), JobError> {
    use super::external::{clean_suffix, encode_output};
    let src = Path::new(&req.input);
    let decoded = crate::photo::decode::decode(src, None).map_err(|e| JobError::new(classify_error(&e), e))?;
    let input = decoded.image.to_rgba32f();
    let out = crate::photo::enhance::enhance(&input, req.params, &|| ctx.cancelled(), &|p| ctx.progress(Some(p * 0.9)))
        .map_err(|e| if e.starts_with(ERR_CANCELLED) { JobError::new(code::FAILED, e) } else { JobError::new(classify_error(&e), e) })?;
    drop(input);
    let (w, h) = (out.width(), out.height());
    let rgba: Vec<u8> = out.as_raw().iter().map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8).collect();
    drop(out);
    let dir = match &req.output.dir {
        Some(d) => PathBuf::from(d),
        None => ctx.env().results_dir().ok_or_else(|| JobError::new(code::FAILED, "no result folder"))?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| JobError::new(classify_error(&e.to_string()), e.to_string()))?;
    ctx.check_space(&dir, rgba.len() as u64 + (16 << 20))?;
    let software = format!("HS Studio {} faithful enhance", env!("CARGO_PKG_VERSION"));
    let enc = encode_output(src, rgba, w, h, &req.output, &software, decoded.icc.as_deref())?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "photo".into());
    let suffix = clean_suffix(Some(req.output.suffix.as_deref().unwrap_or("_enhanced")));
    let wanted = dir.join(format!("{stem}{suffix}.{}", enc.ext));
    let final_name = ctx.reserve(idx, &wanted, false)?;
    let temp = ctx.temp_dir(&parent_dir(&final_name))?;
    let part = temp.join(format!("{idx}.part"));
    write_synced(&part, &enc.bytes).map_err(|e| JobError::new(classify_error(&e), e))?;
    let placed = place_no_clobber(&part, &final_name).map_err(|e| JobError::new(code::FAILED, e))?;
    ctx.progress(Some(1.0));
    let source = ctx.pending.iter().find(|p| p.idx == idx);
    let extra = serde_json::json!({
        "recipe": ctx.request,
        "source": { "size": source.and_then(|p| p.size), "fingerprint": source.and_then(|p| p.fp.clone()) },
        "output": {
            "width": w, "height": h, "format": enc.format, "bitDepth": 8,
            "iccCopied": decoded.icc.is_some(), "alpha": enc.alpha, "orientation": 1, "metadata": req.output.metadata,
        },
        "app": env!("CARGO_PKG_VERSION"),
    });
    ctx.complete_item_with(idx, &placed, enc.bytes.len() as u64, extra)
}

// ---------------------------------------------------------------------------
// Faithful video enhance (no model; `restoration::enhance`)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoEnhanceRequest {
    pub input: String,
    #[serde(default)]
    pub options: crate::restoration::enhance::EnhanceOptions,
    /// The user's answer when the field order could not be measured
    #[serde(default)]
    pub field_order: Option<crate::restoration::probe::FieldOrder>,
    /// Side-by-side preview of `PREVIEW_SECONDS` from `start` (into the app's result folder)
    #[serde(default)]
    pub preview: bool,
    #[serde(default)]
    pub start: f64,
    /// Folder of the full result; default: next to the source
    #[serde(default)]
    pub output_dir: Option<String>,
}

impl VideoEnhanceRequest {
    /// Where the result goes (None: preview into the app's result folder)
    pub fn target_dir(&self) -> Option<PathBuf> {
        if self.preview {
            return None;
        }
        Some(self.output_dir.as_deref().map(PathBuf::from).unwrap_or_else(|| crate::restoration::enhance::default_dir(Path::new(&self.input))))
    }
}

pub struct VideoEnhanceAdapter;

impl Adapter for VideoEnhanceAdapter {
    fn kind(&self) -> &'static str {
        "video-enhance"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn plan(&self, request: &Value, env: &dyn JobEnv) -> Result<Planned, JobError> {
        let req: VideoEnhanceRequest = serde_json::from_value(request.clone()).map_err(invalid)?;
        let input = PathBuf::from(&req.input);
        if !input.is_file() {
            return Err(JobError::new(code::SOURCE_MISSING, file_name(&input)));
        }
        if !req.start.is_finite() || req.start < 0.0 {
            return Err(invalid("start"));
        }
        let model = env.model_version("ffmpeg").map(|version| ModelPin { id: "ffmpeg".into(), version });
        Ok(Planned { title: file_name(&input), inputs: vec![input], model })
    }

    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let req: VideoEnhanceRequest = serde_json::from_value(ctx.request.clone()).map_err(invalid)?;
        for item in &ctx.pending {
            if ctx.cancelled() {
                return Ok(());
            }
            ctx.begin_item(item.idx)?;
            match video_enhance_item(ctx, &req, item.idx) {
                Ok(()) => {}
                Err(e) if e.message.starts_with(ERR_CANCELLED) => ctx.release_item(item.idx)?,
                Err(e) if e.code == code::NO_FFMPEG => {
                    ctx.fail_item(item.idx, e.code, &e.message)?;
                    return Err(e);
                }
                Err(e) => ctx.fail_item(item.idx, e.code, &e.message)?,
            }
        }
        Ok(())
    }
}

fn video_enhance_item(ctx: &RunCtx<'_>, req: &VideoEnhanceRequest, idx: i64) -> Result<(), JobError> {
    use crate::restoration::{self, enhance, recipe};
    let input = PathBuf::from(&req.input);
    let tools = ffmpeg::locate().map_err(|e| JobError::new(code::NO_FFMPEG, e))?;
    let report = restoration::report_for(&tools, &input).map_err(|e| JobError::new(classify_error(&e), e))?;
    let range = req.preview.then(|| recipe::TimeRange { start: req.start, end: Some(req.start + enhance::PREVIEW_SECONDS) });
    let built = enhance::build_recipe(&report, req.options, range, req.field_order);
    let eval = restoration::evaluate(&tools, report.clone(), built);
    let Some(recipe) = eval.recipe.filter(|_| eval.assessment.status != recipe::Status::Blocked) else {
        let codes = if eval.assessment.blockers.is_empty() { "no-video".to_string() } else { eval.assessment.blockers.join(",") };
        return Err(JobError::new(code::UNSUPPORTED, format!("[video-blocked] {codes}")));
    };
    let encoder = ffmpeg::encoder_choice().map_or_else(ffmpeg::default_encoder, |c| c.encoder);
    let dir = match req.target_dir() {
        Some(d) => d,
        None => ctx.env().results_dir().ok_or_else(|| JobError::new(code::FAILED, "no result folder"))?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| JobError::new(classify_error(&e.to_string()), e.to_string()))?;
    let secs = enhance::expected_seconds(&recipe, &report, req.preview);
    let fps = recipe.output.fps.map(|r| r.value()).unwrap_or(30.0);
    let est = (enhance::video_kbps(recipe.scale.width, recipe.scale.height, fps) as f64 * 1000.0 / 8.0 * secs * 1.3) as u64;
    ctx.check_space(&dir, est + (64 << 20))?;
    let (stem, ext) = enhance::output_name(&input, req.preview);
    let wanted = unique_path(&dir, &stem, "", ext, |p| p.exists());
    let final_name = ctx.reserve(idx, &wanted, false)?;
    let temp = ctx.temp_dir(&parent_dir(&final_name))?;
    let part = temp.join(format!("{idx}.part.{ext}"));

    let (tx, rx) = std::sync::mpsc::channel::<f64>();
    let result = std::thread::scope(|s| {
        let runner = s.spawn(|| {
            enhance::render(&tools, &input, &recipe, &report, &encoder, &part, req.preview, &|| ctx.cancelled(), move |p| {
                let _ = tx.send(p);
            })
        });
        for p in rx {
            ctx.progress(Some(p));
        }
        runner.join().unwrap_or_else(|_| Err("ffmpeg runner panicked".into()))
    });
    let size = match result {
        Ok(size) => size,
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return Err(if e.starts_with(ERR_CANCELLED) { JobError::new(code::FAILED, e) } else { JobError::new(classify_error(&e), e) });
        }
    };
    let placed = place_no_clobber(&part, &final_name).map_err(|e| JobError::new(code::FAILED, e))?;
    ctx.progress(Some(1.0));
    let extra = serde_json::json!({
        "recipe": recipe,
        "recipeHash": eval.recipe_hash,
        "filter": eval.filter,
        "preview": req.preview,
        "encoder": encoder.name,
        "output": { "width": recipe.scale.width, "height": recipe.scale.height },
        "app": env!("CARGO_PKG_VERSION"),
    });
    ctx.complete_item_with(idx, &placed, size, extra)
}
