//! Edit / convert operations and batch jobs.
//!
//! Lossless paths (no re-encode):
//! - JPEG rotate/flip: only the EXIF Orientation tag is rewritten (all viewers incl.
//!   the webview honour it). Pixels and quality stay bit-identical.
//! - JPEG metadata strip / GPS strip: segments are removed/edited, pixels untouched.
//! - Rename/copy with unchanged format and metadata: byte copy.
//!
//! Everything else decodes to an upright image, applies the ops in order (in display
//! coordinates), and re-encodes (JPEG/PNG/WebP/AVIF/TIFF/BMP/GIF/TGA/QOI) with EXIF
//! carried over according to `MetadataPolicy` (orientation reset to 1).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use image::{DynamicImage, ImageEncoder};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::decode::{self, Format};
use super::exif::{self, MetadataPolicy, TiffBlob};
use super::{ext_lower, ERR_CANCELLED};

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    Horizontal,
    Vertical,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    /// Clockwise, multiples of 90 (negative = counter-clockwise)
    Rotate { degrees: i32 },
    /// Mirror: horizontal = left/right, vertical = top/bottom
    Flip { axis: Axis },
    /// Rectangle in display pixels of the image as it is at this step (clamped)
    Crop { x: u32, y: u32, width: u32, height: u32 },
    /// `longEdge` | `percent` | `width`/`height` (fit inside, keeps aspect unless `exact`)
    Resize {
        #[serde(default)]
        width: Option<u32>,
        #[serde(default)]
        height: Option<u32>,
        #[serde(default)]
        long_edge: Option<u32>,
        #[serde(default)]
        percent: Option<f64>,
        #[serde(default)]
        exact: bool,
        #[serde(default)]
        upscale: bool,
    },
    /// Colour adjustments, each -100..100 (0 = unchanged). Applied in the order
    /// temperature, brightness, contrast, saturation; the photo editor's canvas preview
    /// (src/studio/logic.js `adjustPixels`) uses the same formulas.
    Adjust {
        #[serde(default)]
        brightness: f32,
        #[serde(default)]
        contrast: f32,
        #[serde(default)]
        saturation: f32,
        #[serde(default)]
        temperature: f32,
    },
    /// 3x3 Laplacian sharpening, `amount` 0..100 (100 = classic 5/-1 kernel)
    Sharpen { amount: f32 },
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutFormat {
    /// Keep the source format (HEIC/RAW/unknown sources become JPEG)
    #[default]
    Same,
    Jpeg,
    Png,
    Webp,
    Avif,
    Tiff,
    Bmp,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Conflict {
    /// Add " (1)", " (2)"... (also when the output would replace the source)
    #[default]
    Rename,
    Overwrite,
    Skip,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct OutputOptions {
    pub format: OutFormat,
    /// 1-100 (JPEG/WebP/AVIF). WebP 100 = lossless.
    pub quality: u8,
    /// Output folder; default = the source file's folder
    pub dir: Option<String>,
    /// File name without extension. Tokens: {name} {ext} {counter} {counter:3} {date}
    pub name_template: String,
    pub counter_start: u32,
    pub conflict: Conflict,
    pub metadata: MetadataPolicy,
    /// Allow the lossless JPEG paths (EXIF orientation rotate, segment strip, byte copy)
    pub lossless: bool,
    /// Delete the source after a successful write to a different path (= move/rename)
    pub remove_source: bool,
}

impl Default for OutputOptions {
    fn default() -> Self {
        OutputOptions {
            format: OutFormat::Same,
            quality: 90,
            dir: None,
            name_template: "{name}".into(),
            counter_start: 1,
            conflict: Conflict::Rename,
            metadata: MetadataPolicy::Keep,
            lossless: true,
            remove_source: false,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BatchJob {
    /// Id for events and `photo_cancel`; generated when omitted
    pub job_id: Option<String>,
    pub files: Vec<String>,
    pub ops: Vec<Op>,
    pub output: OutputOptions,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileOutcome {
    pub index: usize,
    pub input: String,
    pub output: Option<String>,
    pub ok: bool,
    /// Skipped because the output existed (`conflict: "skip"`)
    pub skipped: bool,
    pub error: Option<String>,
    /// Written without re-encoding pixels
    pub lossless: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchSummary {
    pub job_id: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    pub cancelled: bool,
    pub elapsed_ms: u64,
    pub results: Vec<FileOutcome>,
}

// ---------------------------------------------------------------------------
// Orientation algebra (dihedral group D4 as 2x2 matrices in screen coordinates)
// ---------------------------------------------------------------------------

type M = [[i8; 2]; 2];
/// Index = EXIF orientation; matrix = transform from stored to displayed image.
const ORIENT: [M; 9] = [
    [[1, 0], [0, 1]],   // (unused)
    [[1, 0], [0, 1]],   // 1 identity
    [[-1, 0], [0, 1]],  // 2 flip horizontal
    [[-1, 0], [0, -1]], // 3 rotate 180
    [[1, 0], [0, -1]],  // 4 flip vertical
    [[0, 1], [1, 0]],   // 5 transpose
    [[0, -1], [1, 0]],  // 6 rotate 90 CW
    [[0, -1], [-1, 0]], // 7 transverse
    [[0, 1], [-1, 0]],  // 8 rotate 270 CW
];

fn mul(a: M, b: M) -> M {
    let mut r = [[0i8; 2]; 2];
    for i in 0..2 {
        for j in 0..2 {
            r[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j];
        }
    }
    r
}

fn rotation_steps(degrees: i32) -> Result<u32, String> {
    if degrees % 90 != 0 {
        return Err("Yalnızca 90° katlarında döndürme desteklenir".into());
    }
    Ok((degrees.rem_euclid(360) / 90) as u32)
}

fn op_matrix(op: &Op) -> Result<Option<M>, String> {
    Ok(match op {
        Op::Rotate { degrees } => Some(match rotation_steps(*degrees)? {
            0 => ORIENT[1],
            1 => ORIENT[6],
            2 => ORIENT[3],
            _ => ORIENT[8],
        }),
        Op::Flip { axis: Axis::Horizontal } => Some(ORIENT[2]),
        Op::Flip { axis: Axis::Vertical } => Some(ORIENT[4]),
        _ => None,
    })
}

/// New EXIF orientation after applying rotate/flip `ops` (in order) to an image that is
/// displayed with `current` orientation. None if `ops` contain non-orientation ops.
pub fn compose_orientation(current: u16, ops: &[Op]) -> Result<Option<u16>, String> {
    let mut m = ORIENT[current.clamp(1, 8) as usize];
    for op in ops {
        match op_matrix(op)? {
            Some(u) => m = mul(u, m),
            None => return Ok(None),
        }
    }
    Ok(ORIENT.iter().skip(1).position(|o| *o == m).map(|i| i as u16 + 1))
}

// ---------------------------------------------------------------------------
// Pixel operations
// ---------------------------------------------------------------------------

pub fn apply_op(img: DynamicImage, op: &Op) -> Result<DynamicImage, String> {
    Ok(match op {
        Op::Rotate { degrees } => match rotation_steps(*degrees)? {
            0 => img,
            1 => img.rotate90(),
            2 => img.rotate180(),
            _ => img.rotate270(),
        },
        Op::Flip { axis: Axis::Horizontal } => img.fliph(),
        Op::Flip { axis: Axis::Vertical } => img.flipv(),
        Op::Crop { x, y, width, height } => {
            let (w, h) = (img.width(), img.height());
            let x = (*x).min(w.saturating_sub(1));
            let y = (*y).min(h.saturating_sub(1));
            let cw = (*width).min(w - x);
            let ch = (*height).min(h - y);
            if cw == 0 || ch == 0 {
                return Err("Kırpma alanı boş".into());
            }
            img.crop_imm(x, y, cw, ch)
        }
        Op::Resize { width, height, long_edge, percent, exact, upscale } => {
            let (w, h) = (img.width() as f64, img.height() as f64);
            let (nw, nh) = if let Some(p) = percent.filter(|p| *p > 0.0) {
                (w * p / 100.0, h * p / 100.0)
            } else if let Some(l) = long_edge.filter(|l| *l > 0) {
                let r = l as f64 / w.max(h);
                (w * r, h * r)
            } else {
                match (width.filter(|v| *v > 0), height.filter(|v| *v > 0)) {
                    (Some(tw), Some(th)) if *exact => (tw as f64, th as f64),
                    (Some(tw), Some(th)) => {
                        let r = (tw as f64 / w).min(th as f64 / h);
                        (w * r, h * r)
                    }
                    (Some(tw), None) => (tw as f64, h * tw as f64 / w),
                    (None, Some(th)) => (w * th as f64 / h, th as f64),
                    (None, None) => return Err("Boyutlandırma için hedef boyut yok".into()),
                }
            };
            let (nw, nh) = ((nw.round() as u32).max(1), (nh.round() as u32).max(1));
            if !upscale && (nw as f64 > w || nh as f64 > h) {
                img
            } else {
                decode::resize_exact(img, nw, nh)?
            }
        }
        Op::Adjust { brightness, contrast, saturation, temperature } => {
            let a = Adjustments::new(*brightness, *contrast, *saturation, *temperature);
            if a.is_identity() {
                img
            } else {
                map_pixels(img, |px| a.apply(px))
            }
        }
        Op::Sharpen { amount } => {
            let k = amount.clamp(0.0, 100.0) / 100.0;
            if k <= 0.0 { img } else { sharpen(img, k) }
        }
    })
}

/// Normalised colour adjustment factors (see `Op::Adjust`).
#[derive(Clone, Copy, Debug)]
pub struct Adjustments {
    warm: f32,
    bright: f32,
    contrast: f32,
    sat: f32,
}

impl Adjustments {
    pub fn new(brightness: f32, contrast: f32, saturation: f32, temperature: f32) -> Self {
        let n = |v: f32| v.clamp(-100.0, 100.0) / 100.0;
        Adjustments { warm: n(temperature) * 0.15, bright: 1.0 + n(brightness), contrast: 1.0 + n(contrast), sat: 1.0 + n(saturation) }
    }

    fn is_identity(&self) -> bool {
        self.warm == 0.0 && self.bright == 1.0 && self.contrast == 1.0 && self.sat == 1.0
    }

    /// One RGB pixel (0..255).
    pub fn apply(&self, [r, g, b]: [u8; 3]) -> [u8; 3] {
        let (mut r, mut g, mut b) = (r as f32, g as f32, b as f32);
        r *= 1.0 + self.warm;
        b *= 1.0 - self.warm;
        r *= self.bright;
        g *= self.bright;
        b *= self.bright;
        r = (r - 127.5) * self.contrast + 127.5;
        g = (g - 127.5) * self.contrast + 127.5;
        b = (b - 127.5) * self.contrast + 127.5;
        if self.sat != 1.0 {
            let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r = l + (r - l) * self.sat;
            g = l + (g - l) * self.sat;
            b = l + (b - l) * self.sat;
        }
        let c = |v: f32| v.round().clamp(0.0, 255.0) as u8;
        [c(r), c(g), c(b)]
    }
}

/// Applies `f` to every RGB pixel (alpha kept), in parallel. Works on 8-bit copies.
fn map_pixels(img: DynamicImage, f: impl Fn([u8; 3]) -> [u8; 3] + Sync) -> DynamicImage {
    if decode::has_alpha(&img) {
        let mut buf = img.to_rgba8();
        buf.par_chunks_mut(4).for_each(|p| {
            let [r, g, b] = f([p[0], p[1], p[2]]);
            p[..3].copy_from_slice(&[r, g, b]);
        });
        DynamicImage::ImageRgba8(buf)
    } else {
        let mut buf = img.to_rgb8();
        buf.par_chunks_mut(3).for_each(|p| {
            let [r, g, b] = f([p[0], p[1], p[2]]);
            p.copy_from_slice(&[r, g, b]);
        });
        DynamicImage::ImageRgb8(buf)
    }
}

/// out = v + k * (4v - up - down - left - right), edges clamped; alpha untouched.
fn sharpen(img: DynamicImage, k: f32) -> DynamicImage {
    fn run(src: &[u8], w: usize, h: usize, ch: usize, k: f32) -> Vec<u8> {
        let mut out = src.to_vec();
        let stride = w * ch;
        out.par_chunks_mut(stride).enumerate().for_each(|(y, row)| {
            let up = y.saturating_sub(1) * stride;
            let down = (y + 1).min(h - 1) * stride;
            let cur = y * stride;
            for x in 0..w {
                let l = x.saturating_sub(1) * ch;
                let r = (x + 1).min(w - 1) * ch;
                for c in 0..3.min(ch) {
                    let v = src[cur + x * ch + c] as f32;
                    let lap = 4.0 * v
                        - src[up + x * ch + c] as f32
                        - src[down + x * ch + c] as f32
                        - src[cur + l + c] as f32
                        - src[cur + r + c] as f32;
                    row[x * ch + c] = (v + k * lap).round().clamp(0.0, 255.0) as u8;
                }
            }
        });
        out
    }
    let (w, h) = (img.width(), img.height());
    if decode::has_alpha(&img) {
        let buf = img.to_rgba8();
        let out = run(&buf, w as usize, h as usize, 4, k);
        DynamicImage::ImageRgba8(image::RgbaImage::from_raw(w, h, out).expect("same size"))
    } else {
        let buf = img.to_rgb8();
        let out = run(&buf, w as usize, h as usize, 3, k);
        DynamicImage::ImageRgb8(image::RgbImage::from_raw(w, h, out).expect("same size"))
    }
}

// ---------------------------------------------------------------------------
// Encoding + metadata embedding
// ---------------------------------------------------------------------------

fn resolve_format(requested: OutFormat, src: Format) -> OutFormat {
    match requested {
        OutFormat::Same => match src {
            Format::Png => OutFormat::Png,
            Format::Webp => OutFormat::Webp,
            Format::Avif => OutFormat::Avif,
            Format::Tiff => OutFormat::Tiff,
            Format::Bmp => OutFormat::Bmp,
            _ => OutFormat::Jpeg,
        },
        f => f,
    }
}

fn format_ext(f: OutFormat, src_ext: &str) -> String {
    match f {
        OutFormat::Jpeg if matches!(src_ext, "jpg" | "jpeg" | "jpe" | "jfif") => src_ext.to_string(),
        OutFormat::Jpeg => "jpg".into(),
        OutFormat::Png => "png".into(),
        OutFormat::Webp => "webp".into(),
        OutFormat::Avif => "avif".into(),
        OutFormat::Tiff if matches!(src_ext, "tif" | "tiff") => src_ext.to_string(),
        OutFormat::Tiff => "tif".into(),
        OutFormat::Bmp => "bmp".into(),
        OutFormat::Same => src_ext.to_string(),
    }
}

pub fn encode(img: &DynamicImage, format: OutFormat, quality: u8, icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let quality = quality.clamp(1, 100);
    let alpha = decode::has_alpha(img);
    let err = |e: image::ImageError| format!("Kodlama hatası: {e}");
    let mut out = Vec::new();
    match format {
        OutFormat::Jpeg | OutFormat::Same => {
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
            if let Some(p) = icc {
                let _ = enc.set_icc_profile(p.to_vec());
            }
            match img {
                DynamicImage::ImageLuma8(g) => enc.write_image(g, g.width(), g.height(), image::ExtendedColorType::L8),
                _ => {
                    let rgb = img.to_rgb8();
                    enc.write_image(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                }
            }
            .map_err(err)?;
        }
        OutFormat::Png => {
            let mut enc = image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Default,
                image::codecs::png::FilterType::Adaptive,
            );
            if let Some(p) = icc {
                let _ = enc.set_icc_profile(p.to_vec());
            }
            // Keeps 16-bit and grayscale images as they are
            let img = match img {
                DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => DynamicImage::ImageRgba16(img.to_rgba16()),
                _ if img.color().has_alpha() && !alpha => DynamicImage::ImageRgb8(img.to_rgb8()),
                _ => img.clone(),
            };
            img.write_with_encoder(enc).map_err(err)?;
        }
        OutFormat::Webp => {
            if quality >= 100 {
                let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
                if alpha {
                    DynamicImage::ImageRgba8(img.to_rgba8()).write_with_encoder(enc)
                } else {
                    DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(enc)
                }
                .map_err(err)?;
            } else {
                let (w, h) = (img.width(), img.height());
                let mem = if alpha {
                    let rgba = img.to_rgba8();
                    webp::Encoder::from_rgba(&rgba, w, h).encode_simple(false, quality as f32)
                } else {
                    let rgb = img.to_rgb8();
                    webp::Encoder::from_rgb(&rgb, w, h).encode_simple(false, quality as f32)
                }
                .map_err(|e| format!("WebP kodlama hatası: {e:?}"))?;
                out = mem.to_vec();
            }
        }
        OutFormat::Avif => {
            // rav1e (pure Rust): speed 7 keeps 12 MP encodes in the seconds range
            let enc = image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, 7, quality);
            if alpha {
                DynamicImage::ImageRgba8(img.to_rgba8()).write_with_encoder(enc)
            } else {
                DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(enc)
            }
            .map_err(err)?;
        }
        OutFormat::Tiff => {
            let mut cur = std::io::Cursor::new(Vec::new());
            let img = if alpha { DynamicImage::ImageRgba8(img.to_rgba8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) };
            img.write_to(&mut cur, image::ImageFormat::Tiff).map_err(err)?;
            out = cur.into_inner();
        }
        OutFormat::Bmp => {
            let mut cur = std::io::Cursor::new(Vec::new());
            let img = if alpha { DynamicImage::ImageRgba8(img.to_rgba8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) };
            img.write_to(&mut cur, image::ImageFormat::Bmp).map_err(err)?;
            out = cur.into_inner();
        }
    }
    Ok(out)
}

/// Header segments of a JPEG: (marker, byte range incl. FF marker) + offset of SOS.
fn jpeg_segments(d: &[u8]) -> Option<(Vec<(u8, std::ops::Range<usize>)>, usize)> {
    if !d.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut segs = Vec::new();
    let mut pos = 2;
    loop {
        let start = pos;
        if *d.get(pos)? != 0xFF {
            return None;
        }
        while *d.get(pos)? == 0xFF {
            pos += 1;
        }
        let marker = *d.get(pos)?;
        pos += 1;
        if marker == 0xDA {
            return Some((segs, start));
        }
        if matches!(marker, 0x01 | 0xD0..=0xD7) {
            continue;
        }
        let len = u16::from_be_bytes([*d.get(pos)?, *d.get(pos + 1)?]) as usize;
        let end = pos + len;
        if len < 2 || end > d.len() {
            return None;
        }
        segs.push((marker, start..end));
        pos = end;
    }
}

const EXIF_ID: &[u8] = b"Exif\0\0";
const XMP_IDS: [&[u8]; 2] = [b"http://ns.adobe.com/xap/1.0/\0", b"http://ns.adobe.com/xmp/extension/\0"];

/// The TIFF payload of a JPEG's EXIF APP1 segment.
pub fn jpeg_exif_payload(d: &[u8]) -> Option<&[u8]> {
    let (segs, _) = jpeg_segments(d)?;
    segs.iter()
        .find(|(m, r)| *m == 0xE1 && d[r.start + 4..r.end].starts_with(EXIF_ID))
        .map(|(_, r)| &d[r.start + 4 + EXIF_ID.len()..r.end])
}

/// Rebuilds a JPEG's metadata segments without touching the compressed image data:
/// replaces the EXIF APP1 with `exif` (None = remove) and optionally drops XMP / IPTC.
pub fn jpeg_rewrite_metadata(d: &[u8], exif: Option<&[u8]>, drop_xmp: bool, drop_iptc: bool) -> Option<Vec<u8>> {
    let (segs, sos) = jpeg_segments(d)?;
    let mut out = Vec::with_capacity(d.len() + exif.map_or(0, |e| e.len() + 10));
    out.extend_from_slice(&[0xFF, 0xD8]);
    // JFIF/JFXX APP0 first, then EXIF, then everything else in the original order
    for (m, r) in &segs {
        if *m == 0xE0 {
            out.extend_from_slice(&d[r.clone()]);
        }
    }
    if let Some(tiff) = exif {
        if tiff.len() > exif::MAX_APP1_TIFF {
            return None;
        }
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((tiff.len() + EXIF_ID.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(EXIF_ID);
        out.extend_from_slice(tiff);
    }
    for (m, r) in &segs {
        let body = &d[r.start + 4..r.end];
        let drop = match *m {
            0xE0 => true, // already written
            0xE1 if body.starts_with(EXIF_ID) => true,
            0xE1 if XMP_IDS.iter().any(|id| body.starts_with(id)) => drop_xmp,
            0xED => drop_iptc,
            _ => false,
        };
        if !drop {
            out.extend_from_slice(&d[r.clone()]);
        }
    }
    out.extend_from_slice(&d[sos..]);
    Some(out)
}

fn png_with_exif(png: &[u8], tiff: &[u8]) -> Vec<u8> {
    let mut pos = 8;
    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        if &png[pos + 4..pos + 8] == b"IDAT" {
            break;
        }
        pos += 12 + len;
    }
    let pos = pos.min(png.len());
    let mut chunk = Vec::with_capacity(tiff.len() + 12);
    chunk.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"eXIf");
    chunk.extend_from_slice(tiff);
    let crc = crc32fast::hash(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    let mut out = png[..pos].to_vec();
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[pos..]);
    out
}

/// Adds a Latin-1 `tEXt` chunk (before the image data) to a PNG file.
pub(crate) fn png_with_text(png: &[u8], keyword: &str, text: &str) -> Vec<u8> {
    let mut pos = 8;
    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        if &png[pos + 4..pos + 8] == b"IDAT" {
            break;
        }
        pos += 12 + len;
    }
    let pos = pos.min(png.len());
    let latin1 = |s: &str| s.chars().map(|c| if (c as u32) < 256 && c != '\0' { c as u8 } else { b'?' }).collect::<Vec<u8>>();
    let mut data = latin1(keyword);
    data.truncate(79);
    data.push(0);
    data.extend(latin1(text));
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"tEXt");
    chunk.extend_from_slice(&data);
    let crc = crc32fast::hash(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    let mut out = png[..pos].to_vec();
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[pos..]);
    out
}

/// Adds an EXIF chunk to a WebP file (converting a simple VP8/VP8L file to VP8X).
fn webp_with_exif(webp: &[u8], tiff: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    if webp.len() < 20 || &webp[0..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        return None;
    }
    let mut chunks: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    let mut pos = 12;
    while pos + 8 <= webp.len() {
        let fourcc: [u8; 4] = webp[pos..pos + 4].try_into().ok()?;
        let len = u32::from_le_bytes(webp[pos + 4..pos + 8].try_into().ok()?) as usize;
        let data = webp.get(pos + 8..pos + 8 + len)?.to_vec();
        chunks.push((fourcc, data));
        pos += 8 + len + (len & 1);
    }
    chunks.retain(|(c, _)| c != b"EXIF");
    if let Some((_, vp8x)) = chunks.iter_mut().find(|(c, _)| c == b"VP8X") {
        vp8x[0] |= 0x08;
    } else {
        let alpha = chunks.iter().any(|(c, d)| {
            c == b"VP8L" && d.len() >= 5 && (u32::from_le_bytes(d[1..5].try_into().unwrap()) >> 28) & 1 == 1
        });
        let mut x = vec![0u8; 10];
        x[0] = 0x08 | if alpha { 0x10 } else { 0 };
        x[4..7].copy_from_slice(&(w - 1).to_le_bytes()[..3]);
        x[7..10].copy_from_slice(&(h - 1).to_le_bytes()[..3]);
        chunks.insert(0, (*b"VP8X", x));
    }
    chunks.push((*b"EXIF", tiff.to_vec()));
    let mut body = b"WEBP".to_vec();
    for (c, d) in &chunks {
        body.extend_from_slice(c);
        body.extend_from_slice(&(d.len() as u32).to_le_bytes());
        body.extend_from_slice(d);
        if d.len() % 2 == 1 {
            body.push(0);
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Some(out)
}

pub(crate) fn embed_exif(bytes: Vec<u8>, format: OutFormat, tiff: Option<&[u8]>, w: u32, h: u32) -> Vec<u8> {
    let Some(tiff) = tiff else { return bytes };
    match format {
        OutFormat::Jpeg => jpeg_rewrite_metadata(&bytes, Some(tiff), false, false).unwrap_or(bytes),
        OutFormat::Png => png_with_exif(&bytes, tiff),
        OutFormat::Webp => webp_with_exif(&bytes, tiff, w, h).unwrap_or(bytes),
        // AVIF/TIFF/BMP: EXIF is not carried over
        _ => bytes,
    }
}

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + if m <= 2 { 1 } else { 0 }, m, d)
}

fn date_token(src: &Path) -> String {
    let ms = exif::file_date_taken_ms(src)
        .or_else(|| std::fs::metadata(src).ok().map(|m| super::mtime_ms(&m)))
        .unwrap_or(0);
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86400));
    let s = secs.rem_euclid(86400);
    format!("{y:04}{mo:02}{d:02}_{:02}{:02}{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// Expands the name template for file number `index`.
pub fn render_name(template: &str, src: &Path, index: usize, counter_start: u32) -> String {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut out = String::new();
    let mut rest = if template.trim().is_empty() { "{name}" } else { template };
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else {
            out.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let token = &rest[open + 1..open + close];
        let (name, arg) = token.split_once(':').unwrap_or((token, ""));
        match name {
            "name" => out.push_str(&stem),
            "ext" => out.push_str(&ext_lower(src)),
            "counter" => {
                let width = arg.parse::<usize>().unwrap_or(0).min(12);
                out.push_str(&format!("{:0width$}", counter_start as usize + index));
            }
            "date" => out.push_str(&date_token(src)),
            _ => out.push_str(&rest[open..=open + close]),
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    let cleaned: String = out
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').to_string();
    if cleaned.is_empty() { stem } else { cleaned }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

enum Target {
    Write(PathBuf),
    Skip(PathBuf),
}

/// Picks (and reserves, for parallel batches) the output path.
fn choose_output(src: &Path, base: &Path, ext: &str, conflict: Conflict, reserved: &Mutex<HashSet<PathBuf>>) -> Target {
    let mut reserved = reserved.lock().unwrap();
    let candidate = |n: u32| {
        let stem = base.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let name = if n == 0 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") };
        base.with_file_name(name)
    };
    let first = candidate(0);
    let taken = |p: &Path, reserved: &HashSet<PathBuf>| reserved.contains(p) || p.exists();
    match conflict {
        Conflict::Overwrite if !reserved.contains(&first) => {
            reserved.insert(first.clone());
            Target::Write(first)
        }
        Conflict::Skip if taken(&first, &reserved) => Target::Skip(first),
        _ => {
            let mut n = 0;
            loop {
                let p = candidate(n);
                if !taken(&p, &reserved) && !same_file(&p, src) {
                    reserved.insert(p.clone());
                    return Target::Write(p);
                }
                n += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Single file + batch
// ---------------------------------------------------------------------------

fn only_orientation_ops(ops: &[Op]) -> bool {
    ops.iter().all(|o| matches!(o, Op::Rotate { .. } | Op::Flip { .. }))
}

/// JPEG rotate/flip/metadata edit without re-encoding. None = not possible here.
fn lossless_jpeg(bytes: &[u8], ops: &[Op], policy: MetadataPolicy) -> Result<Option<(Vec<u8>, u32, u32)>, String> {
    let payload = jpeg_exif_payload(bytes);
    let blob = payload.and_then(|p| TiffBlob::new(p.to_vec()));
    let unparseable = payload.is_some() && blob.is_none();
    let current = blob.as_ref().and_then(|b| b.orientation()).filter(|o| (1..=8).contains(o)).unwrap_or(1);
    let Some(new_o) = compose_orientation(current, ops)? else { return Ok(None) };
    let new_exif = match (policy, blob) {
        (MetadataPolicy::Strip, _) | (_, None) => (new_o != 1).then(|| exif::orientation_only_tiff(new_o)),
        (_, Some(mut b)) => {
            if policy == MetadataPolicy::StripGps {
                b.strip_gps();
            }
            if new_o != current || b.orientation().is_some() {
                b.set_orientation(new_o);
            }
            Some(b.data)
        }
    };
    // EXIF present but unparseable: leave it alone only if nothing must change
    if unparseable && (new_o != current || policy != MetadataPolicy::Keep) {
        return Ok(None);
    }
    let drop = policy != MetadataPolicy::Keep;
    let Some(out) = jpeg_rewrite_metadata(bytes, new_exif.as_deref(), drop, policy == MetadataPolicy::Strip) else {
        return Ok(None);
    };
    let info = super::raw::jpeg_info(bytes).ok_or("JPEG yapısı okunamadı")?;
    let (w, h) = if new_o >= 5 { (info.height, info.width) } else { (info.width, info.height) };
    Ok(Some((out, w, h)))
}

pub fn process_file(src: &Path, index: usize, ops: &[Op], o: &OutputOptions, reserved: &Mutex<HashSet<PathBuf>>) -> FileOutcome {
    let atomic = |out: &Path, bytes: &[u8]| super::write_atomic(out, bytes).map(|_| out.to_path_buf());
    process_file_with(src, index, ops, o, reserved, &atomic)
}

/// Writes the output: `(chosen path, bytes) -> final path`. The job queue (A02) passes a
/// writer that reserves the name, writes into the job's temp dir and places the file without
/// replacing anything; `process_file` uses `write_atomic`.
pub type OutputWriter<'a> = dyn Fn(&Path, &[u8]) -> Result<PathBuf, String> + Sync + 'a;

pub fn process_file_with(
    src: &Path,
    index: usize,
    ops: &[Op],
    o: &OutputOptions,
    reserved: &Mutex<HashSet<PathBuf>>,
    write: &OutputWriter,
) -> FileOutcome {
    let mut r = FileOutcome { index, input: src.to_string_lossy().into_owned(), ..Default::default() };
    if let Err(e) = process_inner(src, index, ops, o, reserved, write, &mut r) {
        r.ok = false;
        r.error = Some(e);
    }
    r
}

fn process_inner(
    src: &Path,
    index: usize,
    ops: &[Op],
    o: &OutputOptions,
    reserved: &Mutex<HashSet<PathBuf>>,
    write: &OutputWriter,
    r: &mut FileOutcome,
) -> Result<(), String> {
    if !src.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    let src_format = decode::detect(src);
    let format = resolve_format(o.format, src_format);
    let src_ext = ext_lower(src);
    let ext = format_ext(format, &src_ext);
    let dir = o.dir.as_deref().map(PathBuf::from).or_else(|| src.parent().map(Path::to_path_buf)).ok_or("Çıktı klasörü yok")?;
    let base = dir.join(render_name(&o.name_template, src, index, o.counter_start));
    let out = match choose_output(src, &base, &ext, o.conflict, reserved) {
        Target::Write(p) => p,
        Target::Skip(p) => {
            r.ok = true;
            r.skipped = true;
            r.output = Some(p.to_string_lossy().into_owned());
            return Ok(());
        }
    };

    let src_is_jpeg = src_format == Format::Jpeg;
    let format_kept = match format {
        OutFormat::Jpeg => src_is_jpeg,
        OutFormat::Png => src_format == Format::Png,
        OutFormat::Webp => src_format == Format::Webp,
        OutFormat::Avif => src_format == Format::Avif,
        OutFormat::Tiff => src_format == Format::Tiff,
        OutFormat::Bmp => src_format == Format::Bmp,
        OutFormat::Same => false,
    };

    let mut written: Option<(Vec<u8>, u32, u32, bool)> = None;
    if o.lossless && format_kept && only_orientation_ops(ops) {
        if src_is_jpeg {
            let bytes = std::fs::read(src).map_err(|e| format!("Dosya okunamadı: {e}"))?;
            if let Some((b, w, h)) = lossless_jpeg(&bytes, ops, o.metadata)? {
                written = Some((b, w, h, true));
            }
        } else if ops.is_empty() && o.metadata == MetadataPolicy::Keep {
            // Plain copy / rename
            let bytes = std::fs::read(src).map_err(|e| format!("Dosya okunamadı: {e}"))?;
            let (w, h) = exif::photo_info(src).ok().and_then(|i| Some((i.width?, i.height?))).unwrap_or((0, 0));
            written = Some((bytes, w, h, true));
        }
    }

    let (bytes, w, h, lossless) = match written {
        Some(x) => x,
        None => {
            let decoded = decode::decode(src, None)?;
            let icc = decoded.icc;
            let mut img = decoded.image;
            for op in ops {
                img = apply_op(img, op)?;
            }
            let (w, h) = (img.width(), img.height());
            let bytes = encode(&img, format, o.quality, icc.as_deref())?;
            let tiff = exif::blob_for_output(src, o.metadata, 1, Some((w, h)));
            (embed_exif(bytes, format, tiff.as_deref(), w, h), w, h, false)
        }
    };

    let out = write(&out, &bytes)?;
    if o.remove_source && !same_file(&out, src) {
        std::fs::remove_file(src).map_err(|e| format!("Kaynak silinemedi: {e}"))?;
    }
    r.ok = true;
    r.lossless = lossless;
    r.output = Some(out.to_string_lossy().into_owned());
    r.width = (w > 0).then_some(w);
    r.height = (h > 0).then_some(h);
    r.bytes = Some(bytes.len() as u64);
    Ok(())
}

/// Runs a batch on all cores. `on_progress(outcome, done, total)` is called from worker
/// threads after each file.
pub fn run_batch(
    job: &BatchJob,
    job_id: &str,
    cancelled: &(dyn Fn() -> bool + Sync),
    on_progress: &(dyn Fn(&FileOutcome, usize, usize) + Sync),
) -> BatchSummary {
    let started = Instant::now();
    let total = job.files.len();
    let done = AtomicUsize::new(0);
    let reserved = Mutex::new(HashSet::new());
    // Validate ops once instead of failing every file the same way
    let invalid = job.ops.iter().find_map(|op| op_matrix(op).err());
    let mut results: Vec<FileOutcome> = job
        .files
        .par_iter()
        .enumerate()
        .map(|(i, f)| {
            let outcome = if cancelled() {
                FileOutcome { index: i, input: f.clone(), error: Some(ERR_CANCELLED.into()), ..Default::default() }
            } else if let Some(e) = &invalid {
                FileOutcome { index: i, input: f.clone(), error: Some(e.clone()), ..Default::default() }
            } else {
                process_file(Path::new(f), i, &job.ops, &job.output, &reserved)
            };
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            on_progress(&outcome, d, total);
            outcome
        })
        .collect();
    results.sort_by_key(|r| r.index);
    let cancelled_any = results.iter().any(|r| r.error.as_deref() == Some(ERR_CANCELLED));
    BatchSummary {
        job_id: job_id.to_string(),
        total,
        succeeded: results.iter().filter(|r| r.ok && !r.skipped).count(),
        failed: results.iter().filter(|r| !r.ok && r.error.as_deref() != Some(ERR_CANCELLED)).count(),
        skipped: results.iter().filter(|r| r.skipped).count(),
        cancelled: cancelled_any,
        elapsed_ms: started.elapsed().as_millis() as u64,
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photo::exif::tests::{sample_exif_tiff, write_exif_jpeg};
    use crate::photo::exif::{read_path, summarize};
    use crate::photo::testutil::*;

    fn job(files: &[&Path], ops: Vec<Op>, output: OutputOptions) -> BatchJob {
        BatchJob {
            job_id: Some("t".into()),
            files: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            ops,
            output,
        }
    }

    fn run(j: &BatchJob) -> BatchSummary {
        run_batch(j, "t", &|| false, &|_, _, _| {})
    }

    #[test]
    fn orientation_composition() {
        let rot = |d| Op::Rotate { degrees: d };
        assert_eq!(compose_orientation(1, &[rot(90)]), Ok(Some(6)));
        assert_eq!(compose_orientation(6, &[rot(90)]), Ok(Some(3)));
        assert_eq!(compose_orientation(6, &[rot(-90)]), Ok(Some(1)));
        assert_eq!(compose_orientation(1, &[rot(270)]), Ok(Some(8)));
        assert_eq!(compose_orientation(1, &[Op::Flip { axis: Axis::Horizontal }]), Ok(Some(2)));
        assert_eq!(compose_orientation(1, &[Op::Flip { axis: Axis::Vertical }]), Ok(Some(4)));
        assert_eq!(compose_orientation(3, &[rot(180)]), Ok(Some(1)));
        // Matches image's own orientation semantics for every code + op
        let base = DynamicImage::ImageRgb8(pattern(8, 6));
        for o in 1..=8u16 {
            for ops in [vec![rot(90)], vec![Op::Flip { axis: Axis::Horizontal }], vec![rot(180), Op::Flip { axis: Axis::Vertical }]] {
                let mut shown = base.clone();
                shown.apply_orientation(image::metadata::Orientation::from_exif(o as u8).unwrap());
                let mut expected = shown;
                for op in &ops {
                    expected = apply_op(expected, op).unwrap();
                }
                let n = compose_orientation(o, &ops).unwrap().unwrap();
                let mut got = base.clone();
                got.apply_orientation(image::metadata::Orientation::from_exif(n as u8).unwrap());
                assert_eq!(got, expected, "orientation {o} + {ops:?} -> {n}");
            }
        }
        assert!(compose_orientation(1, &[rot(45)]).is_err());
        assert_eq!(compose_orientation(1, &[Op::Crop { x: 0, y: 0, width: 1, height: 1 }]), Ok(None));
    }

    #[test]
    fn photo_ops_lossless_jpeg_rotate_keeps_pixels_and_exif() {
        let dir = temp_dir("ops_lossless");
        let src = dir.join("a.jpg");
        write_exif_jpeg(&src, 64, 48, 1);
        let original = std::fs::read(&src).unwrap();
        let s = run(&job(&[&src], vec![Op::Rotate { degrees: 90 }], OutputOptions::default()));
        let r = &s.results[0];
        assert!(r.ok && r.lossless, "{r:?}");
        assert_eq!((r.width, r.height), (Some(48), Some(64)));
        let out = PathBuf::from(r.output.as_ref().unwrap());
        assert_eq!(out.file_name().unwrap(), "a (1).jpg");
        let bytes = std::fs::read(&out).unwrap();
        // Compressed image data is bit-identical
        let sos = |d: &[u8]| jpeg_segments(d).unwrap().1;
        assert_eq!(&bytes[sos(&bytes)..], &original[sos(&original)..]);
        let ex = summarize(&read_path(&out));
        assert_eq!(ex.orientation, Some(6));
        assert_eq!(ex.model.as_deref(), Some("Fixture 1"));
        assert!(ex.gps.is_some());
        // Decoded display image is rotated
        let img = decode::decode(&out, None).unwrap().image.to_rgb8();
        assert_eq!(img.dimensions(), (48, 64));
        assert_eq!(quadrant(*img.get_pixel(2, 2)), "blue");

        // In-place save, GPS stripped, still lossless
        let o = OutputOptions { conflict: Conflict::Overwrite, metadata: MetadataPolicy::StripGps, ..Default::default() };
        let s = run(&job(&[&out], vec![Op::Rotate { degrees: -90 }], o));
        assert!(s.results[0].lossless);
        assert_eq!(s.results[0].output.as_deref(), Some(out.to_str().unwrap()));
        let ex = summarize(&read_path(&out));
        assert_eq!(ex.orientation, Some(1));
        assert!(ex.gps.is_none());
        assert_eq!(ex.make.as_deref(), Some("VHO Test"));

        // Strip everything
        let o = OutputOptions { conflict: Conflict::Overwrite, metadata: MetadataPolicy::Strip, ..Default::default() };
        let s = run(&job(&[&out], vec![], o));
        assert!(s.results[0].lossless);
        assert!(read_path(&out).is_empty());
    }

    #[test]
    fn photo_ops_reencode_crop_resize_convert_keeps_exif() {
        let dir = temp_dir("ops_reencode");
        let src = dir.join("b.jpg");
        write_exif_jpeg(&src, 400, 300, 6); // displayed 300x400
        let ops = vec![
            Op::Crop { x: 0, y: 0, width: 150, height: 200 }, // top-left display quadrant (blue)
            Op::Resize { width: None, height: None, long_edge: Some(100), percent: None, exact: false, upscale: false },
        ];
        for (fmt, ext) in [(OutFormat::Jpeg, "jpg"), (OutFormat::Png, "png"), (OutFormat::Webp, "webp")] {
            let o = OutputOptions { format: fmt, dir: Some(dir.join("out").to_string_lossy().into()), ..Default::default() };
            let s = run(&job(&[&src], ops.clone(), o));
            let r = &s.results[0];
            assert!(r.ok && !r.lossless, "{fmt:?}: {r:?}");
            assert!(r.output.as_ref().unwrap().ends_with(ext));
            assert_eq!((r.width, r.height), (Some(75), Some(100)));
            let out = Path::new(r.output.as_ref().unwrap());
            let img = image::open(out).unwrap().to_rgb8();
            assert_eq!(img.dimensions(), (75, 100));
            assert_eq!(quadrant(*img.get_pixel(37, 50)), "blue", "{fmt:?}");
            let ex = summarize(&read_path(out));
            assert_eq!(ex.orientation, Some(1), "{fmt:?} orientation reset");
            assert_eq!(ex.date_taken.as_deref(), Some("2024-05-17T14:30:05"), "{fmt:?} date kept");
            assert!(ex.gps.is_some(), "{fmt:?} gps kept");
            let fields = crate::photo::exif::all_fields(&read_path(out));
            assert!(fields.iter().any(|f| f.tag == "PixelXDimension" && f.value.starts_with("75")), "{fmt:?} {fields:?}");
        }
        // AVIF encode (no EXIF in AVIF output)
        let o = OutputOptions { format: OutFormat::Avif, quality: 60, ..Default::default() };
        let s = run(&job(&[&src], vec![Op::Resize { width: Some(64), height: None, long_edge: None, percent: None, exact: false, upscale: false }], o));
        assert!(s.results[0].ok, "{:?}", s.results[0]);
        assert!(s.results[0].output.as_ref().unwrap().ends_with(".avif"));
        // Strip metadata on re-encode
        let o = OutputOptions { format: OutFormat::Png, metadata: MetadataPolicy::Strip, ..Default::default() };
        let s = run(&job(&[&src], vec![Op::Flip { axis: Axis::Horizontal }], o));
        assert!(read_path(Path::new(s.results[0].output.as_ref().unwrap())).is_empty());
    }

    #[test]
    fn photo_batch_naming_conflicts_cancel_and_progress() {
        let dir = temp_dir("ops_batch");
        let mut files = Vec::new();
        for i in 0..5 {
            let p = dir.join(format!("p{i}.png"));
            pattern(20 + i, 10).save(&p).unwrap();
            files.push(p);
        }
        let refs: Vec<&Path> = files.iter().map(|p| p.as_path()).collect();
        let out_dir = dir.join("renamed");
        let o = OutputOptions {
            name_template: "trip_{counter:3}".into(),
            dir: Some(out_dir.to_string_lossy().into()),
            ..Default::default()
        };
        let progress = Mutex::new(Vec::new());
        let s = run_batch(&job(&refs, vec![], o.clone()), "t", &|| false, &|r, d, t| {
            progress.lock().unwrap().push((r.index, d, t))
        });
        assert_eq!((s.succeeded, s.failed), (5, 0));
        assert!(s.results.iter().all(|r| r.lossless), "plain copy");
        assert!(out_dir.join("trip_001.png").exists() && out_dir.join("trip_005.png").exists());
        let mut p = progress.into_inner().unwrap();
        p.sort_by_key(|x| x.1);
        assert_eq!(p.last().unwrap().1, 5);
        // Same names again: renamed, or skipped
        let s = run(&job(&refs, vec![], o.clone()));
        assert!(s.results[0].output.as_ref().unwrap().ends_with("trip_001 (1).png"));
        let s = run(&job(&refs, vec![], OutputOptions { conflict: Conflict::Skip, ..o.clone() }));
        assert_eq!(s.skipped, 5);
        // Move (rename) with {date}
        let s = run(&job(&refs[..1], vec![], OutputOptions { name_template: "{date}_{name}".into(), remove_source: true, ..Default::default() }));
        assert!(s.results[0].ok);
        assert!(!files[0].exists());
        let name = Path::new(s.results[0].output.as_ref().unwrap()).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with("_p0.png") && name.len() == "20240101_000000_p0.png".len(), "{name}");
        // Cancelled
        let s = run_batch(&job(&refs[1..], vec![], o.clone()), "t", &|| true, &|_, _, _| {});
        assert!(s.cancelled);
        assert_eq!(s.succeeded, 0);
        // Invalid op
        let s = run(&job(&refs[1..2], vec![Op::Rotate { degrees: 45 }], o));
        assert_eq!(s.failed, 1);
    }

    #[test]
    fn op_json_shapes() {
        let j: BatchJob = serde_json::from_str(
            r#"{"jobId":"x","files":["a.jpg"],"ops":[{"op":"rotate","degrees":90},{"op":"flip","axis":"horizontal"},
            {"op":"crop","x":1,"y":2,"width":3,"height":4},{"op":"resize","longEdge":1024}],
            "output":{"format":"webp","quality":80,"metadata":"stripGps","conflict":"overwrite","nameTemplate":"{name}_web"}}"#,
        )
        .unwrap();
        assert_eq!(j.ops.len(), 4);
        assert_eq!(j.output.format, OutFormat::Webp);
        assert_eq!(j.output.metadata, MetadataPolicy::StripGps);
        assert!(j.output.lossless);
        assert!(matches!(j.ops[3], Op::Resize { long_edge: Some(1024), .. }));
    }

    #[test]
    fn exif_embedding_helpers() {
        let tiff = sample_exif_tiff(1);
        let png = {
            let mut c = std::io::Cursor::new(Vec::new());
            pattern(4, 4).write_to(&mut c, image::ImageFormat::Png).unwrap();
            c.into_inner()
        };
        let with = png_with_exif(&png, &tiff);
        image::load_from_memory(&with).unwrap();
        assert_eq!(summarize(&crate::photo::exif::ExifSet(vec![crate::photo::exif::read_bytes(&with).unwrap()])).iso, Some(200));
        let webp = encode(&DynamicImage::ImageRgb8(pattern(10, 8)), OutFormat::Webp, 80, None).unwrap();
        let with = webp_with_exif(&webp, &tiff, 10, 8).unwrap();
        assert_eq!(image::load_from_memory(&with).unwrap().width(), 10);
        assert!(crate::photo::exif::read_bytes(&with).is_some());
        let lossless = encode(&DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(6, 6, image::Rgba([1, 2, 3, 100]))), OutFormat::Webp, 100, None).unwrap();
        let with = webp_with_exif(&lossless, &tiff, 6, 6).unwrap();
        let back = image::load_from_memory(&with).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(0, 0).0, [1, 2, 3, 100]);
    }

    #[test]
    fn name_templates() {
        let p = Path::new("C:/x/IMG_0001.JPG");
        assert_eq!(render_name("{name}", p, 0, 1), "IMG_0001");
        assert_eq!(render_name("tatil_{counter:4}", p, 9, 1), "tatil_0010");
        assert_eq!(render_name("{name}-{ext}{unknown}", p, 0, 1), "IMG_0001-jpg{unknown}");
        assert_eq!(render_name("a/b:c", p, 0, 1), "a_b_c");
        assert_eq!(render_name("", p, 0, 1), "IMG_0001");
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19860), (2024, 5, 17));
    }

    #[test]
    fn photo_ops_adjust_formulas() {
        // Reference values shared with tests/unit/studio.test.mjs (adjustPixel)
        let a = |b, c, s, t, px| Adjustments::new(b, c, s, t).apply(px);
        assert_eq!(a(0.0, 0.0, 0.0, 0.0, [10, 128, 250]), [10, 128, 250]);
        assert_eq!(a(50.0, 0.0, 0.0, 0.0, [100, 100, 100]), [150, 150, 150]);
        assert_eq!(a(-100.0, 0.0, 0.0, 0.0, [200, 50, 9]), [0, 0, 0]);
        assert_eq!(a(0.0, 100.0, 0.0, 0.0, [100, 200, 128]), [73, 255, 129]);
        assert_eq!(a(0.0, -100.0, 0.0, 0.0, [0, 255, 30]), [128, 128, 128]);
        assert_eq!(a(0.0, 0.0, -100.0, 0.0, [255, 0, 0]), [54, 54, 54]);
        assert_eq!(a(0.0, 0.0, 0.0, 100.0, [100, 100, 100]), [115, 100, 85]);
        assert_eq!(a(20.0, 10.0, 30.0, -40.0, [120, 80, 40]), [147, 91, 27]);
    }

    #[test]
    fn photo_ops_adjust_and_sharpen_in_batch_keep_exif() {
        let dir = temp_dir("ops_adjust");
        let src = dir.join("c.jpg");
        write_exif_jpeg(&src, 64, 48, 1);
        let before = image::open(&src).unwrap().to_rgb8();
        let ops = vec![
            Op::Adjust { brightness: 30.0, contrast: 0.0, saturation: 0.0, temperature: 0.0 },
            Op::Sharpen { amount: 50.0 },
        ];
        let o = OutputOptions { format: OutFormat::Png, ..Default::default() };
        let s = run(&job(&[&src], ops, o));
        let r = &s.results[0];
        assert!(r.ok && !r.lossless, "{r:?}");
        let out = Path::new(r.output.as_ref().unwrap());
        let after = image::open(out).unwrap().to_rgb8();
        assert_eq!(after.dimensions(), (64, 48));
        // Inside a flat quadrant sharpening is a no-op, so only brightness shows
        assert!(after.get_pixel(40, 36).0.iter().all(|v| *v >= 250), "white quadrant brightened");
        let blue_before = before.get_pixel(5, 40).0[2] as f32;
        let blue_after = after.get_pixel(5, 40).0[2] as f32;
        assert!(blue_after >= (blue_before * 1.3).min(255.0) - 2.0, "{blue_before} -> {blue_after}");
        let ex = summarize(&read_path(out));
        assert_eq!(ex.date_taken.as_deref(), Some("2024-05-17T14:30:05"));

        // Sharpening raises local contrast at the quadrant edge
        let img = DynamicImage::ImageRgb8(pattern(16, 16));
        let sharp = apply_op(img.clone(), &Op::Sharpen { amount: 100.0 }).unwrap().to_rgb8();
        let orig = img.to_rgb8();
        assert_eq!(sharp.get_pixel(3, 3), orig.get_pixel(3, 3));
        assert!(sharp.get_pixel(7, 3).0[0] >= orig.get_pixel(7, 3).0[0]);
        assert!(sharp.get_pixel(8, 3).0[0] <= orig.get_pixel(8, 3).0[0]);
        assert!(sharp.get_pixel(7, 3).0[1] < orig.get_pixel(7, 3).0[1] || orig.get_pixel(7, 3).0[1] == 0);
        // Identity ops leave the image untouched; alpha is preserved
        let rgba = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4, 4, image::Rgba([10, 20, 30, 77])));
        let out = apply_op(rgba.clone(), &Op::Adjust { brightness: 100.0, contrast: 0.0, saturation: 0.0, temperature: 0.0 }).unwrap();
        assert_eq!(out.to_rgba8().get_pixel(1, 1).0, [20, 40, 60, 77]);
        let same = apply_op(rgba.clone(), &Op::Sharpen { amount: 0.0 }).unwrap();
        assert_eq!(same, rgba);
        // JSON shape the UI sends
        let j: BatchJob = serde_json::from_str(r#"{"files":[],"ops":[{"op":"adjust","brightness":10,"temperature":-5},{"op":"sharpen","amount":40}]}"#).unwrap();
        assert!(matches!(j.ops[0], Op::Adjust { brightness, contrast, .. } if brightness == 10.0 && contrast == 0.0));
        assert!(matches!(j.ops[1], Op::Sharpen { amount } if amount == 40.0));
    }
}
