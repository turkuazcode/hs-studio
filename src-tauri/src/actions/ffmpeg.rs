//! Video / music exports through the LGPL `ffmpeg.exe` built together with libmpv
//! (third_party/mpv; configured without `--enable-gpl`). It always runs as a SEPARATE PROCESS
//! (never linked), located like the mpv DLLs: `VHO_FFMPEG` (file or folder), next to the exe,
//! `<exe>/mpv/`, `<exe>/resources/mpv/` (plus `PATH` outside Windows).
//!
//! Encoders (no x264/x265 in an LGPL build):
//! - Video: chosen AT RUN TIME (`encoder_choice`, P04): the platform's H.264 candidates
//!   (`H264_CANDIDATES`: Windows `h264_mf` then AMF/QSV/NVENC/OpenH264 when the build has them,
//!   macOS `h264_videotoolbox`, Linux `libopenh264`) must be listed by `ffmpeg -encoders` AND
//!   pass a real short encode; otherwise ffmpeg's own `mpeg4` is the fallback. Each encoder's
//!   pixel format and maximum frame size are applied to the job (`encoder_scale`); HDR input is
//!   refused for re-encoding (`check_encodable`). Only the Windows path is tested.
//! - AAC: ffmpeg's native `aac`; Opus: native `opus` (experimental flag, 48 kHz); FLAC, WAV;
//!   MP3: `mp3_mf` (Media Foundation) on Windows. GIF: native `gif` with a generated palette.
//!
//! Every job: `-progress pipe:1` (progress events), cancellable (the child is killed), output
//! written to a partial file and renamed when complete.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::files::unique_path;
use super::{ERR_INVALID, ERR_NO_FFMPEG, ERR_UNSUPPORTED};
use crate::photo::ERR_CANCELLED;

/// Preferred H.264 encoder of this platform (= first of `H264_CANDIDATES`; the one actually
/// used is the runtime choice).
#[cfg(windows)]
pub const H264_ENCODER: &str = "h264_mf";
#[cfg(target_os = "macos")]
pub const H264_ENCODER: &str = "h264_videotoolbox";
#[cfg(not(any(windows, target_os = "macos")))]
pub const H264_ENCODER: &str = "libopenh264";

/// MP3 encoder (LAME would also be LGPL, but only as a separate process / dynamic library).
#[cfg(windows)]
pub const MP3_ENCODER: &str = "mp3_mf";
#[cfg(not(windows))]
pub const MP3_ENCODER: &str = "libmp3lame";

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

// ---------------------------------------------------------------------------
// Video encoder selection (P04): runtime probe + fallback, with each encoder's constraints
// ---------------------------------------------------------------------------

/// A video encoder VHO may use for re-encoded exports, with the limits it imposes. Hardware /
/// OS encoders only take 8-bit 4:2:0 in a fixed pixel format and have a maximum frame size;
/// none of them tone-maps HDR (see `check_encodable`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoEncoder {
    pub name: &'static str,
    /// "h264" or the fallback codec ("mpeg4": MPEG-4 Part 2, ffmpeg's own LGPL encoder)
    pub codec: &'static str,
    /// OS/hardware encoder (Media Foundation, VideoToolbox): may use the GPU
    pub hardware: bool,
    pub pix_fmt: &'static str,
    /// Largest frame in landscape orientation (portrait: swapped)
    pub max_width: u32,
    pub max_height: u32,
}

const fn enc(name: &'static str, codec: &'static str, hardware: bool, pix_fmt: &'static str, max_width: u32, max_height: u32) -> VideoEncoder {
    VideoEncoder { name, codec, hardware, pix_fmt, max_width, max_height }
}

/// Last resort on every platform: always in an LGPL ffmpeg, plays in common players, not H.264.
pub const FALLBACK_ENCODER: VideoEncoder = enc("mpeg4", "mpeg4", false, "yuv420p", 7680, 4320);

/// Candidates in order of preference. `h264_d3d12va` / `h264_vulkan` exist in the Windows
/// build but failed on the reference AMD iGPU (filter format errors) and need hwupload
/// graphs: not candidates. VAAPI needs a device + hwupload: not a candidate yet.
#[cfg(windows)]
pub const H264_CANDIDATES: &[VideoEncoder] = &[
    // Media Foundation picks the GPU MFT (AMD/Intel/NVIDIA) or Microsoft's software encoder;
    // AMD VCN / MS software H.264: level 5.1 frame limits
    enc("h264_mf", "h264", true, "nv12", 4096, 2160),
    enc("h264_amf", "h264", true, "nv12", 4096, 2160),
    enc("h264_qsv", "h264", true, "nv12", 4096, 2160),
    enc("h264_nvenc", "h264", true, "nv12", 4096, 4096),
    enc("libopenh264", "h264", false, "yuv420p", 3840, 2160),
];
#[cfg(target_os = "macos")]
pub const H264_CANDIDATES: &[VideoEncoder] =
    &[enc("h264_videotoolbox", "h264", true, "nv12", 4096, 2304), enc("libopenh264", "h264", false, "yuv420p", 3840, 2160)];
#[cfg(not(any(windows, target_os = "macos")))]
pub const H264_CANDIDATES: &[VideoEncoder] = &[enc("libopenh264", "h264", false, "yuv420p", 3840, 2160)];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderAttempt {
    pub name: &'static str,
    /// Listed by `ffmpeg -encoders`
    pub present: bool,
    /// A real short encode succeeded
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncoderChoice {
    pub encoder: VideoEncoder,
    /// No H.264 candidate worked: `FALLBACK_ENCODER` is used
    pub fallback: bool,
    pub attempts: Vec<EncoderAttempt>,
}

/// Pure selection: first candidate that is listed AND passes `probe`; else the fallback.
/// Listing alone is not enough (h264_mf is listed in every Windows build, but MF can fail on
/// a machine without a working H.264 MFT).
pub fn select_encoder(candidates: &[VideoEncoder], present: &[String], probe: &dyn Fn(&VideoEncoder) -> Result<(), String>) -> EncoderChoice {
    let mut attempts = vec![];
    for c in candidates {
        let listed = present.iter().any(|p| p == c.name);
        let result = if listed { probe(c) } else { Err("not in this ffmpeg build".into()) };
        let ok = result.is_ok();
        attempts.push(EncoderAttempt { name: c.name, present: listed, ok, error: result.err() });
        if ok {
            return EncoderChoice { encoder: *c, fallback: false, attempts };
        }
    }
    EncoderChoice { encoder: FALLBACK_ENCODER, fallback: true, attempts }
}

/// Real probe: 8 frames 640x360 through the encoder into an MP4 (muxing included), <= 20 s.
pub fn probe_encoder(tools: &Tools, e: &VideoEncoder) -> Result<(), String> {
    let out = std::env::temp_dir().join(format!("vho-encprobe-{}-{}.mp4", std::process::id(), e.name));
    let mut args = s(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-frames:v", "8", "-an"]);
    args.extend(video_codec_args(e, 800, false));
    args.extend(s(["-loglevel", "error"]));
    args.push(out.to_string_lossy().into_owned());
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let r = run_ffmpeg(&tools.ffmpeg, &args, 0.0, &|| std::time::Instant::now() > deadline, |_| {});
    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&out);
    r.and_then(|_| if size > 0 { Ok(()) } else { Err("empty output".into()) })
}

/// Encoder used by `plan()` when no runtime choice is given (first candidate of the platform).
pub fn default_encoder() -> VideoEncoder {
    H264_CANDIDATES[0]
}

/// Encoder arguments for `kbps` (CBR when the size matters).
pub fn video_codec_args(e: &VideoEncoder, kbps: u32, cbr: bool) -> Vec<String> {
    let mut v = s(["-c:v", e.name, "-b:v"]);
    v.push(format!("{kbps}k"));
    v.extend(s(["-pix_fmt", e.pix_fmt]));
    if e.name == "h264_mf" {
        // "cbr" keeps the e-mail preset under its size limit
        v.extend(s(["-rate_control", if cbr { "cbr" } else { "u_vbr" }]));
    } else if cbr {
        v.push("-maxrate".into());
        v.push(format!("{kbps}k"));
        v.push("-bufsize".into());
        v.push(format!("{}k", kbps * 2));
    }
    v
}

/// `scale=` that makes a WxH output acceptable for the encoder (even size, inside its
/// maximum frame in the same orientation), or None when it already is.
pub fn encoder_scale(w: u32, h: u32, e: &VideoEncoder) -> Option<String> {
    if w == 0 || h == 0 {
        return Some("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    }
    let (mw, mh) = if w >= h { (e.max_width, e.max_height) } else { (e.max_height, e.max_width) };
    if w <= mw && h <= mh && w % 2 == 0 && h % 2 == 0 {
        return None;
    }
    let r = (mw as f64 / w as f64).min(mh as f64 / h as f64).min(1.0);
    let even = |v: f64| ((v / 2.0).floor() as u32 * 2).max(2);
    Some(format!("scale={}:{}", even(w as f64 * r), even(h as f64 * r)))
}

/// HDR (PQ/HLG) cannot be re-encoded correctly: no tone mapping in this LGPL build and the
/// encoders take 8-bit SDR only. Refuse instead of writing washed-out SDR.
pub fn check_encodable(v: &VideoStream) -> Result<(), String> {
    if matches!(v.color_transfer.as_str(), "smpte2084" | "arib-std-b67") {
        return Err(format!("{ERR_UNSUPPORTED} HDR video yeniden kodlanamaz (ton eşleme yok); kayıpsız kesim kullanılabilir"));
    }
    Ok(())
}

/// Runtime choice for this machine (probed once, cached). None without ffmpeg.
pub fn encoder_choice() -> Option<EncoderChoice> {
    tools_info().video_encoder
}

// ---------------------------------------------------------------------------
// Locating the tools
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

fn candidates() -> Vec<PathBuf> {
    let mut dirs = vec![];
    if let Some(p) = std::env::var_os("VHO_FFMPEG").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        dirs.push(if p.is_file() { p.parent().map(Path::to_path_buf).unwrap_or_default() } else { p });
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(d.clone());
        dirs.push(d.join("mpv"));
        dirs.push(d.join("resources").join("mpv"));
    }
    dirs
}

pub fn locate() -> Result<Tools, String> {
    let found = candidates().into_iter().find_map(|d| {
        let ffmpeg = d.join(format!("ffmpeg{EXE}"));
        let ffprobe = d.join(format!("ffprobe{EXE}"));
        (ffmpeg.is_file() && ffprobe.is_file()).then_some(Tools { ffmpeg, ffprobe })
    });
    if let Some(t) = found {
        return Ok(t);
    }
    if !cfg!(windows) {
        // macOS / Linux: a system ffmpeg is acceptable (the user's own install)
        return Ok(Tools { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() });
    }
    Err(format!("{ERR_NO_FFMPEG} ffmpeg.exe bulunamadı (npm run stage:mpv)"))
}

pub(crate) fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolsInfo {
    pub available: bool,
    pub ffmpeg: Option<String>,
    pub version: Option<String>,
    /// Video encoder exports use (runtime choice; the fallback when no H.264 encoder works)
    pub h264_encoder: &'static str,
    /// An H.264 encoder passed the runtime probe
    pub h264_available: bool,
    /// Runtime selection with every attempt (None without ffmpeg)
    pub video_encoder: Option<EncoderChoice>,
    /// Relevant encoders present in this ffmpeg build
    pub encoders: Vec<String>,
    pub error: Option<String>,
}

const INTERESTING: &[&str] = &[
    "h264_mf", "hevc_mf", "h264_videotoolbox", "libopenh264", "h264_vaapi", "libx264", "h264_amf", "h264_qsv", "h264_nvenc", "mpeg4", "aac", "aac_mf", "opus", "libopus",
    "flac", "alac", "mp3_mf", "libmp3lame", "pcm_s16le", "gif", "png", "libwebp", "srt", "ass", "webvtt", "mov_text",
];

fn encoders(tools: &Tools) -> Vec<String> {
    let Ok(out) = command(&tools.ffmpeg).args(["-hide_banner", "-encoders"]).output() else { return vec![] };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let flags = parts.next()?;
            let name = parts.next()?;
            (flags.len() == 6 && INTERESTING.contains(&name)).then(|| name.to_string())
        })
        .collect()
}

