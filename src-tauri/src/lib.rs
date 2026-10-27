mod actions;
mod ai;
mod capabilities;
mod engine;
mod jobs;
mod photo;
mod platform;
mod storage;
mod transcode;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

/// Id of the transcode job the UI currently waits for; older jobs abort themselves.
static TRANSCODE_JOB: AtomicU64 = AtomicU64::new(0);
const TRANSCODE_CACHE_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

// Chromium yalnızca son --enable-features / --disable-features bayrağını okur,
// bu yüzden tüm özellikler tek virgüllü listede. İlk --disable-features değeri
// wry'nin varsayılanıdır; additional_browser_args onu ezdiği için elle ekliyoruz.
const BASE_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --enable-features=PlatformHEVCDecoderSupport \
     --disable-direct-composition-video-overlays \
     --ignore-gpu-blocklist";

// Sorunlu GPU sürücülerinde (borderless pencerede siyah video) son çare.
// Tüm sayfayı CPU ile birleştirir; performans maliyeti yüksektir.
const COMPAT_BROWSER_ARGS: &str = " --disable-gpu-compositing";

fn compat_flag_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("compat_mode"))
}

fn is_compat_mode(app: &AppHandle) -> bool {
    compat_flag_path(app).is_some_and(|p| p.exists())
}

#[tauri::command]
fn get_compat_mode(app: AppHandle) -> bool {
    is_compat_mode(&app)
}

/// Bayrağı yazar ve uygulamayı yeniden başlatır (tarayıcı argümanları yalnızca açılışta okunur).
#[tauri::command]
fn set_compat_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let path = compat_flag_path(&app).ok_or("Yapılandırma klasörü bulunamadı")?;
    if enabled {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, b"1").map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    app.restart();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaEntry {
    path: String,
    name: String,
    size: u64,
}

/// Registers user-chosen files (dialog / drag & drop) with the asset protocol so the
/// webview can stream them, and returns their names and sizes.
#[tauri::command]
fn prepare_media(app: AppHandle, paths: Vec<String>) -> Vec<MediaEntry> {
    let scope = app.asset_protocol_scope();
    paths
        .into_iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(&p).ok().filter(|m| m.is_file())?;
            scope.allow_file(&p).ok()?;
            let name = Path::new(&p).file_name()?.to_string_lossy().into_owned();
            Some(MediaEntry { path: p, name, size: meta.len() })
        })
        .collect()
}

/// Files passed on the command line ("Open with VHO" / double-click in Explorer), plus
/// files the OS handed over before the page was ready (macOS Finder).
#[tauri::command]
fn initial_files(pending: tauri::State<'_, platform::PendingOpen>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut files = platform::file_args(std::env::args().skip(1), &cwd);
    files.extend(pending.take_and_mark_ready());
    files
}

