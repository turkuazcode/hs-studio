//! HEIC/HEIF and AVIF decoding through the operating system's codecs (no codec code is
//! linked into VHO, so there is no HEVC patent/LGPL exposure):
//!
//! - **Windows**: WIC. HEIC needs the Microsoft Store "HEIF Image Extensions" plus
//!   "HEVC Video Extensions"; AVIF needs "AV1 Video Extension". The Microsoft "Raw Image
//!   Extension" also makes WIC a fallback for RAW files without an embedded preview.
//!   Availability is detected by enumerating WIC decoders; when a codec is missing the
//!   error starts with `[codec-missing]` and names the extension to install.
//!   The WIC HEIF decoder applies the HEIF rotation/mirror (irot/imir) itself, so EXIF
//!   orientation is not applied again for HEIC/AVIF. For RAW (WIC fallback) the
//!   `System.Photo.Orientation` value / EXIF orientation is applied by `decode`.
//! - **macOS**: ImageIO through the system `sips` tool (HEIC always, AVIF on macOS 13+).
//!   Output is not rotated; EXIF orientation is applied afterwards.
//! - **Linux**: libheif (LGPL) used only as a separate process (`heif-dec` /
//!   `heif-convert` from libheif-examples), i.e. dynamically, never linked. libheif
//!   applies the HEIF rotation itself.
//!
//! The macOS/Linux paths are compiled only on those targets and verified in CI.

#[cfg(any(not(windows), test))]
use std::path::Path;

#[cfg(not(windows))]
use image::DynamicImage;

#[cfg(any(not(windows), test))]
use super::decode::Format;
#[cfg(not(windows))]
use super::ERR_CODEC_MISSING;

pub const HEIC_HINT: &str = "HEIC için Microsoft Store'dan 'HEIF Görüntü Uzantıları' ve 'HEVC Video Uzantıları' gerekir.";
pub const AVIF_HINT: &str = "AVIF küçük resimleri için Microsoft Store'dan 'AV1 Video Uzantısı' gerekir.";

#[derive(Clone, Copy, Debug, Default)]
pub struct OsSupport {
    pub heic: bool,
    pub avif: bool,
    pub raw: bool,
}

#[cfg(windows)]
pub use wic::{decode, dimensions, os_support};
#[cfg(windows)]
pub const OS_CODEC: &str = "wic";
/// Verified by `photo_heic_wic_roundtrip_or_clear_error`: the WIC HEIF decoder returns
/// irot/imir-transformed pixels and reports System.Photo.Orientation = 1.
#[cfg(windows)]
pub const APPLIES_ORIENTATION: bool = true;

#[cfg(windows)]
mod wic {
    use super::{OsSupport, AVIF_HINT, HEIC_HINT};
    use crate::photo::decode::Format;
    use crate::photo::ERR_CODEC_MISSING;
    use image::DynamicImage;
    use std::path::Path;
    use std::sync::OnceLock;
    use windows::core::{w, Interface, HSTRING};
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Variant::VT_UI2;

