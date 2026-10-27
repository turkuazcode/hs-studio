//! libmpv playback engine (Plan 02 §2, ADR 0001).
//!
//! `libmpv-2.dll` (Windows, LGPL build, 38 DLLs) / `libmpv.so.2` (Linux, LGPL build with its own
//! FFmpeg `.so` files, RUNPATH=$ORIGIN; ADR 0002) is loaded at runtime from next to the executable
//! (or the bundle's `mpv/` resource folder). When it is missing, fails to load, `VHO_DISABLE_MPV` is set or
//! the platform has no video surface yet, the engine is `unavailable` and the frontend falls back to
//! the HTML5 `<video>` engine (incl. the Media Foundation transcode path).
//!
//! Commands: `engine_status`, `engine_load`, `engine_command`, `engine_set`, `engine_get`,
//! `engine_show`, `engine_screenshot`. Events: `engine://property {name, value}`, `engine://event`.

pub mod events;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod mpv;
#[cfg(target_os = "linux")]
pub mod smoke;
pub mod window;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Properties forwarded to the frontend as `engine://property`.
pub const OBSERVED: &[&str] = &[
    "time-pos", "duration", "pause", "track-list", "chapter-list", "chapter", "volume", "mute",
    "eof-reached", "video-params", "hwdec-current", "aid", "sid", "speed", "sub-delay", "audio-delay",
    "demuxer-cache-time", "seeking", "idle-active", "path",
];

#[derive(Default)]
pub struct EngineState {
    mpv: Option<Arc<mpv::Mpv>>,
    error: Option<String>,
    dll: Option<PathBuf>,
    gpu: Value,
}

pub type Engine = Mutex<EngineState>;

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// libmpv file name of this platform (Linux: the SONAME of the LGPL build, ADR 0002).
pub const LIBMPV: &str = if cfg!(windows) { "libmpv-2.dll" } else { "libmpv.so.2" };

/// Finds libmpv. Order: `VHO_MPV_DLL`, next to the exe, `<exe>/mpv/`, `<resources>/mpv/`.
/// Never the system library search path: a distribution `libmpv.so.2` is usually a GPL build
/// (only `VHO_MPV_DLL` can point at one, as the user's own explicit choice).
pub fn locate<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if std::env::var_os("VHO_DISABLE_MPV").is_some_and(|v| !v.is_empty() && v != "0") {
        return Err("libmpv disabled by VHO_DISABLE_MPV".into());
    }
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("libmpv embedding is not available on this platform yet (path B)".into());
    }
    let name = LIBMPV;
    let mut candidates = vec![];
    if let Some(p) = std::env::var_os("VHO_MPV_DLL") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(d) = exe_dir() {
        candidates.push(d.join(name));
        candidates.push(d.join("mpv").join(name));
    }
    if let Ok(r) = app.path().resource_dir() {
        candidates.push(r.join("mpv").join(name));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            if cfg!(windows) {
                format!("{name} not found (run `npm run stage:mpv`)")
            } else {
                format!("{name} not found (run `bash scripts/linux/stage-mpv.sh`)")
            }
        })
}

/// Primary GPU description; integrated GPUs (little dedicated VRAM) default to `profile=fast`.
#[cfg(not(windows))]
fn gpu_info() -> Value {
    json!({})
}

#[cfg(windows)]
fn gpu_info() -> Value {
    unsafe {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
        let info = (|| -> windows::core::Result<Value> {
            let f: IDXGIFactory1 = CreateDXGIFactory1()?;
            let a = f.EnumAdapters1(0)?;
            let d = a.GetDesc1()?;
            let name = String::from_utf16_lossy(&d.Description).trim_end_matches('\0').to_string();
            let vram_mb = (d.DedicatedVideoMemory / (1024 * 1024)) as u64;
            Ok(json!({"name": name, "dedicatedMb": vram_mb, "integrated": vram_mb < 2048}))
        })();
        info.unwrap_or_else(|e| json!({"error": e.to_string()}))
    }
}

/// Creates the video surface + mpv core for `win`. Never fails: errors become "unavailable".
pub fn setup<R: Runtime>(app: &AppHandle<R>, win: &WebviewWindow<R>, dll: Result<PathBuf, String>) {
    let mut st = EngineState { gpu: gpu_info(), ..Default::default() };
    match dll.and_then(|dll| start(app, win, &dll, &st.gpu).map(|m| (m, dll))) {
        Ok((m, dll)) => {
            st.mpv = Some(m);
            st.dll = Some(dll);
        }
        Err(e) => {
            eprintln!("[VHO] libmpv unavailable, using the HTML5 engine: {e}");
            st.error = Some(e);
        }
    }
    app.manage::<Engine>(Mutex::new(st));
}