#[tauri::command]
async fn probe_media(path: String) -> Result<transcode::ProbeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || transcode::probe(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Stable 64-bit FNV-1a (std's DefaultHasher may change between Rust versions).
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

fn transcode_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("transcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscodeProgress {
    path: String,
    progress: f64,
}

/// Converts a legacy-codec file to H.264/AAC MP4 (cached) and returns the playable path.
#[tauri::command]
async fn transcode_media(app: AppHandle, path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let key = fnv1a(format!("{path}|{}|{mtime}", meta.len()).as_bytes());
    let dir = transcode_cache_dir(&app)?;
    let output = dir.join(format!("{key:016x}.mp4"));

    if !output.exists() {
        let job = TRANSCODE_JOB.fetch_add(1, Ordering::SeqCst) + 1;
        // per-job partial file: a cancelled older job (e.g. the same file reopened after a page
        // reload) must not delete the file the current job is writing
        let partial = dir.join(format!("{key:016x}.{job}.part.mp4"));
        let (app2, src, part) = (app.clone(), path.clone(), partial.clone());
        let result = tauri::async_runtime::spawn_blocking(move || {
            let mut report = |p: f64| {
                let _ = app2.emit("transcode-progress", TranscodeProgress { path: src.clone(), progress: p });
            };
            let cancelled = || TRANSCODE_JOB.load(Ordering::SeqCst) != job;
            transcode::transcode(&src, &part, &mut report, &cancelled)
        })
        .await
        .map_err(|e| e.to_string())?;

        if let Err(e) = result {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
        std::fs::rename(&partial, &output).map_err(|e| e.to_string())?;
    }

    app.asset_protocol_scope().allow_file(&output).map_err(|e| e.to_string())?;
    Ok(output.to_string_lossy().into_owned())
}

#[tauri::command]
fn cancel_transcode() {
    TRANSCODE_JOB.fetch_add(1, Ordering::SeqCst);
}

/// Drops converted files that have not been touched for a month.
fn prune_transcode_cache(app: &AppHandle) {
    let Ok(dir) = transcode_cache_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > TRANSCODE_CACHE_MAX_AGE);
        let partial = entry.file_name().to_string_lossy().contains(".part.");
        if stale || partial {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
async fn suspend_system() -> Result<(), String> {
    // Safety switch for automated tests: never put the developer's machine to sleep.
    if std::env::var_os("VHO_DISABLE_SYSTEM_SUSPEND").is_some() {
        eprintln!("[VHO] suspend_system skipped (VHO_DISABLE_SYSTEM_SUSPEND is set)");
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Power::SetSuspendState;
        // bHibernate=false (uyku), bForce=true, bWakeupEventsDisabled=false
        let ok = unsafe { SetSuspendState(false, true, false) };
        if !ok {
            return Err(format!(
                "SetSuspendState başarısız: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let s = std::process::Command::new("pmset")
            .arg("sleepnow")
            .status()
            .map_err(|e| e.to_string())?;
        if !s.success() {
            return Err(format!("pmset çıkış kodu: {s}"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::process::Command::new("systemctl")
            .arg("suspend")
            .status()
            .map_err(|e| e.to_string())?;
        if !s.success() {
            return Err(format!("systemctl çıkış kodu: {s}"));
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    platform::apply_test_isolation(&mut context);

    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch exits here, before any window exists.
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        platform::on_second_instance(app, argv, cwd)
    }));

    let mut window_state = tauri_plugin_window_state::Builder::new().with_state_flags(
        tauri_plugin_window_state::StateFlags::SIZE
            | tauri_plugin_window_state::StateFlags::POSITION
            | tauri_plugin_window_state::StateFlags::MAXIMIZED,
    );
    if let Some(file) = platform::window_state_filename() {
        window_state = window_state.with_filename(file);
    }

    let app = builder
        .manage(platform::PendingOpen::default())
        .manage(storage::StorageState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(window_state.build())
        .setup(|app| {
            prune_transcode_cache(app.handle());

            // Pencere tauri.conf.json'da "create": false olarak tanımlı; argümanları
            // çalışma anında belirleyebilmek için burada oluşturuyoruz.
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json içinde pencere tanımı yok")?;

            let mut args = String::from(BASE_BROWSER_ARGS);
            if is_compat_mode(app.handle()) {
                args.push_str(COMPAT_BROWSER_ARGS);
            }

            // libmpv engine: when the DLL set is present the window is transparent and the video
            // is drawn by mpv into an owned popup behind it (ADR 0001). Otherwise the window stays
            // opaque and the frontend uses the HTML5 <video> engine.
            let mpv_dll = engine::locate(app.handle());
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?.additional_browser_args(&args);
            if mpv_dll.is_ok() {
                builder = builder.transparent(true);
            }
            let window = builder.build()?;
            engine::setup(app.handle(), &window, mpv_dll);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            suspend_system,
            get_compat_mode,
            set_compat_mode,
            prepare_media,
            initial_files,
            probe_media,
            transcode_media,
            cancel_transcode,
            ai::ai_status,
            ai::ai_status_all,
            ai::ai_install,
            ai::ai_cancel_download,
            ai::ai_verify,
            ai::ai_remove,
            ai::ai_acquire,
            ai::ai_release,
            photo::photo_scan,
            photo::photo_thumb,
            photo::photo_thumbs,
            photo::photo_info,
            photo::photo_decode,
            photo::photo_batch,
            photo::photo_cancel,
            photo::photo_list_dirs,
            photo::photo_capabilities,
            platform::settings_dir,
            platform::open_default_apps_settings,
            engine::engine_status,
            capabilities::platform_capabilities,
            engine::engine_load,
            engine::engine_command,
            engine::engine_set,
            engine::engine_get,
            engine::engine_show,
            engine::engine_screenshot,
            engine::engine_thumbnail,
            actions::file_trash,
            actions::file_rename,
            actions::file_properties,
            actions::file_reveal,
            actions::file_open_with,
            actions::file_share,
            actions::set_wallpaper,
            actions::actions_capabilities,
            actions::system_action_allowed,
            actions::actions_system_log,
            actions::clipboard_copy_text,
            actions::clipboard_read_text,
            actions::clipboard_copy_files,
            actions::clipboard_read_files,
            actions::clipboard_copy_image,
            actions::clipboard_copy_image_data,
            actions::clipboard_image_size,
            actions::clipboard_copy_frame,
            actions::ocr_image,
            actions::ocr_languages,
            actions::media_tools,
            actions::media_probe,
            actions::media_job,
            actions::media_job_cancel,
            actions::replaygain_analyze,
            actions::tags_read,
            actions::tags_write,
            actions::tags_save_cover,
            actions::lyrics_read,
            actions::export_dir,
            storage::library_load,
            storage::library_save,
            jobs::jobs_list,
            jobs::jobs_get,
            jobs::jobs_submit,
            jobs::jobs_cancel,
            jobs::jobs_pause,
            jobs::jobs_resume,
            jobs::jobs_remove,
            jobs::jobs_clear_finished,
            jobs::jobs_output_copy,
            jobs::jobs_runner_ready,
            jobs::jobs_ext_begin,
            jobs::jobs_ext_progress,
            jobs::jobs_ext_fail,
            jobs::jobs_ext_done,
            jobs::jobs_ext_output
        ])
        .build(context)
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // Finder "Open With" / double-click while running or at launch (macOS only)
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            platform::on_opened_urls(_app, urls);
        }
        if let tauri::RunEvent::Exit = _event {
            engine::shutdown(_app);
        }
    });
}