/// Cached: encoders do not change while running.
pub fn tools_info() -> ToolsInfo {
    static INFO: OnceLock<ToolsInfo> = OnceLock::new();
    INFO.get_or_init(|| match locate() {
        Err(e) => ToolsInfo {
            available: false, ffmpeg: None, version: None, h264_encoder: H264_ENCODER, h264_available: false,
            video_encoder: None, encoders: vec![], error: Some(e),
        },
        Ok(t) => {
            let version = command(&t.ffmpeg)
                .args(["-hide_banner", "-version"])
                .output()
                .ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(str::to_string));
            let enc = encoders(&t);
            let choice = version.is_some().then(|| select_encoder(H264_CANDIDATES, &enc, &|e| probe_encoder(&t, e)));
            ToolsInfo {
                available: version.is_some(),
                ffmpeg: Some(t.ffmpeg.to_string_lossy().into_owned()),
                version,
                h264_encoder: choice.as_ref().map_or(H264_ENCODER, |c| c.encoder.name),
                h264_available: choice.as_ref().is_some_and(|c| !c.fallback),
                video_encoder: choice,
                encoders: enc,
                error: None,
            }
        }
    })
    .clone()
}

// ---------------------------------------------------------------------------
// Probing (ffprobe JSON)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Display rotation, counter-clockwise degrees (ffprobe convention)
    pub rotation: i32,
    pub bit_rate: u64,
    /// ffprobe `pix_fmt` / `color_transfer` ("" when not reported)
    pub pix_fmt: String,
    pub color_transfer: String,
}

impl VideoStream {
    /// Size as displayed (rotation applied).
    pub fn display_size(&self) -> (u32, u32) {
        if self.rotation.rem_euclid(180) == 90 { (self.height, self.width) } else { (self.width, self.height) }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub bit_rate: u64,
    pub language: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubStream {
    /// Index among the subtitle streams (`0:s:<index>`)
    pub index: usize,
    pub codec: String,
    pub language: String,
    pub title: String,
    /// Text based (exportable as SRT/ASS/VTT); false for bitmap subtitles (PGS, DVD)
    pub text: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub format: String,
    pub bit_rate: u64,
    pub size: u64,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubStream>,
    pub has_cover: bool,
    pub tags: serde_json::Map<String, Value>,
}

fn num<T: std::str::FromStr + Default>(v: &Value) -> T {
    match v {
        Value::String(s) => s.parse().unwrap_or_default(),
        Value::Number(n) => n.to_string().parse().unwrap_or_default(),
        _ => T::default(),
    }
}

fn rate(v: &Value) -> f64 {
    let s = v.as_str().unwrap_or("0/1");
    match s.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.parse::<f64>().unwrap_or(0.0), b.parse::<f64>().unwrap_or(0.0));
            if b > 0.0 { a / b } else { 0.0 }
        }
        None => s.parse().unwrap_or(0.0),
    }
}

const BITMAP_SUBS: &[&str] = &["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", "dvb_teletext"];