fn start<R: Runtime>(app: &AppHandle<R>, win: &WebviewWindow<R>, dll: &Path, gpu: &Value) -> Result<Arc<mpv::Mpv>, String> {
    let fast = gpu.get("integrated").and_then(Value::as_bool).unwrap_or(false);
    let shots = screenshot_dir(app);
    let mut opts: Vec<(&str, String)> = surface_options(win)?;
    opts.extend([
        ("config", "no".into()),
        ("terminal", "no".into()),
        ("input-default-bindings", "no".into()),
        ("input-vo-keyboard", "no".into()),
        ("input-cursor", "no".into()),
        ("cursor-autohide", "no".into()),
        ("load-scripts", "no".into()), // VHO draws its own UI; the LGPL build has no Lua anyway
        ("idle", "yes".into()),
        ("keep-open", "yes".into()),
        ("volume-max", "200".into()),
        ("deinterlace", "auto".into()),
        ("tone-mapping", "auto".into()),
        ("screenshot-format", "png".into()),
        ("sub-auto", "fuzzy".into()),
        ("sub-codepage", "auto".into()),
        ("alang", "tur,tr,eng,en".into()),
        ("slang", "tur,tr,eng,en".into()),
        ("background-color", "#000000".into()),
    ]);
    if let Some(d) = &shots {
        opts.push(("screenshot-directory", d.to_string_lossy().into_owned()));
    }
    if fast {
        opts.push(("profile", "fast".into()));
    }
    let refs: Vec<(&str, &str)> = opts.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let m = mpv::Mpv::new(dll, &refs)?;
    // mpv messages go to stderr; VHO_MPV_LOG_LEVEL (e.g. "v", "debug") for diagnostics
    m.request_log_messages(&std::env::var("VHO_MPV_LOG_LEVEL").unwrap_or_else(|_| "warn".into()));
    for (i, p) in OBSERVED.iter().enumerate() {
        let _ = m.observe(i as u64 + 1, p);
    }
    #[cfg(target_os = "linux")]
    linux::attach(win, Arc::clone(&m))?;
    let h = app.clone();
    let mut throttle = events::Throttle::default();
    m.spawn_event_loop(move |ev| {
        if ev.get("event").and_then(Value::as_str) == Some("log-message") {
            eprintln!("[mpv] {}", ev.get("text").and_then(Value::as_str).unwrap_or("").trim_end());
        }
        for out in throttle.process(&ev, Instant::now()) {
            let _ = match out {
                events::Out::Property(p) => h.emit("engine://property", p),
                events::Out::Event(e) => h.emit("engine://event", e),
            };
        }
    });
    Ok(m)
}

/// Video output options of this platform's surface.
/// Windows: mpv's own `gpu-next` VO in the owned popup (`wid`). Linux: `vo=libmpv` (render API,
/// the GL context is VHO's GtkGLArea); hardware decoding only as copy-back, so a missing or
/// broken VAAPI (WSLg, VMs, some drivers) falls back to software decoding instead of a black frame.
#[cfg(windows)]
fn surface_options<R: Runtime>(win: &WebviewWindow<R>) -> Result<Vec<(&'static str, String)>, String> {
    let top = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let wid = window::create(top)?;
    Ok(vec![
        ("wid", wid.to_string()),
        ("force-window", "yes".into()),
        ("vo", "gpu-next".into()),
        ("hwdec", "auto-safe".into()),
    ])
}

#[cfg(target_os = "linux")]
fn surface_options<R: Runtime>(_win: &WebviewWindow<R>) -> Result<Vec<(&'static str, String)>, String> {
    Ok(vec![("vo", "libmpv".into()), ("hwdec", "auto-copy-safe".into())])
}

#[cfg(not(any(windows, target_os = "linux")))]
fn surface_options<R: Runtime>(_win: &WebviewWindow<R>) -> Result<Vec<(&'static str, String)>, String> {
    window::create(0).map(|_| vec![])
}

fn screenshot_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("VHO_SCREENSHOT_DIR") {
        return Some(PathBuf::from(d));
    }
    app.path().picture_dir().ok().map(|d| d.join("VHO"))
}

/// Stops mpv on exit (the event thread ends with the shutdown event).
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    // Linux: the render context goes first (GL context current), then the core
    #[cfg(target_os = "linux")]
    linux::shutdown();
    if let Some(st) = app.try_state::<Engine>() {
        if let Some(m) = st.lock().unwrap().mpv.take() {
            let _ = m.command(&json!(["quit"]));
        }
    }
}

fn mpv_of(st: &tauri::State<'_, Engine>) -> Result<Arc<mpv::Mpv>, String> {
    let g = st.lock().unwrap();
    g.mpv.clone().ok_or_else(|| g.error.clone().unwrap_or_else(|| "libmpv not loaded".into()))
}

