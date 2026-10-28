//! Linux engine smoke scenario (P03), run INSIDE the real app: `VHO_ENGINE_SMOKE_REPORT=<json>`
//! plus a media file on the command line. The frontend opens the file through its normal path
//! (initial_files -> libmpv engine -> engine_show); this thread then checks, through the same
//! mpv core and the GL surface: frames drawn into the GtkGLArea, a non-black centre pixel,
//! play / pause / seek, audio + subtitle track switching, subtitle text, the audio output.
//! Writes a JSON report and exits the app (exit code 0 = all steps passed).
//! WebKitGTK has no CDP, so this replaces the Windows E2E driver for the engine part on Linux.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::{Engine, linux};

pub fn maybe_start(app: &AppHandle) {
    let Some(report) = std::env::var_os("VHO_ENGINE_SMOKE_REPORT").map(PathBuf::from) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        let r = run(&app);
        let ok = r["ok"].as_bool().unwrap_or(false);
        let _ = std::fs::write(&report, serde_json::to_vec_pretty(&r).unwrap_or_default());
        eprintln!("[VHO] engine smoke: {}", if ok { "PASS" } else { "FAIL" });
        app.exit(if ok { 0 } else { 1 });
    });
}

fn wait<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let end = Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if Instant::now() > end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_secs(3)).ok()
}