/// ffprobe JSON (`-show_format -show_streams`) -> MediaInfo.
pub fn parse_probe(json: &Value) -> MediaInfo {
    let fmt = &json["format"];
    let mut info = MediaInfo {
        duration: num(&fmt["duration"]),
        format: fmt["format_name"].as_str().unwrap_or("").to_string(),
        bit_rate: num(&fmt["bit_rate"]),
        size: num(&fmt["size"]),
        tags: fmt["tags"].as_object().cloned().unwrap_or_default(),
        ..Default::default()
    };
    let tag = |s: &Value, k: &str| s["tags"][k].as_str().unwrap_or("").to_string();
    for s in json["streams"].as_array().into_iter().flatten() {
        let codec = s["codec_name"].as_str().unwrap_or("").to_string();
        match s["codec_type"].as_str() {
            Some("video") if s["disposition"]["attached_pic"].as_i64() == Some(1) => info.has_cover = true,
            Some("video") if info.video.is_none() => {
                let rotation = s["side_data_list"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find_map(|d| d["rotation"].as_f64())
                    .map_or(0, |r| r.round() as i32);
                let fps = [rate(&s["avg_frame_rate"]), rate(&s["r_frame_rate"])].into_iter().find(|f| *f > 0.0 && *f < 1000.0);
                info.video = Some(VideoStream {
                    codec,
                    width: num(&s["width"]),
                    height: num(&s["height"]),
                    fps: fps.unwrap_or(0.0),
                    rotation,
                    bit_rate: num(&s["bit_rate"]),
                    pix_fmt: s["pix_fmt"].as_str().unwrap_or("").to_string(),
                    color_transfer: s["color_transfer"].as_str().unwrap_or("").to_string(),
                });
            }
            Some("audio") => info.audio.push(AudioStream {
                codec,
                channels: num(&s["channels"]),
                sample_rate: num(&s["sample_rate"]),
                bit_rate: num(&s["bit_rate"]),
                language: tag(s, "language"),
            }),
            Some("subtitle") => info.subtitles.push(SubStream {
                index: info.subtitles.len(),
                text: !BITMAP_SUBS.contains(&codec.as_str()),
                codec,
                language: tag(s, "language"),
                title: tag(s, "title"),
            }),
            _ => {}
        }
    }
    if info.duration <= 0.0 {
        // some streams (raw audio) only carry a stream duration
        info.duration = json["streams"].as_array().into_iter().flatten().map(|s| num::<f64>(&s["duration"])).fold(0.0, f64::max);
    }
    info
}

pub fn probe_with(tools: &Tools, path: &Path) -> Result<MediaInfo, String> {
    let out = command(&tools.ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe çalıştırılamadı: {e}"))?;
    if !out.status.success() {
        return Err(format!("{ERR_UNSUPPORTED} Medya okunamadı: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(parse_probe(&json))
}

pub fn probe(path: &Path) -> Result<MediaInfo, String> {
    probe_with(&locate()?, path)
}

// ---------------------------------------------------------------------------
// Job description (front-end contract)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    /// Original stream, no re-encoding
    #[default]
    Copy,
    Aac,
    /// AAC in an iPhone ringtone container
    M4r,
    Opus,
    Flac,
    Mp3,
    Wav,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    #[serde(rename = "whatsapp")]
    Whatsapp,
    /// Fits a 25 MB e-mail attachment limit
    #[serde(rename = "email")]
    Email,
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "1080p")]
    P1080,
    /// Audio only (AAC)
    #[serde(rename = "audio")]
    AudioOnly,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SubFormat {
    #[default]
    Srt,
    Ass,
    Vtt,
}

fn d_gif_width() -> u32 {
    480
}
fn d_gif_fps() -> u32 {
    12
}
fn d_cols() -> u32 {
    4
}
fn d_rows() -> u32 {
    4
}
fn d_sheet_width() -> u32 {
    320
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobKind {
    /// Lossless (`-c copy`, starts at the keyframe before `start`) or frame-accurate (re-encode)
    Cut { start: f64, end: f64, #[serde(default)] precise: bool },
    Gif { start: f64, end: f64, #[serde(default = "d_gif_width")] width: u32, #[serde(default = "d_gif_fps")] fps: u32 },
    /// Short MP4 clip (H.264/AAC, at most 720p)
    Clip { start: f64, end: f64 },
    ExtractAudio { #[serde(default)] format: AudioFormat },
    Convert { preset: Preset },
    /// Clockwise degrees (90 / 180 / 270); lossless = display rotation flag (MP4/MOV)
    #[serde(rename_all = "camelCase")]
    Rotate { degrees: i32, #[serde(default)] reencode: bool },
    EmbedSubtitle { subtitle: String },
    ExtractSubtitle { stream: usize, #[serde(default)] format: SubFormat },
    ContactSheet { #[serde(default = "d_cols")] columns: u32, #[serde(default = "d_rows")] rows: u32, #[serde(default = "d_sheet_width")] width: u32 },
    /// Audio excerpt (ringtone): range -> audio file
    Segment { start: f64, end: f64, #[serde(default)] format: AudioFormat },
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub job_id: Option<String>,
    pub input: String,
    /// Exact output path (otherwise derived from the input name, unique in `output_dir`)
    pub output: Option<String>,
    /// Output folder (default: the input's folder)
    pub output_dir: Option<String>,
    #[serde(flatten)]
    pub kind: JobKind,
    /// Job queue (A02) only, never from the UI: folder for the partial file (the job's own
    /// temp dir, same volume as the output)
    #[serde(skip)]
    pub temp_dir: Option<PathBuf>,
    /// Job queue (A02) only: never replace an existing output, pick `name (n)` instead
    #[serde(skip)]
    pub no_clobber: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub output: String,
    pub size: u64,
}

/// What a job runs: options before `-i input`, extra inputs, options before the output.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub input_opts: Vec<String>,
    pub extra_inputs: Vec<String>,
    pub output_opts: Vec<String>,
    /// Output file suffix (before the extension) and extension
    pub suffix: String,
    pub ext: String,
    /// Expected output duration in seconds (progress), 0 = unknown
    pub duration: f64,
    /// Encoders that must exist in the ffmpeg build
    pub needs: Vec<&'static str>,
}

fn s<I: IntoIterator<Item = T>, T: ToString>(items: I) -> Vec<String> {
    items.into_iter().map(|x| x.to_string()).collect()
}

fn secs(t: f64) -> String {
    format!("{:.3}", t.max(0.0))
}

/// Largest even size with the shorter side <= `short_max`, never upscaled.
pub fn fit_short_side(w: u32, h: u32, short_max: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let short = w.min(h);
    let even = |v: f64| ((v / 2.0).round() as u32 * 2).max(2);
    if short <= short_max {
        return (even(w as f64), even(h as f64));
    }
    let r = short_max as f64 / short as f64;
    (even(w as f64 * r), even(h as f64 * r))
}

/// Output size of `scale_filter(info, short_max)` when the source size is known.
fn scaled_size(info: &MediaInfo, short_max: u32) -> Option<(u32, u32)> {
    info.video.as_ref().map(|v| v.display_size()).filter(|(w, h)| *w > 0 && *h > 0).map(|(w, h)| fit_short_side(w, h, short_max))
}

/// `scale=W:H` for a display size limit (the decoder auto-rotates before filters), or an
/// expression when the source size is unknown.
fn scale_filter(info: &MediaInfo, short_max: u32) -> String {
    match info.video.as_ref().map(|v| v.display_size()).filter(|(w, h)| *w > 0 && *h > 0) {
        Some((w, h)) => {
            let (nw, nh) = fit_short_side(w, h, short_max);
            format!("scale={nw}:{nh}")
        }
        None => format!("scale='if(gt(iw,ih),-2,min({short_max},iw))':'if(gt(iw,ih),min({short_max},ih),-2)'"),
    }
}

fn aac(kbps: u32) -> Vec<String> {
    let mut v = s(["-c:a", "aac", "-b:a"]);
    v.push(format!("{kbps}k"));
    v
}

/// Container extension that can hold a copied audio stream of `codec`.
pub fn audio_copy_ext(codec: &str) -> &'static str {
    match codec {
        "aac" | "alac" => "m4a",
        "mp3" => "mp3",
        "opus" => "opus",
        "vorbis" => "ogg",
        "flac" => "flac",
        "ac3" => "ac3",
        "eac3" => "eac3",
        c if c.starts_with("pcm_") => "wav",
        _ => "mka",
    }
}

/// Audio encoder options + extension (+ needed encoder) for a target format.
fn audio_format(format: AudioFormat, info: &MediaInfo) -> (Vec<String>, &'static str, Option<&'static str>) {
    let src = info.audio.first();
    match format {
        AudioFormat::Copy => (s(["-c:a", "copy"]), audio_copy_ext(src.map_or("", |a| a.codec.as_str())), None),
        AudioFormat::Aac => (aac(192), "m4a", None),
        AudioFormat::M4r => ([aac(192), s(["-f", "ipod"])].concat(), "m4r", None),
        AudioFormat::Opus => {
            let mut v = s(["-c:a", "opus", "-strict", "-2", "-b:a", "128k", "-ar", "48000"]);
            if src.is_some_and(|a| a.channels > 2) {
                v.extend(s(["-ac", "2"]));
            }
            (v, "opus", Some("opus"))
        }
        AudioFormat::Flac => (s(["-c:a", "flac"]), "flac", Some("flac")),
        AudioFormat::Mp3 => (s(["-c:a", MP3_ENCODER, "-b:a", "192k"]), "mp3", Some(MP3_ENCODER)),
        AudioFormat::Wav => (s(["-c:a", "pcm_s16le"]), "wav", None),
    }
}

/// Embedded cover art survives audio conversions into containers that support it.
fn keep_cover(info: &MediaInfo, ext: &str) -> Vec<String> {
    if info.video.is_none() && info.has_cover && matches!(ext, "mp3" | "flac" | "m4a") {
        s(["-map", "0:v:0?", "-c:v", "copy", "-disposition:v:0", "attached_pic"])
    } else {
        vec![]
    }
}

fn check_range(start: f64, end: f64, info: &MediaInfo) -> Result<(f64, f64), String> {
    let end = if info.duration > 0.0 { end.min(info.duration) } else { end };
    if !(start >= 0.0 && end > start + 0.05) {
        return Err(format!("{ERR_INVALID} Geçersiz aralık: başlangıç bitişten önce olmalı"));
    }
    Ok((start, end))
}

fn need_video(info: &MediaInfo) -> Result<&VideoStream, String> {
    info.video.as_ref().ok_or_else(|| format!("{ERR_UNSUPPORTED} Bu dosyada görüntü yok"))
}

/// Bitrate budget of the e-mail preset: (video kbps, audio kbps, short side).
pub fn email_budget(duration: f64, has_video: bool) -> Result<(u32, u32, u32), String> {
    if duration <= 0.0 {
        return Err(format!("{ERR_UNSUPPORTED} Süre bilinmiyor; e-posta boyutu hesaplanamadı"));
    }
    // 25 MB limit, 24 MiB target, 8 % container / rate-control margin
    let total = (24.0 * 1024.0 * 1024.0 * 8.0 * 0.92 / duration / 1000.0).floor() as u32;
    if !has_video {
        return Ok((0, total.clamp(32, 192), 0));
    }
    let audio = if total < 400 { 48 } else { 96 };
    let video = total.saturating_sub(audio);
    if video < 100 {
        return Err(format!("{ERR_UNSUPPORTED} Video e-posta için çok uzun (25 MB'a sığmaz)"));
    }
    let short = if video >= 1200 { 720 } else if video >= 500 { 480 } else { 360 };
    Ok((video.min(4000), audio, short))
}

/// Builds the ffmpeg arguments of a job with the platform's default encoder (tests).
pub fn plan(kind: &JobKind, info: &MediaInfo, input: &Path) -> Result<Plan, String> {
    plan_with(kind, info, input, &default_encoder())
}

/// `-vf` for a re-encode: `base` filter (or none) plus the encoder's size constraints for an
/// output of `out` (display orientation, after `base`).
fn encode_vf(base: Option<&str>, out: Option<(u32, u32)>, e: &VideoEncoder) -> Vec<String> {
    let fix = match out {
        Some((w, h)) => encoder_scale(w, h, e),
        None => Some("scale=trunc(iw/2)*2:trunc(ih/2)*2".into()),
    };
    let chain: Vec<&str> = base.into_iter().chain(fix.as_deref()).collect();
    if chain.is_empty() { vec![] } else { vec!["-vf".into(), chain.join(",")] }
}

/// Builds the ffmpeg arguments of a job (pure: unit tested for every preset). `e` is the video
/// encoder chosen at run time (`encoder_choice`): its pixel format, size limit and rate options.
pub fn plan_with(kind: &JobKind, info: &MediaInfo, input: &Path, e: &VideoEncoder) -> Result<Plan, String> {
    let in_ext = crate::photo::ext_lower(input);
    let mut p = Plan::default();
    match kind {
        JobKind::Cut { start, end, precise } => {
            let (a, b) = check_range(*start, *end, info)?;
            p.input_opts = s(["-ss", &secs(a), "-to", &secs(b)]);
            p.duration = b - a;
            p.suffix = "_kesit".into();
            if *precise {
                if let Some(v) = &info.video {
                    check_encodable(v)?;
                    let kbps = if v.bit_rate > 0 { (v.bit_rate / 1000) as u32 } else { 4000 };
                    let size = Some(v.display_size()).filter(|(w, h)| *w > 0 && *h > 0);
                    p.output_opts = [s(["-map", "0:v:0", "-map", "0:a?"]), encode_vf(None, size, e), video_codec_args(e, kbps.clamp(800, 20000), false),
                        aac(192), s(["-sn", "-movflags", "+faststart"])].concat();
                    p.ext = "mp4".into();
                    p.needs.push(e.name);
                } else {
                    // audio: re-encode to the same family for a sample-exact cut
                    let (opts, ext, need) = audio_format(if matches!(in_ext.as_str(), "flac" | "wav") { AudioFormat::Flac } else { AudioFormat::Aac }, info);
                    p.output_opts = [s(["-map", "0:a:0", "-vn"]), opts, s(["-map_metadata", "0"])].concat();
                    p.ext = ext.into();
                    p.needs.extend(need);
                }
            } else {
                let mut maps = s(["-map", "0:v?", "-map", "0:a?", "-map", "0:s?"]);
                if in_ext == "mkv" {
                    maps.extend(s(["-map", "0:t?"]));
                }
                p.output_opts = [maps, s(["-c", "copy", "-avoid_negative_ts", "make_zero", "-map_metadata", "0", "-map_chapters", "-1"])].concat();
                p.ext = if in_ext.is_empty() { "mkv".into() } else { in_ext.clone() };
            }
        }
        JobKind::Gif { start, end, width, fps } => {
            let v = need_video(info)?;
            let (a, b) = check_range(*start, *end, info)?;
            if b - a > 60.0 {
                return Err(format!("{ERR_INVALID} GIF en fazla 60 saniye olabilir"));
            }
            let w = (*width).clamp(64, 1920).min(v.display_size().0.max(64));
            let fps = (*fps).clamp(1, 30);
            p.input_opts = s(["-ss", &secs(a), "-t", &secs(b - a)]);
            p.output_opts = vec![
                "-filter_complex".into(),
                format!("[0:v:0]fps={fps},scale={w}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"),
                "-an".into(), "-loop".into(), "0".into(),
            ];
            p.duration = b - a;
            p.suffix = "_gif".into();
            p.ext = "gif".into();
            p.needs.push("gif");
        }
        JobKind::Clip { start, end } => {
            check_encodable(need_video(info)?)?;
            let (a, b) = check_range(*start, *end, info)?;
            p.input_opts = s(["-ss", &secs(a), "-to", &secs(b)]);
            p.output_opts = [s(["-map", "0:v:0", "-map", "0:a:0?"]), encode_vf(Some(&scale_filter(info, 720)), scaled_size(info, 720), e),
                video_codec_args(e, 2000, false), aac(128), s(["-sn", "-movflags", "+faststart"])].concat();
            p.duration = b - a;
            p.suffix = "_klip".into();
            p.ext = "mp4".into();
            p.needs.push(e.name);
        }
        JobKind::ExtractAudio { format } => {
            if info.audio.is_empty() {
                return Err(format!("{ERR_UNSUPPORTED} Bu dosyada ses yok"));
            }
            let (opts, ext, need) = audio_format(*format, info);
            p.output_opts = [s(["-map", "0:a:0"]), keep_cover(info, ext), if keep_cover(info, ext).is_empty() { s(["-vn"]) } else { vec![] },
                opts, s(["-map_metadata", "0"])].concat();
            p.duration = info.duration;
            p.suffix = if info.video.is_some() { "_ses".into() } else { String::new() };
            p.ext = ext.into();
            p.needs.extend(need);
        }
        JobKind::Convert { preset } => {
            p.duration = info.duration;
            p.ext = "mp4".into();
            let has_video = info.video.is_some();
            let (short, vk, ak, cbr, suffix) = match preset {
                Preset::P720 => (720, 2500, 160, false, "_720p"),
                Preset::P1080 => (1080, 5000, 192, false, "_1080p"),
                Preset::Whatsapp => (720, 1500, 128, false, "_whatsapp"),
                Preset::Email => {
                    let (v, a, sh) = email_budget(info.duration, has_video)?;
                    (sh, v, a, true, "_eposta")
                }
                Preset::AudioOnly => (0, 0, 192, false, "_ses"),
            };
            p.suffix = suffix.into();
            if !has_video || *preset == Preset::AudioOnly {
                if info.audio.is_empty() {
                    return Err(format!("{ERR_UNSUPPORTED} Bu dosyada ses yok"));
                }
                p.output_opts = [s(["-map", "0:a:0", "-vn"]), aac(ak), s(["-map_metadata", "0", "-movflags", "+faststart"])].concat();
                p.ext = "m4a".into();
                if !has_video && *preset != Preset::AudioOnly {
                    p.suffix = suffix.into();
                }
            } else {
                if let Some(v) = &info.video {
                    check_encodable(v)?;
                }
                let mut vf = scale_filter(info, short);
                if matches!(preset, Preset::Whatsapp | Preset::Email) && info.video.as_ref().is_some_and(|v| v.fps > 30.5) {
                    vf.push_str(",fps=30");
                }
                p.output_opts = [s(["-map", "0:v:0", "-map", "0:a:0?"]), encode_vf(Some(&vf), scaled_size(info, short), e),
                    video_codec_args(e, vk, cbr), aac(ak), s(["-sn", "-map_metadata", "0", "-movflags", "+faststart"])].concat();
                p.needs.push(e.name);
            }
        }
        JobKind::Rotate { degrees, reencode } => {
            let v = need_video(info)?;
            let cw = degrees.rem_euclid(360);
            if ![90, 180, 270].contains(&cw) {
                return Err(format!("{ERR_INVALID} Döndürme 90, 180 veya 270 derece olmalı"));
            }
            p.duration = info.duration;
            p.suffix = "_dondur".into();
            let lossless_ok = matches!(in_ext.as_str(), "mp4" | "m4v" | "mov" | "3gp");
            if !*reencode && lossless_ok {
                // display matrix only (counter-clockwise degrees), streams copied
                let mut ccw = (v.rotation - cw).rem_euclid(360);
                if ccw > 180 {
                    ccw -= 360;
                }
                p.input_opts = s(["-display_rotation:v:0", &ccw.to_string()]);
                p.output_opts = s(["-map", "0", "-c", "copy", "-map_metadata", "0"]);
                p.ext = in_ext;
            } else {
                let tf = match cw {
                    90 => "transpose=1",
                    270 => "transpose=2",
                    _ => "hflip,vflip",
                };
                check_encodable(v)?;
                let kbps = if v.bit_rate > 0 { (v.bit_rate / 1000) as u32 } else { 4000 };
                let (dw, dh) = v.display_size();
                let out = if cw == 180 { (dw, dh) } else { (dh, dw) };
                let out = Some(out).filter(|(w, h)| *w > 0 && *h > 0);
                p.output_opts = [s(["-map", "0:v:0", "-map", "0:a?"]), encode_vf(Some(tf), out, e), video_codec_args(e, kbps.clamp(800, 20000), false),
                    aac(192), s(["-sn", "-map_metadata", "0", "-movflags", "+faststart"])].concat();
                p.ext = "mp4".into();
                p.needs.push(e.name);
            }
        }
        JobKind::EmbedSubtitle { subtitle } => {
            need_video(info)?;
            let sub_ext = crate::photo::ext_lower(Path::new(subtitle));
            if !["srt", "ass", "ssa", "vtt"].contains(&sub_ext.as_str()) {
                return Err(format!("{ERR_UNSUPPORTED} Altyazı SRT, ASS veya VTT olmalı"));
            }
            p.extra_inputs = s(["-i", subtitle]);
            p.output_opts = s(["-map", "0:v?", "-map", "0:a?", "-map", "0:s?", "-map", "1:0", "-c", "copy", "-map_metadata", "0"]);
            if in_ext == "mkv" {
                p.output_opts.splice(6..6, s(["-map", "0:t?"]));
            }
            p.duration = info.duration;
            p.suffix = "_altyazili".into();
            p.ext = "mkv".into();
        }
        JobKind::ExtractSubtitle { stream, format } => {
            let sub = info.subtitles.get(*stream).ok_or_else(|| format!("{ERR_INVALID} Altyazı kanalı yok"))?;
            if !sub.text {
                return Err(format!("{ERR_UNSUPPORTED} Görüntü tabanlı altyazı ({}) metin olarak dışa aktarılamaz", sub.codec));
            }
            let (codec, ext) = match format {
                SubFormat::Srt => ("srt", "srt"),
                SubFormat::Ass => ("ass", "ass"),
                SubFormat::Vtt => ("webvtt", "vtt"),
            };
            p.output_opts = s(["-map", &format!("0:s:{stream}"), "-c:s", codec]);
            p.duration = info.duration;
            let lang = if sub.language.is_empty() { String::new() } else { format!(".{}", sub.language) };
            p.suffix = if info.subtitles.len() > 1 { format!("{lang}.{}", stream + 1) } else { lang };
            p.ext = ext.into();
        }
        JobKind::ContactSheet { columns, rows, width } => {
            need_video(info)?;
            let (c, r) = ((*columns).clamp(1, 10), (*rows).clamp(1, 10));
            let n = (c * r) as f64;
            if info.duration <= 0.0 {
                return Err(format!("{ERR_UNSUPPORTED} Süre bilinmiyor"));
            }
            let interval = info.duration / n;
            p.input_opts = s(["-ss", &secs(interval / 2.0)]);
            p.output_opts = s([
                "-vf",
                &format!("fps=1/{interval:.4},scale={}:-2,tile={c}x{r}:padding=6:margin=6:color=0x202020", (*width).clamp(80, 960)),
                "-frames:v", "1", "-an", "-sn",
            ]);
            p.duration = info.duration;
            p.suffix = "_kontak".into();
            p.ext = "png".into();
        }
        JobKind::Segment { start, end, format } => {
            if info.audio.is_empty() {
                return Err(format!("{ERR_UNSUPPORTED} Bu dosyada ses yok"));
            }
            let (a, b) = check_range(*start, *end, info)?;
            let (opts, ext, need) = audio_format(*format, info);
            p.input_opts = s(["-ss", &secs(a), "-to", &secs(b)]);
            p.output_opts = [s(["-map", "0:a:0", "-vn"]), opts, s(["-map_metadata", "0"])].concat();
            p.duration = b - a;
            p.suffix = "_kesit".into();
            p.ext = ext.into();
            p.needs.extend(need);
        }
    }
    Ok(p)
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/// `out_time_us=1234567` (or the identical `out_time_ms`) -> seconds.
pub fn parse_progress_line(line: &str) -> Option<f64> {
    let (k, v) = line.trim().split_once('=')?;
    match k {
        "out_time_us" | "out_time_ms" => v.trim().parse::<i64>().ok().filter(|us| *us >= 0).map(|us| us as f64 / 1e6),
        _ => None,
    }
}

/// Runs ffmpeg with `-progress pipe:1`; kills it when `cancelled()` turns true.
pub fn run_ffmpeg(
    exe: &Path,
    args: &[String],
    expected: f64,
    cancelled: &dyn Fn() -> bool,
    progress: impl Fn(f64) + Send + 'static,
) -> Result<String, String> {
    let mut child = command(exe)
        .args(["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1"])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg başlatılamadı: {e}"))?;
    #[cfg(windows)]
    tie_to_app(&child);
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut last = -1.0f64;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(t) = parse_progress_line(&line) {
                if expected > 0.0 {
                    let p = (t / expected).clamp(0.0, 0.999);
                    if p - last >= 0.01 {
                        last = p;
                        progress(p);
                    }
                }
            } else if line.trim() == "progress=end" {
                progress(1.0);
            }
        }
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });
    let status = loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = err_reader.join();
            return Err(format!("{ERR_CANCELLED} İptal edildi"));
        }
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let _ = reader.join();
    let err = err_reader.join().unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(3)..].join(" | ");
        return Err(format!("ffmpeg hatası ({status}): {tail}"));
    }
    Ok(err)
}

/// Windows: ffmpeg children join a job object that closes with VHO (also on a crash or a
/// forced kill), so an export never keeps running orphaned and its partial file can be
/// cleaned up by the job queue's recovery (A02) on the next start.
#[cfg(windows)]
fn tie_to_app(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    static JOB: OnceLock<usize> = OnceLock::new();
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if h.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            h,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        );
        h as usize // never closed: the OS closes it when VHO exits
    });
    if job != 0 {
        unsafe {
            AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
        }
    }
}

static PART_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn run_job(req: &JobRequest, cancelled: &dyn Fn() -> bool, progress: impl Fn(f64) + Send + 'static) -> Result<JobResult, String> {
    let tools = locate()?;
    let input = Path::new(&req.input);
    if !input.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    if let JobKind::EmbedSubtitle { subtitle } = &req.kind {
        if !Path::new(subtitle).is_file() {
            return Err("Altyazı dosyası bulunamadı".into());
        }
    }
    let info = probe_with(&tools, input)?;
    let encoder = encoder_choice().map_or_else(default_encoder, |c| c.encoder);
    let plan = plan_with(&req.kind, &info, input, &encoder)?;
    let available = tools_info().encoders;
    if let Some(missing) = plan.needs.iter().find(|n| !available.iter().any(|e| e == *n)) {
        return Err(format!("{ERR_UNSUPPORTED} Bu ffmpeg derlemesinde {missing} kodlayıcısı yok"));
    }
    let output = match &req.output {
        Some(o) => PathBuf::from(o),
        None => {
            let dir = req.output_dir.as_deref().map(PathBuf::from).or_else(|| input.parent().map(Path::to_path_buf)).unwrap_or_default();
            std::fs::create_dir_all(&dir).map_err(|e| format!("Klasör oluşturulamadı: {e}"))?;
            let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "vho".into());
            unique_path(&dir, &stem, &plan.suffix, &plan.ext, |p| p.exists())
        }
    };
    if output == input {
        return Err(format!("{ERR_INVALID} Çıktı kaynak dosyanın üzerine yazamaz"));
    }
    let dir = output.parent().ok_or("Geçersiz çıktı yolu")?;
    let partial = req.temp_dir.as_deref().unwrap_or(dir).join(format!(
        ".{}.vho-part{}-{}.{}",
        output.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id(),
        PART_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        plan.ext
    ));
    let mut args = plan.input_opts.clone();
    args.push("-i".into());
    args.push(input.to_string_lossy().into_owned());
    args.extend(plan.extra_inputs.iter().cloned());
    args.extend(plan.output_opts.iter().cloned());
    args.extend(s(["-loglevel", "error"]));
    args.push(partial.to_string_lossy().into_owned());
    let r = run_ffmpeg(&tools.ffmpeg, &args, plan.duration, cancelled, progress);
    if let Err(e) = r {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    let size = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&partial);
        return Err("ffmpeg boş bir dosya üretti".into());
    }
    let output = if req.no_clobber {
        super::files::place_no_clobber(&partial, &output).inspect_err(|_| {
            let _ = std::fs::remove_file(&partial);
        })?
    } else {
        if output.exists() {
            // explicit output path chosen in a save dialog (the dialog asked about overwriting)
            let _ = std::fs::remove_file(&output);
        }
        std::fs::rename(&partial, &output).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            format!("Çıktı yazılamadı: {e}")
        })?;
        output
    };
    Ok(JobResult { output: output.to_string_lossy().into_owned(), size })
}

