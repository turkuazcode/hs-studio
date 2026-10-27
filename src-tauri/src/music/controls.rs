//! System media controls: one adapter for the OS "now playing" surface (Plan 13/L03).
//!
//! * Windows: System Media Transport Controls (SMTC) of the app window — media keys, the
//!   volume overlay / lock screen card with title, artist, album and cover.
//! * macOS (MPNowPlayingInfoCenter) / Linux (MPRIS): not implemented in this build; the
//!   capability reports `available: false` (`not-implemented`), the UI hides nothing else.
//!
//! Loop safety: an OS button press is forwarded to the frontend once (`media-control`
//! event); the frontend reports state changes back with `media_controls_update`, which only
//! sets properties and never raises a button event, so no ping-pong is possible.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The media file (its embedded cover or a folder.jpg/cover.jpg is shown).
    pub path: Option<String>,
    /// "playing" | "paused" | "stopped" | "closed" (closed = nothing is playing: card hidden)
    pub status: String,
    pub can_next: bool,
    pub can_previous: bool,
}

/// What the OS surface currently shows (read back from the OS object, for tests/diagnostics).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlsState {
    pub available: bool,
    pub enabled: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub has_thumbnail: bool,
    pub buttons_received: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonEvent {
    /// "play" | "pause" | "stop" | "next" | "previous"
    pub button: &'static str,
    /// "os" (a real press) or "simulated" (media_controls_simulate)
    pub source: &'static str,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::{Emitter, Manager};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButton,
        SystemMediaTransportControlsButtonPressedEventArgs,
    };
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::RandomAccessStreamReference;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
    use windows::core::{HSTRING, factory};

    static SMTC: OnceLock<Mutex<Option<SystemMediaTransportControls>>> = OnceLock::new();
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static PRESSES: AtomicU64 = AtomicU64::new(0);
    static LAST_COVER: Mutex<Option<String>> = Mutex::new(None);

    fn slot() -> &'static Mutex<Option<SystemMediaTransportControls>> {
        SMTC.get_or_init(|| Mutex::new(None))
    }

    pub fn button_name(b: SystemMediaTransportControlsButton) -> Option<&'static str> {
        Some(match b {
            SystemMediaTransportControlsButton::Play => "play",
            SystemMediaTransportControlsButton::Pause => "pause",
            SystemMediaTransportControlsButton::Stop => "stop",
            SystemMediaTransportControlsButton::Next => "next",
            SystemMediaTransportControlsButton::Previous => "previous",
            _ => return None,
        })
    }

    pub fn emit_button(button: &'static str, source: &'static str) {
        PRESSES.fetch_add(1, Ordering::Relaxed);
        if let Some(app) = APP.get() {
            let _ = app.emit("media-control", ButtonEvent { button, source });
        }
    }

    /// Creates the SMTC of the main window (on the UI thread) once.
    fn ensure(app: &AppHandle) -> Result<SystemMediaTransportControls, String> {
        if let Some(s) = slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(s);
        }
        let _ = APP.set(app.clone());
        let win = app.get_webview_window("main").or_else(|| app.webview_windows().into_values().next()).ok_or("no window")?;
        let raw = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let r = (|| -> windows::core::Result<SystemMediaTransportControls> {
                let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
                let smtc: SystemMediaTransportControls = unsafe { interop.GetForWindow(HWND(raw as *mut _)) }?;
                smtc.SetIsEnabled(true)?;
                smtc.SetIsPlayEnabled(true)?;
                smtc.SetIsPauseEnabled(true)?;
                smtc.SetIsStopEnabled(true)?;
                smtc.ButtonPressed(&TypedEventHandler::<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>::new(
                    |_, args| {
                        if let Some(a) = args.as_ref() {
                            if let Some(name) = button_name(a.Button()?) {
                                emit_button(name, "os");
                            }
                        }
                        Ok(())
                    },
                ))?;
                smtc.DisplayUpdater()?.SetType(MediaPlaybackType::Music)?;
                Ok(smtc)
            })();
            let _ = tx.send(r.map_err(|e| e.to_string()));
        })
        .map_err(|e| e.to_string())?;
        let smtc = rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())??;
        *slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(smtc.clone());
        Ok(smtc)
    }

    /// The file's embedded cover (written to the cache) or a cover image next to it.
    fn cover_for(app: &AppHandle, media: &Path) -> Option<PathBuf> {
        let dir = app.path().app_cache_dir().ok()?.join("nowplaying");
        std::fs::create_dir_all(&dir).ok()?;
        if let Ok(p) = crate::actions::tags::save_cover(media, &dir.join("cover")) {
            return Some(p);
        }
        let folder = media.parent()?;
        ["cover.jpg", "folder.jpg", "cover.png", "folder.png", "front.jpg", "album.jpg"]
            .iter()
            .map(|n| folder.join(n))
            .find(|p| p.is_file())
    }

    pub fn update(app: &AppHandle, np: &NowPlaying) -> Result<(), String> {
        let smtc = ensure(app)?;
        let status = match np.status.as_str() {
            "playing" => MediaPlaybackStatus::Playing,
            "paused" => MediaPlaybackStatus::Paused,
            "stopped" => MediaPlaybackStatus::Stopped,
            _ => MediaPlaybackStatus::Closed,
        };
        let r = (|| -> windows::core::Result<()> {
            smtc.SetIsNextEnabled(np.can_next)?;
            smtc.SetIsPreviousEnabled(np.can_previous)?;
            smtc.SetPlaybackStatus(status)?;
            let du = smtc.DisplayUpdater()?;
            if np.status == "closed" {
                du.ClearAll()?;
                du.Update()?;
                return Ok(());
            }
            du.SetType(MediaPlaybackType::Music)?;
            let mp = du.MusicProperties()?;
            mp.SetTitle(&HSTRING::from(np.title.as_str()))?;
            mp.SetArtist(&HSTRING::from(np.artist.as_str()))?;
            mp.SetAlbumTitle(&HSTRING::from(np.album.as_str()))?;
            // the cover only changes with the file
            let mut last = LAST_COVER.lock().unwrap_or_else(|e| e.into_inner());
            if last.as_deref() != np.path.as_deref() {
                *last = np.path.clone();
                let cover = np.path.as_deref().and_then(|p| cover_for(app, Path::new(p)));
                match cover {
                    Some(c) => {
                        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(c.to_string_lossy().as_ref()))?.join()?;
                        du.SetThumbnail(&RandomAccessStreamReference::CreateFromFile(&file)?)?;
                    }
                    None => du.SetThumbnail(None)?,
                }
            }
            du.Update()
        })();
        r.map_err(|e| e.to_string())
    }

    pub fn state() -> ControlsState {
        let Some(smtc) = slot().lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return ControlsState { available: true, ..Default::default() };
        };
        let read = || -> windows::core::Result<ControlsState> {
            let du = smtc.DisplayUpdater()?;
            let mp = du.MusicProperties()?;
            let status = match smtc.PlaybackStatus()? {
                MediaPlaybackStatus::Playing => "playing",
                MediaPlaybackStatus::Paused => "paused",
                MediaPlaybackStatus::Stopped => "stopped",
                MediaPlaybackStatus::Closed => "closed",
                _ => "changing",
            };
            Ok(ControlsState {
                available: true,
                enabled: smtc.IsEnabled()?,
                title: mp.Title()?.to_string(),
                artist: mp.Artist()?.to_string(),
                album: mp.AlbumTitle()?.to_string(),
                status: status.into(),
                has_thumbnail: du.Thumbnail().is_ok(),
                buttons_received: PRESSES.load(Ordering::Relaxed),
            })
        };
        read().unwrap_or(ControlsState { available: true, ..Default::default() })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn update(_app: &AppHandle, _np: &NowPlaying) -> Result<(), String> {
        Err("[unsupported] system media controls are not implemented on this platform yet".into())
    }
    pub fn state() -> ControlsState {
        ControlsState::default()
    }
    pub fn emit_button(_button: &'static str, _source: &'static str) {}
}

/// Updates the OS "now playing" card and transport buttons.
#[tauri::command]
pub async fn media_controls_update(app: AppHandle, now: NowPlaying) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::update(&app, &now)).await.map_err(|e| e.to_string())?
}

/// What the OS surface shows now (tests, diagnostics).
#[tauri::command]
pub fn media_controls_state() -> ControlsState {
    imp::state()
}

/// Same path as a hardware media key (E2E: real key presses would reach the user's desktop).
#[tauri::command]
pub fn media_controls_simulate(button: String) -> Result<(), String> {
    let b: &'static str = match button.as_str() {
        "play" => "play",
        "pause" => "pause",
        "stop" => "stop",
        "next" => "next",
        "previous" => "previous",
        _ => return Err("[invalid] button".into()),
    };
    imp::emit_button(b, "simulated");
    Ok(())
}
