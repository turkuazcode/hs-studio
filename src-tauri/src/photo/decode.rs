//! Format detection and decoding to an upright (EXIF orientation applied) image.
//!
//! - JPEG/PNG/WebP/GIF/BMP/ICO/TIFF/TGA/PNM/QOI: `image` crate (pure Rust). JPEG
//!   thumbnails use `jpeg-decoder`'s DCT-domain downscaling (1/2, 1/4, 1/8), which
//!   makes 12 MP thumbnails several times faster than a full decode.
//! - HEIC/HEIF/AVIF: OS codecs (`heic` module). The webview shows AVIF itself.
//! - RAW: embedded JPEG preview (`raw` module), OS codec as fallback.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageDecoder, ImageReader};
use serde::Serialize;

use super::{err_unsupported, exif, ext_lower, heic, raw, ERR_CODEC_MISSING};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Webp,
    Gif,
    Bmp,
    Ico,
    Tiff,
    Tga,
    Pnm,
    Qoi,
    Heif,
    Avif,
    Raw,
    Svg,
    Unknown,
}

impl Format {
    pub fn name(self) -> &'static str {
        match self {
            Format::Jpeg => "jpeg",
            Format::Png => "png",
            Format::Webp => "webp",
            Format::Gif => "gif",
            Format::Bmp => "bmp",
            Format::Ico => "ico",
            Format::Tiff => "tiff",
            Format::Tga => "tga",
            Format::Pnm => "pnm",
            Format::Qoi => "qoi",
            Format::Heif => "heif",
            Format::Avif => "avif",
            Format::Raw => "raw",
            Format::Svg => "svg",
            Format::Unknown => "unknown",
        }
    }

    /// Formats WebView2/Chromium (and WebKit) render in an `<img>` directly.
    pub fn browser_native(self) -> bool {
        matches!(
            self,
            Format::Jpeg | Format::Png | Format::Webp | Format::Gif | Format::Bmp | Format::Ico | Format::Avif | Format::Svg
        )
    }

    fn image_format(self) -> Option<image::ImageFormat> {
        use image::ImageFormat as F;
        Some(match self {
            Format::Jpeg => F::Jpeg,
            Format::Png => F::Png,
            Format::Webp => F::WebP,
            Format::Gif => F::Gif,
            Format::Bmp => F::Bmp,
            Format::Ico => F::Ico,
            Format::Tiff => F::Tiff,
            Format::Tga => F::Tga,
            Format::Pnm => F::Pnm,
            Format::Qoi => F::Qoi,
            _ => return None,
        })
    }
}

/// Still-image extensions the scanner lists (RAW extensions are added from `raw`).
pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "apng", "webp", "gif", "bmp", "dib", "ico", "tif", "tiff", "tga", "pbm",
    "pgm", "ppm", "pnm", "pam", "qoi", "heic", "heif", "hif", "avif", "svg",
];

pub const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "flv", "3gp", "3g2", "mpg", "mpeg", "ts", "m2ts", "mts",
    "vob", "ogv", "divx",
];

fn from_ext(ext: &str) -> Format {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" => Format::Jpeg,
        "png" | "apng" => Format::Png,
        "webp" => Format::Webp,
        "gif" => Format::Gif,
        "bmp" | "dib" => Format::Bmp,
        "ico" => Format::Ico,
        "tif" | "tiff" => Format::Tiff,
        "tga" => Format::Tga,
        "pbm" | "pgm" | "ppm" | "pnm" | "pam" => Format::Pnm,
        "qoi" => Format::Qoi,
        "heic" | "heif" | "hif" => Format::Heif,
        "avif" => Format::Avif,
        "svg" => Format::Svg,
        e if raw::is_raw_ext(e) => Format::Raw,
        _ => Format::Unknown,
    }
}

