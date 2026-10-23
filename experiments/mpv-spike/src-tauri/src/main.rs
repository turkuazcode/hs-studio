// VHO engine spike: libmpv rendering into a native child HWND under a transparent Tauri webview.
//
// Windows-only experiment (path A, HWND embedding).
// Usage: mpv-spike.exe [--dll <libmpv-2.dll>] [--selftest <log.json>] [--browser-args "<flags>"]
//                      [--mpv-opt key=value]... [file]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mpv;
mod video_window;

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::{Value, json};
use tauri::{Emitter, Manager, WebviewWindowBuilder, WindowEvent};

#[derive(Default, Clone, serde::Serialize)]
struct Args {
    dll: Option<String>,
    selftest: Option<String>,
    browser_args: Option<String>,
    mode: Option<String>,
    mpv_opts: Vec<String>,
    file: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--dll" => a.dll = it.next(),
            "--selftest" => a.selftest = it.next(),
            "--browser-args" => a.browser_args = it.next(),
            "--mode" => a.mode = it.next(),
            "--mpv-opt" => a.mpv_opts.extend(it.next()),
            _ => a.file = Some(x),
        }
    }
    a
}

struct Spike {
    mpv: Option<Arc<mpv::Mpv>>,
    mpv_error: Option<String>,
    top_hwnd: isize,
    video_hwnd: isize,
    started: Instant,
}

static ARGS: OnceLock<Args> = OnceLock::new();
static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();

fn log(line: &str) {
    if let Some(f) = LOG.get() {
        let _ = writeln!(f.lock().unwrap(), "{line}");
    }
}

fn mpv_of(s: &tauri::State<Mutex<Spike>>) -> Result<Arc<mpv::Mpv>, String> {
    let g = s.lock().unwrap();
    g.mpv.clone().ok_or_else(|| g.mpv_error.clone().unwrap_or("mpv not loaded".into()))
}

#[tauri::command]
fn mpv_command(s: tauri::State<Mutex<Spike>>, args: Value) -> Result<Value, String> {
    mpv_of(&s)?.command(&args)
}

#[tauri::command]
fn mpv_set(s: tauri::State<Mutex<Spike>>, name: String, value: Value) -> Result<(), String> {
    mpv_of(&s)?.set_property(&name, &value)
}

#[tauri::command]
fn mpv_get(s: tauri::State<Mutex<Spike>>, name: String) -> Result<Value, String> {
    mpv_of(&s)?.get_property(&name)
}

#[tauri::command]
fn spike_info(s: tauri::State<Mutex<Spike>>) -> Value {
    let g = s.lock().unwrap();
    let (major, minor) = g.mpv.as_ref().map(|m| m.client_api_version()).unwrap_or((0, 0));
    json!({
        "args": ARGS.get(),
        "mpv_error": g.mpv_error,
        "client_api": format!("{major}.{minor}"),
        "mpv_version": g.mpv.as_ref().and_then(|m| m.get_property_string("mpv-version")),
        "ffmpeg_version": g.mpv.as_ref().and_then(|m| m.get_property_string("ffmpeg-version")),
        "zorder": video_window::child_zorder(g.top_hwnd),
        "video_hwnd": format!("{:#x}", g.video_hwnd),
    })
}

#[tauri::command]
fn spike_log(line: String) {
    log(&line);
}

/// Process CPU time (user+kernel, ms) and wall time, for CPU% sampling from the UI.
#[tauri::command]
fn spike_cpu(s: tauri::State<Mutex<Spike>>) -> Value {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let z = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut c, mut e, mut k, mut u) = (z(), z(), z(), z());
    unsafe { GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) };
    let ft = |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 10_000.0;
    let wall = s.lock().unwrap().started.elapsed().as_secs_f64() * 1000.0;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    json!({"cpu_ms": ft(k) + ft(u), "wall_ms": wall, "cores": cores})
}

