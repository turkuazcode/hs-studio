//! OS integration: desktop background / lock screen, share sheet, "open with" chooser.
//! Callers go through `actions::gate` first (VHO_DISABLE_SYSTEM_CHANGES).
//!
//! Windows: IDesktopWallpaper, Windows.System.UserProfile.LockScreen, DataTransferManager
//! (IDataTransferManagerInterop), SHOpenWithDialog.
//! macOS: System Events (osascript) for the background, `open -R` fallback for share.
//! Linux: GNOME gsettings for the background, `xdg-open` / the portal for "open with".

use tauri::AppHandle;
#[cfg(windows)]
use tauri::Manager;

pub const WALLPAPER_SUPPORTED: bool = cfg!(any(windows, target_os = "macos", target_os = "linux"));

fn absolute(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    if !p.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    std::fs::canonicalize(p).map(|p| {
        // canonicalize gives \\?\C:\... on Windows; the shell APIs want the plain form
        let s = p.to_string_lossy().into_owned();
        std::path::PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s))
    })
    .map_err(|e| e.to_string())
}

/// AppleScript string literal of `s`. Backslashes are escaped before quotes: escaping only
/// the quote let a file name like `a\" & do shell script "x` end the string and run a command.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(windows)]
fn main_hwnd(app: &AppHandle) -> Result<windows::Win32::Foundation::HWND, String> {
    let w = app.webview_windows().into_values().next().ok_or("Pencere yok")?;
    let h = w.hwnd().map_err(|e| e.to_string())?;
    Ok(windows::Win32::Foundation::HWND(h.0 as _))
}

// ---------------------------------------------------------------------------
// Wallpaper / lock screen
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn set_wallpaper(path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper, DWPOS_FILL};
    let p = absolute(path)?;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wp: IDesktopWallpaper = CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        wp.SetPosition(DWPOS_FILL).map_err(|e| e.to_string())?;
        wp.SetWallpaper(windows::core::PCWSTR::null(), &HSTRING::from(p.as_os_str())).map_err(|e| format!("Arka plan ayarlanamadı: {e}"))
    }
}

#[cfg(windows)]
pub fn set_lock_screen(path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Storage::StorageFile;
    use windows::System::UserProfile::LockScreen;
    let p = absolute(path)?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(p.as_os_str()))
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
    LockScreen::SetImageFileAsync(&file)
        .and_then(|op| op.join())
        .map_err(|e| format!("Kilit ekranı ayarlanamadı: {e}"))
}

#[cfg(target_os = "macos")]
pub fn set_wallpaper(path: &str) -> Result<(), String> {
    let p = absolute(path)?;
    let script = format!(
        "tell application \"System Events\" to tell every desktop to set picture to POSIX file {}",
        applescript_string(&p.to_string_lossy())
    );
    let st = std::process::Command::new("osascript").args(["-e", &script]).status().map_err(|e| e.to_string())?;
    if st.success() { Ok(()) } else { Err(format!("osascript: {st}")) }
}

#[cfg(target_os = "linux")]
pub fn set_wallpaper(path: &str) -> Result<(), String> {
    let p = absolute(path)?;
    let uri = format!("file://{}", p.to_string_lossy());
    // GNOME (and GNOME-based desktops) only; other desktops report an error instead of a fake success
    let mut ok = false;
    for key in ["picture-uri", "picture-uri-dark"] {
        ok |= std::process::Command::new("gsettings")
            .args(["set", "org.gnome.desktop.background", key, &uri])
            .status()
            .is_ok_and(|s| s.success());
    }
    if ok { Ok(()) } else { Err(format!("{} Arka plan yalnızca GNOME masaüstünde ayarlanabiliyor", super::ERR_UNSUPPORTED)) }
}

