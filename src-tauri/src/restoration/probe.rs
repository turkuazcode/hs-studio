//! V01 source inspection for video restoration (Plan 12).
//!
//! Everything here is MEASURED or READ from the file, never guessed from the codec name or the
//! file extension. Missing metadata stays `"unknown"`; a later step (the recipe) has to state an
//! explicit assumption or ask the user.
//!
//! Three sources, all through the D1 runner (`actions::ffmpeg`: same ffmpeg/ffprobe lookup,
//! same separate-process LGPL build):
//! 1. `ffprobe -show_format -show_streams` (stream list, timebase, SAR/DAR, rotation, field
//!    order flag, pixel format, colour tags, HDR side data),
//! 2. a short packet-timestamp sample (`-read_intervals START%+#N`) → CFR/VFR,
//! 3. a short decode with ffmpeg's `idet` filter → field order by content.
//!
//! The parsers are pure functions (unit tested with recorded JSON / log text); `probe_source`
//! only runs the tools.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::actions::ffmpeg::{self, Tools};

/// Number of video packets / frames used for the CFR/VFR and field order analysis.
pub const SAMPLE_FRAMES: u32 = 300;
/// Upper bound for the whole short-sample analysis (decode of `SAMPLE_FRAMES`).
pub const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(45);
pub const UNKNOWN: &str = "unknown";