#[tauri::command]
fn spike_capture(s: tauri::State<Mutex<Spike>>, name: String) -> Result<Value, String> {
    let top = s.lock().unwrap().top_hwnd;
    let dir = ARGS
        .get()
        .and_then(|a| a.selftest.as_ref())
        .and_then(|p| std::path::Path::new(p).parent().map(|d| d.join("captures")))
        .unwrap_or_else(|| std::env::temp_dir().join("vho-mpv-spike"));
    let _ = std::fs::create_dir_all(&dir);
    let stem = ARGS
        .get()
        .and_then(|a| a.selftest.as_ref())
        .and_then(|p| std::path::Path::new(p).file_name().map(|f| f.to_string_lossy().replace(".log.jsonl", "")))
        .unwrap_or_default();
    let path = dir.join(format!("{stem}-{name}.bmp"));
    let (w, h, nonblack) = video_window::capture_client(top, &path)?;
    Ok(json!({"path": path, "w": w, "h": h, "nonblack": nonblack}))
}

/// Synthesize a real OS mouse click at client coordinates (physical px) of the top-level window.
#[tauri::command]
fn spike_click(s: tauri::State<Mutex<Spike>>, x: i32, y: i32) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
        use windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let top = s.lock().unwrap().top_hwnd;
        let mut p = POINT { x, y };
        ClientToScreen(top as _, &mut p);
        // Only click if that screen point really belongs to our window (never click other apps).
        let hit = video_window::hit_test(top, p.x, p.y);
        if !hit.0 {
            return Err(format!("point occluded by another window: {:?}", hit.1));
        }
        let mut old = POINT { x: 0, y: 0 };
        GetCursorPos(&mut old);
        SetCursorPos(p.x, p.y);
        let mk = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        };
        let inputs = [mk(MOUSEEVENTF_LEFTDOWN), mk(MOUSEEVENTF_LEFTUP)];
        SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(50));
        SetCursorPos(old.x, old.y);
        return Ok(hit.1);
    }
    #[allow(unreachable_code)]
    Err("unsupported".into())
}

/// Which HWND would receive mouse input at client point (x,y)? (non-intrusive input check)
#[tauri::command]
fn spike_hittest(s: tauri::State<Mutex<Spike>>, x: i32, y: i32) -> Value {
    let top = s.lock().unwrap().top_hwnd;
    let (ours, chain) = video_window::hit_test_client(top, x, y);
    json!({"ours": ours, "chain": chain})
}

#[tauri::command]
fn spike_quit(app: tauri::AppHandle, s: tauri::State<Mutex<Spike>>, code: i32) {
    if let Some(m) = s.lock().unwrap().mpv.take() {
        let _ = m.command(&json!(["quit"]));
    }
    app.exit(code);
}

fn resolve_dll(args: &Args) -> PathBuf {
    if let Some(d) = &args.dll {
        return std::path::absolute(d).unwrap_or_else(|_| PathBuf::from(d));
    }
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));
    exe_dir.unwrap_or_default().join("libmpv-2.dll")
}