    /// COM for the current (rayon/tokio blocking) thread.
    struct Com(bool);
    impl Com {
        fn init() -> Self {
            // S_FALSE (already initialised) also needs a matching CoUninitialize;
            // RPC_E_CHANGED_MODE means COM is usable but not ours to uninitialise.
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn factory() -> windows::core::Result<IWICImagingFactory> {
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
    }

    fn codec_error(format: Format, e: &windows::core::Error) -> String {
        let hint = match format {
            Format::Heif => HEIC_HINT,
            Format::Avif => AVIF_HINT,
            Format::Raw => "RAW için Microsoft Store'dan 'Raw Görüntü Uzantısı' gerekir.",
            _ => "Bu biçim için sistemde çözücü yok.",
        };
        format!("{ERR_CODEC_MISSING} {hint} (WIC: {:#010X} {})", e.code().0 as u32, e.message())
    }

    fn open(factory: &IWICImagingFactory, path: &Path, format: Format) -> Result<IWICBitmapFrameDecode, String> {
        unsafe {
            let decoder = factory
                .CreateDecoderFromFilename(
                    &HSTRING::from(path.as_os_str()),
                    None,
                    GENERIC_READ,
                    WICDecodeMetadataCacheOnDemand,
                )
                .map_err(|e| codec_error(format, &e))?;
            decoder.GetFrame(0).map_err(|e| codec_error(format, &e))
        }
    }

    fn orientation(frame: &IWICBitmapFrameDecode) -> Option<u16> {
        unsafe {
            let reader = frame.GetMetadataQueryReader().ok()?;
            let mut value = PROPVARIANT::default();
            reader.GetMetadataByName(w!("System.Photo.Orientation"), &mut value).ok()?;
            let inner = &value.Anonymous.Anonymous;
            // VT_UI2: no allocation inside, nothing to clear
            (inner.vt == VT_UI2).then_some(inner.Anonymous.uiVal).filter(|o| (1..=8).contains(o))
        }
    }

    /// Decodes the first frame to RGBA8, scaled by WIC so the longest side == target.
    pub fn decode(path: &Path, format: Format, target: Option<u32>) -> Result<(DynamicImage, Option<u16>), String> {
        let _com = Com::init();
        let factory = factory().map_err(|e| format!("WIC başlatılamadı: {e}"))?;
        let frame = open(&factory, path, format)?;
        unsafe {
            let (mut w, mut h) = (0u32, 0u32);
            frame.GetSize(&mut w, &mut h).map_err(|e| codec_error(format, &e))?;
            if w == 0 || h == 0 {
                return Err("Görüntü boyutu okunamadı".into());
            }
            let mut source: IWICBitmapSource = frame.cast().map_err(|e| e.to_string())?;
            let (mut ow, mut oh) = (w, h);
            if let Some(t) = target.filter(|&t| w.max(h) > t) {
                let r = t as f64 / w.max(h) as f64;
                ow = ((w as f64 * r).round() as u32).max(1);
                oh = ((h as f64 * r).round() as u32).max(1);
                let scaler = factory.CreateBitmapScaler().map_err(|e| e.to_string())?;
                scaler
                    .Initialize(&source, ow, oh, WICBitmapInterpolationModeFant)
                    .map_err(|e| codec_error(format, &e))?;
                source = scaler.cast().map_err(|e| e.to_string())?;
            }
            let conv = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
            conv.Initialize(
                &source,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeMedianCut,
            )
            .map_err(|e| codec_error(format, &e))?;
            let stride = ow as usize * 4;
            let mut buf = vec![0u8; stride * oh as usize];
            // Pixel decoding happens here: a missing HEVC/AV1 codec fails at this point
            conv.CopyPixels(std::ptr::null(), stride as u32, &mut buf)
                .map_err(|e| codec_error(format, &e))?;
            let img = image::RgbaImage::from_raw(ow, oh, buf).ok_or("WIC çıktı boyutu hatalı")?;
            let rgba = DynamicImage::ImageRgba8(img);
            // Drop the alpha channel when the source is opaque (smaller thumbnails, JPEG output)
            let img = if crate::photo::decode::has_alpha(&rgba) { rgba } else { DynamicImage::ImageRgb8(rgba.to_rgb8()) };
            Ok((img, orientation(&frame)))
        }
    }

    pub fn dimensions(path: &Path) -> Option<(u32, u32)> {
        let _com = Com::init();
        let factory = factory().ok()?;
        let frame = open(&factory, path, Format::Heif).ok()?;
        let (mut w, mut h) = (0u32, 0u32);
        unsafe { frame.GetSize(&mut w, &mut h).ok()? };
        Some((w, h))
    }

    /// File extensions of all installed WIC decoders, e.g. ".heic", ".avif", ".cr2".
    fn decoder_extensions() -> Vec<String> {
        let _com = Com::init();
        let Ok(factory) = factory() else { return vec![] };
        let mut out = Vec::new();
        unsafe {
            let Ok(list) = factory.CreateComponentEnumerator(WICDecoder.0 as u32, WICComponentEnumerateDefault.0 as u32)
            else {
                return out;
            };
            loop {
                let mut item = [None];
                let mut fetched = 0u32;
                if list.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }
                let Some(Ok(info)) = item[0].take().map(|u| u.cast::<IWICBitmapDecoderInfo>()) else { continue };
                // The size query may report "insufficient buffer" while still setting len
                let mut len = 0u32;
                let _ = info.GetFileExtensions(&mut [], &mut len);
                if len == 0 {
                    continue;
                }
                let mut buf = vec![0u16; len as usize];
                if info.GetFileExtensions(&mut buf, &mut len).is_ok() {
                    let s = String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]);
                    out.extend(s.split(',').map(|e| e.trim().to_ascii_lowercase()));
                }
            }
        }
        out
    }

    pub fn os_support() -> OsSupport {
        static CACHE: OnceLock<OsSupport> = OnceLock::new();
        *CACHE.get_or_init(|| {
            let exts = decoder_extensions();
            let has = |e: &str| exts.iter().any(|x| x == e);
            OsSupport { heic: has(".heic"), avif: has(".avif"), raw: has(".cr2") || has(".nef") || has(".dng") }
        })
    }
}

// --------------------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
pub const OS_CODEC: &str = "imageio";
#[cfg(target_os = "macos")]
pub const APPLIES_ORIENTATION: bool = false;