#[cfg(not(windows))]
pub fn set_lock_screen(_path: &str) -> Result<(), String> {
    Err(format!("{} Kilit ekranı bu sistemde desteklenmiyor", super::ERR_UNSUPPORTED))
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

/// Opens the share sheet. Returns "share" or "reveal" (fallback: show in folder).
#[cfg(windows)]
pub fn share(app: &AppHandle, path: &str) -> Result<String, String> {
    use windows::core::{factory, AgileReference, HSTRING, Interface};
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;
    use windows_collections::IIterable;

    let p = absolute(path)?;
    let hwnd = main_hwnd(app)?;
    // The file object is created up front (agile) so the DataRequested handler never blocks
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(p.as_os_str()))
        .and_then(|op| op.join())
        .map_err(|e| e.to_string())?;
    let item: IStorageItem = file.cast().map_err(|e| e.to_string())?;
    // event handlers must be Send: the item travels as an agile reference
    let item = AgileReference::new(&item).map_err(|e| e.to_string())?;
    let title = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let hwnd_raw = hwnd.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let r = (|| -> windows::core::Result<()> {
            let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as _);
            let interop = factory::<DataTransferManager, IDataTransferManagerInterop>()?;
            let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
            let item = item.clone();
            let title = HSTRING::from(title.as_str());
            let token = std::sync::Arc::new(std::sync::Mutex::new(None::<i64>));
            let token2 = token.clone();
            let t = dtm.DataRequested(&TypedEventHandler::<DataTransferManager, DataRequestedEventArgs>::new(move |sender, args| {
                if let Some(args) = args.as_ref() {
                    let data = args.Request()?.Data()?;
                    data.Properties()?.SetTitle(&title)?;
                    data.SetStorageItemsReadOnly(&IIterable::<IStorageItem>::from(vec![Some(item.resolve()?)]))?;
                }
                // one-shot: the next share registers its own file
                if let (Some(s), Some(tok)) = (sender.as_ref(), *token2.lock().unwrap()) {
                    let _ = s.RemoveDataRequested(tok);
                }
                Ok(())
            }))?;
            *token.lock().unwrap() = Some(t);
            unsafe { interop.ShowShareUIForWindow(hwnd) }
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())??;
    Ok("share".into())
}

/// No share sheet outside Windows yet (macOS NSSharingServicePicker / Linux portal: not
/// implemented). Not imitated by "show in folder": the UI hides the action.
#[cfg(not(windows))]
pub fn share(_app: &AppHandle, _path: &str) -> Result<String, String> {
    Err(format!("{} Paylaşım bu sistemde desteklenmiyor", super::ERR_UNSUPPORTED))
}

// ---------------------------------------------------------------------------
// Open with
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub fn open_with(app: &AppHandle, path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO};
    let p = absolute(path)?;
    let hwnd_raw = main_hwnd(app)?.0 as isize;
    // Modal dialog on its own thread: the app keeps painting / playing meanwhile
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let file = HSTRING::from(p.as_os_str());
        let info = OPENASINFO {
            pcszFile: windows::core::PCWSTR(file.as_ptr()),
            pcszClass: windows::core::PCWSTR::null(),
            oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
        };
        if let Err(e) = SHOpenWithDialog(Some(windows::Win32::Foundation::HWND(hwnd_raw as _)), &info) {
            eprintln!("[VHO] SHOpenWithDialog: {e}");
        }
    });
    Ok(())
}

/// Finder's "Open With" chooser needs AppKit (not implemented); not imitated by a reveal.
#[cfg(target_os = "macos")]
pub fn open_with(_app: &AppHandle, _path: &str) -> Result<(), String> {
    Err(format!("{} Birlikte aç bu sistemde desteklenmiyor", super::ERR_UNSUPPORTED))
}

#[cfg(target_os = "linux")]
pub fn open_with(_app: &AppHandle, path: &str) -> Result<(), String> {
    let _ = absolute(path)?;
    // xdg-desktop-portal OpenURI with "ask" shows the chooser on GNOME/KDE; xdg-open otherwise
    let uri = format!("file://{path}");
    let portal = std::process::Command::new("gdbus")
        .args([
            "call", "--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop",
            "--method", "org.freedesktop.portal.OpenURI.OpenURI", "", &uri, "{'ask': <true>}",
        ])
        .status();
    if portal.is_ok_and(|s| s.success()) {
        return Ok(());
    }
    std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applescript_string_cannot_be_broken_out_of() {
        assert_eq!(applescript_string("/a b/c.jpg"), r#""/a b/c.jpg""#);
        assert_eq!(applescript_string(r#"/x/a\" & do shell script "touch /tmp/p" & ".jpg"#), r#""/x/a\\\" & do shell script \"touch /tmp/p\" & \".jpg""#);
        // every quote inside is preceded by an odd number of backslashes, so none ends the literal
        let s = applescript_string(r#"\\"\""#);
        let inner = &s[1..s.len() - 1];
        for (i, _) in inner.match_indices('"') {
            let run = inner[..i].chars().rev().take_while(|&c| c == '\\').count();
            assert_eq!(run % 2, 1, "{s}");
        }
    }
}
