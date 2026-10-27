//! Photo studio backend: folder scanning, thumbnails, EXIF, decoding of formats the
//! webview cannot show (HEIC, RAW, TIFF), and batch edit/convert jobs.
//!
//! Frontend contract: docs/plans/04-fotograf-studyosu-api.md
//!
//! Layout
//! - `decode`  - format detection + decoding to an upright `DynamicImage`
//! - `heic`    - HEIC/HEIF/AVIF (+ RAW fallback) through the OS codecs (WIC / ImageIO / libheif)
//! - `raw`     - embedded JPEG preview extraction from camera RAW files
//! - `exif`    - EXIF reading (camera, exposure, GPS, orientation) and EXIF blob editing
//! - `thumbs`  - 256 px thumbnails with a disk cache keyed by path + size + mtime
//! - `scan`    - folder listing with sorting, recursion and paged streaming
//! - `ops`     - rotate/flip/crop/resize/convert/strip-metadata, lossless JPEG paths, batches
//!
//! Errors are `String`s; the ones the UI should react to start with a `[code]` tag
//! (see `ERR_*` constants) followed by a Turkish message.

pub mod decode;
pub mod exif;
pub mod heic;
pub mod ops;
pub mod raw;
pub mod scan;
pub mod thumbs;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The file is not an image we can handle (unknown/unsupported format).
pub const ERR_UNSUPPORTED: &str = "[unsupported]";
/// An OS codec (HEIF/HEVC/AV1/RAW extension) is missing.
pub const ERR_CODEC_MISSING: &str = "[codec-missing]";
/// The OS codec is installed but could not be initialised or could not decode this file.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows WIC decoder reports it so far
pub const ERR_CODEC_FAILED: &str = "[codec-failed]";
/// The job was cancelled through `photo_cancel`.
pub const ERR_CANCELLED: &str = "[cancelled]";

/// Default thumbnail edge (longest side) in pixels.
pub const THUMB_SIZE: u32 = 256;

pub(crate) fn err_unsupported(msg: impl std::fmt::Display) -> String {
    format!("{ERR_UNSUPPORTED} {msg}")
}

/// Stable 64-bit FNV-1a (same function lib.rs uses for the transcode cache).
pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

pub(crate) fn ext_lower(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default()
}

/// File modification time in milliseconds since the Unix epoch (0 when unknown).
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Writes `bytes` to `target` through a temporary file + rename, so readers never see
/// half-written files (thumbnail cache, converted images, in-place saves).
pub(crate) fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = target.parent().ok_or("Geçersiz hedef yolu")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
    let tmp = dir.join(format!(
        ".{}.{}-{}.tmp",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("vho"),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Dosya yazılamadı: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Dosya yazılamadı: {e}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cancellable jobs (scan / thumbnail batch / edit batch share one registry)
// ---------------------------------------------------------------------------

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

/// Registration of a running job; unregisters itself on drop.
pub struct JobGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl JobGuard {
    pub fn register(id: &str) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        JOBS.lock().unwrap().insert(id.to_string(), flag.clone());
        JobGuard { id: id.to_string(), flag }
    }

    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut jobs = JOBS.lock().unwrap();
        // A newer job may have reused the id; only remove our own entry
        if jobs.get(&self.id).is_some_and(|f| Arc::ptr_eq(f, &self.flag)) {
            jobs.remove(&self.id);
        }
    }
}