#[cfg(target_os = "macos")]
pub fn os_support() -> OsSupport {
    let sips = Path::new("/usr/bin/sips").exists();
    OsSupport { heic: sips, avif: sips, raw: sips }
}

/// ImageIO via `sips` (always present on macOS) → temporary PNG.
#[cfg(target_os = "macos")]
pub fn decode(path: &Path, format: Format, target: Option<u32>) -> Result<(DynamicImage, Option<u16>), String> {
    let tmp = temp_png();
    let mut cmd = std::process::Command::new("/usr/bin/sips");
    cmd.args(["-s", "format", "png"]);
    if let Some(t) = target {
        cmd.args(["-Z", &t.to_string()]);
    }
    cmd.arg(path).arg("--out").arg(&tmp);
    run_to_png(cmd, &tmp, format).map(|img| (img, None))
}

// --------------------------------------------------------------------------- Linux & others

#[cfg(all(not(windows), not(target_os = "macos")))]
pub const OS_CODEC: &str = "libheif";
#[cfg(all(not(windows), not(target_os = "macos")))]
pub const APPLIES_ORIENTATION: bool = true;

#[cfg(all(not(windows), not(target_os = "macos")))]
fn heif_tool() -> Option<&'static str> {
    use std::sync::OnceLock;
    static TOOL: OnceLock<Option<&'static str>> = OnceLock::new();
    *TOOL.get_or_init(|| {
        ["heif-dec", "heif-convert"].into_iter().find(|t| {
            std::process::Command::new(t)
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok()
        })
    })
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn os_support() -> OsSupport {
    let ok = heif_tool().is_some();
    OsSupport { heic: ok, avif: ok, raw: false }
}

/// libheif as a separate process (LGPL, never linked) → temporary PNG.
#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn decode(path: &Path, format: Format, _target: Option<u32>) -> Result<(DynamicImage, Option<u16>), String> {
    let Some(tool) = heif_tool().filter(|_| matches!(format, Format::Heif | Format::Avif)) else {
        return Err(format!(
            "{ERR_CODEC_MISSING} HEIC/AVIF için libheif araçları gerekir (ör. 'sudo apt install libheif-examples')."
        ));
    };
    let tmp = temp_png();
    let mut cmd = std::process::Command::new(tool);
    cmd.arg(path).arg(&tmp);
    run_to_png(cmd, &tmp, format).map(|img| (img, None))
}

#[cfg(not(windows))]
fn temp_png() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("vho-os-decode-{}-{}.png", std::process::id(), N.fetch_add(1, Ordering::Relaxed)))
}