fn main() {
    let args = parse_args();
    ARGS.set(args.clone()).ok();
    if let Some(p) = &args.selftest {
        if let Ok(f) = std::fs::File::create(p) {
            LOG.set(Mutex::new(f)).ok();
        }
    }

    tauri::Builder::default()
        .setup(move |app| {
            let config = app.config().app.windows.first().cloned().ok_or("no window config")?;
            let mut b = WebviewWindowBuilder::from_config(app.handle(), &config)?;
            if let Some(extra) = &args.browser_args {
                // keep wry's default --disable-features list, which this call would otherwise drop
                let a = format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {extra}"
                );
                b = b.additional_browser_args(&a);
            }
            // Composition variants under test:
            //  transparent (default): tauri.conf "transparent": true -> tao DwmEnableBlurBehind + webview alpha 0
            //  bgcolor: opaque top-level window, only the WebView2 default background has alpha 0
            //  videotop: diagnostic - video child ABOVE the webview (proves mpv renders; UI hidden)
            //  owned: transparent Tauri window owned by a separate top-level video popup (A')
            if args.mode.as_deref() == Some("bgcolor") {
                b = b.transparent(false).background_color(tauri::window::Color(0, 0, 0, 0));
            }
            let win = b.build()?;
            let top = win.hwnd()?.0 as isize;
            let size = win.inner_size()?;
            let mode = args.mode.clone().unwrap_or_else(|| "transparent".into());
            let owned = mode == "owned";
            let video = if owned {
                video_window::create_owner_popup(top)
            } else {
                video_window::create(top, size.width as i32, size.height as i32)
            };
            if mode == "videotop" {
                video_window::bring_to_top(video);
            }

            let started = Instant::now();
            let dll = resolve_dll(&args);
            let wid = video.to_string();
            let mut opts: Vec<(String, String)> = vec![
                ("wid".into(), wid),
                ("config".into(), "no".into()),
                ("terminal".into(), "no".into()),
                ("input-default-bindings".into(), "no".into()),
                ("input-vo-keyboard".into(), "no".into()),
                ("input-cursor".into(), "no".into()),
                ("load-scripts".into(), "no".into()), // no OSC/ytdl; LGPL build has no Lua at all
                ("idle".into(), "yes".into()),
                ("force-window".into(), "yes".into()),
                ("keep-open".into(), "yes".into()),
                ("vo".into(), "gpu-next".into()),
                ("hwdec".into(), "auto-safe".into()),
            ];
            for o in &args.mpv_opts {
                if let Some((k, v)) = o.split_once('=') {
                    opts.retain(|(ok, _)| ok != k);
                    opts.push((k.into(), v.into()));
                }
            }
            let opt_refs: Vec<(&str, &str)> = opts.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let (mpv, mpv_error) = match mpv::Mpv::new(&dll, &opt_refs) {
                Ok(m) => (Some(m), None),
                Err(e) => (None, Some(e)),
            };
            log(&json!({"t": 0, "ev": "init", "dll": dll, "opts": opts, "error": mpv_error}).to_string());

            if let Some(m) = &mpv {
                m.request_log_messages("warn");
                let props = [
                    "time-pos", "duration", "pause", "track-list", "chapter-list", "volume",
                    "eof-reached", "video-params", "hwdec-current", "aid", "sid", "fullscreen",
                ];
                for (i, p) in props.iter().enumerate() {
                    let _ = m.observe(i as u64 + 1, p);
                }
                let h = app.handle().clone();
                m.spawn_event_loop(move |ev| {
                    let name = ev.get("event").and_then(|e| e.as_str()).unwrap_or("");
                    if name == "log-message" {
                        log(&json!({"t": started.elapsed().as_millis(), "ev": "mpv-log", "data": ev}).to_string());
                    }
                    let _ = h.emit("mpv://event", ev);
                });
            }

            app.manage(Mutex::new(Spike { mpv, mpv_error, top_hwnd: top, video_hwnd: video, started }));

            // Keep the video child covering the client area (resize, maximize, fullscreen).
            let h2 = app.handle().clone();
            win.on_window_event(move |e| {
                let Some(st) = h2.try_state::<Mutex<Spike>>() else { return };
                let (t, v) = { let g = st.lock().unwrap(); (g.top_hwnd, g.video_hwnd) };
                match e {
                    _ if owned => match e {
                        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                            video_window::sync_owner_popup(t, v)
                        }
                        _ => {}
                    },
                    WindowEvent::Resized(sz) if mode != "videotop" => {
                        video_window::send_to_bottom(v, sz.width as i32, sz.height as i32)
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mpv_command, mpv_set, mpv_get, spike_info, spike_log, spike_cpu, spike_capture, spike_click,
            spike_hittest, spike_quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
