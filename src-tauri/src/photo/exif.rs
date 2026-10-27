//! EXIF reading (kamadak-exif, BSD-2-Clause) and small in-place EXIF blob edits
//! (orientation, GPS removal, pixel dimensions) used by the lossless/batch paths.

use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use exif::{Context, Exif, Field, In, Reader, Tag, Value};
use serde::Serialize;

use super::decode::{self, Format};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// TIFF-structured files (TIFF, most RAWs) keep EXIF near the start; reading only a
/// prefix avoids loading 30-80 MB RAW files just for metadata.
const TIFF_PREFIX: u64 = 1 << 20;

fn reader() -> Reader {
    let mut r = Reader::new();
    r.continue_on_error(true);
    r
}

fn accept(result: Result<Exif, exif::Error>) -> Option<Exif> {
    match result {
        Ok(e) => Some(e),
        Err(exif::Error::PartialResult(p)) => Some(p.into_inner().0),
        Err(_) => None,
    }
}

/// Parses TIFF data, accepting the ORF/RW2 header variants by patching the magic.
fn read_tiff(mut data: Vec<u8>) -> Option<Exif> {
    if data.len() >= 4 && matches!(&data[0..2], b"II" | b"MM") {
        let le = &data[0..2] == b"II";
        let magic = if le { u16::from_le_bytes([data[2], data[3]]) } else { u16::from_be_bytes([data[2], data[3]]) };
        if magic != 42 {
            let fixed = if le { 42u16.to_le_bytes() } else { 42u16.to_be_bytes() };
            data[2..4].copy_from_slice(&fixed);
        }
    }
    accept(reader().read_raw(data))
}

/// All EXIF blocks of a file. Usually one; Canon CR3 stores IFD0 and the EXIF IFD as
/// separate TIFF blocks (CMT1/CMT2 boxes).
pub struct ExifSet(pub Vec<Exif>);

impl ExifSet {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Looks a primary-image tag up by number; GPS tags are matched in the GPS context
    /// only (their numbers overlap with interoperability tags).
    pub fn field(&self, tag: Tag) -> Option<&Field> {
        let gps = tag.context() == Context::Gps;
        self.0.iter().find_map(|e| {
            e.get_field(tag, In::PRIMARY).or_else(|| {
                // CR3 blocks are parsed as plain TIFF: match by number outside GPS
                if gps {
                    return None;
                }
                e.fields().find(|f| {
                    f.ifd_num == In::PRIMARY
                        && f.tag.number() == tag.number()
                        && f.tag.context() == Context::Tiff
                        && tag.context() != Context::Tiff
                })
            })
        })
    }

    pub fn orientation(&self) -> Option<u16> {
        self.field(Tag::Orientation)
            .and_then(|f| f.value.get_uint(0))
            .map(|v| v as u16)
            .filter(|v| (1..=8).contains(v))
    }
}

/// Reads EXIF from any supported container (JPEG, TIFF/RAW, HEIF/AVIF, PNG, WebP, CR3, RAF).
pub fn read_path(path: &Path) -> ExifSet {
    let Ok(mut file) = std::fs::File::open(path) else { return ExifSet(vec![]) };
    let mut head = [0u8; 16];
    let n = file.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    let _ = file.seek(SeekFrom::Start(0));

    // TIFF structure (TIFF, DNG, CR2, NEF, ARW, ORF, RW2, PEF...)
    if head.len() >= 4 && matches!(&head[0..2], b"II" | b"MM") {
        let mut buf = Vec::new();
        let _ = file.take(TIFF_PREFIX).read_to_end(&mut buf);
        return ExifSet(read_tiff(buf).into_iter().collect());
    }
    // Fuji RAF: EXIF lives in the embedded JPEG preview
    if head.starts_with(b"FUJIFILMCCD-RAW") {
        let mut buf = Vec::new();
        let _ = file.take(TIFF_PREFIX * 4).read_to_end(&mut buf);
        if buf.len() > 92 {
            let off = u32::from_be_bytes(buf[84..88].try_into().unwrap()) as usize;
            if let Some(jpeg) = buf.get(off..) {
                return ExifSet(read_bytes(jpeg).into_iter().collect());
            }
        }
        return ExifSet(vec![]);
    }
    // Canon CR3 (ISO-BMFF, brand "crx "): CMT1 = IFD0, CMT2 = EXIF IFD
    if head.len() >= 12 && &head[4..8] == b"ftyp" && &head[8..12] == b"crx " {
        let mut buf = Vec::new();
        let _ = file.take(TIFF_PREFIX).read_to_end(&mut buf);
        return ExifSet(cr3_blocks(&buf));
    }
    ExifSet(accept(reader().read_from_container(&mut BufReader::new(file))).into_iter().collect())
}

