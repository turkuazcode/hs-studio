//! Jobs executed by the webview (Plan 11/A03): AI inference runs in a Web Worker (ONNX
//! Runtime Web), so the queue worker cannot run it itself. The external adapter keeps the job
//! in the queue like any other (one long job at a time, persistent, interrupted on restart,
//! validated on continue) and hands the work to the front-end runner:
//!
//!   queue worker                         webview runner (src/media/ai-jobs.js)
//!   `job-run` {jobId, attemptId, ...} ->  begin(idx) / progress / output(raw RGBA) / fail / done
//!   `job-stop` {jobId, attemptId}     ->  aborts the worker, then done
//!
//! Every runner call carries the attempt id; a stale attempt (an older run, a reloaded page)
//! is refused. A reloaded page announces itself with `jobs_runner_ready`: runs of the previous
//! page are lost and their jobs end `interrupted` (continue = run again, validated).
//! The output arrives as raw RGBA over binary IPC (no base64) and is written by the queue's
//! reservation / temp dir / no-clobber placement; a partial result never counts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use super::scheduler::{Adapter, Planned, RunCtx};
use crate::photo::exif::MetadataPolicy;
use super::{JobEnv, JobError, ModelPin, code, parent_dir};

/// Kinds the webview runs. `components`: AI components pinned at submit (validated on continue).
pub const AI_KINDS: &[&str] = &["ai-photo-enhance", "ai-inpaint", "ai-background", "ai-colorize"];

/// How long a job waits for a runner (a page that has not loaded yet) before it is put back.
const RUNNER_WAIT: Duration = Duration::from_secs(20);
/// After a stop request the runner has this long to answer `done`.
const STOP_GRACE: Duration = Duration::from_secs(15);
/// Largest output the runner may upload (RGBA bytes; ~64 MP).
pub const MAX_OUTPUT_BYTES: usize = 64_000_000 * 4;

pub enum Msg {
    Begin { idx: i64, reply: Sender<Result<(), JobError>> },
    Progress { fraction: Option<f64> },
    Output { idx: i64, width: u32, height: u32, rgba: Vec<u8>, reply: Sender<Result<String, JobError>> },
    Fail { idx: i64, code: String, detail: String, reply: Sender<Result<(), JobError>> },
    Done,
    /// The page that ran this attempt is gone (reload).
    Lost,
}

#[derive(Default)]
struct Bridge {
    /// job id -> (attempt id, channel into the adapter loop)
    runs: HashMap<String, (String, Sender<Msg>)>,
    ready: HashSet<String>,
}

static BRIDGE: LazyLock<Mutex<Bridge>> = LazyLock::new(Default::default);

fn bridge() -> std::sync::MutexGuard<'static, Bridge> {
    BRIDGE.lock().unwrap_or_else(|e| e.into_inner())
}

/// A (re)loaded page runs these kinds. Runs of an earlier page are lost.
pub fn runner_ready(kinds: &[String]) {
    let mut b = bridge();
    for (_, (_, tx)) in b.runs.drain() {
        let _ = tx.send(Msg::Lost);
    }
    b.ready = kinds.iter().filter(|k| AI_KINDS.contains(&k.as_str())).cloned().collect();
}

#[cfg(test)]
pub fn reset_runner() {
    let mut b = bridge();
    b.runs.clear();
    b.ready.clear();
}

/// Sends a runner message to the attempt's adapter loop (stale attempts are refused).
pub fn send(job_id: &str, attempt_id: &str, msg: Msg) -> Result<(), JobError> {
    let b = bridge();
    match b.runs.get(job_id) {
        Some((a, tx)) if a == attempt_id => tx.send(msg).map_err(|_| JobError::new(code::INVALID_STATE, "the run has ended")),
        _ => Err(JobError::new(code::INVALID_STATE, "not the running attempt of this job")),
    }
}

fn wait_reply<T>(rx: Receiver<Result<T, JobError>>) -> Result<T, JobError> {
    rx.recv_timeout(Duration::from_secs(600)).map_err(|_| JobError::new(code::INVALID_STATE, "the run has ended"))?
}

pub fn begin(job_id: &str, attempt_id: &str, idx: i64) -> Result<(), JobError> {
    let (tx, rx) = channel();
    send(job_id, attempt_id, Msg::Begin { idx, reply: tx })?;
    wait_reply(rx)
}