/// ISO-BMFF brand check: HEIF vs AVIF (mif1 files list their real brand later).
fn bmff_format(head: &[u8]) -> Option<Format> {
    if head.len() < 12 || &head[4..8] != b"ftyp" {
        return None;
    }
    let box_len = (u32::from_be_bytes(head[0..4].try_into().ok()?) as usize).clamp(12, head.len());
    let brands: Vec<&[u8]> = std::iter::once(&head[8..12])
        .chain(head.get(16..box_len).unwrap_or(&[]).chunks_exact(4))
        .collect();
    if brands.iter().any(|b| *b == b"crx ") {
        return Some(Format::Raw);
    }
    if brands.iter().any(|b| *b == b"avif" || *b == b"avis") {
        return Some(Format::Avif);
    }
    if brands.iter().any(|b| matches!(*b, b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1")) {
        return Some(Format::Heif);
    }
    None
}

/// Detects the format from the file's magic bytes (falls back to the extension).
pub fn detect(path: &Path) -> Format {
    let ext = ext_lower(path);
    let by_ext = from_ext(&ext);
    let mut head = [0u8; 64];
    let n = std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read(&mut f, &mut head))
        .unwrap_or(0);
    detect_bytes(&head[..n], by_ext)
}

pub fn detect_bytes(head: &[u8], by_ext: Format) -> Format {
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Format::Jpeg;
    }
    if head.starts_with(b"\x89PNG") {
        return Format::Png;
    }
    if head.starts_with(b"GIF8") {
        return Format::Gif;
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Format::Webp;
    }
    if head.starts_with(b"qoif") {
        return Format::Qoi;
    }
    if head.starts_with(b"FUJIFILMCCD-RAW") {
        return Format::Raw;
    }
    if let Some(f) = bmff_format(head) {
        return f;
    }
    if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        // DNG/CR2/NEF/ARW... are TIFF files too
        return if by_ext == Format::Raw { Format::Raw } else { Format::Tiff };
    }
    if head.starts_with(b"BM") && by_ext != Format::Raw {
        return Format::Bmp;
    }
    by_ext
}

/// Does the OS decoder already apply the HEIF rotation (so EXIF orientation must not be
/// applied again)?
pub fn os_applies_orientation(format: Format) -> bool {
    matches!(format, Format::Heif | Format::Avif) && heic::APPLIES_ORIENTATION
}

pub struct Decoded {
    pub image: DynamicImage,
    /// "native" (pure Rust decoder), "os" (WIC/ImageIO/libheif), "rawPreview"
    pub source: &'static str,
    /// ICC profile of the source, if any (kept when converting to JPEG/PNG)
    pub icc: Option<Vec<u8>>,
}

fn orient(img: DynamicImage, orientation: Option<u16>) -> DynamicImage {
    let mut img = img;
    if let Some(o) = orientation.and_then(|o| image::metadata::Orientation::from_exif(o as u8)) {
        img.apply_orientation(o);
    }
    img
}

/// Size request for a downscaled JPEG decode: the decoder picks the smallest DCT scale
/// whose output still covers both values.
fn scaled_request(w: u16, h: u16, target: u32) -> (u16, u16) {
    let long = w.max(h) as f64;
    if long <= target as f64 {
        return (w, h);
    }
    let r = target as f64 / long;
    (((w as f64 * r).ceil() as u16).max(1), ((h as f64 * r).ceil() as u16).max(1))
}

/// Decodes a JPEG at reduced size (longest side >= target) with jpeg-decoder.
pub fn jpeg_scaled(bytes: &[u8], target: u32) -> Result<DynamicImage, String> {
    let mut d = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    d.read_info().map_err(|e| format!("JPEG okunamadı: {e}"))?;
    let info = d.info().ok_or("JPEG başlığı okunamadı")?;
    let (rw, rh) = scaled_request(info.width, info.height, target);
    let (w, h) = d.scale(rw, rh).map_err(|e| format!("JPEG ölçeklenemedi: {e}"))?;
    let pixels = d.decode().map_err(|e| format!("JPEG çözülemedi: {e}"))?;
    let (w, h) = (w as u32, h as u32);
    let bad = || "JPEG çıktı boyutu beklenmedik".to_string();
    Ok(match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, pixels).ok_or_else(bad)?),
        jpeg_decoder::PixelFormat::L8 => DynamicImage::ImageLuma8(image::GrayImage::from_raw(w, h, pixels).ok_or_else(bad)?),
        jpeg_decoder::PixelFormat::L16 => {
            let v: Vec<u16> = pixels.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            DynamicImage::ImageLuma16(image::ImageBuffer::from_raw(w, h, v).ok_or_else(bad)?)
        }
        jpeg_decoder::PixelFormat::CMYK32 => {
            // jpeg-decoder outputs CMYK as stored; Adobe CMYK JPEGs are inverted
            let rgb: Vec<u8> = pixels
                .chunks_exact(4)
                .flat_map(|p| {
                    let k = p[3] as u32;
                    [(p[0] as u32 * k / 255) as u8, (p[1] as u32 * k / 255) as u8, (p[2] as u32 * k / 255) as u8]
                })
                .collect();
            DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, rgb).ok_or_else(bad)?)
        }
    })
}