fn run(app: &AppHandle) -> Value {
    let mut steps: Vec<Value> = vec![];
    let mut step = |name: &str, ok: bool, detail: Value| {
        eprintln!("[VHO] smoke {name}: {} {detail}", if ok { "ok" } else { "FAILED" });
        steps.push(json!({"name": name, "ok": ok, "detail": detail}));
    };
    let env = json!({
        "GDK_BACKEND": std::env::var("GDK_BACKEND").ok(),
        "WAYLAND_DISPLAY": std::env::var("WAYLAND_DISPLAY").ok(),
        "DISPLAY": std::env::var("DISPLAY").ok(),
        "PULSE_SERVER": std::env::var("PULSE_SERVER").ok(),
    });
    let m = wait(Duration::from_secs(10), || app.try_state::<Engine>().and_then(|s| s.lock().unwrap().mpv.clone()));
    let Some(m) = m else {
        let err = app.try_state::<Engine>().and_then(|s| s.lock().unwrap().error.clone());
        step("engine", false, json!(err));
        return json!({"ok": false, "steps": steps, "env": env});
    };
    step("engine", true, json!(m.get_property_string("mpv-version")));

    let surface = wait(Duration::from_secs(15), || {
        let i = linux::info();
        (i.get("gl").is_some() || i["error"].is_string() && i["error"] != "GL area not realized yet").then_some(i)
    })
    .unwrap_or_else(linux::info);
    step("surface", surface["error"].is_null() && surface.get("gl").is_some(), surface.clone());

    let num = |name: &str| m.get_property(name).ok().and_then(|v| v.as_f64());
    let loaded = wait(Duration::from_secs(20), || {
        let p = m.get_property("path").ok()?;
        (p.as_str().is_some_and(|s| !s.is_empty()) && num("duration").is_some_and(|d| d > 0.0)).then_some(p)
    });
    step("open (frontend initial file -> libmpv)", loaded.is_some(), json!(loaded));

    let _ = m.set_property("pause", &json!(false));
    let started = wait(Duration::from_secs(10), || num("time-pos").filter(|t| *t > 0.2));
    let f0 = linux::FRAMES.load(Ordering::Relaxed);
    let t1 = num("time-pos").unwrap_or(0.0);
    std::thread::sleep(Duration::from_millis(1200));
    let t2 = num("time-pos").unwrap_or(0.0);
    let frames = linux::FRAMES.load(Ordering::Relaxed) - f0;
    step("play", started.is_some() && t2 - t1 > 0.6, json!({"t1": t1, "t2": t2}));
    step("frames drawn into the GL area", frames >= 10, json!({"framesIn1.2s": frames}));
    let visible = on_main(app, linux::is_visible);
    step("surface visible (frontend engine_show)", visible == Some(true), json!(visible));

    // The generated testsrc2 clip is blue (0,0,254) in the centre from 1 s on. Several probes while
    // playing: a black frame in between would be visible flicker.
    let bright = |p: &Value| p.as_array().is_some_and(|a| a.iter().take(3).any(|c| c.as_u64().unwrap_or(0) > 40));
    let mut probes = vec![];
    for _ in 0..6 {
        linux::request_pixel_probe();
        linux::queue_render();
        let px = wait(Duration::from_secs(3), linux::probed_pixel);
        probes.push(json!({
            "t": num("time-pos"),
            "px": px,
            "voConfigured": m.get_property("vo-configured").ok(),
            "videoOut": m.get_property("video-out-params").ok().map(|v| json!([v["w"], v["h"], v["pixelformat"]])),
            "drops": [m.get_property("frame-drop-count").ok(), m.get_property("decoder-frame-drop-count").ok()],
        }));
        std::thread::sleep(Duration::from_millis(150));
    }
    let lit = probes.iter().filter(|p| bright(&p["px"]["rgba"])).count();
    step("centre pixel is video (not black)", lit == probes.len(), json!({"lit": lit, "probes": probes}));
    let shown = on_main(app, linux::composited_samples).flatten();
    step(
        "composited window shows the video (webview transparent above)",
        shown.as_ref().is_some_and(|s| bright(&s["centre"])),
        json!(shown),
    );

    let _ = m.set_property("pause", &json!(true));
    std::thread::sleep(Duration::from_millis(500));
    let p1 = num("time-pos").unwrap_or(-1.0);
    std::thread::sleep(Duration::from_millis(800));
    let p2 = num("time-pos").unwrap_or(-2.0);
    step("pause", (p2 - p1).abs() < 0.05 && m.get_property("pause").ok() == Some(json!(true)), json!({"p1": p1, "p2": p2}));

    let _ = m.command(&json!(["seek", 1.0, "absolute+exact"]));
    let at = wait(Duration::from_secs(4), || num("time-pos").filter(|t| (t - 1.0).abs() < 0.2));
    step("seek to 1.0 s", at.is_some(), json!(num("time-pos")));

    let tracks = m.get_property("track-list").unwrap_or(Value::Null);
    let count = |kind: &str| tracks.as_array().map_or(0, |a| a.iter().filter(|t| t["type"] == kind).count());
    let (audio, subs) = (count("audio"), count("sub"));
    let _ = m.set_property("aid", &json!(2));
    let aid = wait(Duration::from_secs(2), || m.get_property("aid").ok().filter(|v| v == &json!(2)));
    step("audio track 2", audio >= 2 && aid.is_some(), json!({"audioTracks": audio, "aid": m.get_property("aid").ok()}));
    let _ = m.set_property("sid", &json!(1));
    let sid = wait(Duration::from_secs(2), || m.get_property("sid").ok().filter(|v| v == &json!(1)));
    let _ = m.set_property("pause", &json!(false));
    let text = wait(Duration::from_secs(3), || m.get_property_string("sub-text").filter(|s| !s.trim().is_empty()));
    step("subtitle track 1 + text", subs >= 1 && sid.is_some() && text.is_some(), json!({"subTracks": subs, "text": text}));

    let ao = m.get_property_string("current-ao");
    step("audio output", ao.as_deref().is_some_and(|a| !a.is_empty() && a != "null"), json!({"ao": ao, "device": m.get_property_string("audio-device")}));
    let vo = m.get_property_string("current-vo");
    step("video output is the render API", vo.as_deref() == Some("libmpv"), json!(vo));
    let hwdec = m.get_property_string("hwdec-current");
    let _ = m.set_property("pause", &json!(true));

    let ok = steps.iter().all(|s| s["ok"] == true);
    json!({
        "ok": ok,
        "steps": steps,
        "env": env,
        "surface": linux::info(),
        "hwdecCurrent": hwdec,
        "mpvVersion": m.get_property_string("mpv-version"),
        "ffmpegVersion": m.get_property_string("ffmpeg-version"),
    })
}