/// EXIF from an in-memory JPEG/PNG/WebP/HEIF/TIFF file.
pub fn read_bytes(data: &[u8]) -> Option<Exif> {
    if data.len() >= 4 && matches!(&data[0..2], b"II" | b"MM") {
        return read_tiff(data.to_vec());
    }
    accept(reader().read_from_container(&mut std::io::Cursor::new(data)))
}

fn cr3_blocks(buf: &[u8]) -> Vec<Exif> {
    let mut out = Vec::new();
    for name in [b"CMT1", b"CMT2", b"CMT4"] {
        let Some(pos) = buf.windows(4).position(|w| w == name) else { continue };
        if pos < 4 {
            continue;
        }
        let size = u32::from_be_bytes(buf[pos - 4..pos].try_into().unwrap()) as usize;
        let Some(data) = buf.get(pos + 4..(pos - 4 + size).min(buf.len())) else { continue };
        if name == b"CMT4" {
            // GPS IFD stored as IFD0: re-tag it so GPS lookups work
            if let Some(gps) = read_tiff(data.to_vec()) {
                if let Some(fixed) = retag_as_gps(&gps) {
                    out.push(fixed);
                }
            }
        } else if let Some(e) = read_tiff(data.to_vec()) {
            out.push(e);
        }
    }
    out
}

/// Rebuilds a GPS-IFD-as-IFD0 block into a proper TIFF with a GPS IFD.
fn retag_as_gps(e: &Exif) -> Option<Exif> {
    let fields: Vec<Field> = e
        .fields()
        .filter(|f| f.ifd_num == In::PRIMARY && !matches!(f.value, Value::Unknown(..)))
        .map(|f| Field { tag: Tag(Context::Gps, f.tag.number()), ifd_num: In::PRIMARY, value: f.value.clone() })
        .collect();
    let mut w = exif::experimental::Writer::new();
    for f in &fields {
        w.push_field(f);
    }
    let mut out = std::io::Cursor::new(Vec::new());
    w.write(&mut out, e.little_endian()).ok()?;
    read_tiff(out.into_inner())
}

