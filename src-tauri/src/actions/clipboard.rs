//! Clipboard: text, file lists (Explorer/Finder paste; CF_HDROP on Windows) and images, through
//! `arboard` (MIT OR Apache-2.0). One clipboard handle lives for the whole run: on X11 the
//! content would otherwise vanish with the handle.

use std::borrow::Cow;
use std::sync::Mutex;

use arboard::{Clipboard, ImageData};

static CLIP: Mutex<Option<Clipboard>> = Mutex::new(None);

fn with<T>(mut f: impl FnMut(&mut Clipboard) -> Result<T, arboard::Error>) -> Result<T, String> {
    let mut guard = CLIP.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|e| format!("Pano açılamadı: {e}"))?);
    }
    // The clipboard may be busy (another app holds it open): retry briefly
    let mut last = None;
    for _ in 0..5 {
        match f(guard.as_mut().unwrap()) {
            Ok(v) => return Ok(v),
            Err(arboard::Error::ClipboardOccupied) => {
                last = Some(arboard::Error::ClipboardOccupied);
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            Err(e) => return Err(format!("Pano: {e}")),
        }
    }
    Err(format!("Pano: {}", last.map(|e| e.to_string()).unwrap_or_default()))
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
    #[test]
    fn base64_roundtrip() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar", "çğü\u{0}\u{ff}"] {
            let enc = crate::engine::base64(s.as_bytes());
            assert_eq!(super::base64_decode(&enc).unwrap(), s.as_bytes());
        }
        assert!(super::base64_decode("ab$c").is_err());
    }
}