#[cfg(not(windows))]
fn run_to_png(mut cmd: std::process::Command, tmp: &Path, format: Format) -> Result<DynamicImage, String> {
    let out = cmd.output().map_err(|e| format!("{ERR_CODEC_MISSING} Sistem çözücüsü çalıştırılamadı: {e}"))?;
    let result = if out.status.success() {
        image::open(tmp).map_err(|e| format!("Çözülen görüntü okunamadı: {e}"))
    } else {
        Err(format!(
            "{ERR_CODEC_MISSING} {} çözülemedi: {}",
            format.name(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    };
    let _ = std::fs::remove_file(tmp);
    result
}

#[cfg(not(windows))]
pub fn dimensions(_path: &Path) -> Option<(u32, u32)> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::photo::testutil::*;

    /// Encodes `img` with WIC's HEIF encoder (part of the HEIF Image Extensions),
    /// optionally tagging System.Photo.Orientation.
    fn wic_encode_heic(img: &image::RgbImage, path: &Path) -> Result<(), String> {
        wic_encode_heic_oriented(img, path, None)
    }

    fn wic_encode_heic_oriented(img: &image::RgbImage, path: &Path, orientation: Option<u16>) -> Result<(), String> {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::GENERIC_WRITE;
        use windows::Win32::Graphics::Imaging::*;
        use windows::Win32::System::Com::*;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let f: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
            let stream = f.CreateStream().map_err(|e| e.to_string())?;
            stream
                .InitializeFromFilename(&HSTRING::from(path.as_os_str()), GENERIC_WRITE.0)
                .map_err(|e| e.to_string())?;
            let enc = f.CreateEncoder(&GUID_ContainerFormatHeif, std::ptr::null()).map_err(|e| e.to_string())?;
            enc.Initialize(&stream, WICBitmapEncoderNoCache).map_err(|e| e.to_string())?;
            let mut frame = None;
            enc.CreateNewFrame(&mut frame, std::ptr::null_mut()).map_err(|e| e.to_string())?;
            let frame = frame.ok_or("no frame")?;
            frame.Initialize(None).map_err(|e| e.to_string())?;
            frame.SetSize(img.width(), img.height()).map_err(|e| e.to_string())?;
            if let Some(o) = orientation {
                use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
                let writer = frame.GetMetadataQueryWriter().map_err(|e| e.to_string())?;
                let mut pv = PROPVARIANT::default();
                (*pv.Anonymous.Anonymous).vt = windows::Win32::System::Variant::VT_UI2;
                (*pv.Anonymous.Anonymous).Anonymous.uiVal = o;
                writer
                    .SetMetadataByName(windows::core::w!("System.Photo.Orientation"), &pv)
                    .map_err(|e| format!("orientation metadata: {e}"))?;
            }
            let bgr: Vec<u8> = img.pixels().flat_map(|p| [p.0[2], p.0[1], p.0[0]]).collect();
            let bitmap = f
                .CreateBitmapFromMemory(img.width(), img.height(), &GUID_WICPixelFormat24bppBGR, img.width() * 3, &bgr)
                .map_err(|e| e.to_string())?;
            // WriteSource converts to whatever pixel format the encoder wants
            frame.WriteSource(&bitmap, std::ptr::null()).map_err(|e| e.to_string())?;
            frame.Commit().map_err(|e| e.to_string())?;
            enc.Commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    #[test]
    fn photo_heic_wic_roundtrip_or_clear_error() {
        let dir = temp_dir("heic");
        let p = dir.join("t.heic");
        let support = os_support();
        println!("WIC support: {support:?}");
        match wic_encode_heic(&pattern(256, 160), &p) {
            Ok(()) => {
                assert_eq!(crate::photo::decode::detect(&p), Format::Heif);
                match crate::photo::decode::decode(&p, None) {
                    Ok(d) => {
                        assert_eq!((d.image.width(), d.image.height()), (256, 160));
                        let rgb = d.image.to_rgb8();
                        assert_eq!(quadrant(*rgb.get_pixel(10, 10)), "red");
                        assert_eq!(quadrant(*rgb.get_pixel(250, 150)), "white");
                        let t = crate::photo::decode::decode(&p, Some(64)).unwrap();
                        assert_eq!(t.image.width(), 64);
                        assert_eq!(dimensions(&p), Some((256, 160)));
                        println!("HEIC roundtrip through WIC: ok");
                        // How does WIC treat a rotated HEIF? (decides APPLIES_ORIENTATION)
                        let po = dir.join("o6.heic");
                        match wic_encode_heic_oriented(&pattern(256, 160), &po, Some(6)) {
                            Ok(()) => {
                                let (raw_img, o) = decode(&po, Format::Heif, None).unwrap();
                                let exif_o = crate::photo::exif::read_path(&po).orientation();
                                println!(
                                    "WIC HEIF o6: pixels {}x{}, System.Photo.Orientation {o:?}, EXIF {exif_o:?}",
                                    raw_img.width(),
                                    raw_img.height()
                                );
                                assert_eq!((raw_img.width(), raw_img.height()), (160, 256), "WIC applies irot");
                                let shown = crate::photo::decode::decode(&po, None).unwrap().image;
                                assert_eq!((shown.width(), shown.height()), (160, 256), "displayed once-rotated");
                                assert_eq!(quadrant(*shown.to_rgb8().get_pixel(4, 4)), "blue");
                            }
                            Err(e) => println!("orientation write unsupported: {e}"),
                        }
                    }
                    Err(e) => assert!(e.starts_with(crate::photo::ERR_CODEC_MISSING), "{e}"),
                }
            }
            Err(e) => println!("HEIF encoder unavailable ({e}); decode error path only"),
        }
        // A file that claims to be HEIC but is garbage must give a tagged error
        let bad = dir.join("bad.heic");
        let mut junk = 24u32.to_be_bytes().to_vec();
        junk.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
        junk.extend_from_slice(&[0u8; 200]);
        std::fs::write(&bad, junk).unwrap();
        let e = crate::photo::decode::decode(&bad, None).err().unwrap();
        assert!(e.starts_with(crate::photo::ERR_CODEC_MISSING), "{e}");
    }

    #[test]
    fn photo_avif_encode_then_os_decode() {
        let dir = temp_dir("avif");
        let p = dir.join("t.avif");
        image::DynamicImage::ImageRgb8(pattern(128, 96)).save(&p).unwrap();
        assert_eq!(crate::photo::decode::detect(&p), Format::Avif);
        match crate::photo::decode::decode(&p, Some(64)) {
            Ok(d) => {
                assert_eq!(d.image.width(), 64);
                assert_eq!(quadrant(*d.image.to_rgb8().get_pixel(4, 4)), "red");
            }
            Err(e) => {
                assert!(!os_support().avif, "AV1 extension reported but decode failed: {e}");
                assert!(e.starts_with(crate::photo::ERR_CODEC_MISSING), "{e}");
            }
        }
    }
}