// ---------------------------------------------------------------------------
// Report types (front-end contract, camelCase)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    /// "30000/1001", "16:11"; None for "0/0", "0:1", "N/A", "" (= unknown).
    pub fn parse(s: &str) -> Option<Rational> {
        let (a, b) = s.split_once(['/', ':'])?;
        let (num, den) = (a.trim().parse::<i64>().ok()?, b.trim().parse::<i64>().ok()?);
        (num > 0 && den > 0).then_some(Rational { num, den })
    }
    pub fn value(self) -> f64 {
        self.num as f64 / self.den as f64
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FieldOrder {
    Progressive,
    Tff,
    Bff,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FieldOrderSource {
    /// Container/codec flag and content analysis agree
    MetadataAndAnalysis,
    /// Content analysis only (flag missing)
    Analysis,
    /// Flag only (analysis inconclusive, e.g. static picture)
    Metadata,
    /// Flag and analysis disagree: the user has to choose
    Conflict,
    /// Neither: the user has to choose
    Unknown,
}

/// idet "Multi frame detection" counters.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IdetCounts {
    pub tff: u32,
    pub bff: u32,
    pub progressive: u32,
    pub undetermined: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldOrderInfo {
    /// Final value; `Unknown` when `needs_choice`
    pub value: FieldOrder,
    /// What the file says (`field_order` of ffprobe)
    pub metadata: FieldOrder,
    /// What the short sample says (None: no analysis ran / failed)
    pub detected: Option<FieldOrder>,
    pub counts: Option<IdetCounts>,
    pub source: FieldOrderSource,
    /// True when the recipe must carry an explicit user choice (TFF / BFF / progressive)
    pub needs_choice: bool,
    /// Suggested choice for the technical details (never applied silently)
    pub suggestion: FieldOrder,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RateMode {
    Cfr,
    Vfr,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameRateInfo {
    pub mode: RateMode,
    /// 1 / median frame duration of the sample
    pub measured_fps: Option<f64>,
    /// Container/codec rates (r_frame_rate / avg_frame_rate)
    pub r_frame_rate: Option<Rational>,
    pub avg_frame_rate: Option<Rational>,
    /// Frame durations in the sample (count) and how many deviated from the median
    pub samples: u32,
    pub irregular: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    /// ffprobe names (bt709, bt470bg, smpte170m, bt2020, smpte2084, arib-std-b67, tv, pc...)
    /// or "unknown"
    pub primaries: String,
    pub transfer: String,
    pub matrix: String,
    pub range: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DynamicRange {
    Sdr,
    HdrPq,
    HdrHlg,
    DolbyVision,
    /// Transfer not tagged and no HDR side data
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// Absolute stream index (`0:<index>`)
    pub index: u32,
    pub codec: String,
    pub profile: String,
    /// Coded size
    pub width: u32,
    pub height: u32,
    pub sar: Option<Rational>,
    pub dar: Option<Rational>,
    /// Counter-clockwise degrees from the display matrix (0 / 90 / 180 / 270; raw if odd)
    pub rotation: i32,
    /// Size shown to the viewer: SAR applied (square pixels), rotation applied
    pub display_width: u32,
    pub display_height: u32,
    pub time_base: Option<Rational>,
    pub frame_rate: FrameRateInfo,
    pub field_order: FieldOrderInfo,
    pub pix_fmt: String,
    pub bit_depth: Option<u32>,
    pub color: ColorInfo,
    pub dynamic_range: DynamicRange,
    /// HDR side data seen (mastering display, content light level, Dolby Vision)
    pub hdr_side_data: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub language: String,
    pub title: String,
    pub default: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleInfo {
    pub index: u32,
    pub codec: String,
    pub language: String,
    /// Text subtitles can be copied/converted; bitmap ones (PGS, DVD) only copied
    pub text: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFingerprint {
    pub path: String,
    pub size: u64,
    /// Modification time, ms since the Unix epoch (0 when unavailable)
    pub modified_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub schema: u32,
    pub source: SourceFingerprint,
    pub container: String,
    pub duration: Option<f64>,
    /// First real video stream (cover art is skipped)
    pub video: Option<VideoInfo>,
    pub audio: Vec<AudioInfo>,
    pub subtitles: Vec<SubtitleInfo>,
    /// Start of the analysed sample (seconds)
    pub sample_start: f64,
    /// Analysis problems that did not stop the probe (`idet-failed`, `timestamps-failed`...)
    pub notes: Vec<String>,
}

pub const REPORT_SCHEMA: u32 = 1;

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

fn text(v: &Value) -> String {
    match v {
        Value::String(s) if !s.is_empty() && s != "N/A" => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn known(v: &Value) -> String {
    let s = text(v);
    if s.is_empty() || s == "unknown" || s == "reserved" || s == "unspecified" { UNKNOWN.into() } else { s }
}

fn number<T: std::str::FromStr>(v: &Value) -> Option<T> {
    text(v).parse().ok()
}

/// ffprobe `field_order`: tt/bt = top field displayed first, bb/tb = bottom displayed first
/// (FFmpeg `AVFieldOrder`: the second letter is the display order).
pub fn field_order_flag(s: &str) -> FieldOrder {
    match s {
        "progressive" => FieldOrder::Progressive,
        "tt" | "bt" => FieldOrder::Tff,
        "bb" | "tb" => FieldOrder::Bff,
        _ => FieldOrder::Unknown,
    }
}

/// Bit depth: `bits_per_raw_sample` when present, else from the decoded pixel format name.
pub fn bit_depth(bits_per_raw_sample: &Value, pix_fmt: &str) -> Option<u32> {
    if let Some(b) = number::<u32>(bits_per_raw_sample).filter(|b| *b > 0) {
        return Some(b);
    }
    if pix_fmt.is_empty() {
        return None;
    }
    let digits = |tag: &str| -> Option<u32> {
        let i = pix_fmt.find(tag)? + tag.len();
        let d: String = pix_fmt[i..].chars().take_while(char::is_ascii_digit).collect();
        d.parse().ok()
    };
    // yuv420p10le, yuv422p12be, gbrp16le, gray10le, p010le, p016le
    if let Some(d) = digits("p").filter(|d| (9..=16).contains(d)) {
        return Some(d);
    }
    if let Some(d) = digits("gray").filter(|d| (9..=16).contains(d)) {
        return Some(d);
    }
    match pix_fmt {
        "p010le" | "p010be" | "x2rgb10le" | "x2bgr10le" | "y210le" => Some(10),
        "p012le" | "p012be" => Some(12),
        "p016le" | "p016be" | "rgb48le" | "rgb48be" | "rgba64le" | "rgba64be" => Some(16),
        f if f.starts_with("yuv") || f.starts_with("yuvj") || f.starts_with("nv") || f.starts_with("gray")
            || f.starts_with("rgb") || f.starts_with("bgr") || f.starts_with("gbrp") || f.starts_with("uyvy")
            || f.starts_with("yuyv") || f.starts_with("argb") || f.starts_with("abgr") || f.starts_with("rgba")
            || f.starts_with("bgra") || f == "pal8" => Some(8),
        _ => None,
    }
}

const SDR_TRANSFERS: &[&str] = &[
    "bt709", "smpte170m", "bt470m", "bt470bg", "gamma22", "gamma28", "smpte240m", "iec61966-2-1", "iec61966-2-4",
    "bt1361e", "bt2020-10", "bt2020-12", "linear",
];

pub fn dynamic_range(color: &ColorInfo, side_data: &[String]) -> DynamicRange {
    if side_data.iter().any(|s| s.contains("DOVI") || s.contains("Dolby Vision")) {
        return DynamicRange::DolbyVision;
    }
    match color.transfer.as_str() {
        "smpte2084" => DynamicRange::HdrPq,
        "arib-std-b67" => DynamicRange::HdrHlg,
        t if SDR_TRANSFERS.contains(&t) => {
            // HDR10 static metadata without a PQ tag is contradictory: do not call it SDR
            if side_data.iter().any(|s| s.contains("Mastering display") || s.contains("Content light")) {
                DynamicRange::Unknown
            } else {
                DynamicRange::Sdr
            }
        }
        _ if side_data.iter().any(|s| s.contains("Mastering display") || s.contains("Content light")) => DynamicRange::HdrPq,
        _ => DynamicRange::Unknown,
    }
}

/// Size shown to the viewer: SAR applied to the width (even numbers), then rotation.
pub fn display_size(width: u32, height: u32, sar: Option<Rational>, rotation: i32) -> (u32, u32) {
    let w = match sar {
        Some(r) if r.num != r.den => ((width as f64 * r.value() / 2.0).round() as u32 * 2).max(2),
        _ => width,
    };
    if rotation.rem_euclid(180) == 90 { (height, w) } else { (w, height) }
}

fn normalize_rotation(r: f64) -> i32 {
    let r = r.round() as i32;
    let n = r.rem_euclid(360);
    if n % 90 == 0 { n } else { r }
}

/// ffprobe JSON (`-show_format -show_streams`) → report without the sample analysis
/// (frame rate mode `Unknown`, field order from the flag only).
pub fn parse_streams(json: &Value, source: SourceFingerprint) -> SourceReport {
    let fmt = &json["format"];
    let mut report = SourceReport {
        schema: REPORT_SCHEMA,
        source,
        container: text(&fmt["format_name"]),
        duration: number::<f64>(&fmt["duration"]).filter(|d| d.is_finite() && *d > 0.0),
        video: None,
        audio: vec![],
        subtitles: vec![],
        sample_start: 0.0,
        notes: vec![],
    };
    for s in json["streams"].as_array().into_iter().flatten() {
        let index = s["index"].as_u64().unwrap_or(0) as u32;
        let tag = |k: &str| text(&s["tags"][k]);
        let codec = text(&s["codec_name"]);
        match s["codec_type"].as_str() {
            Some("video") if s["disposition"]["attached_pic"].as_i64() == Some(1) => {}
            Some("video") if report.video.is_none() => {
                let side: Vec<&Value> = s["side_data_list"].as_array().into_iter().flatten().collect();
                let rotation = side
                    .iter()
                    .find_map(|d| d["rotation"].as_f64())
                    .or_else(|| tag("rotate").parse::<f64>().ok().map(|r| -r)) // legacy tag is clockwise
                    .map_or(0, normalize_rotation);
                let hdr_side_data: Vec<String> = side
                    .iter()
                    .filter_map(|d| d["side_data_type"].as_str())
                    .filter(|t| t.contains("Mastering display") || t.contains("Content light") || t.contains("DOVI") || t.contains("Dolby"))
                    .map(str::to_string)
                    .collect();
                let (width, height) = (number(&s["width"]).unwrap_or(0), number(&s["height"]).unwrap_or(0));
                let sar = Rational::parse(&text(&s["sample_aspect_ratio"]));
                let pix_fmt = text(&s["pix_fmt"]);
                let color = ColorInfo {
                    primaries: known(&s["color_primaries"]),
                    transfer: known(&s["color_transfer"]),
                    matrix: known(&s["color_space"]),
                    range: known(&s["color_range"]),
                };
                let metadata = field_order_flag(&text(&s["field_order"]));
                let (display_width, display_height) = display_size(width, height, sar, rotation);
                report.video = Some(VideoInfo {
                    index,
                    profile: text(&s["profile"]),
                    codec,
                    width,
                    height,
                    sar,
                    dar: Rational::parse(&text(&s["display_aspect_ratio"])),
                    rotation,
                    display_width,
                    display_height,
                    time_base: Rational::parse(&text(&s["time_base"])),
                    frame_rate: FrameRateInfo {
                        mode: RateMode::Unknown,
                        measured_fps: None,
                        r_frame_rate: Rational::parse(&text(&s["r_frame_rate"])),
                        avg_frame_rate: Rational::parse(&text(&s["avg_frame_rate"])),
                        samples: 0,
                        irregular: 0,
                    },
                    field_order: classify_field_order(metadata, None),
                    bit_depth: bit_depth(&s["bits_per_raw_sample"], &pix_fmt),
                    pix_fmt: if pix_fmt.is_empty() { UNKNOWN.into() } else { pix_fmt },
                    dynamic_range: dynamic_range(&color, &hdr_side_data),
                    color,
                    hdr_side_data,
                });
            }
            Some("audio") => report.audio.push(AudioInfo {
                index,
                codec,
                channels: number(&s["channels"]).unwrap_or(0),
                sample_rate: number(&s["sample_rate"]).unwrap_or(0),
                language: tag("language"),
                title: tag("title"),
                default: s["disposition"]["default"].as_i64() == Some(1),
            }),
            Some("subtitle") => report.subtitles.push(SubtitleInfo {
                index,
                text: !["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext"].contains(&codec.as_str()),
                codec,
                language: tag("language"),
            }),
            _ => {}
        }
    }
    report
}

/// Last "Multi frame detection" line of ffmpeg's idet log (the filter may print twice when the
/// graph is reconfigured; the last one has the real counts).
pub fn parse_idet(log: &str) -> Option<IdetCounts> {
    let line = log.lines().rev().find(|l| l.contains("Multi frame detection:"))?;
    let rest = &line[line.find("Multi frame detection:")? + "Multi frame detection:".len()..];
    let value = |key: &str| -> Option<u32> {
        let i = rest.find(key)? + key.len();
        rest[i..].trim_start().split_whitespace().next()?.parse().ok()
    };
    Some(IdetCounts {
        tff: value("TFF:")?,
        bff: value("BFF:")?,
        progressive: value("Progressive:")?,
        undetermined: value("Undetermined:")?,
    })
}

/// Content verdict of idet: a clear majority (≥ 80 %) of at least 10 decided frames that are also
/// ≥ 30 % of all analysed frames; otherwise None (static / ambiguous picture).
pub fn idet_verdict(c: &IdetCounts) -> Option<FieldOrder> {
    let decided = c.tff + c.bff + c.progressive;
    let total = decided + c.undetermined;
    if decided < 10 || (decided as f64) < 0.3 * total as f64 {
        return None;
    }
    let (best, n) = [(FieldOrder::Tff, c.tff), (FieldOrder::Bff, c.bff), (FieldOrder::Progressive, c.progressive)]
        .into_iter()
        .max_by_key(|(_, n)| *n)?;
    (n as f64 >= 0.8 * decided as f64).then_some(best)
}

/// Combines the file's flag with the content analysis. Disagreement or no information never
/// becomes a silent assumption: `needs_choice` is set and `value` stays `Unknown`.
pub fn classify_field_order(metadata: FieldOrder, counts: Option<IdetCounts>) -> FieldOrderInfo {
    let detected = counts.as_ref().and_then(idet_verdict);
    let (value, source) = match (metadata, detected) {
        (m, Some(d)) if m == d => (m, FieldOrderSource::MetadataAndAnalysis),
        (FieldOrder::Unknown, Some(d)) => (d, FieldOrderSource::Analysis),
        (_, Some(_)) => (FieldOrder::Unknown, FieldOrderSource::Conflict),
        // Analysis inconclusive (or not run): a progressive flag is trusted only together with a
        // successful analysis; an interlaced flag is kept but still needs confirmation.
        (FieldOrder::Unknown, None) => (FieldOrder::Unknown, FieldOrderSource::Unknown),
        (m, None) => (m, FieldOrderSource::Metadata),
    };
    let needs_choice = match source {
        FieldOrderSource::MetadataAndAnalysis | FieldOrderSource::Analysis => false,
        FieldOrderSource::Metadata => counts.is_some() && metadata != FieldOrder::Progressive,
        FieldOrderSource::Conflict | FieldOrderSource::Unknown => true,
    };
    let suggestion = detected.unwrap_or(if metadata == FieldOrder::Unknown { FieldOrder::Progressive } else { metadata });
    FieldOrderInfo {
        value: if needs_choice { FieldOrder::Unknown } else { value },
        metadata,
        detected,
        counts,
        source,
        needs_choice,
        suggestion,
    }
}

/// CFR/VFR from a sample of presentation timestamps (any order, in `time_base` ticks).
/// A frame duration counts as irregular when it differs from the median by more than
/// max(2 ticks, 10 %) (millisecond timebases round 29.97 fps to 33/34 ms); VFR when more than
/// 5 % (at least 2) are irregular.
pub fn analyze_timestamps(pts: &[i64], time_base: Option<Rational>) -> (RateMode, Option<f64>, u32, u32) {
    let mut p: Vec<i64> = pts.to_vec();
    p.sort_unstable();
    p.dedup();
    let deltas: Vec<i64> = p.windows(2).map(|w| w[1] - w[0]).filter(|d| *d > 0).collect();
    if deltas.len() < 3 {
        return (RateMode::Unknown, None, deltas.len() as u32, 0);
    }
    let mut sorted = deltas.clone();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];
    let tol = (median as f64 * 0.10).max(2.0);
    let irregular = deltas.iter().filter(|d| (**d - median).abs() as f64 > tol).count() as u32;
    let mode = if irregular >= 2 && irregular as f64 > 0.05 * deltas.len() as f64 { RateMode::Vfr } else { RateMode::Cfr };
    let fps = time_base.map(|tb| tb.den as f64 / (median as f64 * tb.num as f64)).filter(|f| f.is_finite() && *f > 0.0);
    (mode, fps, deltas.len() as u32, irregular)
}

/// `pts` column of `ffprobe -show_entries packet=pts -of csv=p=0` (N/A lines skipped).
pub fn parse_pts_csv(out: &str) -> Vec<i64> {
    out.lines().filter_map(|l| l.trim().trim_end_matches(',').parse().ok()).collect()
}

/// Where the short sample starts: skip intros of long files (10 %, at most 60 s).
pub fn sample_start(duration: Option<f64>) -> f64 {
    match duration {
        Some(d) if d > 30.0 => (d * 0.1).min(60.0).floor(),
        _ => 0.0,
    }
}

// ---------------------------------------------------------------------------
// Running the tools
// ---------------------------------------------------------------------------

pub fn fingerprint(path: &Path) -> Result<SourceFingerprint, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{} {e}", crate::actions::ERR_INVALID))?;
    if !meta.is_file() {
        return Err(format!("{} not a file", crate::actions::ERR_INVALID));
    }
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(SourceFingerprint { path: path.to_string_lossy().into_owned(), size: meta.len(), modified_ms })
}

fn ffprobe_json(tools: &Tools, path: &Path) -> Result<Value, String> {
    let out = ffmpeg::command(&tools.ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i"])
        .arg(path)
        .output()
        .map_err(|e| format!("{} ffprobe: {e}", crate::actions::ERR_NO_FFMPEG))?;
    if !out.status.success() {
        return Err(format!("{} {}", crate::actions::ERR_UNSUPPORTED, String::from_utf8_lossy(&out.stderr).trim()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("{} {e}", crate::actions::ERR_UNSUPPORTED))
}

fn sample_pts(tools: &Tools, path: &Path, stream: u32, start: f64) -> Result<Vec<i64>, String> {
    let out = ffmpeg::command(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", &stream.to_string(), "-read_intervals"])
        .arg(format!("{start}%+#{SAMPLE_FRAMES}"))
        .args(["-show_entries", "packet=pts", "-of", "csv=p=0", "-i"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_pts_csv(&String::from_utf8_lossy(&out.stdout)))
}

fn sample_idet(tools: &Tools, path: &Path, stream: u32, start: f64, cancelled: &dyn Fn() -> bool) -> Result<IdetCounts, String> {
    let deadline = Instant::now() + ANALYSIS_TIMEOUT;
    let stop = || cancelled() || Instant::now() > deadline;
    // -noautorotate: fields are lines of the CODED picture; a rotated picture has no fields.
    let args: Vec<String> = [
        "-noautorotate", "-ss", &start.to_string(), "-i", &path.to_string_lossy(), "-map", &format!("0:{stream}"),
        "-an", "-sn", "-dn", "-frames:v", &SAMPLE_FRAMES.to_string(), "-vf", "idet", "-f", "null", "-",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let log = ffmpeg::run_ffmpeg(&tools.ffmpeg, &args, 0.0, &stop, |_| {})?;
    parse_idet(&log).ok_or_else(|| "idet: no summary".to_string())
}

/// Full V01 probe: stream list + short-sample analysis. `cancelled` stops the analysis.
pub fn probe_source_with(tools: &Tools, path: &Path, cancelled: &dyn Fn() -> bool) -> Result<SourceReport, String> {
    let fp = fingerprint(path)?;
    let json = ffprobe_json(tools, path)?;
    let mut report = parse_streams(&json, fp);
    let start = sample_start(report.duration);
    report.sample_start = start;
    let mut notes: Vec<String> = vec![];
    let Some(video) = report.video.as_mut() else { return Ok(report) };
    match sample_pts(tools, path, video.index, start) {
        Ok(pts) => {
            let (mode, fps, samples, irregular) = analyze_timestamps(&pts, video.time_base);
            video.frame_rate.mode = mode;
            video.frame_rate.measured_fps = fps;
            video.frame_rate.samples = samples;
            video.frame_rate.irregular = irregular;
        }
        Err(_) => notes.push("timestamps-failed".into()),
    }
    let metadata = video.field_order.metadata;
    match sample_idet(tools, path, video.index, start, cancelled) {
        Ok(counts) => video.field_order = classify_field_order(metadata, Some(counts)),
        Err(e) if e.starts_with(crate::photo::ERR_CANCELLED) && cancelled() => return Err(e),
        Err(_) => {
            notes.push("idet-failed".into());
            // no analysis: an interlaced/unknown flag needs a user choice (a progressive flag is kept)
            let mut fo = classify_field_order(metadata, None);
            if fo.metadata != FieldOrder::Progressive {
                fo.needs_choice = true;
                fo.value = FieldOrder::Unknown;
            }
            video.field_order = fo;
        }
    }
    report.notes.extend(notes);
    Ok(report)
}

/// Filters of the ffmpeg build (`ffmpeg -filters`), to verify a recipe can run.
pub fn available_filters(tools: &Tools) -> Vec<String> {
    let Ok(out) = ffmpeg::command(&tools.ffmpeg).args(["-hide_banner", "-filters"]).output() else { return vec![] };
    parse_filters(&String::from_utf8_lossy(&out.stdout))
}

/// ` TS bwdif   V->V   Deinterlace the input image.` → "bwdif"
pub fn parse_filters(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|l| {
            let mut p = l.split_whitespace();
            let flags = p.next()?;
            let name = p.next()?;
            let io = p.next()?;
            (flags.len() <= 3 && flags.chars().all(|c| matches!(c, 'T' | 'S' | 'C' | '.')) && io.contains("->"))
                .then(|| name.to_string())
        })
        .collect()
}