/// Requests cancellation of a running job. Returns false when no such job runs.
pub fn cancel(id: &str) -> bool {
    match JOBS.lock().unwrap().get(id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

fn new_job_id(prefix: &str) -> String {
    use std::sync::atomic::AtomicU64;
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{prefix}-{}", N.fetch_add(1, Ordering::Relaxed) + 1)
}

// ---------------------------------------------------------------------------
// Cache directories + asset protocol scope
// ---------------------------------------------------------------------------

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::platform::cache_dir(app)?.join("photo");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Thumbnails + converted images are served to the webview through the asset protocol
    static ALLOWED: OnceLock<()> = OnceLock::new();
    if ALLOWED.get().is_none() {
        app.asset_protocol_scope().allow_directory(&dir, true).map_err(|e| e.to_string())?;
        if ALLOWED.set(()).is_ok() {
            // Housekeeping once per run: converted copies are large, thumbnails small
            let root = dir.clone();
            std::thread::spawn(move || {
                const DAY: u64 = 24 * 3600;
                thumbs::prune(&root.join("decoded"), std::time::Duration::from_secs(30 * DAY));
                thumbs::prune(&thumbs::thumb_dir(&root), std::time::Duration::from_secs(180 * DAY));
            });
        }
    }
    Ok(dir)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanPageEvent<'a> {
    scan_id: &'a str,
    offset: usize,
    items: &'a [scan::ScanItem],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent<'a> {
    scan_id: &'a str,
    phase: &'static str,
    done: usize,
    total: usize,
}

/// Lists the images (and optionally videos) of a folder. Items arrive as
/// `photo-scan-page` events in display order; the promise resolves with the summary.
#[tauri::command]
pub async fn photo_scan(
    app: AppHandle,
    dir: String,
    options: Option<scan::ScanOptions>,
) -> Result<scan::ScanSummary, String> {
    let opts = options.unwrap_or_default();
    let scan_id = opts.scan_id.clone().unwrap_or_else(|| new_job_id("scan"));
    // The grid shows the originals of browser-native formats directly
    app.asset_protocol_scope()
        .allow_directory(&dir, opts.recursive)
        .map_err(|e| e.to_string())?;
    blocking(move || {
        let job = JobGuard::register(&scan_id);
        let mut on_page = |offset: usize, items: &[scan::ScanItem]| {
            let _ = app.emit("photo-scan-page", ScanPageEvent { scan_id: &scan_id, offset, items });
        };
        let mut on_progress = |phase: &'static str, done: usize, total: usize| {
            let _ = app.emit("photo-scan-progress", ScanProgressEvent { scan_id: &scan_id, phase, done, total });
        };
        scan::scan(Path::new(&dir), &opts, &scan_id, &|| job.cancelled(), &mut on_page, &mut on_progress)
    })
    .await
}

/// Thumbnail of one file (cached). Returns the cache file path for `convertFileSrc`.
#[tauri::command]
pub async fn photo_thumb(app: AppHandle, path: String, size: Option<u32>) -> Result<thumbs::ThumbResult, String> {
    let root = cache_root(&app)?;
    blocking(move || thumbs::thumb(&thumbs::thumb_dir(&root), Path::new(&path), size.unwrap_or(THUMB_SIZE))).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbEvent<'a> {
    request_id: &'a str,
    index: usize,
    path: &'a str,
    thumb: Option<&'a thumbs::ThumbResult>,
    error: Option<&'a str>,
}

/// Thumbnails for many files, generated in parallel. Each result arrives as a
/// `photo-thumb` event (cache hits first, in completion order); cancel stale requests
/// (e.g. after fast scrolling) with `photo_cancel(requestId)`.
#[tauri::command]
pub async fn photo_thumbs(
    app: AppHandle,
    request_id: String,
    paths: Vec<String>,
    size: Option<u32>,
) -> Result<thumbs::ThumbBatchSummary, String> {
    let root = cache_root(&app)?;
    blocking(move || {
        let job = JobGuard::register(&request_id);
        let dir = thumbs::thumb_dir(&root);
        let size = size.unwrap_or(THUMB_SIZE);
        let summary = thumbs::thumbs_parallel(&dir, &paths, size, &|| job.cancelled(), &|index, result| {
            let (thumb, error) = match result {
                Ok(t) => (Some(t), None),
                Err(e) => (None, Some(e.as_str())),
            };
            let _ = app.emit(
                "photo-thumb",
                ThumbEvent { request_id: &request_id, index, path: &paths[index], thumb, error },
            );
        });
        Ok(summary)
    })
    .await
}

/// File + image + EXIF information (camera, exposure, GPS, all raw tags).
#[tauri::command]
pub async fn photo_info(path: String) -> Result<exif::PhotoInfo, String> {
    blocking(move || exif::photo_info(Path::new(&path))).await
}

/// Makes any supported photo displayable by the webview: browser-native formats are
/// returned as-is, others (HEIC, RAW, TIFF...) are converted once into the cache.
#[tauri::command]
pub async fn photo_decode(
    app: AppHandle,
    path: String,
    max_size: Option<u32>,
) -> Result<decode::DisplayResult, String> {
    let root = cache_root(&app)?;
    let result = blocking(move || decode::display_copy(&root.join("decoded"), Path::new(&path), max_size)).await?;
    if !result.converted {
        app.asset_protocol_scope().allow_file(&result.path).map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchProgressEvent<'a> {
    job_id: &'a str,
    #[serde(flatten)]
    item: &'a ops::FileOutcome,
    done: usize,
    total: usize,
}

/// Runs an edit/convert job over many files (parallel, `photo-batch-progress` events,
/// cancellable with `photo_cancel(jobId)`).
#[tauri::command]
pub async fn photo_batch(app: AppHandle, job: ops::BatchJob) -> Result<ops::BatchSummary, String> {
    let job_id = job.job_id.clone().unwrap_or_else(|| new_job_id("batch"));
    blocking(move || {
        let guard = JobGuard::register(&job_id);
        let summary = ops::run_batch(&job, &job_id, &|| guard.cancelled(), &|item, done, total| {
            let _ = app.emit("photo-batch-progress", BatchProgressEvent { job_id: &job_id, item, done, total });
        });
        // New files inside the user's folders should be viewable right away
        for r in summary.results.iter().filter_map(|r| r.output.as_deref()) {
            let _ = app.asset_protocol_scope().allow_file(r);
        }
        Ok(summary)
    })
    .await
}

/// Folder tree for the photo browser: sub-folders of `dir`, or (no `dir`) the
/// well-known picture folders followed by the file system roots.
#[tauri::command]
pub async fn photo_list_dirs(app: AppHandle, dir: Option<String>) -> Result<Vec<scan::DirEntry>, String> {
    match dir.filter(|d| !d.is_empty()) {
        Some(d) => blocking(move || scan::list_dirs(Path::new(&d))).await,
        None => {
            let p = app.path();
            let known: Vec<(String, PathBuf)> = [
                ("Resimler", p.picture_dir()),
                ("Masaüstü", p.desktop_dir()),
                ("İndirilenler", p.download_dir()),
                ("Videolar", p.video_dir()),
                ("Ana klasör", p.home_dir()),
            ]
            .into_iter()
            .filter_map(|(n, d)| Some((n.to_string(), d.ok()?)))
            .collect();
            blocking(move || Ok(scan::roots(known))).await
        }
    }
}

/// Cancels a running scan / thumbnail request / batch job by id.
#[tauri::command]
pub fn photo_cancel(id: String) -> bool {
    cancel(&id)
}

/// What this machine can decode/encode (HEIC/AVIF/RAW depend on OS codecs).
#[tauri::command]
pub async fn photo_capabilities() -> Result<decode::Capabilities, String> {
    blocking(|| Ok(decode::capabilities())).await
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::PathBuf;

    /// Fresh, empty temp directory for a test.
    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vho_photo_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Asymmetric test pattern: red top-left quadrant, green top-right, blue bottom-left,
    /// white bottom-right, so rotations/flips/crops are detectable.
    pub fn pattern(w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_fn(w, h, |x, y| match (x < w / 2, y < h / 2) {
            (true, true) => image::Rgb([230, 20, 20]),
            (false, true) => image::Rgb([20, 230, 20]),
            (true, false) => image::Rgb([20, 20, 230]),
            (false, false) => image::Rgb([240, 240, 240]),
        })
    }

    pub fn jpeg_bytes(img: &image::RgbImage, quality: u8) -> Vec<u8> {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(img)
            .unwrap();
        out
    }

    /// Classifies a pixel into the pattern's quadrant colours.
    pub fn quadrant(p: image::Rgb<u8>) -> &'static str {
        let [r, g, b] = p.0;
        if r > 180 && g > 180 && b > 180 {
            "white"
        } else if r > 150 {
            "red"
        } else if g > 150 {
            "green"
        } else if b > 150 {
            "blue"
        } else {
            "?"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_registry_cancel_and_reuse() {
        let a = JobGuard::register("t-job");
        assert!(!a.cancelled());
        assert!(cancel("t-job"));
        assert!(a.cancelled());
        // Re-registering the same id must not be removed by the old guard's drop
        let b = JobGuard::register("t-job");
        drop(a);
        assert!(!b.cancelled());
        assert!(cancel("t-job"));
        drop(b);
        assert!(!cancel("t-job"));
    }
}
