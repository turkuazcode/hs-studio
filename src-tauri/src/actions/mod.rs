//! Media actions (Plan 06): common file actions (recycle bin, rename, reveal, open with, copy,
//! share, properties), photo actions (clipboard image, wallpaper / lock screen, OCR), video and
//! music exports through the LGPL `ffmpeg.exe` (separate process, never linked), music tags,
//! lyrics and ReplayGain.
//!
//! Layout
//! - `files`     - rename / conflict logic, recycle bin (`trash`), file properties
//! - `clipboard` - text, file list (CF_HDROP) and image clipboard (`arboard`)
//! - `ffmpeg`    - locating ffmpeg/ffprobe, argument builders for every export preset, job runner
//! - `tags`      - music tags + cover art + embedded lyrics (`lofty`), `.lrc` side files
//! - `system`    - OS integration: wallpaper / lock screen, share sheet, open-with dialog, reveal
//! - `ocr`       - text recognition (Windows.Media.Ocr)
//!
//! SAFETY: with `VHO_DISABLE_SYSTEM_CHANGES=1` (always set by the E2E launcher) every action that
//! changes the OS or opens OS UI (wallpaper, lock screen, share, print, open with, reveal in
//! folder) only records itself in the system-action log (`actions_system_log`) and returns Ok.

pub mod clipboard;
pub mod ffmpeg;
pub mod files;
pub mod ocr;
pub mod system;
pub mod tags;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::grants::{self, Access};

/// Environment switch: OS-level actions are logged instead of performed (tests).
pub const DISABLE_ENV: &str = "VHO_DISABLE_SYSTEM_CHANGES";