fn decode_with_image(reader: ImageReader<impl std::io::BufRead + std::io::Seek>) -> Result<(DynamicImage, Option<Vec<u8>>), String> {
    let mut reader = reader;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(4 << 30); // large panoramas
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|e| err_unsupported(format!("Görüntü açılamadı: {e}")))?;
    let icc = decoder.icc_profile().ok().flatten();
    let img = DynamicImage::from_decoder(decoder).map_err(|e| format!("Görüntü çözülemedi: {e}"))?;
    Ok((img, icc))
}

fn decode_jpeg_bytes(bytes: &[u8], target: Option<u32>) -> Result<(DynamicImage, Option<Vec<u8>>), String> {
    match target {
        Some(t) => jpeg_scaled(bytes, t).map(|i| (i, None)),
        None => decode_with_image(ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Jpeg)),
    }
}

/// Decodes `path` to an upright image. `target` = Some(n) allows a smaller result whose
/// longest side is still >= n (thumbnail fast paths); None = full resolution.
pub fn decode(path: &Path, target: Option<u32>) -> Result<Decoded, String> {
    let format = detect(path);
    match format {
        Format::Jpeg => {
            let bytes = std::fs::read(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
            let orientation = exif::read_bytes(&bytes).and_then(|e| exif::ExifSet(vec![e]).orientation());
            let (img, icc) = decode_jpeg_bytes(&bytes, target)?;
            Ok(Decoded { image: orient(img, orientation), source: "native", icc })
        }
        Format::Raw => {
            let bytes = std::fs::read(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
            if let Some(preview) = raw::best_preview(&bytes, target) {
                // The RAW's own orientation wins; some previews carry their own EXIF
                let orientation = exif::read_path(path)
                    .orientation()
                    .or_else(|| exif::read_bytes(preview).and_then(|e| exif::ExifSet(vec![e]).orientation()));
                let (img, icc) = decode_jpeg_bytes(preview, target)?;
                return Ok(Decoded { image: orient(img, orientation), source: "rawPreview", icc });
            }
            drop(bytes);
            decode_os(path, format, target).map_err(|e| {
                format!("{ERR_CODEC_MISSING} RAW dosyasında önizleme yok ve sistem RAW çözücüsü kullanılamadı ({e})")
            })
        }
        Format::Heif | Format::Avif => decode_os(path, format, target),
        Format::Svg => Err(err_unsupported("SVG küçük resmi arayüzde doğrudan gösterilir")),
        _ => {
            let reader = ImageReader::open(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
            let reader = match format.image_format() {
                Some(f) => {
                    let mut r = reader;
                    r.set_format(f);
                    r
                }
                None => reader.with_guessed_format().map_err(|e| e.to_string())?,
            };
            match decode_with_image(reader) {
                Ok((img, icc)) => {
                    let orientation = exif::read_path(path).orientation();
                    Ok(Decoded { image: orient(img, orientation), source: "native", icc })
                }
                // Unknown to the image crate: maybe the OS can (JPEG XR, DDS...)
                Err(e) if format == Format::Unknown => decode_os(path, format, target).map_err(|_| e),
                Err(e) => Err(e),
            }
        }
    }
}

fn decode_os(path: &Path, format: Format, target: Option<u32>) -> Result<Decoded, String> {
    let (img, os_orientation) = heic::decode(path, format, target)?;
    let orientation = if os_applies_orientation(format) {
        None
    } else {
        os_orientation.or_else(|| exif::read_path(path).orientation())
    };
    Ok(Decoded { image: orient(img, orientation), source: "os", icc: None })
}

/// Stored (not orientation-corrected) pixel size from the file header.
pub fn dimensions(path: &Path, format: Format) -> Option<(u32, u32)> {
    match format {
        Format::Raw => {
            let bytes = std::fs::read(path).ok()?;
            raw::find_previews(&bytes).first().map(|p| (p.width, p.height))
        }
        Format::Heif | Format::Avif => heic::dimensions(path),
        Format::Svg | Format::Unknown => None,
        f => {
            let mut r = ImageReader::open(path).ok()?;
            r.set_format(f.image_format()?);
            r.into_dimensions().ok()
        }
    }
}

// ---------------------------------------------------------------------------
// Display copies for formats the webview cannot show
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DisplayResult {
    /// File to show (original for browser-native formats, otherwise a cached JPEG/PNG)
    pub path: String,
    pub converted: bool,
    /// Display size of `path` (0 when unknown, e.g. SVG)
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// "original" | "native" | "os" | "rawPreview" | "cache"
    pub source: String,
}

pub(crate) fn has_alpha(img: &DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    match img {
        DynamicImage::ImageRgba8(b) => b.pixels().any(|p| p.0[3] < 255),
        DynamicImage::ImageLumaA8(b) => b.pixels().any(|p| p.0[1] < 255),
        other => other.to_rgba8().pixels().any(|p| p.0[3] < 255),
    }
}

/// Encodes an RGB(A) image as JPEG (opaque) or PNG (transparent); returns bytes + ext.
pub(crate) fn encode_display(img: &DynamicImage, quality: u8, icc: Option<&[u8]>) -> Result<(Vec<u8>, &'static str), String> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    if has_alpha(img) {
        let rgba = img.to_rgba8();
        let mut enc = image::codecs::png::PngEncoder::new_with_quality(
            &mut out,
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Adaptive,
        );
        if let Some(p) = icc {
            let _ = enc.set_icc_profile(p.to_vec());
        }
        enc.write_image(&rgba, rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
        Ok((out, "png"))
    } else {
        let rgb = img.to_rgb8();
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
        if let Some(p) = icc {
            let _ = enc.set_icc_profile(p.to_vec());
        }
        enc.write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        Ok((out, "jpg"))
    }
}

/// Reads the pixel size of a cached JPEG/PNG from its first bytes.
pub(crate) fn cached_dims(path: &Path) -> Option<(u32, u32)> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).ok()?;
    let d = &buf[..n];
    if d.starts_with(b"\x89PNG") && n >= 24 {
        return Some((u32::from_be_bytes(d[16..20].try_into().ok()?), u32::from_be_bytes(d[20..24].try_into().ok()?)));
    }
    // JPEG: walk segments to the SOF
    let mut pos = 2;
    while pos + 9 < n {
        if d[pos] != 0xFF {
            return None;
        }
        let m = d[pos + 1];
        let len = u16::from_be_bytes([d[pos + 2], d[pos + 3]]) as usize;
        if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
            let h = u16::from_be_bytes([d[pos + 5], d[pos + 6]]) as u32;
            let w = u16::from_be_bytes([d[pos + 7], d[pos + 8]]) as u32;
            return Some((w, h));
        }
        pos += 2 + len;
    }
    None
}

