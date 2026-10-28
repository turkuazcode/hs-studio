//! Cast to a device on the local network (Plan 13/L04): UPnP/DLNA MediaRenderer.
//!
//! * Discovery runs only when the user opens "Cast to device…" (no background traffic).
//! * The renderer fetches the selected local file from `server::MediaServer` (one file, random
//!   token, closed on stop). The firewall is not touched.
//! * Control: AVTransport Play / Pause / Stop / Seek, status via GetTransportInfo / GetPositionInfo.
//! * Format check: when the renderer lists its sink formats and the file's type is not among
//!   them the cast is refused with `[cast-format]` (no automatic transcoding).
//! * Chromecast (CASTV2) is not implemented (`cast.chromecast` capability).
//! * Every network call has a timeout and runs off the UI thread; an unreachable device is an
//!   error, never a hang.

pub mod http;
pub mod server;
pub mod ssdp;
pub mod upnp;
pub mod xml;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use server::MediaServer;
use upnp::{Renderer, AVT, CM};

struct Session {
    renderer: Renderer,
    server: MediaServer,
}

struct State {
    devices: Vec<Renderer>,
    session: Option<Session>,
}

static STATE: Mutex<State> = Mutex::new(State { devices: Vec::new(), session: None });

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Search target: the SSDP multicast group, or `VHO_SSDP_TARGET` (tests: a fake renderer on loopback).
fn ssdp_target() -> SocketAddr {
    std::env::var("VHO_SSDP_TARGET").ok().and_then(|s| s.parse().ok()).unwrap_or_else(|| ssdp::MULTICAST.parse().unwrap())
}

pub fn discover(target: SocketAddr, window: Duration) -> Result<Vec<Renderer>, String> {
    let found = ssdp::search(target, ssdp::RENDERER, window)?;
    let handles: Vec<_> = found.into_iter().map(|f| std::thread::spawn(move || upnp::describe(&f.location, f.from))).collect();
    let mut out: Vec<Renderer> = Vec::new();
    for h in handles {
        if let Ok(Ok(r)) = h.join() {
            if !out.iter().any(|o| o.id == r.id) {
                out.push(r);
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    STATE.lock().unwrap().devices = out.clone();
    Ok(out)
}

fn stop_session(s: &mut Session) {
    let _ = upnp::soap(&s.renderer.avt_control, AVT, "Stop", &[("InstanceID", "0")]);
    s.server.stop();
}

pub fn start(id: &str, path: &Path, title: &str, start_at: f64) -> Result<(), String> {
    let dev = STATE.lock().unwrap().devices.iter().find(|d| d.id == id).cloned().ok_or("[cast-device-gone] search again")?;
    if let Some(mut old) = STATE.lock().unwrap().session.take() {
        stop_session(&mut old);
    }
    let ip = dev.ip.ok_or("[cast-device-gone]")?;
    let mime = server::mime_of(path).ok_or("[cast-format] not a castable file type")?;
    if let Some(cm) = &dev.cm_control {
        if let Ok(n) = upnp::soap(cm, CM, "GetProtocolInfo", &[]) {
            if upnp::sink_accepts(n.child_text("Sink").unwrap_or(""), mime) == Some(false) {
                return Err(format!("[cast-format] {mime}"));
            }
        }
    }
    let mut srv = MediaServer::start(path, server::local_ip_towards(ip)?)?;
    let meta = upnp::didl(title, mime, &srv.url);
    let res = (|| {
        upnp::soap(&dev.avt_control, AVT, "SetAVTransportURI", &[("InstanceID", "0"), ("CurrentURI", &srv.url), ("CurrentURIMetaData", &meta)])?;
        upnp::soap(&dev.avt_control, AVT, "Play", &[("InstanceID", "0"), ("Speed", "1")])?;
        if start_at >= 1.0 {
            // best effort: some renderers only accept Seek once playing
            let _ = upnp::soap(&dev.avt_control, AVT, "Seek", &[("InstanceID", "0"), ("Unit", "REL_TIME"), ("Target", &upnp::format_time(start_at))]);
        }
        Ok::<(), String>(())
    })();
    if let Err(e) = res {
        srv.stop();
        return Err(e);
    }
    STATE.lock().unwrap().session = Some(Session { renderer: dev, server: srv });
    Ok(())
}

pub fn control(action: &str, position: Option<f64>) -> Result<(), String> {
    let avt = STATE.lock().unwrap().session.as_ref().map(|s| s.renderer.avt_control.clone()).ok_or("[cast-inactive]")?;
    match action {
        "play" => upnp::soap(&avt, AVT, "Play", &[("InstanceID", "0"), ("Speed", "1")]).map(|_| ()),
        "pause" => upnp::soap(&avt, AVT, "Pause", &[("InstanceID", "0")]).map(|_| ()),
        "seek" => {
            let t = upnp::format_time(position.unwrap_or(0.0));
            upnp::soap(&avt, AVT, "Seek", &[("InstanceID", "0"), ("Unit", "REL_TIME"), ("Target", &t)]).map(|_| ())
        }
        "stop" => {
            if let Some(mut s) = STATE.lock().unwrap().session.take() {
                stop_session(&mut s);
            }
            Ok(())
        }
        _ => Err("[cast-bad-action]".into()),
    }
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub active: bool,
    pub device: Option<String>,
    /// PLAYING / PAUSED_PLAYBACK / STOPPED / TRANSITIONING / NO_MEDIA_PRESENT
    pub state: Option<String>,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// media requests the renderer made (0 after a while: blocked by a firewall?)
    pub requests: u64,
}

pub fn status() -> Result<Status, String> {
    let (avt, name, requests) = {
        let g = STATE.lock().unwrap();
        match g.session.as_ref() {
            Some(s) => (s.renderer.avt_control.clone(), s.renderer.name.clone(), s.server.requests()),
            None => return Ok(Status::default()),
        }
    };
    let info = upnp::soap(&avt, AVT, "GetTransportInfo", &[("InstanceID", "0")])?;
    let pos = upnp::soap(&avt, AVT, "GetPositionInfo", &[("InstanceID", "0")]).ok();
    Ok(Status {
        active: true,
        device: Some(name),
        state: info.child_text("CurrentTransportState").map(str::to_string),
        position: pos.as_ref().and_then(|p| p.child_text("RelTime")).and_then(upnp::parse_time),
        duration: pos.as_ref().and_then(|p| p.child_text("TrackDuration")).and_then(upnp::parse_time).filter(|d| *d > 0.0),
        requests,
    })
}

/// App exit: stop the renderer and close the media URL.
pub fn shutdown() {
    if let Some(mut s) = STATE.lock().unwrap().session.take() {
        stop_session(&mut s);
    }
}

#[tauri::command]
pub async fn cast_discover() -> Result<Vec<Renderer>, String> {
    let window = std::env::var("VHO_SSDP_WINDOW_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(3000u64);
    blocking(move || discover(ssdp_target(), Duration::from_millis(window))).await
}

#[tauri::command]
pub async fn cast_start(id: String, path: String, title: Option<String>, start: Option<f64>) -> Result<(), String> {
    blocking(move || {
        let p = Path::new(&path);
        let title = title.unwrap_or_else(|| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        self::start(&id, p, &title, start.unwrap_or(0.0))
    })
    .await
}

#[tauri::command]
pub async fn cast_control(action: String, position: Option<f64>) -> Result<(), String> {
    blocking(move || control(&action, position)).await
}

#[tauri::command]
pub async fn cast_status() -> Result<Status, String> {
    blocking(status).await
}

#[cfg(test)]
mod tests;