// ---------------------------------------------------------------------------
// Summary for the UI
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Gps {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: Option<f64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifSummary {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// "YYYY-MM-DDTHH:MM:SS" (camera local time, no zone)
    pub date_taken: Option<String>,
    /// e.g. "+03:00" when the camera recorded it
    pub date_taken_offset: Option<String>,
    /// e.g. "1/250" or "2.5"
    pub exposure_time: Option<String>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    pub focal_length: Option<f64>,
    pub focal_length_35mm: Option<u32>,
    pub exposure_bias: Option<f64>,
    pub flash: Option<String>,
    /// EXIF orientation 1-8
    pub orientation: Option<u16>,
    pub software: Option<String>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
    pub description: Option<String>,
    pub gps: Option<Gps>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExifField {
    /// "primary" or "thumbnail"
    pub ifd: &'static str,
    /// "tiff" | "exif" | "gps" | "interop"
    pub group: &'static str,
    pub tag: String,
    pub id: u16,
    pub value: String,
}

fn ascii(set: &ExifSet, tag: Tag) -> Option<String> {
    match &set.field(tag)?.value {
        Value::Ascii(parts) => {
            let s = parts
                .iter()
                .map(|p| String::from_utf8_lossy(p).trim_matches(char::from(0)).trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

fn rational(set: &ExifSet, tag: Tag, idx: usize) -> Option<f64> {
    match &set.field(tag)?.value {
        Value::Rational(v) => v.get(idx).filter(|r| r.denom != 0).map(|r| r.to_f64()),
        Value::SRational(v) => v.get(idx).filter(|r| r.denom != 0).map(|r| r.to_f64()),
        v => v.get_uint(idx).map(f64::from),
    }
}

fn uint(set: &ExifSet, tag: Tag) -> Option<u32> {
    set.field(tag)?.value.get_uint(0)
}

fn round(v: f64, digits: i32) -> f64 {
    let p = 10f64.powi(digits);
    (v * p).round() / p
}

/// Parses an EXIF "YYYY:MM:DD HH:MM:SS" date into its components.
pub fn parse_exif_date(s: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    let s = s.trim();
    let num = |a: usize, b: usize| s.get(a..b)?.parse::<u32>().ok();
    let y = num(0, 4)? as i32;
    let (mo, d) = (num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13).unwrap_or(0), num(14, 16).unwrap_or(0), num(17, 19).unwrap_or(0));
    ((1..=12).contains(&mo) && (1..=31).contains(&d) && y > 1800 && h < 24 && mi < 60 && se < 61)
        .then_some((y, mo, d, h, mi, se))
}

/// Days since 1970-01-01 (proleptic Gregorian), Howard Hinnant's algorithm.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Capture date as "local wall clock" milliseconds since the epoch (sort key).
pub fn date_taken_ms(set: &ExifSet) -> Option<i64> {
    let (y, mo, d, h, mi, s) = date_taken_raw(set).and_then(|s| parse_exif_date(&s))?;
    Some((days_from_civil(y, mo, d) * 86400 + (h * 3600 + mi * 60 + s) as i64) * 1000)
}

fn date_taken_raw(set: &ExifSet) -> Option<String> {
    [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime]
        .into_iter()
        .find_map(|t| ascii(set, t).filter(|s| parse_exif_date(s).is_some()))
}

/// Fast EXIF capture date of a file (used for "sort by EXIF date").
pub fn file_date_taken_ms(path: &Path) -> Option<i64> {
    date_taken_ms(&read_path(path))
}

fn gps(set: &ExifSet) -> Option<Gps> {
    let coord = |tag: Tag, ref_tag: Tag, neg: &str| -> Option<f64> {
        let (d, m, s) = (rational(set, tag, 0)?, rational(set, tag, 1).unwrap_or(0.0), rational(set, tag, 2).unwrap_or(0.0));
        let v = d + m / 60.0 + s / 3600.0;
        let r = ascii(set, ref_tag).unwrap_or_default();
        Some(if r.eq_ignore_ascii_case(neg) { -v } else { v })
    };
    let latitude = coord(Tag::GPSLatitude, Tag::GPSLatitudeRef, "S")?;
    let longitude = coord(Tag::GPSLongitude, Tag::GPSLongitudeRef, "W")?;
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return None;
    }
    // 0,0 is what some phones write when they had no fix
    if latitude == 0.0 && longitude == 0.0 {
        return None;
    }
    let altitude = rational(set, Tag::GPSAltitude, 0).map(|a| {
        let below = set.field(Tag::GPSAltitudeRef).and_then(|f| f.value.get_uint(0)) == Some(1);
        round(if below { -a } else { a }, 2)
    });
    Some(Gps { latitude: round(latitude, 7), longitude: round(longitude, 7), altitude })
}

pub fn summarize(set: &ExifSet) -> ExifSummary {
    let exposure_time = set.field(Tag::ExposureTime).and_then(|f| match &f.value {
        Value::Rational(v) => v.first().filter(|r| r.denom != 0 && r.num != 0).map(|r| {
            let secs = r.to_f64();
            if secs < 1.0 {
                format!("1/{}", (1.0 / secs).round() as u64)
            } else {
                format!("{}", round(secs, 1))
            }
        }),
        _ => None,
    });
    let flash = set.field(Tag::Flash).and_then(|f| f.value.get_uint(0)).map(|v| {
        if v & 1 == 1 { "fired" } else { "off" }.to_string()
    });
    let date_raw = date_taken_raw(set);
    ExifSummary {
        make: ascii(set, Tag::Make),
        model: ascii(set, Tag::Model),
        lens: ascii(set, Tag::LensModel).or_else(|| ascii(set, Tag::LensMake)),
        date_taken: date_raw.as_deref().and_then(parse_exif_date).map(|(y, mo, d, h, mi, s)| {
            format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
        }),
        date_taken_offset: ascii(set, Tag::OffsetTimeOriginal).or_else(|| ascii(set, Tag::OffsetTime)),
        exposure_time,
        f_number: rational(set, Tag::FNumber, 0).map(|v| round(v, 1)),
        iso: uint(set, Tag::PhotographicSensitivity),
        focal_length: rational(set, Tag::FocalLength, 0).map(|v| round(v, 1)),
        focal_length_35mm: uint(set, Tag::FocalLengthIn35mmFilm).filter(|&v| v > 0),
        exposure_bias: rational(set, Tag::ExposureBiasValue, 0).map(|v| round(v, 2)),
        flash,
        orientation: set.orientation(),
        software: ascii(set, Tag::Software),
        artist: ascii(set, Tag::Artist),
        copyright: ascii(set, Tag::Copyright),
        description: ascii(set, Tag::ImageDescription),
        gps: gps(set),
    }
}

/// Every readable tag as display text (MakerNote and large binary blobs skipped).
pub fn all_fields(set: &ExifSet) -> Vec<ExifField> {
    let mut out = Vec::new();
    for e in &set.0 {
        for f in e.fields() {
            if f.tag == Tag::MakerNote {
                continue;
            }
            if let Value::Undefined(b, _) | Value::Byte(b) = &f.value {
                if b.len() > 64 {
                    continue;
                }
            }
            let group = match f.tag.context() {
                Context::Tiff => "tiff",
                Context::Exif => "exif",
                Context::Gps => "gps",
                Context::Interop => "interop",
                _ => "other",
            };
            let mut value = f.display_value().with_unit(e).to_string();
            if value.len() > 512 {
                value.truncate(509);
                value.push_str("...");
            }
            out.push(ExifField {
                ifd: if f.ifd_num == In::PRIMARY { "primary" } else { "thumbnail" },
                group,
                tag: f.tag.to_string(),
                id: f.tag.number(),
                value,
            });
        }
    }
    out
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhotoInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Modification time, ms since epoch
    pub mtime: i64,
    /// Detected format: "jpeg", "png", "webp", "gif", "bmp", "tiff", "heif", "avif", "raw", ...
    pub format: String,
    /// Display size (orientation applied); None if the header could not be read
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Whether the webview can show the original file directly
    pub browser_native: bool,
    pub exif: Option<ExifSummary>,
    pub fields: Vec<ExifField>,
}

pub fn photo_info(path: &Path) -> Result<PhotoInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    if !meta.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    let format = decode::detect(path);
    let set = read_path(path);
    let orientation = set.orientation().unwrap_or(1);
    let dims = decode::dimensions(path, format).or_else(|| {
        Some((uint(&set, Tag::PixelXDimension)?, uint(&set, Tag::PixelYDimension)?)).filter(|(w, h)| *w > 0 && *h > 0)
    });
    // Stored size -> display size (some OS HEIF decoders already apply the rotation)
    let dims = dims.map(|(w, h)| {
        if orientation >= 5 && !decode::os_applies_orientation(format) { (h, w) } else { (w, h) }
    });
    Ok(PhotoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: meta.len(),
        mtime: super::mtime_ms(&meta),
        format: format.name().to_string(),
        width: dims.map(|d| d.0),
        height: dims.map(|d| d.1),
        browser_native: format.browser_native(),
        exif: (!set.is_empty()).then(|| summarize(&set)),
        fields: all_fields(&set),
    })
}

// ---------------------------------------------------------------------------
// EXIF (TIFF) blob editing
// ---------------------------------------------------------------------------

/// What to do with metadata when writing a new file.
#[derive(serde::Deserialize, serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MetadataPolicy {
    /// Keep EXIF (orientation reset/updated, stale embedded thumbnail dropped)
    #[default]
    Keep,
    /// Keep EXIF but remove the GPS block (and XMP, which may repeat the location)
    StripGps,
    /// Remove EXIF/XMP/IPTC entirely
    Strip,
}

fn type_size(ty: u16) -> usize {
    match ty {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 => 8,
        _ => 0,
    }
}

/// Mutable view of a TIFF ("Exif\0\0" payload) blob.
pub struct TiffBlob {
    pub data: Vec<u8>,
    le: bool,
}

impl TiffBlob {
    pub fn new(data: Vec<u8>) -> Option<Self> {
        let le = match data.get(0..2)? {
            b"II" => true,
            b"MM" => false,
            _ => return None,
        };
        let b = TiffBlob { data, le };
        (b.u16(2)? == 42).then_some(b)
    }

    fn u16(&self, at: usize) -> Option<u16> {
        let b = [*self.data.get(at)?, *self.data.get(at + 1)?];
        Some(if self.le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    }
    fn u32(&self, at: usize) -> Option<u32> {
        let b: [u8; 4] = self.data.get(at..at + 4)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }
    fn put16(&mut self, at: usize, v: u16) {
        let b = if self.le { v.to_le_bytes() } else { v.to_be_bytes() };
        self.data[at..at + 2].copy_from_slice(&b);
    }
    fn put32(&mut self, at: usize, v: u32) {
        let b = if self.le { v.to_le_bytes() } else { v.to_be_bytes() };
        self.data[at..at + 4].copy_from_slice(&b);
    }

    fn ifd0(&self) -> Option<usize> {
        self.u32(4).map(|o| o as usize).filter(|&o| o >= 8 && o + 2 <= self.data.len())
    }

    /// (entry offset) of `tag` in the IFD at `ifd`.
    fn find(&self, ifd: usize, tag: u16) -> Option<usize> {
        let n = self.u16(ifd)? as usize;
        (0..n).map(|i| ifd + 2 + i * 12).find(|&e| self.u16(e) == Some(tag))
    }

    fn sub_ifd(&self, tag: u16) -> Option<usize> {
        let e = self.find(self.ifd0()?, tag)?;
        self.u32(e + 8).map(|o| o as usize).filter(|&o| o + 2 <= self.data.len())
    }

    pub fn orientation(&self) -> Option<u16> {
        let e = self.find(self.ifd0()?, 0x0112)?;
        self.u16(e + 8)
    }

    /// Sets IFD0 Orientation, adding the tag (by relocating IFD0 to the end) if needed.
    pub fn set_orientation(&mut self, value: u16) -> bool {
        let Some(ifd) = self.ifd0() else { return false };
        if let Some(e) = self.find(ifd, 0x0112) {
            if self.u16(e + 2) == Some(3) {
                self.put16(e + 8, value);
                self.put16(e + 10, 0);
                return true;
            }
        }
        // Relocate IFD0 with the new entry; out-of-line values keep their offsets
        let Some(n) = self.u16(ifd).map(|n| n as usize) else { return false };
        if ifd + 2 + n * 12 + 4 > self.data.len() {
            return false;
        }
        let mut entries: Vec<[u8; 12]> = (0..n)
            .map(|i| self.data[ifd + 2 + i * 12..ifd + 14 + i * 12].try_into().unwrap())
            .filter(|e: &[u8; 12]| {
                let tag = if self.le { u16::from_le_bytes([e[0], e[1]]) } else { u16::from_be_bytes([e[0], e[1]]) };
                tag != 0x0112
            })
            .collect();
        let next = self.u32(ifd + 2 + n * 12).unwrap_or(0);
        let mut new_entry = [0u8; 12];
        let (t, ty, c, v) = if self.le {
            (0x0112u16.to_le_bytes(), 3u16.to_le_bytes(), 1u32.to_le_bytes(), value.to_le_bytes())
        } else {
            (0x0112u16.to_be_bytes(), 3u16.to_be_bytes(), 1u32.to_be_bytes(), value.to_be_bytes())
        };
        new_entry[0..2].copy_from_slice(&t);
        new_entry[2..4].copy_from_slice(&ty);
        new_entry[4..8].copy_from_slice(&c);
        new_entry[8..10].copy_from_slice(&v);
        entries.push(new_entry);
        let tag_of = |e: &[u8; 12]| if self.le { u16::from_le_bytes([e[0], e[1]]) } else { u16::from_be_bytes([e[0], e[1]]) };
        entries.sort_by_key(tag_of);
        if self.data.len() % 2 == 1 {
            self.data.push(0);
        }
        let new_ifd = self.data.len();
        self.data.resize(new_ifd + 2 + entries.len() * 12 + 4, 0);
        self.put16(new_ifd, entries.len() as u16);
        for (i, e) in entries.iter().enumerate() {
            self.data[new_ifd + 2 + i * 12..new_ifd + 14 + i * 12].copy_from_slice(e);
        }
        self.put32(new_ifd + 2 + entries.len() * 12, next);
        self.put32(4, new_ifd as u32);
        true
    }

    /// Unlinks IFD1 (the embedded thumbnail would be stale after edits).
    pub fn drop_thumbnail(&mut self) {
        if let Some(ifd) = self.ifd0() {
            if let Some(n) = self.u16(ifd) {
                let at = ifd + 2 + n as usize * 12;
                if at + 4 <= self.data.len() {
                    self.put32(at, 0);
                }
            }
        }
    }

    /// Updates PixelXDimension/PixelYDimension in the EXIF IFD (in place).
    pub fn set_pixel_dims(&mut self, w: u32, h: u32) {
        let Some(exif_ifd) = self.sub_ifd(0x8769) else { return };
        for (tag, v) in [(0xA002u16, w), (0xA003u16, h)] {
            if let Some(e) = self.find(exif_ifd, tag) {
                match self.u16(e + 2) {
                    Some(3) if v <= u16::MAX as u32 => {
                        self.put16(e + 8, v as u16);
                    }
                    Some(4) => self.put32(e + 8, v),
                    _ => {}
                }
            }
        }
    }

    /// Removes the GPS IFD: zeroes its entries and out-of-line values, then deletes the
    /// GPSInfo pointer from IFD0.
    pub fn strip_gps(&mut self) {
        let Some(ifd0) = self.ifd0() else { return };
        let Some(ptr_entry) = self.find(ifd0, 0x8825) else { return };
        if let Some(gps) = self.u32(ptr_entry + 8).map(|o| o as usize) {
            if let Some(n) = self.u16(gps).map(|n| n as usize) {
                for i in 0..n {
                    let e = gps + 2 + i * 12;
                    let (Some(ty), Some(count)) = (self.u16(e + 2), self.u32(e + 4)) else { break };
                    let size = type_size(ty).saturating_mul(count as usize);
                    if size > 4 {
                        if let Some(off) = self.u32(e + 8).map(|o| o as usize) {
                            if off.saturating_add(size) <= self.data.len() {
                                self.data[off..off + size].fill(0);
                            }
                        }
                    }
                }
                let end = (gps + 2 + n * 12).min(self.data.len());
                self.data[gps..end].fill(0);
            }
        }
        // Remove the pointer entry: shift the following entries + next-IFD pointer up
        let n = self.u16(ifd0).unwrap_or(0) as usize;
        let table_end = ifd0 + 2 + n * 12 + 4;
        if table_end <= self.data.len() {
            self.data.copy_within(ptr_entry + 12..table_end, ptr_entry);
            self.data[table_end - 12..table_end].fill(0);
            self.put16(ifd0, (n - 1) as u16);
        }
    }
}

/// Minimal TIFF blob holding only an orientation tag.
pub fn orientation_only_tiff(orientation: u16) -> Vec<u8> {
    let mut d = b"II*\0\x08\0\0\0\x01\0".to_vec();
    d.extend_from_slice(&0x0112u16.to_le_bytes());
    d.extend_from_slice(&3u16.to_le_bytes());
    d.extend_from_slice(&1u32.to_le_bytes());
    d.extend_from_slice(&(orientation as u32).to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes());
    d
}

/// IFD0 tags worth carrying over when EXIF must be rebuilt from a TIFF/RAW source.
const REBUILD_IFD0: &[Tag] = &[
    Tag::Make,
    Tag::Model,
    Tag::Software,
    Tag::DateTime,
    Tag::Artist,
    Tag::Copyright,
    Tag::ImageDescription,
];

/// Builds a fresh EXIF blob from parsed fields (used when the source EXIF is part of a
/// TIFF/RAW file or too large for a JPEG APP1 segment). MakerNote is not carried over.
pub fn rebuild_tiff(set: &ExifSet, keep_gps: bool) -> Option<Vec<u8>> {
    let little_endian = set.0.first()?.little_endian();
    let fields: Vec<Field> = set
        .0
        .iter()
        .flat_map(|e| e.fields())
        .filter(|f| f.ifd_num == In::PRIMARY && !matches!(f.value, Value::Unknown(..)))
        .filter(|f| match f.tag.context() {
            Context::Tiff => REBUILD_IFD0.contains(&f.tag),
            Context::Exif => f.tag != Tag::MakerNote && f.tag != Tag::InteropIFDPointer,
            Context::Gps => keep_gps,
            _ => false,
        })
        .cloned()
        .collect();
    if fields.is_empty() {
        return None;
    }
    let mut w = exif::experimental::Writer::new();
    for f in &fields {
        w.push_field(f);
    }
    let mut out = std::io::Cursor::new(Vec::new());
    w.write(&mut out, little_endian).ok()?;
    Some(out.into_inner())
}

/// Largest EXIF blob a JPEG APP1 segment can carry ("Exif\0\0" + TIFF).
pub const MAX_APP1_TIFF: usize = 65533 - 6;

/// EXIF blob for a newly written image: orientation set to `orientation`, pixel size
/// updated, stale thumbnail dropped, GPS removed if requested. None = write no EXIF.
pub fn blob_for_output(
    src: &Path,
    policy: MetadataPolicy,
    orientation: u16,
    dims: Option<(u32, u32)>,
) -> Option<Vec<u8>> {
    if policy == MetadataPolicy::Strip {
        return (orientation != 1).then(|| orientation_only_tiff(orientation));
    }
    let set = read_path(src);
    if set.is_empty() {
        return (orientation != 1).then(|| orientation_only_tiff(orientation));
    }
    // A container-embedded EXIF block can be copied verbatim (keeps MakerNote intact);
    // TIFF/RAW sources hold the whole image in that buffer, so rebuild those instead.
    let src_is_tiff = matches!(decode::detect(src), Format::Tiff | Format::Raw);
    let verbatim = (!src_is_tiff && set.0.len() == 1)
        .then(|| set.0[0].buf().to_vec())
        .filter(|b| b.len() <= MAX_APP1_TIFF);
    let data = verbatim.or_else(|| rebuild_tiff(&set, policy != MetadataPolicy::StripGps))?;
    let mut blob = TiffBlob::new(data)?;
    if policy == MetadataPolicy::StripGps {
        blob.strip_gps();
    }
    blob.drop_thumbnail();
    if let Some((w, h)) = dims {
        blob.set_pixel_dims(w, h);
    }
    blob.set_orientation(orientation);
    Some(blob.data).filter(|d| d.len() <= MAX_APP1_TIFF)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::photo::testutil::*;
    use exif::Rational;

    fn r(num: u32, denom: u32) -> Rational {
        Rational { num, denom }
    }

    /// Our own EXIF fixture: camera, date, exposure, orientation and GPS
    /// (41°0'36"N 28°58'48"E, 39 m = Istanbul).
    pub fn sample_exif_tiff(orientation: u16) -> Vec<u8> {
        let fields = vec![
            Field { tag: Tag::Make, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"VHO Test".to_vec()]) },
            Field { tag: Tag::Model, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"Fixture 1".to_vec()]) },
            Field { tag: Tag::Orientation, ifd_num: In::PRIMARY, value: Value::Short(vec![orientation]) },
            Field {
                tag: Tag::DateTimeOriginal,
                ifd_num: In::PRIMARY,
                value: Value::Ascii(vec![b"2024:05:17 14:30:05".to_vec()]),
            },
            Field { tag: Tag::ExposureTime, ifd_num: In::PRIMARY, value: Value::Rational(vec![r(1, 250)]) },
            Field { tag: Tag::FNumber, ifd_num: In::PRIMARY, value: Value::Rational(vec![r(28, 10)]) },
            Field { tag: Tag::PhotographicSensitivity, ifd_num: In::PRIMARY, value: Value::Short(vec![200]) },
            Field { tag: Tag::PixelXDimension, ifd_num: In::PRIMARY, value: Value::Long(vec![64]) },
            Field { tag: Tag::PixelYDimension, ifd_num: In::PRIMARY, value: Value::Long(vec![48]) },
            Field { tag: Tag::GPSLatitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"N".to_vec()]) },
            Field {
                tag: Tag::GPSLatitude,
                ifd_num: In::PRIMARY,
                value: Value::Rational(vec![r(41, 1), r(0, 1), r(36, 1)]),
            },
            Field { tag: Tag::GPSLongitudeRef, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"E".to_vec()]) },
            Field {
                tag: Tag::GPSLongitude,
                ifd_num: In::PRIMARY,
                value: Value::Rational(vec![r(28, 1), r(58, 1), r(48, 1)]),
            },
            Field { tag: Tag::GPSAltitudeRef, ifd_num: In::PRIMARY, value: Value::Byte(vec![0]) },
            Field { tag: Tag::GPSAltitude, ifd_num: In::PRIMARY, value: Value::Rational(vec![r(39, 1)]) },
        ];
        let mut w = exif::experimental::Writer::new();
        for f in &fields {
            w.push_field(f);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        w.write(&mut out, false).unwrap();
        out.into_inner()
    }

    /// JPEG with an APP1 EXIF segment inserted after SOI.
    pub fn jpeg_with_exif(jpeg: &[u8], tiff: &[u8]) -> Vec<u8> {
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(tiff);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    pub fn write_exif_jpeg(path: &Path, w: u32, h: u32, orientation: u16) {
        let jpg = jpeg_bytes(&pattern(w, h), 90);
        std::fs::write(path, jpeg_with_exif(&jpg, &sample_exif_tiff(orientation))).unwrap();
    }

    #[test]
    fn photo_exif_summary_with_gps() {
        let dir = temp_dir("exif");
        let p = dir.join("gps.jpg");
        write_exif_jpeg(&p, 64, 48, 6);
        let info = photo_info(&p).unwrap();
        let ex = info.exif.unwrap();
        assert_eq!(ex.make.as_deref(), Some("VHO Test"));
        assert_eq!(ex.model.as_deref(), Some("Fixture 1"));
        assert_eq!(ex.date_taken.as_deref(), Some("2024-05-17T14:30:05"));
        assert_eq!(ex.exposure_time.as_deref(), Some("1/250"));
        assert_eq!(ex.f_number, Some(2.8));
        assert_eq!(ex.iso, Some(200));
        assert_eq!(ex.orientation, Some(6));
        let gps = ex.gps.unwrap();
        assert!((gps.latitude - 41.01).abs() < 1e-6, "{gps:?}");
        assert!((gps.longitude - 28.98).abs() < 1e-6, "{gps:?}");
        assert_eq!(gps.altitude, Some(39.0));
        // Orientation 6: display size is rotated
        assert_eq!((info.width, info.height), (Some(48), Some(64)));
        assert_eq!(info.format, "jpeg");
        assert!(info.fields.iter().any(|f| f.group == "gps" && f.tag == "GPSLatitude"));
        let ms = file_date_taken_ms(&p).unwrap();
        assert_eq!(ms, 1_715_956_205_000);
    }

    #[test]
    fn exif_blob_edits() {
        let tiff = sample_exif_tiff(1);
        let mut b = TiffBlob::new(tiff.clone()).unwrap();
        assert_eq!(b.orientation(), Some(1));
        assert!(b.set_orientation(8));
        b.strip_gps();
        b.set_pixel_dims(10, 20);
        b.drop_thumbnail();
        let e = read_tiff(b.data.clone()).unwrap();
        let set = ExifSet(vec![e]);
        assert_eq!(set.orientation(), Some(8));
        assert!(gps(&set).is_none());
        assert!(set.field(Tag::GPSLatitude).is_none());
        assert_eq!(uint(&set, Tag::PixelXDimension), Some(10));
        assert_eq!(ascii(&set, Tag::Model).as_deref(), Some("Fixture 1"));
        // The GPS bytes themselves must be gone (privacy), not just unlinked
        let needle = [0u8, 0, 0, 41, 0, 0, 0, 1]; // BE rational 41/1
        assert!(tiff.windows(8).any(|w| w == needle));
        assert!(!b.data.windows(8).any(|w| w == needle));

        // Adding a missing orientation tag relocates IFD0
        let mut w = exif::experimental::Writer::new();
        let f = Field { tag: Tag::Make, ifd_num: In::PRIMARY, value: Value::Ascii(vec![b"X".to_vec()]) };
        w.push_field(&f);
        let mut out = std::io::Cursor::new(Vec::new());
        w.write(&mut out, true).unwrap();
        let mut b = TiffBlob::new(out.into_inner()).unwrap();
        assert_eq!(b.orientation(), None);
        assert!(b.set_orientation(3));
        let set = ExifSet(vec![read_tiff(b.data).unwrap()]);
        assert_eq!(set.orientation(), Some(3));
        assert_eq!(ascii(&set, Tag::Make).as_deref(), Some("X"));
    }

    #[test]
    fn exif_date_parsing() {
        assert_eq!(parse_exif_date("2024:05:17 14:30:05"), Some((2024, 5, 17, 14, 30, 5)));
        assert_eq!(parse_exif_date("0000:00:00 00:00:00"), None);
        assert_eq!(parse_exif_date("    "), None);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }
}