pub(crate) fn resize_to_fit(img: DynamicImage, max_side: u32) -> Result<DynamicImage, String> {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_side {
        return Ok(img);
    }
    let r = max_side as f64 / w.max(h) as f64;
    let (nw, nh) = (((w as f64 * r).round() as u32).max(1), ((h as f64 * r).round() as u32).max(1));
    resize_exact(img, nw, nh)
}

/// High quality resize (fast_image_resize, Lanczos3, SIMD). Works on 8-bit RGB/RGBA/L.
pub(crate) fn resize_exact(img: DynamicImage, nw: u32, nh: u32) -> Result<DynamicImage, String> {
    use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
    if (img.width(), img.height()) == (nw, nh) {
        return Ok(img);
    }
    let src = match img {
        DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) | DynamicImage::ImageLuma8(_) => img,
        other if other.color().has_alpha() => DynamicImage::ImageRgba8(other.to_rgba8()),
        other => DynamicImage::ImageRgb8(other.to_rgb8()),
    };
    let mut dst = DynamicImage::new(nw, nh, src.color());
    Resizer::new()
        .resize(&src, &mut dst, &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)))
        .map_err(|e| format!("Yeniden boyutlandırılamadı: {e}"))?;
    Ok(dst)
}

/// Makes `src` viewable by the webview (see `photo_decode`).
pub fn display_copy(cache_dir: &Path, src: &Path, max_size: Option<u32>) -> Result<DisplayResult, String> {
    let meta = std::fs::metadata(src).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    let format = detect(src);
    if format.browser_native() {
        let o = exif::read_path(src).orientation().unwrap_or(1);
        let (w, h) = dimensions(src, format).unwrap_or((0, 0));
        // <img> applies EXIF orientation itself (CSS image-orientation: from-image)
        let (w, h) = if o >= 5 && !os_applies_orientation(format) { (h, w) } else { (w, h) };
        return Ok(DisplayResult {
            path: src.to_string_lossy().into_owned(),
            converted: false,
            width: w,
            height: h,
            format: format.name().into(),
            source: "original".into(),
        });
    }
    let max = max_size.filter(|&m| m > 0);
    let key = super::fnv1a(
        format!("{}|{}|{}|{}", src.to_string_lossy(), meta.len(), super::mtime_ms(&meta), max.unwrap_or(0)).as_bytes(),
    );
    let base: PathBuf = cache_dir.join(format!("{key:016x}"));
    for ext in ["jpg", "png"] {
        let p = base.with_extension(ext);
        if let Some((w, h)) = cached_dims(&p) {
            return Ok(DisplayResult {
                path: p.to_string_lossy().into_owned(),
                converted: true,
                width: w,
                height: h,
                format: format.name().into(),
                source: "cache".into(),
            });
        }
    }
    let decoded = decode(src, None)?;
    let source = decoded.source;
    let img = match max {
        Some(m) => resize_to_fit(decoded.image, m)?,
        None => decoded.image,
    };
    let (bytes, ext) = encode_display(&img, 92, decoded.icc.as_deref())?;
    let out = base.with_extension(ext);
    super::write_atomic(&out, &bytes)?;
    Ok(DisplayResult {
        path: out.to_string_lossy().into_owned(),
        converted: true,
        width: img.width(),
        height: img.height(),
        format: format.name().into(),
        source: source.into(),
    })
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// HEIC/HEIF decoding through the OS is available
    pub heic: bool,
    /// AVIF decoding in the backend (thumbnails); the webview shows AVIF regardless
    pub avif_decode: bool,
    pub avif_encode: bool,
    pub webp_lossy: bool,
    /// Embedded RAW previews (always)
    pub raw_preview: bool,
    /// Full RAW decoding through an OS codec (Windows Raw Image Extension / macOS)
    pub raw_os: bool,
    /// "wic" | "imageio" | "libheif" | "none"
    pub os_codec: &'static str,
    /// Extensions the scanner lists as images
    pub image_extensions: Vec<&'static str>,
    pub video_extensions: Vec<&'static str>,
    /// Output formats for photo_batch
    pub write_formats: Vec<&'static str>,
    /// Human readable hint when something is missing (Turkish), e.g. which Store extension to install
    pub hint: Option<String>,
}