// ---------------------------------------------------------------------------
// Loudness (ReplayGain 2.0: reference -18 LUFS)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    pub integrated_lufs: f64,
    pub true_peak_dbfs: f64,
    /// ReplayGain track gain in dB (-18 LUFS reference)
    pub track_gain_db: f64,
    /// Linear peak (1.0 = full scale)
    pub track_peak: f64,
}

pub const REPLAYGAIN_REFERENCE_LUFS: f64 = -18.0;

/// Parses the ebur128 summary ffmpeg prints at the end.
pub fn parse_ebur128(log: &str) -> Option<Loudness> {
    let mut integrated = None;
    let mut peak = None;
    let mut section = "";
    for line in log.lines() {
        let l = line.trim();
        if l.ends_with(':') && !l.contains(' ') || l == "Integrated loudness:" || l == "True peak:" || l == "Loudness range:" {
            section = if l.starts_with("Integrated") { "i" } else if l.starts_with("True peak") { "p" } else { "" };
            continue;
        }
        let value = |prefix: &str| l.strip_prefix(prefix).and_then(|r| r.split_whitespace().next()).and_then(|v| v.parse::<f64>().ok());
        if section == "i" {
            if let Some(v) = value("I:") {
                integrated = Some(v);
            }
        } else if section == "p" {
            if let Some(v) = value("Peak:") {
                peak = Some(v);
            }
        }
    }
    let i = integrated?;
    let p = peak.unwrap_or(0.0);
    Some(Loudness {
        integrated_lufs: i,
        true_peak_dbfs: p,
        track_gain_db: ((REPLAYGAIN_REFERENCE_LUFS - i) * 100.0).round() / 100.0,
        track_peak: (10f64.powf(p / 20.0) * 1e6).round() / 1e6,
    })
}

