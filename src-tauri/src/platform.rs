//! Platform integration: settings location (with a test override), single instance,
//! files opened by the OS ("Open with", Finder), Windows "Default apps" shortcut.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event carrying file paths the OS asked us to open while the app is running.
pub const OPEN_FILES_EVENT: &str = "open-files";

/// Environment override for the data folder (settings.json, library.json, window state).
/// Used by the E2E tests so they never touch the user's real settings; when it is set the
/// single-instance lock is also scoped to that folder (see [`apply_test_isolation`]).
const DATA_DIR_ENV: &str = "VHO_DATA_DIR";

pub fn data_dir_override() -> Option<PathBuf> {
    std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Test instances only (VHO_DATA_DIR): the WebView2 arguments the E2E harness sets in
/// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (--remote-debugging-port). The runtime may ignore that
/// variable once the app passes its own additional_browser_args (WebView2 155 on the GitHub
/// Windows runner: no debug port, diag-webview2.yml), so the app appends them itself.
pub fn test_browser_args() -> Option<String> {
    data_dir_override()?;
    std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().filter(|a| !a.trim().is_empty())
}

/// Cache root (photo thumbnails, frame grabs, transcodes). With the test override it lives in
/// `<VHO_DATA_DIR>/cache`, so test runs never write into the user's real cache folder.
pub fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    match data_dir_override() {
        Some(d) => Ok(d.join("cache")),
        None => app.path().app_cache_dir().map_err(|e| e.to_string()),
    }
}

/// Stable 64-bit FNV-1a.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

/// With VHO_DATA_DIR set, the identifier (single-instance mutex name, default app dirs)
/// gets a suffix derived from that folder: a test instance never forwards its files to,
/// or receives files from, the user's own VHO.
pub fn apply_test_isolation<R: Runtime>(context: &mut tauri::Context<R>) {
    if let Some(dir) = data_dir_override() {
        let config = context.config_mut();
        config.identifier = test_identifier(&config.identifier, &dir);
    }
}

/// `<identifier>.test<fnv1a(lowercase data dir)>`. The E2E harness derives the same name
/// (tests/e2e/lib/app.mjs `testIdentity`) to remove the app folders a test instance created.
pub fn test_identifier(base: &str, data_dir: &Path) -> String {
    let suffix = fnv1a(data_dir.to_string_lossy().to_lowercase().as_bytes());
    format!("{base}.test{suffix:016x}")
}

/// Folder for settings.json / library.json: VHO_DATA_DIR or the app config dir.
pub fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = match data_dir_override() {
        Some(d) => d,
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Window-state file name; an absolute path (inside VHO_DATA_DIR) when overridden.
pub fn window_state_filename() -> Option<String> {
    data_dir_override().map(|d| d.join("window-state.json").to_string_lossy().into_owned())
}

#[tauri::command]
pub fn settings_dir(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

/// Media files among command-line style arguments (options skipped, relative paths
/// resolved against `cwd`, only existing files kept).
pub fn file_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Files the OS handed over before the page was ready (macOS cold start via Finder).
#[derive(Default)]
pub struct PendingOpen {
    files: Mutex<Vec<String>>,
    frontend_ready: AtomicBool,
}

impl PendingOpen {
    /// Called by `initial_files`: from now on files are delivered as events.
    pub fn take_and_mark_ready(&self) -> Vec<String> {
        self.frontend_ready.store(true, Ordering::SeqCst);
        std::mem::take(&mut *self.files.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Delivers files to the page: as an event once it listens, queued before that.
pub fn deliver_files<R: Runtime>(app: &AppHandle<R>, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    // handed over by the OS ("Open with", second instance, Finder): the user chose them
    crate::grants::grant_opened(app, &files);
    let pending = app.state::<PendingOpen>();
    if pending.frontend_ready.load(Ordering::SeqCst) {
        let _ = app.emit(OPEN_FILES_EVENT, files);
    } else {
        pending.files.lock().unwrap_or_else(|e| e.into_inner()).extend(files);
    }
}

/// Second launch ("vho.exe file.mp4" while VHO is running): bring the window forward
/// and open the files there; the second process exits inside the plugin.
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    if let Some(w) = app.webview_windows().values().next() {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    deliver_files(app, file_args(argv.into_iter().skip(1), Path::new(&cwd)));
}

/// macOS: files opened from Finder / "Open With" arrive as file:// URLs.
#[cfg(target_os = "macos")]
pub fn on_opened_urls<R: Runtime>(app: &AppHandle<R>, urls: &[tauri::Url]) {
    let files = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    deliver_files(app, files);
}

/// Opens Windows Settings > Apps > Default apps (Windows 10/11 do not let an app make
/// itself the default; the user picks VHO there).
#[tauri::command]
pub fn open_default_apps_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg("ms-settings:defaultapps")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_args_skips_options_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("vho-file-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.mp4");
        std::fs::write(&file, b"x").unwrap();
        let got = file_args(
            vec!["--flag".into(), "a.mp4".into(), "missing.mkv".into(), String::new(), file.to_string_lossy().into_owned()],
            &dir,
        );
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|p| Path::new(p).is_absolute() && p.ends_with("a.mp4")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_identifier_matches_the_e2e_harness() {
        // Same vector as tests/unit/test-layers.test.mjs (JS side of the derivation)
        let dir = Path::new(r"C:\Users\Test\AppData\Local\Temp\vho-e2e-ABC\vho-data");
        assert_eq!(test_identifier("com.vho.app", dir), "com.vho.app.test784bc84e15c2ff8b");
    }

    #[test]
    fn pending_files_drain_once() {
        let p = PendingOpen::default();
        p.files.lock().unwrap().push("x".into());
        assert_eq!(p.take_and_mark_ready(), vec!["x".to_string()]);
        assert!(p.take_and_mark_ready().is_empty());
        assert!(p.frontend_ready.load(Ordering::SeqCst));
    }
}
