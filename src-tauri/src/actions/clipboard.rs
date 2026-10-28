//! Clipboard: text, file lists (Explorer/Finder paste; CF_HDROP on Windows) and images, through
//! `arboard` (MIT OR Apache-2.0). One clipboard handle lives for the whole run: on X11 the
//! content would otherwise vanish with the handle.

use std::borrow::Cow;
use std::sync::Mutex;
use std::time::Duration;

use arboard::{Clipboard, ImageData};

static CLIP: Mutex<Option<Clipboard>> = Mutex::new(None);

/// Waits between attempts while another process holds the clipboard open (OpenClipboard
/// fails). arboard itself only retries for ~25 ms; Windows clipboard history / cloud
/// clipboard, clipboard managers, RDP (rdpclip) and Office render clipboard data for up to a
/// few hundred ms after every change — long enough to fail every copy/paste that follows a
/// large image. Total ~3.1 s, then a coded error naming the holder.
const BACKOFF_MS: [u64; 9] = [10, 20, 40, 80, 160, 320, 500, 800, 1200];

/// Runs `op`, retrying only while the clipboard is occupied. `sleep` is injected for tests.
fn retry<T>(
    mut op: impl FnMut() -> Result<T, arboard::Error>,
    mut sleep: impl FnMut(Duration),
) -> Result<T, arboard::Error> {
    let mut i = 0;
    loop {
        match op() {
            Err(arboard::Error::ClipboardOccupied) if i < BACKOFF_MS.len() => {
                sleep(Duration::from_millis(BACKOFF_MS[i]));
                i += 1;
            }
            other => return other,
        }
    }
}

/// Executable name (no path: no private folder names in messages) of the process that has
/// the clipboard open right now, if any.
#[cfg(windows)]
fn clipboard_holder() -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::DataExchange::GetOpenClipboardWindow;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    // SAFETY: plain Win32 queries with valid out-pointers; the process handle is closed.
    unsafe {
        let hwnd = GetOpenClipboardWindow();
        if hwnd.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        if pid == std::process::id() {
            return Some("vho".into());
        }
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return Some(format!("pid {pid}"));
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        if ok == 0 {
            return Some(format!("pid {pid}"));
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        Some(full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string())
    }
}

#[cfg(not(windows))]
fn clipboard_holder() -> Option<String> {
    None
}

fn with<T>(mut f: impl FnMut(&mut Clipboard) -> Result<T, arboard::Error>) -> Result<T, String> {
    let mut guard = CLIP.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|e| format!("Pano açılamadı: {e}"))?);
    }
    let clip = guard.as_mut().expect("set above");
    match retry(|| f(clip), std::thread::sleep) {
        Ok(v) => Ok(v),
        Err(arboard::Error::ClipboardOccupied) => {
            let holder = clipboard_holder().unwrap_or_else(|| "?".into());
            eprintln!("[clipboard] still occupied after retries, held by {holder}");
            Err(format!("[clipboard-busy] Pano başka bir uygulama tarafından kullanılıyor ({holder})"))
        }
        Err(e) => Err(format!("Pano: {e}")),
    }
}

pub fn set_text(text: &str) -> Result<(), String> {
    with(|c| c.set_text(text.to_string()))
}

pub fn get_text() -> Result<String, String> {
    with(|c| c.get_text())
}

pub fn set_files(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Kopyalanacak dosya yok".into());
    }
    let list: Vec<std::path::PathBuf> = paths.iter().map(std::path::PathBuf::from).collect();
    with(|c| c.set().file_list(&list))
}

pub fn get_files() -> Result<Vec<String>, String> {
    with(|c| c.get().file_list()).map(|v| v.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Puts an image on the clipboard (RGBA). Returns its size.
pub fn set_image(img: image::DynamicImage) -> Result<[u32; 2], String> {
    let rgba = img.into_rgba8();
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    with(|c| c.set_image(ImageData { width: w as usize, height: h as usize, bytes: Cow::Borrowed(&raw) }))?;
    Ok([w, h])
}

pub fn image_size() -> Result<Option<[u32; 2]>, String> {
    match with(|c| c.get_image()) {
        Ok(img) => Ok(Some([img.width as u32, img.height as u32])),
        Err(e) if e.contains("not available") || e.contains("content") => Ok(None),
        Err(e) => Err(e),
    }
}

/// Standard base64 (with or without padding, whitespace ignored).
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        acc = (acc << 6) | val(c).ok_or("Geçersiz base64 verisi")?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_waits_out_a_busy_clipboard_with_backoff() {
        let mut calls = 0;
        let mut slept = vec![];
        let r = retry(
            || {
                calls += 1;
                if calls < 5 { Err(arboard::Error::ClipboardOccupied) } else { Ok(calls) }
            },
            |d| slept.push(d.as_millis() as u64),
        );
        assert_eq!(r.unwrap(), 5);
        assert_eq!(slept, vec![10, 20, 40, 80]);
    }

    #[test]
    fn retry_gives_up_after_the_budget_and_never_retries_other_errors() {
        let mut slept = 0u64;
        let r: Result<(), _> = retry(|| Err(arboard::Error::ClipboardOccupied), |d| slept += d.as_millis() as u64);
        assert!(matches!(r, Err(arboard::Error::ClipboardOccupied)));
        assert_eq!(slept, BACKOFF_MS.iter().sum::<u64>());
        assert!((2_500..=4_000).contains(&slept), "total wait {slept} ms");
        let mut calls = 0;
        let r: Result<(), _> = retry(|| { calls += 1; Err(arboard::Error::ContentNotAvailable) }, |_| panic!("no sleep"));
        assert!(matches!(r, Err(arboard::Error::ContentNotAvailable)));
        assert_eq!(calls, 1);
    }

    #[test]
    fn base64_roundtrip() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar", "çğü\u{0}\u{ff}"] {
            let enc = crate::engine::base64(s.as_bytes());
            assert_eq!(super::base64_decode(&enc).unwrap(), s.as_bytes());
        }
        assert!(super::base64_decode("ab$c").is_err());
    }
}