pub fn loudness(path: &Path) -> Result<Loudness, String> {
    let tools = locate()?;
    let args = s(["-i", &path.to_string_lossy(), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    let log = run_ffmpeg(&tools.ffmpeg, &args, 0.0, &|| false, |_| {})?;
    parse_ebur128(&log).ok_or_else(|| "Ses yüksekliği ölçülemedi".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn video_info(w: u32, h: u32, dur: f64) -> MediaInfo {
        MediaInfo {
            duration: dur,
            video: Some(VideoStream { codec: "h264".into(), width: w, height: h, fps: 30.0, rotation: 0, bit_rate: 3_000_000, ..Default::default() }),
            audio: vec![AudioStream { codec: "aac".into(), channels: 2, sample_rate: 48000, bit_rate: 128_000, language: String::new() }],
            ..Default::default()
        }
    }

    fn audio_info(codec: &str) -> MediaInfo {
        MediaInfo {
            duration: 200.0,
            audio: vec![AudioStream { codec: codec.into(), channels: 2, sample_rate: 44100, ..Default::default() }],
            ..Default::default()
        }
    }

    fn has(v: &[String], seq: &[&str]) -> bool {
        v.windows(seq.len()).any(|w| w.iter().zip(seq).all(|(a, b)| a == b))
    }

    fn mp4() -> &'static Path {
        Path::new("C:/v/film.mp4")
    }

    #[test]
    fn job_json_contract() {
        let r: JobRequest = serde_json::from_value(json!({"jobId": "j1", "input": "a.mp4", "kind": "cut", "start": 1.5, "end": 4, "precise": true})).unwrap();
        assert_eq!(r.kind, JobKind::Cut { start: 1.5, end: 4.0, precise: true });
        let r: JobRequest = serde_json::from_value(json!({"input": "a.mp4", "kind": "convert", "preset": "720p"})).unwrap();
        assert_eq!(r.kind, JobKind::Convert { preset: Preset::P720 });
        let r: JobRequest = serde_json::from_value(json!({"input": "a.mp4", "kind": "extractAudio"})).unwrap();
        assert_eq!(r.kind, JobKind::ExtractAudio { format: AudioFormat::Copy });
        let r: JobRequest = serde_json::from_value(json!({"input": "a", "kind": "gif", "start": 0, "end": 2})).unwrap();
        assert_eq!(r.kind, JobKind::Gif { start: 0.0, end: 2.0, width: 480, fps: 12 });
        let r: JobRequest = serde_json::from_value(json!({"input": "a", "kind": "contactSheet", "outputDir": "D:/x"})).unwrap();
        assert_eq!(r.output_dir.as_deref(), Some("D:/x"));
        for p in ["whatsapp", "email", "1080p", "audio"] {
            assert!(serde_json::from_value::<JobRequest>(json!({"input": "a", "kind": "convert", "preset": p})).is_ok(), "{p}");
        }
    }

    #[test]
    fn lossless_cut_copies_streams() {
        let p = plan(&JobKind::Cut { start: 2.0, end: 7.5, precise: false }, &video_info(1920, 1080, 60.0), mp4()).unwrap();
        assert_eq!(p.input_opts, s(["-ss", "2.000", "-to", "7.500"]));
        assert!(has(&p.output_opts, &["-c", "copy"]));
        assert!(has(&p.output_opts, &["-avoid_negative_ts", "make_zero"]));
        assert!(!p.output_opts.iter().any(|a| a == "0:t?")); // attachments: mkv only
        assert_eq!((p.ext.as_str(), p.suffix.as_str(), p.duration), ("mp4", "_kesit", 5.5));
        let mkv = plan(&JobKind::Cut { start: 0.0, end: 1.0, precise: false }, &video_info(640, 480, 9.0), Path::new("a.MKV")).unwrap();
        assert!(has(&mkv.output_opts, &["-map", "0:t?"]) && mkv.ext == "mkv");
        // end beyond the duration is clamped; empty / reversed ranges are rejected
        let c = plan(&JobKind::Cut { start: 50.0, end: 99.0, precise: false }, &video_info(640, 480, 60.0), mp4()).unwrap();
        assert_eq!(c.duration, 10.0);
        for (a, b) in [(5.0, 5.0), (6.0, 2.0), (-1.0, 3.0)] {
            assert!(plan(&JobKind::Cut { start: a, end: b, precise: false }, &video_info(1, 1, 60.0), mp4()).unwrap_err().starts_with(ERR_INVALID));
        }
    }

    #[test]
    fn precise_cut_reencodes_with_platform_h264() {
        let p = plan(&JobKind::Cut { start: 1.0, end: 3.0, precise: true }, &video_info(1280, 720, 10.0), Path::new("x.mkv")).unwrap();
        assert!(has(&p.output_opts, &["-c:v", H264_ENCODER]));
        assert!(has(&p.output_opts, &["-b:v", "3000k"]));
        assert!(has(&p.output_opts, &["-c:a", "aac"]));
        assert_eq!(p.ext, "mp4");
        assert_eq!(p.needs, vec![H264_ENCODER]);
        // audio file: sample-exact re-encode, lossless stays lossless
        let a = plan(&JobKind::Cut { start: 1.0, end: 3.0, precise: true }, &audio_info("flac"), Path::new("s.flac")).unwrap();
        assert!(has(&a.output_opts, &["-c:a", "flac"]) && a.ext == "flac");
    }

    #[test]
    fn gif_uses_palette_and_limits() {
        let p = plan(&JobKind::Gif { start: 1.0, end: 4.0, width: 480, fps: 12 }, &video_info(1920, 1080, 30.0), mp4()).unwrap();
        assert_eq!(p.input_opts, s(["-ss", "1.000", "-t", "3.000"]));
        let fc = &p.output_opts[1];
        assert!(fc.contains("fps=12") && fc.contains("scale=480:-1") && fc.contains("palettegen") && fc.contains("paletteuse"), "{fc}");
        assert!(has(&p.output_opts, &["-loop", "0"]));
        assert_eq!(p.ext, "gif");
        // never upscaled beyond the source width
        let small = plan(&JobKind::Gif { start: 0.0, end: 1.0, width: 800, fps: 50 }, &video_info(320, 240, 3.0), mp4()).unwrap();
        assert!(small.output_opts[1].contains("scale=320:-1") && small.output_opts[1].contains("fps=30"));
        assert!(plan(&JobKind::Gif { start: 0.0, end: 70.0, width: 480, fps: 10 }, &video_info(320, 240, 90.0), mp4()).is_err());
        assert!(plan(&JobKind::Gif { start: 0.0, end: 1.0, width: 480, fps: 10 }, &audio_info("mp3"), mp4()).unwrap_err().starts_with(ERR_UNSUPPORTED));
    }

    #[test]
    fn convert_presets() {
        let hd = video_info(1920, 1080, 120.0);
        let p720 = plan(&JobKind::Convert { preset: Preset::P720 }, &hd, mp4()).unwrap();
        assert!(has(&p720.output_opts, &["-vf", "scale=1280:720"]), "{:?}", p720.output_opts);
        assert!(has(&p720.output_opts, &["-b:v", "2500k"]) && has(&p720.output_opts, &["-movflags", "+faststart"]));
        assert_eq!((p720.ext.as_str(), p720.suffix.as_str()), ("mp4", "_720p"));

        let p1080 = plan(&JobKind::Convert { preset: Preset::P1080 }, &video_info(3840, 2160, 10.0), mp4()).unwrap();
        assert!(has(&p1080.output_opts, &["-vf", "scale=1920:1080"]) && has(&p1080.output_opts, &["-b:v", "5000k"]));
        // no upscaling: a 480p source stays 480p
        let small = plan(&JobKind::Convert { preset: Preset::P1080 }, &video_info(854, 480, 10.0), mp4()).unwrap();
        assert!(has(&small.output_opts, &["-vf", "scale=854:480"]));
        // portrait phone video (rotation -90): shorter displayed side is the width
        let mut portrait = video_info(1920, 1080, 10.0);
        portrait.video.as_mut().unwrap().rotation = -90;
        let pp = plan(&JobKind::Convert { preset: Preset::P720 }, &portrait, mp4()).unwrap();
        assert!(has(&pp.output_opts, &["-vf", "scale=720:1280"]), "{:?}", pp.output_opts);

        let wa = plan(&JobKind::Convert { preset: Preset::Whatsapp }, &hd, mp4()).unwrap();
        assert!(has(&wa.output_opts, &["-vf", "scale=1280:720"]));
        let mut fast = hd.clone();
        fast.video.as_mut().unwrap().fps = 59.94;
        let wa60 = plan(&JobKind::Convert { preset: Preset::Whatsapp }, &fast, mp4()).unwrap();
        assert!(has(&wa60.output_opts, &["-vf", "scale=1280:720,fps=30"]));
        assert!(has(&wa.output_opts, &["-b:v", "1500k"]) && has(&wa.output_opts, &["-b:a", "128k"]));
        assert_eq!(wa.suffix, "_whatsapp");

        let audio = plan(&JobKind::Convert { preset: Preset::AudioOnly }, &hd, mp4()).unwrap();
        assert!(has(&audio.output_opts, &["-vn"]) && audio.ext == "m4a" && !audio.needs.contains(&H264_ENCODER));
    }

    #[test]
    fn email_preset_fits_25_mb() {
        let p = plan(&JobKind::Convert { preset: Preset::Email }, &video_info(1920, 1080, 120.0), mp4()).unwrap();
        let kbps = |flag: &str| {
            let i = p.output_opts.iter().position(|a| a == flag).unwrap();
            p.output_opts[i + 1].trim_end_matches('k').parse::<f64>().unwrap()
        };
        let total_mb = (kbps("-b:v") + kbps("-b:a")) * 1000.0 * 120.0 / 8.0 / 1e6;
        assert!(total_mb < 25.0 * 0.97, "{total_mb} MB");
        if H264_ENCODER == "h264_mf" {
            assert!(has(&p.output_opts, &["-rate_control", "cbr"]));
        }
        assert_eq!(p.suffix, "_eposta");
        // budget tiers
        assert_eq!(email_budget(60.0, true).unwrap().2, 720);
        assert_eq!(email_budget(300.0, true).unwrap().2, 480);
        assert_eq!(email_budget(900.0, true).unwrap().2, 360);
        assert!(email_budget(4000.0, true).unwrap_err().starts_with(ERR_UNSUPPORTED));
        assert!(email_budget(0.0, true).is_err());
        // audio only: AAC sized for the limit
        let (_, a, _) = email_budget(3600.0, false).unwrap();
        assert!(a as f64 * 1000.0 * 3600.0 / 8.0 / 1e6 < 25.0);
    }

    #[test]
    fn extract_audio_formats() {
        let v = video_info(1280, 720, 10.0);
        let copy = plan(&JobKind::ExtractAudio { format: AudioFormat::Copy }, &v, mp4()).unwrap();
        assert!(has(&copy.output_opts, &["-vn"]) && has(&copy.output_opts, &["-c:a", "copy"]));
        assert_eq!((copy.ext.as_str(), copy.suffix.as_str()), ("m4a", "_ses"));
        for (codec, ext) in [("mp3", "mp3"), ("opus", "opus"), ("vorbis", "ogg"), ("flac", "flac"), ("pcm_s16le", "wav"), ("dts", "mka")] {
            assert_eq!(audio_copy_ext(codec), ext);
        }
        let opus = plan(&JobKind::ExtractAudio { format: AudioFormat::Opus }, &v, mp4()).unwrap();
        assert!(has(&opus.output_opts, &["-c:a", "opus", "-strict", "-2"]) && opus.needs == vec!["opus"]);
        let mp3 = plan(&JobKind::ExtractAudio { format: AudioFormat::Mp3 }, &v, mp4()).unwrap();
        assert!(has(&mp3.output_opts, &["-c:a", MP3_ENCODER]) && mp3.ext == "mp3");
        let wav = plan(&JobKind::ExtractAudio { format: AudioFormat::Wav }, &v, mp4()).unwrap();
        assert!(has(&wav.output_opts, &["-c:a", "pcm_s16le"]));
        // music conversion keeps the cover where the container allows it
        let mut song = audio_info("mp3");
        song.has_cover = true;
        let flac = plan(&JobKind::ExtractAudio { format: AudioFormat::Flac }, &song, Path::new("s.mp3")).unwrap();
        assert!(has(&flac.output_opts, &["-disposition:v:0", "attached_pic"]) && !flac.output_opts.contains(&"-vn".to_string()));
        assert_eq!(flac.suffix, "");
        let opus_song = plan(&JobKind::ExtractAudio { format: AudioFormat::Opus }, &song, Path::new("s.mp3")).unwrap();
        assert!(opus_song.output_opts.contains(&"-vn".to_string()));
        assert!(plan(&JobKind::ExtractAudio { format: AudioFormat::Aac }, &MediaInfo::default(), mp4()).is_err());
    }

    #[test]
    fn rotate_lossless_and_reencode() {
        let v = video_info(1920, 1080, 10.0);
        let p = plan(&JobKind::Rotate { degrees: 90, reencode: false }, &v, mp4()).unwrap();
        assert_eq!(p.input_opts, s(["-display_rotation:v:0", "-90"]));
        assert!(has(&p.output_opts, &["-c", "copy"]));
        // combines with an existing rotation: -90 (portrait) rotated by 90 cw again -> 180
        let mut r = v.clone();
        r.video.as_mut().unwrap().rotation = -90;
        assert_eq!(plan(&JobKind::Rotate { degrees: 90, reencode: false }, &r, mp4()).unwrap().input_opts[1], "180");
        assert_eq!(plan(&JobKind::Rotate { degrees: 270, reencode: false }, &r, mp4()).unwrap().input_opts[1], "0");
        // MKV / explicit re-encode -> transpose filter
        let mkv = plan(&JobKind::Rotate { degrees: 90, reencode: false }, &v, Path::new("a.mkv")).unwrap();
        assert!(has(&mkv.output_opts, &["-vf", "transpose=1"]) && mkv.ext == "mp4");
        let r180 = plan(&JobKind::Rotate { degrees: 180, reencode: true }, &v, mp4()).unwrap();
        assert!(has(&r180.output_opts, &["-vf", "hflip,vflip"]));
        let r270 = plan(&JobKind::Rotate { degrees: -90, reencode: true }, &v, mp4()).unwrap();
        assert!(has(&r270.output_opts, &["-vf", "transpose=2"]));
        assert!(plan(&JobKind::Rotate { degrees: 45, reencode: true }, &v, mp4()).is_err());
    }

    #[test]
    fn subtitles_embed_and_extract() {
        let mut v = video_info(1280, 720, 10.0);
        let e = plan(&JobKind::EmbedSubtitle { subtitle: "C:/s/film.tr.srt".into() }, &v, mp4()).unwrap();
        assert_eq!(e.extra_inputs, s(["-i", "C:/s/film.tr.srt"]));
        assert!(has(&e.output_opts, &["-map", "1:0", "-c", "copy"]) && e.ext == "mkv");
        assert!(plan(&JobKind::EmbedSubtitle { subtitle: "x.idx".into() }, &v, mp4()).is_err());

        v.subtitles = vec![
            SubStream { index: 0, codec: "subrip".into(), language: "tur".into(), title: String::new(), text: true },
            SubStream { index: 1, codec: "hdmv_pgs_subtitle".into(), language: "eng".into(), title: String::new(), text: false },
        ];
        let x = plan(&JobKind::ExtractSubtitle { stream: 0, format: SubFormat::Srt }, &v, mp4()).unwrap();
        assert!(has(&x.output_opts, &["-map", "0:s:0", "-c:s", "srt"]));
        assert_eq!((x.suffix.as_str(), x.ext.as_str()), (".tur.1", "srt"));
        let vtt = plan(&JobKind::ExtractSubtitle { stream: 0, format: SubFormat::Vtt }, &v, mp4()).unwrap();
        assert!(has(&vtt.output_opts, &["-c:s", "webvtt"]) && vtt.ext == "vtt");
        assert!(plan(&JobKind::ExtractSubtitle { stream: 1, format: SubFormat::Srt }, &v, mp4()).unwrap_err().starts_with(ERR_UNSUPPORTED));
        assert!(plan(&JobKind::ExtractSubtitle { stream: 5, format: SubFormat::Srt }, &v, mp4()).is_err());
    }

    #[test]
    fn contact_sheet_and_segment() {
        let p = plan(&JobKind::ContactSheet { columns: 4, rows: 3, width: 320 }, &video_info(1920, 1080, 120.0), mp4()).unwrap();
        assert_eq!(p.input_opts, s(["-ss", "5.000"]));
        assert!(p.output_opts[1].starts_with("fps=1/10.0000,scale=320:-2,tile=4x3"), "{}", p.output_opts[1]);
        assert!(has(&p.output_opts, &["-frames:v", "1"]) && p.ext == "png");

        let seg = plan(&JobKind::Segment { start: 30.0, end: 60.0, format: AudioFormat::M4r }, &audio_info("mp3"), Path::new("s.mp3")).unwrap();
        assert_eq!(seg.input_opts, s(["-ss", "30.000", "-to", "60.000"]));
        assert!(has(&seg.output_opts, &["-f", "ipod"]) && seg.ext == "m4r" && seg.duration == 30.0);
        let mp3 = plan(&JobKind::Segment { start: 0.0, end: 20.0, format: AudioFormat::Mp3 }, &audio_info("flac"), Path::new("s.flac")).unwrap();
        assert!(has(&mp3.output_opts, &["-c:a", MP3_ENCODER]));
    }

    #[test]
    fn fit_short_side_even_no_upscale() {
        assert_eq!(fit_short_side(1920, 1080, 720), (1280, 720));
        assert_eq!(fit_short_side(1080, 1920, 720), (720, 1280));
        assert_eq!(fit_short_side(1280, 720, 1080), (1280, 720));
        assert_eq!(fit_short_side(1000, 750, 720), (960, 720));
        assert_eq!(fit_short_side(321, 241, 720), (322, 242));
        assert_eq!(fit_short_side(0, 10, 720), (0, 0));
        // unknown size -> expression form
        let mut i = video_info(0, 0, 1.0);
        i.video.as_mut().unwrap().width = 0;
        assert!(scale_filter(&i, 720).contains("min(720"));
    }

    #[test]
    fn progress_and_probe_parsing() {
        assert_eq!(parse_progress_line("out_time_us=1500000"), Some(1.5));
        assert_eq!(parse_progress_line("out_time_ms=2000000\r"), Some(2.0));
        assert_eq!(parse_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_progress_line("frame=12"), None);

        let j = json!({
            "format": {"duration": "12.5", "format_name": "mov,mp4", "bit_rate": "800000", "size": "1250000", "tags": {"title": "T"}},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001",
                 "side_data_list": [{"rotation": -90}], "bit_rate": "700000"},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000", "tags": {"language": "tur"}},
                {"codec_type": "subtitle", "codec_name": "mov_text", "tags": {"language": "eng"}},
                {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
            ]
        });
        let i = parse_probe(&j);
        assert_eq!(i.duration, 12.5);
        let v = i.video.as_ref().unwrap();
        assert_eq!((v.width, v.rotation, v.display_size()), (1920, -90, (1080, 1920)));
        assert!((v.fps - 29.97).abs() < 0.01);
        assert_eq!(i.audio[0].language, "tur");
        assert!(i.subtitles[0].text && i.has_cover);
        assert_eq!(i.tags["title"], "T");
    }

    #[test]
    fn ebur128_summary_to_replaygain() {
        let log = "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -12.7 LUFS\n    Threshold: -22.7 LUFS\n\n  Loudness range:\n    LRA:        20.0 LU\n    Threshold: -32.7 LUFS\n\n  True peak:\n    Peak:      -11.5 dBFS\n";
        let l = parse_ebur128(log).unwrap();
        assert_eq!(l.integrated_lufs, -12.7);
        assert_eq!(l.true_peak_dbfs, -11.5);
        assert_eq!(l.track_gain_db, -5.3);
        assert!((l.track_peak - 0.266073).abs() < 1e-5, "{}", l.track_peak);
        assert!(parse_ebur128("nothing").is_none());
    }

    #[test]
    fn encoder_selection_probes_and_falls_back() {
        let present = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let a = enc("enc_a", "h264", true, "nv12", 4096, 2160);
        let b = enc("enc_b", "h264", false, "yuv420p", 3840, 2160);
        // listed and working: first wins
        let c = select_encoder(&[a, b], &present(&["enc_a", "enc_b"]), &|_| Ok(()));
        assert_eq!((c.encoder.name, c.fallback, c.attempts.len()), ("enc_a", false, 1));
        // listed but failing (MF without a working MFT) -> next candidate
        let c = select_encoder(&[a, b], &present(&["enc_a", "enc_b"]), &|e| if e.name == "enc_a" { Err("MFT".into()) } else { Ok(()) });
        assert_eq!(c.encoder.name, "enc_b");
        assert_eq!(c.attempts[0], EncoderAttempt { name: "enc_a", present: true, ok: false, error: Some("MFT".into()) });
        // not listed -> never probed
        let c = select_encoder(&[a, b], &present(&["enc_b"]), &|e| { assert_ne!(e.name, "enc_a"); Ok(()) });
        assert_eq!(c.encoder.name, "enc_b");
        assert!(!c.attempts[0].present);
        // nothing works -> mpeg4 fallback, flagged
        let c = select_encoder(&[a, b], &present(&["enc_a"]), &|_| Err("x".into()));
        assert_eq!((c.encoder, c.fallback), (FALLBACK_ENCODER, true));
        assert_eq!(c.attempts.len(), 2);
    }

    #[test]
    fn encoder_constraints_in_plans() {
        let mf = enc("h264_mf", "h264", true, "nv12", 4096, 2160);
        let soft = enc("libopenh264", "h264", false, "yuv420p", 3840, 2160);
        // size limits: 8K landscape and portrait fit inside, even, aspect kept; odd sizes fixed
        assert_eq!(encoder_scale(1920, 1080, &mf), None);
        assert_eq!(encoder_scale(7680, 4320, &mf).as_deref(), Some("scale=3840:2160"));
        assert_eq!(encoder_scale(4320, 7680, &mf).as_deref(), Some("scale=2160:3840"));
        assert_eq!(encoder_scale(641, 361, &mf).as_deref(), Some("scale=640:360"));
        assert_eq!(encoder_scale(0, 0, &mf).as_deref(), Some("scale=trunc(iw/2)*2:trunc(ih/2)*2"));
        // pixel format + rate control per encoder
        let a = video_codec_args(&mf, 2000, true);
        assert!(has(&a, &["-pix_fmt", "nv12"]) && has(&a, &["-rate_control", "cbr"]));
        let a = video_codec_args(&soft, 2000, true);
        assert!(has(&a, &["-pix_fmt", "yuv420p"]) && has(&a, &["-maxrate", "2000k"]) && !a.iter().any(|x| x == "-rate_control"));
        let a = video_codec_args(&FALLBACK_ENCODER, 900, false);
        assert!(has(&a, &["-c:v", "mpeg4", "-b:v", "900k"]));
        // 8K precise cut with MF gets a size-limiting scale; 1080p none
        let p = plan_with(&JobKind::Cut { start: 0.0, end: 2.0, precise: true }, &video_info(7680, 4320, 9.0), mp4(), &mf).unwrap();
        assert!(has(&p.output_opts, &["-vf", "scale=3840:2160"]), "{:?}", p.output_opts);
        assert_eq!(p.needs, vec!["h264_mf"]);
        let p = plan_with(&JobKind::Cut { start: 0.0, end: 2.0, precise: true }, &video_info(1920, 1080, 9.0), mp4(), &mf).unwrap();
        assert!(!p.output_opts.iter().any(|a| a == "-vf"));
        // rotate 90 re-encode of a 4320x7680 portrait -> transpose then fit landscape 3840x2160
        let mut v = video_info(4320, 7680, 9.0);
        v.video.as_mut().unwrap().rotation = 0;
        let p = plan_with(&JobKind::Rotate { degrees: 90, reencode: true }, &v, mp4(), &mf).unwrap();
        assert!(has(&p.output_opts, &["-vf", "transpose=1,scale=3840:2160"]), "{:?}", p.output_opts);
        // fallback encoder recorded in needs; convert keeps its own scale first
        let p = plan_with(&JobKind::Convert { preset: Preset::P720 }, &video_info(1920, 1080, 9.0), mp4(), &FALLBACK_ENCODER).unwrap();
        assert!(has(&p.output_opts, &["-vf", "scale=1280:720"]) && p.needs == vec!["mpeg4"]);
    }

    #[test]
    fn hdr_is_not_reencoded() {
        let mut v = video_info(3840, 2160, 9.0);
        v.video.as_mut().unwrap().color_transfer = "smpte2084".into();
        for kind in [
            JobKind::Cut { start: 0.0, end: 2.0, precise: true },
            JobKind::Clip { start: 0.0, end: 2.0 },
            JobKind::Convert { preset: Preset::P1080 },
            JobKind::Rotate { degrees: 90, reencode: true },
        ] {
            assert!(plan(&kind, &v, mp4()).unwrap_err().starts_with(ERR_UNSUPPORTED), "{kind:?}");
        }
        // lossless cut / rotation metadata stay possible
        assert!(plan(&JobKind::Cut { start: 0.0, end: 2.0, precise: false }, &v, mp4()).is_ok());
        assert!(plan(&JobKind::Rotate { degrees: 90, reencode: false }, &v, mp4()).is_ok());
        v.video.as_mut().unwrap().color_transfer = "arib-std-b67".into();
        assert!(plan(&JobKind::Clip { start: 0.0, end: 2.0 }, &v, mp4()).is_err());
        let json = json!({"streams": [{"codec_type": "video", "width": 1920, "height": 1080, "pix_fmt": "yuv420p10le", "color_transfer": "smpte2084"}]});
        let i = parse_probe(&json);
        assert_eq!((i.video.as_ref().unwrap().pix_fmt.as_str(), i.video.as_ref().unwrap().color_transfer.as_str()), ("yuv420p10le", "smpte2084"));
    }

    /// Real runtime probe with the staged LGPL ffmpeg (`npm run stage:mpv`): on Windows the
    /// first candidate h264_mf must pass on this machine, the fallback must encode, and a
    /// missing encoder is reported as such.
    #[test]
    fn encoder_runtime_probe_real_ffmpeg() {
        let t = test_tools();
        let listed = encoders(&t);
        assert!(listed.iter().any(|e| e == "mpeg4"), "{listed:?}");
        probe_encoder(&t, &FALLBACK_ENCODER).expect("mpeg4 fallback encodes");
        let c = select_encoder(H264_CANDIDATES, &listed, &|e| probe_encoder(&t, e));
        if cfg!(windows) {
            assert_eq!((c.encoder.name, c.fallback), ("h264_mf", false), "{:?}", c.attempts);
        }
        let ghost = enc("h264_does_not_exist", "h264", false, "yuv420p", 64, 64);
        assert!(probe_encoder(&t, &ghost).is_err());
        let c = select_encoder(&[ghost], &listed, &|e| probe_encoder(&t, e));
        assert!(c.fallback && !c.attempts[0].present);
    }
}

/// ffmpeg/ffprobe for tests: `VHO_FFMPEG`, else the staged copy in `src-tauri/target/{release,debug}`.
/// Missing ffmpeg FAILS the calling test (no silent pass).
#[cfg(test)]
pub(crate) fn test_tools() -> Tools {
    let mut dirs: Vec<PathBuf> = vec![];
    if let Some(p) = std::env::var_os("VHO_FFMPEG").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        dirs.push(if p.is_file() { p.parent().map(Path::to_path_buf).unwrap_or_default() } else { p });
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    dirs.push(manifest.join("target").join("release"));
    dirs.push(manifest.join("target").join("debug"));
    dirs.into_iter()
        .find_map(|d| {
            let (ffmpeg, ffprobe) = (d.join(format!("ffmpeg{EXE}")), d.join(format!("ffprobe{EXE}")));
            (ffmpeg.is_file() && ffprobe.is_file()).then_some(Tools { ffmpeg, ffprobe })
        })
        .expect("ffmpeg/ffprobe not found: run `npm run stage:mpv` (copies them to src-tauri/target/release) or set VHO_FFMPEG")
}