pub fn capabilities() -> Capabilities {
    let os = heic::os_support();
    let mut hints = Vec::new();
    if !os.heic {
        hints.push(heic::HEIC_HINT);
    }
    let avif = heic::avif_works();
    if !os.avif {
        hints.push(heic::AVIF_HINT);
    } else if !avif {
        hints.push(heic::AVIF_FAILED_HINT);
    }
    Capabilities {
        heic: os.heic,
        avif_decode: avif,
        avif_encode: true,
        webp_lossy: true,
        raw_preview: true,
        raw_os: os.raw,
        os_codec: heic::OS_CODEC,
        image_extensions: IMAGE_EXTS.iter().chain(raw::RAW_EXTS).copied().collect(),
        video_extensions: VIDEO_EXTS.to_vec(),
        write_formats: vec!["jpeg", "png", "webp", "avif"],
        hint: (!hints.is_empty()).then(|| hints.join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photo::exif::tests::write_exif_jpeg;
    use crate::photo::testutil::*;

    fn save(img: &image::RgbImage, path: &Path) {
        img.save(path).unwrap();
    }

    #[test]
    fn photo_decode_all_native_formats() {
        let dir = temp_dir("formats");
        let img = pattern(120, 80);
        let rgba = DynamicImage::ImageRgb8(img.clone()).to_rgba8();
        let files = [
            ("a.jpg", Format::Jpeg),
            ("a.png", Format::Png),
            ("a.gif", Format::Gif),
            ("a.bmp", Format::Bmp),
            ("a.tiff", Format::Tiff),
            ("a.webp", Format::Webp),
            ("a.tga", Format::Tga),
            ("a.qoi", Format::Qoi),
        ];
        for (name, fmt) in files {
            let p = dir.join(name);
            match fmt {
                Format::Webp | Format::Gif => rgba.save(&p).unwrap(),
                _ => save(&img, &p),
            }
            assert_eq!(detect(&p), fmt, "{name}");
            let d = decode(&p, None).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!((d.image.width(), d.image.height()), (120, 80), "{name}");
            let rgb = d.image.to_rgb8();
            assert_eq!(quadrant(*rgb.get_pixel(10, 10)), "red", "{name}");
            assert_eq!(quadrant(*rgb.get_pixel(110, 70)), "white", "{name}");
            assert_eq!(dimensions(&p, fmt), Some((120, 80)), "{name}");
        }
        // Misnamed file: content wins over the extension
        let p = dir.join("really_png.jpg");
        std::fs::copy(dir.join("a.png"), &p).unwrap();
        assert_eq!(detect(&p), Format::Png);
        assert!(decode(&p, None).is_ok());
    }

    #[test]
    fn photo_decode_applies_orientation() {
        let dir = temp_dir("orient");
        let p = dir.join("o6.jpg");
        write_exif_jpeg(&p, 64, 48, 6); // stored 64x48, displayed rotated 90° CW
        for target in [None, Some(32)] {
            let d = decode(&p, target).unwrap();
            let rgb = d.image.to_rgb8();
            let (w, h) = rgb.dimensions();
            assert!(h > w, "rotated: {w}x{h}");
            // After a 90° CW rotation the stored bottom-left (blue) is the display top-left
            assert_eq!(quadrant(*rgb.get_pixel(2, 2)), "blue");
            assert_eq!(quadrant(*rgb.get_pixel(w - 3, 2)), "red");
        }
    }

    #[test]
    fn photo_decode_jpeg_scaled_is_small() {
        let jpg = jpeg_bytes(&pattern(2000, 1500), 85);
        let img = jpeg_scaled(&jpg, 256).unwrap();
        // 1/4 scale (500x375) is the smallest that still covers 256 px
        assert_eq!((img.width(), img.height()), (500, 375));
        let img = jpeg_scaled(&jpg, 4000).unwrap();
        assert_eq!((img.width(), img.height()), (2000, 1500));
    }

    #[test]
    fn photo_decode_raw_preview_and_display_copy() {
        let dir = temp_dir("rawdisp");
        let big = jpeg_bytes(&pattern(640, 480), 85);
        let small = jpeg_bytes(&pattern(160, 120), 85);
        let p = dir.join("shot.nef");
        std::fs::write(&p, crate::photo::raw::tests::fake_raw(&big, &small, 8)).unwrap();
        assert_eq!(detect(&p), Format::Raw);
        let d = decode(&p, None).unwrap();
        assert_eq!(d.source, "rawPreview");
        // Orientation 8 (rotate 270 CW) from the RAW's IFD0
        assert_eq!((d.image.width(), d.image.height()), (480, 640));
        let cache = dir.join("cache");
        let r = display_copy(&cache, &p, None).unwrap();
        assert!(r.converted && r.source == "rawPreview" && r.path.ends_with(".jpg"));
        assert_eq!((r.width, r.height), (480, 640));
        let again = display_copy(&cache, &p, None).unwrap();
        assert_eq!((again.source.as_str(), again.path.as_str(), again.width), ("cache", r.path.as_str(), 480));
        // Browser-native files are passed through
        let j = dir.join("x.jpg");
        write_exif_jpeg(&j, 64, 48, 6);
        let r = display_copy(&cache, &j, None).unwrap();
        assert!(!r.converted);
        assert_eq!((r.width, r.height), (48, 64));
    }

    #[test]
    fn photo_decode_bmff_brands() {
        let mut h = Vec::new();
        h.extend_from_slice(&24u32.to_be_bytes());
        h.extend_from_slice(b"ftypmif1\0\0\0\0mif1avif");
        assert_eq!(detect_bytes(&h, Format::Unknown), Format::Avif);
        let mut h = Vec::new();
        h.extend_from_slice(&24u32.to_be_bytes());
        h.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
        assert_eq!(detect_bytes(&h, Format::Unknown), Format::Heif);
    }

    #[test]
    fn photo_decode_unsupported_is_tagged() {
        let dir = temp_dir("unsup");
        let p = dir.join("x.png");
        std::fs::write(&p, b"definitely not an image").unwrap();
        let e = decode(&p, None).err().unwrap();
        assert!(e.starts_with("[unsupported]") || e.contains("çözülemedi"), "{e}");
    }
}