pub fn system_changes_disabled() -> bool {
    std::env::var_os(DISABLE_ENV).is_some_and(|v| !v.is_empty() && v != "0")
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemLogEntry {
    pub action: String,
    pub target: String,
    /// false: skipped because of VHO_DISABLE_SYSTEM_CHANGES
    pub applied: bool,
}

static SYSTEM_LOG: Mutex<Vec<SystemLogEntry>> = Mutex::new(Vec::new());

/// Records an OS-level action. Returns true when it may really run.
pub fn gate(action: &str, target: &str) -> bool {
    let applied = !system_changes_disabled();
    if !applied {
        eprintln!("[VHO] system action skipped ({DISABLE_ENV} is set): {action} {target}");
    }
    let mut log = SYSTEM_LOG.lock().unwrap_or_else(|e| e.into_inner());
    if log.len() > 200 {
        log.remove(0);
    }
    log.push(SystemLogEntry { action: action.into(), target: target.into(), applied });
    applied
}

/// Error tags the UI reacts to (same convention as the photo module).
pub const ERR_EXISTS: &str = "[exists]";
pub const ERR_INVALID: &str = "[invalid]";
pub const ERR_NO_FFMPEG: &str = "[no-ffmpeg]";
pub const ERR_UNSUPPORTED: &str = "[unsupported]";
pub const ERR_OCR_LANGUAGE: &str = "[ocr-language]";

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Common file actions
// ---------------------------------------------------------------------------

/// Moves a file to the recycle bin / trash.
#[tauri::command]
pub async fn file_trash(app: AppHandle, path: String) -> Result<(), String> {
    blocking(move || {
        grants::require(&app, Path::new(&path), Access::Entry)?;
        // library operation log (L02): the media row becomes "deleted", a crash is reconciled
        crate::library::tracked_trash(&app, &path, || files::trash_file(Path::new(&path)))
    })
    .await
}

/// Renames a file inside its folder. Returns the new full path.
/// Errors: `[invalid]` bad name, `[exists]` another file has that name.
#[tauri::command]
pub async fn file_rename(app: AppHandle, path: String, new_name: String) -> Result<String, String> {
    // library operation log (L02): identity, favorite, resume position and bookmarks follow
    let app2 = app.clone();
    let out = blocking(move || {
        grants::require(&app2, Path::new(&path), Access::Entry)?;
        crate::library::tracked_rename(&app2, &path, &new_name, || files::rename(Path::new(&path), &new_name))
    })
    .await?;
    // the renamed file stays the user's file
    grants::grant_picked(&app, &out, grants::Scope::File);
    let _ = app.asset_protocol_scope().allow_file(&out);
    Ok(out.to_string_lossy().into_owned())
}

/// File system facts for the properties dialog (size, dates, folder).
#[tauri::command]
pub async fn file_properties(path: String) -> Result<files::FileProps, String> {
    blocking(move || files::properties(Path::new(&path))).await
}

/// Shows the file selected in Explorer / Finder / the file manager.
#[tauri::command]
pub async fn file_reveal(path: String) -> Result<(), String> {
    if !gate("reveal", &path) {
        return Ok(());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// "Open with" chooser of the OS.
#[tauri::command]
pub async fn file_open_with(app: AppHandle, path: String) -> Result<(), String> {
    if !gate("open-with", &path) {
        return Ok(());
    }
    system::open_with(&app, &path)
}

/// Share sheet (Windows Share UI); other platforms: reveal in the file manager.
#[tauri::command]
pub async fn file_share(app: AppHandle, path: String) -> Result<String, String> {
    if !gate("share", &path) {
        return Ok("skipped".into());
    }
    system::share(&app, &path)
}

/// Desktop background (`target: "desktop"`) or lock screen (`"lock"`).
#[tauri::command]
pub async fn set_wallpaper(path: String, target: String) -> Result<(), String> {
    let action = if target == "lock" { "lock-screen" } else { "wallpaper" };
    if !gate(action, &path) {
        return Ok(());
    }
    blocking(move || if action == "lock-screen" { system::set_lock_screen(&path) } else { system::set_wallpaper(&path) }).await
}

/// What OS integrations this build supports (the UI hides the rest). Same answers as the
/// P04 support table in `capabilities.rs`: an action the platform does not offer is hidden,
/// never imitated by another one (e.g. no "share" that only reveals the file).
#[tauri::command]
pub fn actions_capabilities() -> serde_json::Value {
    serde_json::json!({
        "wallpaper": system::WALLPAPER_SUPPORTED,
        "lockScreen": cfg!(windows),
        "share": cfg!(windows),
        // macOS: Finder's chooser needs AppKit (not implemented); Linux: xdg-desktop-portal
        "openWith": cfg!(any(windows, target_os = "linux")),
        // window.print(): WebView2 and WebKitGTK; a silent no-op in WKWebView (macOS)
        "print": cfg!(any(windows, target_os = "linux")),
        "ocr": ocr::engine_name().is_some(),
        "ffmpeg": ffmpeg::locate().is_ok(),
        "systemChangesDisabled": system_changes_disabled(),
    })
}

/// Front-end only OS actions (print dialog): asks whether it may run and records it.
#[tauri::command]
pub fn system_action_allowed(action: String, target: Option<String>) -> bool {
    gate(&action, target.as_deref().unwrap_or(""))
}

/// Log of OS-level actions of this run (E2E: proves they were logged but not applied).
#[tauri::command]
pub fn actions_system_log() -> Vec<SystemLogEntry> {
    SYSTEM_LOG.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn clipboard_copy_text(text: String) -> Result<(), String> {
    blocking(move || clipboard::set_text(&text)).await
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    blocking(clipboard::get_text).await
}

/// Copies files (Explorer can paste them: CF_HDROP on Windows).
#[tauri::command]
pub async fn clipboard_copy_files(paths: Vec<String>) -> Result<(), String> {
    blocking(move || clipboard::set_files(&paths)).await
}

/// File paths currently on the clipboard (tests / paste).
#[tauri::command]
pub async fn clipboard_read_files() -> Result<Vec<String>, String> {
    blocking(clipboard::get_files).await
}

/// Copies an image file (any format the photo module decodes), optionally rotated (degrees
/// clockwise: the viewer's unsaved rotation).
#[tauri::command]
pub async fn clipboard_copy_image(path: String, rotation: Option<i32>) -> Result<[u32; 2], String> {
    blocking(move || {
        let img = crate::photo::decode::decode(Path::new(&path), None)?.image;
        clipboard::set_image(rotate_image(img, rotation.unwrap_or(0)))
    })
    .await
}

/// Copies an image given as base64 PNG/JPEG bytes (HTML5 video frame, canvas).
#[tauri::command]
pub async fn clipboard_copy_image_data(data: String) -> Result<[u32; 2], String> {
    blocking(move || {
        let b64 = data.split_once(',').map_or(data.as_str(), |(_, b)| b);
        let bytes = clipboard::base64_decode(b64)?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("Görüntü okunamadı: {e}"))?;
        clipboard::set_image(img)
    })
    .await
}

/// Size of the image on the clipboard (tests).
#[tauri::command]
pub async fn clipboard_image_size() -> Result<Option<[u32; 2]>, String> {
    blocking(clipboard::image_size).await
}

/// Current libmpv frame (video only) to the clipboard.
#[tauri::command]
pub async fn clipboard_copy_frame(app: AppHandle, st: tauri::State<'_, crate::engine::Engine>) -> Result<[u32; 2], String> {
    let path = crate::engine::frame_to_temp(&app, &st)?;
    let p = path.clone();
    let r = blocking(move || {
        let img = image::open(&p).map_err(|e| format!("Kare okunamadı: {e}"))?;
        clipboard::set_image(img)
    })
    .await;
    let _ = std::fs::remove_file(&path);
    r
}

fn rotate_image(img: image::DynamicImage, deg: i32) -> image::DynamicImage {
    match deg.rem_euclid(360) {
        90 => img.rotate90(),
        180 => img.rotate180(),
        270 => img.rotate270(),
        _ => img,
    }
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/// Recognizes text in an image. `language`: BCP-47 tag ("tr", "en-US") or None for the user's
/// profile languages. Errors: `[ocr-language]` no OCR language installed, `[unsupported]`.
#[tauri::command]
pub async fn ocr_image(path: String, language: Option<String>) -> Result<ocr::OcrResult, String> {
    blocking(move || ocr::recognize(Path::new(&path), language.as_deref())).await
}

/// Installed OCR languages (empty when OCR is unavailable).
#[tauri::command]
pub async fn ocr_languages() -> Result<Vec<String>, String> {
    blocking(|| Ok(ocr::languages())).await
}

// ---------------------------------------------------------------------------
// ffmpeg jobs
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobProgressEvent<'a> {
    job_id: &'a str,
    progress: f64,
}

/// ffmpeg/ffprobe availability, version and the H.264 encoder this platform uses.
#[tauri::command]
pub async fn media_tools() -> Result<ffmpeg::ToolsInfo, String> {
    blocking(|| Ok(ffmpeg::tools_info())).await
}

/// Stream / format summary (ffprobe) for the properties dialog and the export dialogs.
#[tauri::command]
pub async fn media_probe(path: String) -> Result<ffmpeg::MediaInfo, String> {
    blocking(move || ffmpeg::probe(Path::new(&path))).await
}

/// Runs an export (cut, GIF, convert, extract audio, rotate, subtitles, contact sheet...).
/// Progress: `media-job-progress {jobId, progress}`; cancel with `media_job_cancel(jobId)`.
#[tauri::command]
pub async fn media_job(app: AppHandle, job: ffmpeg::JobRequest) -> Result<ffmpeg::JobResult, String> {
    let job_id = job.job_id.clone().unwrap_or_else(|| "media-job".into());
    let result = blocking(move || {
        require_export_target(&app, &job)?;
        let guard = crate::photo::JobGuard::register(&job_id);
        let app2 = app.clone();
        let id2 = job_id.clone();
        let r = ffmpeg::run_job(&job, &|| guard.cancelled(), move |p| {
            let _ = app2.emit("media-job-progress", JobProgressEvent { job_id: &id2, progress: p });
        });
        if let Ok(r) = &r {
            let _ = app.asset_protocol_scope().allow_file(&r.output);
        }
        r
    })
    .await?;
    Ok(result)
}

/// Q04: an export writes only where the user chose (exact output from a save dialog, the output
/// folder, or the source's own folder).
pub(crate) fn require_export_target(app: &AppHandle, job: &ffmpeg::JobRequest) -> Result<(), String> {
    match (&job.output, &job.output_dir) {
        (Some(o), _) => grants::require(app, Path::new(o), Access::Create),
        (None, Some(d)) => grants::require(app, Path::new(d), Access::IntoFolder),
        (None, None) => {
            let dir = Path::new(&job.input).parent().ok_or_else(|| grants::not_granted(Path::new(&job.input)))?;
            grants::require(app, dir, Access::IntoFolder)
        }
    }
}

#[tauri::command]
pub fn media_job_cancel(job_id: String) -> bool {
    crate::photo::cancel(&job_id)
}

/// Integrated loudness / true peak (ffmpeg ebur128) -> ReplayGain track gain; `write`: store
/// it in the file's tags.
#[tauri::command]
pub async fn replaygain_analyze(app: AppHandle, path: String, write: Option<bool>) -> Result<ffmpeg::Loudness, String> {
    blocking(move || {
        if write.unwrap_or(false) {
            grants::require(&app, Path::new(&path), Access::Content)?;
        }
        let l = ffmpeg::loudness(Path::new(&path))?;
        if write.unwrap_or(false) {
            tags::write_replaygain(Path::new(&path), &l)?;
        }
        Ok(l)
    })
    .await
}

// ---------------------------------------------------------------------------
// Tags / lyrics
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tags_read(path: String) -> Result<tags::TagData, String> {
    blocking(move || tags::read(Path::new(&path))).await
}

/// Writes the given fields (None = unchanged, "" = remove). `cover`: image file to embed as
/// front cover, `removeCover`: drop all pictures.
#[tauri::command]
pub async fn tags_write(app: AppHandle, path: String, tags: tags::TagUpdate) -> Result<tags::TagData, String> {
    blocking(move || {
        grants::require(&app, Path::new(&path), Access::Content)?;
        tags::write(Path::new(&path), &tags)?;
        tags::read(Path::new(&path))
    })
    .await
}

/// Saves the embedded front cover to `output` (extension follows the picture's format).
#[tauri::command]
pub async fn tags_save_cover(app: AppHandle, path: String, output: String) -> Result<String, String> {
    blocking(move || {
        // the extension may change with the picture's format: the folder is what counts
        let dir = Path::new(&output).parent().ok_or_else(|| grants::not_granted(Path::new(&output)))?;
        grants::require(&app, dir, Access::IntoFolder)?;
        tags::save_cover(Path::new(&path), Path::new(&output)).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Lyrics: `.lrc` next to the file (same stem) first, then embedded (USLT / LYRICS).
#[tauri::command]
pub async fn lyrics_read(path: String) -> Result<Option<tags::Lyrics>, String> {
    blocking(move || tags::lyrics(Path::new(&path))).await
}

/// Output folder for exports when the user picked "Videos\HS Studio" in Settings.
#[tauri::command]
pub fn export_dir(app: AppHandle, kind: String) -> Result<String, String> {
    let p = app.path();
    let base: PathBuf = match kind.as_str() {
        "music" => p.audio_dir(),
        "photo" => p.picture_dir(),
        _ => p.video_dir(),
    }
    .map_err(|e| e.to_string())?;
    let dir = base.join("HS Studio");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