pub fn output(job_id: &str, attempt_id: &str, idx: i64, width: u32, height: u32, rgba: Vec<u8>) -> Result<String, JobError> {
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 || rgba.len() > MAX_OUTPUT_BYTES {
        return Err(JobError::new(code::INVALID_REQUEST, format!("bad image {width}x{height} ({} bytes)", rgba.len())));
    }
    let (tx, rx) = channel();
    send(job_id, attempt_id, Msg::Output { idx, width, height, rgba, reply: tx })?;
    wait_reply(rx)
}

pub fn fail(job_id: &str, attempt_id: &str, idx: i64, code: String, detail: String) -> Result<(), JobError> {
    let (tx, rx) = channel();
    send(job_id, attempt_id, Msg::Fail { idx, code, detail, reply: tx })?;
    wait_reply(rx)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    input: String,
    /// AI components the run uses (runtime + models); pinned with their manifest versions
    components: Vec<String>,
    #[serde(default)]
    output: AiOutput,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AiOutput {
    /// Output folder; None = the app's AI result folder (not the user's folders)
    dir: Option<String>,
    /// Name suffix before the extension (default `_restored`)
    suffix: Option<String>,
    /// "png" (default) | "jpeg" | "webp"
    format: Option<String>,
    /// JPEG / WebP quality (default 95)
    quality: Option<u8>,
    /// keep (default) | stripGps | strip — like the photo batch
    #[serde(default)]
    metadata: MetadataPolicy,
    /// JPEG has no alpha: transparent pixels are composited onto this colour (default white)
    background: Option<[u8; 3]>,
}

/// Encoded output (A04): RGBA from the page (sRGB, upright, 8 bit) -> file bytes.
/// - colour: the page's pixels are sRGB (the browser converted the source profile); the
///   source ICC profile is NOT copied (it would mislabel the pixels), no profile = sRGB;
/// - orientation: the pixels are upright, EXIF orientation is written as 1;
/// - EXIF: date / camera / copyright kept from the source, GPS by policy, pixel size updated,
///   stale thumbnail dropped; PNG also gets a `Software` text naming the AI components;
/// - alpha: kept in PNG/WebP when any pixel is not opaque; JPEG composites onto `background`.
pub struct Encoded {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
    pub alpha: bool,
    pub format: &'static str,
}

fn encode_output(src: &Path, rgba: Vec<u8>, w: u32, h: u32, out: &AiOutput, software: &str) -> Result<Encoded, JobError> {
    use crate::photo::ops::{self, OutFormat};
    let bad = |e: String| JobError::new(code::FAILED, e);
    let img = image::RgbaImage::from_raw(w, h, rgba).ok_or_else(|| JobError::new(code::INVALID_REQUEST, "bad image buffer"))?;
    let has_alpha = img.pixels().any(|p| p.0[3] < 255);
    let (format, fmt, ext) = match out.format.as_deref().unwrap_or("png") {
        "jpeg" | "jpg" => ("jpeg", OutFormat::Jpeg, "jpg"),
        "webp" => ("webp", OutFormat::Webp, "webp"),
        _ => ("png", OutFormat::Png, "png"),
    };
    let keep_alpha = has_alpha && fmt != OutFormat::Jpeg;
    let dynimg = if keep_alpha {
        image::DynamicImage::ImageRgba8(img)
    } else {
        let [br, bg, bb] = out.background.unwrap_or([255, 255, 255]).map(f32::from);
        let rgb = image::RgbImage::from_fn(w, h, |x, y| {
            let p = img.get_pixel(x, y).0;
            let a = p[3] as f32 / 255.0;
            let mix = |c: u8, b: f32| (c as f32 * a + b * (1.0 - a)).round() as u8;
            image::Rgb([mix(p[0], br), mix(p[1], bg), mix(p[2], bb)])
        });
        image::DynamicImage::ImageRgb8(rgb)
    };
    let quality = out.quality.unwrap_or(95).clamp(1, 100);
    let bytes = ops::encode(&dynimg, fmt, quality, None).map_err(bad)?;
    let tiff = crate::photo::exif::blob_for_output(src, out.metadata, 1, Some((w, h)));
    let mut bytes = ops::embed_exif(bytes, fmt, tiff.as_deref(), w, h);
    if fmt == OutFormat::Png {
        bytes = ops::png_with_text(&bytes, "Software", software);
    }
    Ok(Encoded { bytes, ext, alpha: keep_alpha, format })
}

pub struct ExternalAdapter {
    pub kind: &'static str,
    /// How long a job waits for a runner page before it fails with `runnerUnavailable`
    pub runner_wait: Duration,
}

impl ExternalAdapter {
    pub fn new(kind: &'static str) -> Self {
        ExternalAdapter { kind, runner_wait: RUNNER_WAIT }
    }
}

fn clean_suffix(s: Option<&str>) -> String {
    let s: String = s
        .unwrap_or("_restored")
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
        .take(40)
        .collect();
    if s.trim().is_empty() { "_restored".into() } else { s }
}

/// `ai:<id>+<id>...` -> versions joined with `+` (the env resolves each `ai:<id>`).
fn pin_components(components: &[String], env: &dyn JobEnv) -> Result<Option<ModelPin>, JobError> {
    if components.is_empty() {
        return Ok(None);
    }
    let mut versions = Vec::new();
    for c in components {
        let v = env
            .model_version(&format!("ai:{c}"))
            .ok_or_else(|| JobError::new(code::MODEL_CHANGED, format!("unknown AI component {c}")))?;
        versions.push(v);
    }
    Ok(Some(ModelPin { id: format!("ai:{}", components.join("+")), version: versions.join("+") }))
}

/// Resolves a pinned `ai:a+b` id to the current `va+vb` (None when one is missing).
pub fn resolve_pin(id: &str, one: impl Fn(&str) -> Option<String>) -> Option<String> {
    let list = id.strip_prefix("ai:")?;
    let mut out = Vec::new();
    for c in list.split('+') {
        out.push(one(c)?);
    }
    Some(out.join("+"))
}

impl Adapter for ExternalAdapter {
    fn kind(&self) -> &'static str {
        self.kind
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn plan(&self, request: &Value, env: &dyn JobEnv) -> Result<Planned, JobError> {
        let req: AiRequest = serde_json::from_value(request.clone()).map_err(|e| JobError::new(code::INVALID_REQUEST, e.to_string()))?;
        let input = PathBuf::from(&req.input);
        if !input.is_file() {
            return Err(JobError::new(code::SOURCE_MISSING, input.file_name().unwrap_or_default().to_string_lossy()));
        }
        let title = input.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(Planned { title, inputs: vec![input], model: pin_components(&req.components, env)? })
    }

    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let req: AiRequest = serde_json::from_value(ctx.request.clone()).map_err(|e| JobError::new(code::INVALID_REQUEST, e.to_string()))?;
        // wait for a page that runs this kind
        let started = Instant::now();
        while !bridge().ready.contains(self.kind) {
            if ctx.cancelled() {
                return Ok(());
            }
            if started.elapsed() > self.runner_wait {
                return Err(JobError::new(code::RUNNER_UNAVAILABLE, "no AI runner in the webview"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let (tx, rx) = channel();
        bridge().runs.insert(ctx.job_id.to_string(), (ctx.attempt_id.to_string(), tx));
        let items: Vec<Value> = ctx.pending.iter().map(|p| json!({ "idx": p.idx, "path": p.path })).collect();
        ctx.env().emit_runner(
            "job-run",
            &json!({ "jobId": ctx.job_id, "attemptId": ctx.attempt_id, "kind": self.kind, "request": ctx.request, "items": items }),
        );
        let out = self.serve(ctx, &req, &rx);
        let mut b = bridge();
        if b.runs.get(ctx.job_id).is_some_and(|(a, _)| a == ctx.attempt_id) {
            b.runs.remove(ctx.job_id);
        }
        out
    }
}

impl ExternalAdapter {
    fn serve(&self, ctx: &RunCtx<'_>, req: &AiRequest, rx: &Receiver<Msg>) -> Result<(), JobError> {
        let mut stop_sent: Option<Instant> = None;
        let mut running: Option<i64> = None;
        loop {
            if ctx.cancelled() && stop_sent.is_none() {
                ctx.env().emit_runner("job-stop", &json!({ "jobId": ctx.job_id, "attemptId": ctx.attempt_id }));
                stop_sent = Some(Instant::now());
            }
            if stop_sent.is_some_and(|t| t.elapsed() > STOP_GRACE) {
                break; // the page does not answer: the item stays unfinished
            }
            let msg = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            match msg {
                Msg::Begin { idx, reply } => {
                    let r = if !ctx.pending.iter().any(|p| p.idx == idx) {
                        Err(JobError::new(code::INVALID_REQUEST, format!("item {idx} is not pending")))
                    } else if stop_sent.is_some() {
                        Err(JobError::new(code::INVALID_STATE, "stopping"))
                    } else {
                        running = Some(idx);
                        ctx.begin_item(idx)
                    };
                    let _ = reply.send(r);
                }
                Msg::Progress { fraction } => ctx.progress(fraction),
                Msg::Output { idx, width, height, rgba, reply } => {
                    let r = if running != Some(idx) {
                        Err(JobError::new(code::INVALID_STATE, format!("item {idx} was not begun")))
                    } else {
                        let r = self.write_output(ctx, req, idx, width, height, rgba);
                        if r.is_ok() {
                            running = None;
                        }
                        r
                    };
                    let _ = reply.send(r);
                }
                Msg::Fail { idx, code: c, detail, reply } => {
                    let code = match c.as_str() {
                        code::DISK_FULL => code::DISK_FULL,
                        code::MEMORY => code::MEMORY,
                        code::MODEL_FAILED => code::MODEL_FAILED,
                        code::UNSUPPORTED => code::UNSUPPORTED,
                        _ => code::FAILED,
                    };
                    let r = ctx.fail_item(idx, code, &detail);
                    if running == Some(idx) {
                        running = None;
                    }
                    let _ = reply.send(r);
                }
                Msg::Done | Msg::Lost => break,
            }
        }
        if let Some(idx) = running {
            ctx.release_item(idx)?; // stopped or lost mid-item: not done, not counted
        }
        Ok(())
    }

    /// RGBA -> encoded file (A04 colour / orientation / EXIF / alpha rules, see `encode_output`)
    /// in the job's temp dir -> reserved final name (no overwrite) -> completed, with the
    /// recipe record in the artifact.
    fn write_output(&self, ctx: &RunCtx<'_>, req: &AiRequest, idx: i64, w: u32, h: u32, rgba: Vec<u8>) -> Result<String, JobError> {
        let src = Path::new(&req.input);
        let dir = match &req.output.dir {
            Some(d) => PathBuf::from(d),
            None => ctx.env().results_dir().ok_or_else(|| JobError::new(code::FAILED, "no AI result folder"))?,
        };
        std::fs::create_dir_all(&dir).map_err(|e| JobError::new(super::classify_error(&e.to_string()), e.to_string()))?;
        ctx.check_space(&dir, rgba.len() as u64 + (16 << 20))?;
        let software = format!("VHO {} AI ({})", env!("CARGO_PKG_VERSION"), req.components.join(", "));
        let enc = encode_output(src, rgba, w, h, &req.output, &software)?;
        let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "photo".into());
        let wanted = dir.join(format!("{stem}{}.{}", clean_suffix(req.output.suffix.as_deref()), enc.ext));
        let final_name = ctx.reserve(idx, &wanted, false)?;
        let temp = ctx.temp_dir(&parent_dir(&final_name))?;
        let part = temp.join(format!("{idx}.part"));
        {
            use std::io::Write;
            let io = |e: std::io::Error| JobError::new(super::classify_error(&e.to_string()), e.to_string());
            let mut f = std::fs::File::create(&part).map_err(io)?;
            f.write_all(&enc.bytes).and_then(|_| f.sync_all()).map_err(io)?;
        }
        let placed = crate::actions::files::place_no_clobber(&part, &final_name).map_err(|e| JobError::new(code::FAILED, e))?;
        let source = ctx.pending.iter().find(|p| p.idx == idx);
        let extra = json!({
            "recipe": ctx.request,
            "models": ctx.model.and_then(|m| serde_json::from_str::<Value>(m).ok()),
            "source": { "size": source.and_then(|p| p.size), "fingerprint": source.and_then(|p| p.fp.clone()) },
            "output": {
                "width": w, "height": h, "format": enc.format, "bitDepth": 8, "colorSpace": "sRGB",
                "iccCopied": false, "alpha": enc.alpha, "orientation": 1, "metadata": req.output.metadata,
            },
            "app": env!("CARGO_PKG_VERSION"),
        });
        ctx.complete_item_with(idx, &placed, enc.bytes.len() as u64, extra)?;
        Ok(placed.to_string_lossy().into_owned())
    }
}