#[tauri::command]
pub fn engine_status(st: tauri::State<'_, Engine>) -> Value {
    let g = st.lock().unwrap();
    let m = g.mpv.as_ref();
    let (client_major, client_minor) = m.map(|m| m.client_api_version()).unwrap_or((0, 0));
    let (client, video, visible) = window::geometry();
    json!({
        "available": m.is_some(),
        "error": g.error,
        "dll": g.dll,
        "mpvVersion": m.and_then(|m| m.get_property_string("mpv-version")),
        "ffmpegVersion": m.and_then(|m| m.get_property_string("ffmpeg-version")),
        "clientApi": format!("{client_major}.{client_minor}"),
        "gpu": g.gpu,
        "visible": visible,
        "clientRect": client,
        "videoRect": video,
        "surface": surface_info(),
    })
}

#[cfg(target_os = "linux")]
fn surface_info() -> Value {
    linux::info()
}

#[cfg(windows)]
fn surface_info() -> Value {
    json!({"surface": "win32-owned-popup"})
}

#[cfg(not(any(windows, target_os = "linux")))]
fn surface_info() -> Value {
    json!({"surface": null})
}

/// `loadfile <path> replace`, optionally starting at `start` seconds.
#[tauri::command]
pub async fn engine_load(st: tauri::State<'_, Engine>, path: String, start: Option<f64>) -> Result<(), String> {
    let m = mpv_of(&st)?;
    let mut cmd = json!({"name": "loadfile", "url": path, "flags": "replace"});
    if let Some(s) = start.filter(|s| *s > 0.0) {
        cmd["options"] = json!({ "start": format!("{s:.3}") });
    }
    m.command(&cmd).map(|_| ())
}

#[tauri::command]
pub async fn engine_command(st: tauri::State<'_, Engine>, args: Value) -> Result<Value, String> {
    mpv_of(&st)?.command(&args)
}

#[tauri::command]
pub async fn engine_set(st: tauri::State<'_, Engine>, name: String, value: Value) -> Result<(), String> {
    mpv_of(&st)?.set_property(&name, &value)
}

#[tauri::command]
pub async fn engine_get(st: tauri::State<'_, Engine>, name: String) -> Result<Value, String> {
    mpv_of(&st)?.get_property(&name)
}

/// Shows / hides the video surface (hidden for photos, the empty screen and the HTML5 engine).
#[tauri::command]
pub async fn engine_show(app: AppHandle, visible: bool) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        window::set_visible(visible);
        let _ = tx.send(window::is_visible());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())
}

/// Current frame (video only, no subtitles) as a PNG file in the app cache folder; the caller
/// removes it (thumbnails, "copy frame").
pub fn frame_to_temp(app: &AppHandle, st: &tauri::State<'_, Engine>) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let m = mpv_of(st)?;
    let dir = crate::platform::cache_dir(app)?.join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("frame-{}-{}.png", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    m.command(&json!(["screenshot-to-file", path.to_string_lossy(), "video"]))?;
    Ok(path)
}

/// Current frame (video only, no subtitles) as a PNG data URL, for the recent-files thumbnails.
/// The temporary file lives in the app cache folder and is removed again.
#[tauri::command]
pub async fn engine_thumbnail(app: AppHandle, st: tauri::State<'_, Engine>) -> Result<String, String> {
    let path = frame_to_temp(&app, &st)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&path);
    Ok(format!("data:image/png;base64,{}", base64(&bytes?)))
}

/// Standard base64 (RFC 4648, with padding).
pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (i, o) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(super::base64(i.as_bytes()), o);
        }
    }
}

/// Saves the current frame as PNG (`with_subs`: as shown, incl. subtitles) and returns its path.
#[tauri::command]
pub async fn engine_screenshot(
    app: AppHandle,
    st: tauri::State<'_, Engine>,
    stem: String,
    with_subs: Option<bool>,
) -> Result<String, String> {
    let m = mpv_of(&st)?;
    let dir = screenshot_dir(&app).ok_or("Resimler klasörü bulunamadı")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() || "-_".contains(c) { c } else { '_' })
        .collect();
    let stem = if stem.is_empty() { "VHO".to_string() } else { stem };
    let mut path = dir.join(format!("{stem}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}_{n}.png"));
        n += 1;
    }
    let p = path.to_string_lossy().into_owned();
    let flags = if with_subs.unwrap_or(true) { "subtitles" } else { "video" };
    m.command(&json!(["screenshot-to-file", p, flags]))?;
    if !path.is_file() {
        return Err("Ekran görüntüsü yazılamadı".into());
    }
    Ok(p)
}
