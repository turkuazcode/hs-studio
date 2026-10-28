//! V01 restoration recipe (Plan 12): every decision of a restoration job in one serialisable
//! struct, hashed TOGETHER with the source measurements (`SourceReport`), so a preview/segment
//! made with other settings or from a changed file is never reused.
//!
//! First version: output is SDR, BT.709, 8-bit 4:2:0 (`output_color`). HDR input (PQ, HLG,
//! Dolby Vision) is BLOCKED: this LGPL ffmpeg build has no correct tone mapping path (no zimg /
//! `zscale`, no libplacebo filter; `tonemap` needs linear-light input and `colorspace` has no
//! PQ/HLG transfer). Copying HDR tags onto SDR pixels is never done: output tags are written
//! from `output_color()`, not copied.
//!
//! Filters (all present in the staged FFmpeg n8.1.3 build, all LGPL-2.1+ in that source tree;
//! `hqdn3d`, `kerndeint`, `mcdeint`, `pp7`, `spp`, `owdenoise`, `tinterlace` are GPL-only and
//! absent): deinterlace `bwdif` / `yadif` / `w3fdif` / `estdif`; denoise `atadenoise` /
//! `nlmeans` / `fftdnoiz`; block clean-up `deblock`; sharpening `cas`; `transpose`/`hflip`/
//! `vflip`, `scale` (lanczos), `setsar`, `colorspace`, `format`. Verified against `ffmpeg -filters` at run time (`missing_filters`).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::probe::{ColorInfo, DynamicRange, FieldOrder, RateMode, Rational, SourceReport, UNKNOWN, VideoInfo};

pub const RECIPE_SCHEMA: u32 = 1;
/// Without a (V02-approved) model the scale factor is limited to plain resampling quality.
pub const MAX_FACTOR_WITHOUT_MODEL: f64 = 2.0;
/// Short side ceiling of the suggestions (never "auto 4K").
pub const MAX_SUGGESTED_SHORT_SIDE: u32 = 1080;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputColor {
    pub primaries: String,
    pub transfer: String,
    pub matrix: String,
    pub range: String,
    pub pix_fmt: String,
    pub bit_depth: u32,
}

/// The only output of the first version: SDR BT.709, limited range, 8-bit 4:2:0.
pub fn output_color() -> OutputColor {
    OutputColor {
        primaries: "bt709".into(),
        transfer: "bt709".into(),
        matrix: "bt709".into(),
        range: "tv".into(),
        pix_fmt: "yuv420p".into(),
        bit_depth: 8,
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeinterlaceFilter {
    Off,
    Bwdif,
    Yadif,
    W3fdif,
    Estdif,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FieldRate {
    /// One output frame per input frame (25i → 25p)
    Frame,
    /// One output frame per field (25i → 50p; keeps the motion of interlaced video)
    Field,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Deinterlace {
    pub filter: DeinterlaceFilter,
    /// Field order used by the filter (`parity`); `Progressive` with `Off`
    pub field_order: FieldOrder,
    pub rate: FieldRate,
    /// The user confirmed `field_order` (required when the probe could not decide)
    pub user_confirmed: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DenoiseFilter {
    Off,
    /// Temporal, fast
    Atadenoise,
    /// Spatial non-local means, slow
    Nlmeans,
    /// 2D/3D FFT
    Fftdnoiz,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Strength {
    Light,
    Medium,
    Strong,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Denoise {
    pub filter: DenoiseFilter,
    pub strength: Strength,
}

/// Light post-processing steps of the faithful (model-free) enhance: JPEG/MPEG block clean-up
/// (`deblock`) before denoising, contrast-adaptive sharpening (`cas`) after scaling.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    #[default]
    Off,
    Light,
    Medium,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub id: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TargetOption {
    /// "1x", "2x", "720p", "1080p"
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub factor: f64,
    pub recommended: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub target: String,
    /// Output size in display orientation, square pixels
    pub width: u32,
    pub height: u32,
    pub method: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorPlan {
    /// Input colour as it will be interpreted (measured values + explicit assumptions)
    pub input: ColorInfo,
    /// Fields of `input` that are NOT from the file (assumed by the suggestion or set by the user)
    pub assumed: Vec<String>,
    pub output: OutputColor,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FpsMode {
    /// Constant rate `fps`
    Cfr,
    /// Keep the source timestamps (VFR / unknown); field-rate deinterlace still doubles them
    Passthrough,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputPlan {
    pub container: String,
    pub video_encoder: String,
    pub fps_mode: FpsMode,
    pub fps: Option<Rational>,
    /// Rotation baked into the pixels (the output carries no display rotation)
    pub rotation_applied: i32,
    /// Horizontal mirror baked in before the rotation (mirroring display matrix)
    #[serde(default)]
    pub mirror_applied: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StreamPolicy {
    /// Copy every stream of that type unchanged (default: original audio is kept)
    CopyAll,
    /// Copy only `streams`
    Selected,
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamSelection {
    pub policy: StreamPolicy,
    /// Absolute stream indexes (with `Selected`)
    pub streams: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: f64,
    /// None = until the end
    pub end: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub schema: u32,
    pub video_stream: u32,
    pub range: TimeRange,
    pub deinterlace: Deinterlace,
    /// Block clean-up before denoising (absent in V01 recipes = off)
    #[serde(default)]
    pub deblock: Level,
    pub denoise: Denoise,
    /// None until a model passes the V02 gate
    pub model: Option<ModelRef>,
    pub scale: Scale,
    /// Contrast-adaptive sharpening after scaling (absent in V01 recipes = off)
    #[serde(default)]
    pub sharpen: Level,
    pub color: ColorPlan,
    pub output: OutputPlan,
    pub audio: StreamSelection,
    pub subtitles: StreamSelection,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Ok,
    /// Runs, the user is told about `notices`
    Notify,
    /// Must not run (`blockers`)
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub status: Status,
    /// Codes (i18n keys `restoration.notice.<code>` once V04 shows them)
    pub notices: Vec<String>,
    pub blockers: Vec<String>,
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

fn even(x: f64) -> u32 {
    ((x / 2.0).round() as u32 * 2).max(2)
}

/// Output sizes worth offering for a display size (square pixels, display orientation).
/// Never more than ×2 (plain resampling) and never above a 1080 short side.
pub fn targets(display_w: u32, display_h: u32) -> Vec<TargetOption> {
    let (dw, dh) = (display_w.max(2), display_h.max(2));
    let short = dw.min(dh) as f64;
    let size = |f: f64| (even(dw as f64 * f), even(dh as f64 * f));
    let mut out = vec![];
    let (w, h) = size(1.0);
    out.push(TargetOption { id: "1x".into(), width: w, height: h, factor: 1.0, recommended: false });
    if short * 2.0 <= MAX_SUGGESTED_SHORT_SIDE as f64 {
        let (w, h) = size(2.0);
        out.push(TargetOption { id: "2x".into(), width: w, height: h, factor: 2.0, recommended: false });
    }
    for (id, side) in [("720p", 720.0), ("1080p", 1080.0)] {
        let f = side / short;
        if f > 1.0 && f <= MAX_FACTOR_WITHOUT_MODEL && !out.iter().any(|t| (t.factor - f).abs() < 0.01) {
            let (w, h) = size(f);
            out.push(TargetOption { id: id.into(), width: w, height: h, factor: f, recommended: false });
        }
    }
    let pick = if short <= 360.0 {
        "2x"
    } else if short < 720.0 && out.iter().any(|t| t.id == "720p") {
        "720p"
    } else {
        "1x"
    };
    for t in &mut out {
        t.recommended = t.id == pick;
    }
    if !out.iter().any(|t| t.recommended) {
        out[0].recommended = true;
    }
    out
}

/// Conventional interpretation of untagged video (what players do): SD → BT.601 (625 lines:
/// BT.470BG, else SMPTE 170M), HD → BT.709; range limited unless the decoder says full (yuvj).
/// Returned fields are marked as ASSUMED in the recipe.
pub fn assume_color(v: &VideoInfo) -> (ColorInfo, Vec<String>) {
    let sd = v.height <= 576;
    let pal = v.height == 576 || v.height == 288;
    let mut c = v.color.clone();
    let mut assumed = vec![];
    let mut set = |field: &str, value: &str, slot: &mut String| {
        if slot == UNKNOWN {
            *slot = value.into();
            assumed.push(field.to_string());
        }
    };
    let prim = if !sd { "bt709" } else if pal { "bt470bg" } else { "smpte170m" };
    let mat = if !sd { "bt709" } else if pal { "bt470bg" } else { "smpte170m" };
    let trc = if sd { "smpte170m" } else { "bt709" };
    set("primaries", prim, &mut c.primaries);
    set("matrix", mat, &mut c.matrix);
    // Transfer decides SDR vs HDR: only assumed for 8-bit sources (10-bit untagged may be HLG/log)
    if v.bit_depth.is_some_and(|b| b <= 8) {
        set("transfer", trc, &mut c.transfer);
    }
    let full = v.pix_fmt.starts_with("yuvj");
    set("range", if full { "pc" } else { "tv" }, &mut c.range);
    (c, assumed)
}

fn source_fps(v: &VideoInfo) -> Option<Rational> {
    let fr = &v.frame_rate;
    let measured = fr.measured_fps?;
    [fr.r_frame_rate, fr.avg_frame_rate].into_iter().flatten().find(|r| (r.value() - measured).abs() / measured < 0.01)
}

/// Suggested recipe for a probed source. The suggestion may still be BLOCKED (`assess`), e.g.
/// HDR input or a field order the user has to confirm.
pub fn suggest(report: &SourceReport) -> Option<Recipe> {
    let v = report.video.as_ref()?;
    let fo = &v.field_order;
    let interlaced = matches!(fo.suggestion, FieldOrder::Tff | FieldOrder::Bff);
    let deinterlace = Deinterlace {
        filter: if interlaced { DeinterlaceFilter::Bwdif } else { DeinterlaceFilter::Off },
        field_order: if fo.needs_choice { fo.suggestion } else { fo.value },
        rate: FieldRate::Field,
        user_confirmed: false,
    };
    let target = targets(v.display_width, v.display_height).into_iter().find(|t| t.recommended)?;
    let (input, assumed) = assume_color(v);
    let mut recipe = Recipe {
        schema: RECIPE_SCHEMA,
        video_stream: v.index,
        range: TimeRange { start: 0.0, end: None },
        deinterlace,
        deblock: Level::Off,
        denoise: Denoise { filter: DenoiseFilter::Off, strength: Strength::Light },
        model: None,
        scale: Scale { target: target.id, width: target.width, height: target.height, method: "lanczos".into() },
        sharpen: Level::Off,
        color: ColorPlan { input, assumed, output: output_color() },
        output: OutputPlan {
            container: "mkv".into(),
            video_encoder: crate::actions::ffmpeg::H264_ENCODER.into(),
            fps_mode: FpsMode::Cfr,
            fps: None,
            rotation_applied: v.rotation,
            mirror_applied: v.mirrored,
        },
        audio: StreamSelection { policy: StreamPolicy::CopyAll, streams: vec![] },
        subtitles: StreamSelection { policy: StreamPolicy::CopyAll, streams: vec![] },
    };
    normalize(&mut recipe, report);
    Some(recipe)
}

/// Derived fields the user does not choose directly: output fps / mode (field-rate doubling),
/// rotation, schema. Called by `suggest` and on every recipe coming from the UI.
pub fn normalize(recipe: &mut Recipe, report: &SourceReport) {
    recipe.schema = RECIPE_SCHEMA;
    recipe.color.output = output_color();
    let Some(v) = report.video.as_ref() else { return };
    recipe.output.rotation_applied = v.rotation;
    recipe.output.mirror_applied = v.mirrored;
    if recipe.deinterlace.filter == DeinterlaceFilter::Off || recipe.deinterlace.field_order == FieldOrder::Progressive {
        recipe.deinterlace.filter = DeinterlaceFilter::Off;
        recipe.deinterlace.field_order = FieldOrder::Progressive;
    }
    let doubled = recipe.deinterlace.filter != DeinterlaceFilter::Off && recipe.deinterlace.rate == FieldRate::Field;
    match (v.frame_rate.mode, source_fps(v)) {
        (RateMode::Cfr, Some(r)) => {
            recipe.output.fps_mode = FpsMode::Cfr;
            recipe.output.fps = Some(if doubled { Rational { num: r.num * 2, den: r.den } } else { r });
        }
        _ => {
            recipe.output.fps_mode = FpsMode::Passthrough;
            recipe.output.fps = None;
        }
    }
    // assumed = every input colour field that differs from the measurement
    recipe.color.assumed = [
        ("primaries", &recipe.color.input.primaries, &v.color.primaries),
        ("transfer", &recipe.color.input.transfer, &v.color.transfer),
        ("matrix", &recipe.color.input.matrix, &v.color.matrix),
        ("range", &recipe.color.input.range, &v.color.range),
    ]
    .into_iter()
    .filter(|(_, used, measured)| used != measured)
    .map(|(k, _, _)| k.to_string())
    .collect();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// colorspace filter names (ffprobe → `vf_colorspace`); None = not convertible by this build.
fn cs_matrix(s: &str) -> Option<&'static str> {
    Some(match s {
        "bt709" => "bt709",
        "smpte170m" => "smpte170m",
        "bt470bg" => "bt470bg",
        "smpte240m" => "smpte240m",
        "fcc" => "fcc",
        "bt2020nc" | "bt2020ncl" => "bt2020ncl",
        "ycgco" => "ycgco",
        _ => return None,
    })
}
fn cs_primaries(s: &str) -> Option<&'static str> {
    Some(match s {
        "bt709" => "bt709",
        "bt470m" => "bt470m",
        "bt470bg" => "bt470bg",
        "smpte170m" => "smpte170m",
        "smpte240m" => "smpte240m",
        "film" => "film",
        "bt2020" => "bt2020",
        "smpte431" => "smpte431",
        "smpte432" => "smpte432",
        _ => return None,
    })
}
fn cs_transfer(s: &str) -> Option<&'static str> {
    Some(match s {
        "bt709" => "bt709",
        "bt470m" | "gamma22" => "gamma22",
        "bt470bg" | "gamma28" => "gamma28",
        "smpte170m" => "smpte170m",
        "smpte240m" => "smpte240m",
        "linear" => "linear",
        "iec61966-2-1" => "iec61966-2-1",
        "iec61966-2-4" => "iec61966-2-4",
        "bt2020-10" => "bt2020-10",
        "bt2020-12" => "bt2020-12",
        _ => return None,
    })
}
fn cs_range(s: &str) -> Option<&'static str> {
    match s {
        "tv" | "mpeg" | "limited" => Some("tv"),
        "pc" | "jpeg" | "full" => Some("pc"),
        _ => None,
    }
}

/// True when the input already is the output colour (no `colorspace` step).
fn color_is_output(c: &ColorInfo) -> bool {
    cs_matrix(&c.matrix) == Some("bt709")
        && cs_primaries(&c.primaries) == Some("bt709")
        && matches!(cs_transfer(&c.transfer), Some("bt709" | "smpte170m"))
        && cs_range(&c.range) == Some("tv")
}

/// Checks the recipe against the measurements. Never panics on odd input; problems are codes.
pub fn assess(recipe: &Recipe, report: &SourceReport) -> Assessment {
    let mut notices = vec![];
    let mut blockers = vec![];
    let Some(v) = report.video.as_ref() else {
        return Assessment { status: Status::Blocked, notices, blockers: vec!["no-video".into()] };
    };
    if recipe.schema != RECIPE_SCHEMA {
        blockers.push("recipe-schema".into());
    }
    if recipe.video_stream != v.index {
        blockers.push("video-stream".into());
    }
    // dynamic range: HDR is stopped, never relabelled
    match v.dynamic_range {
        DynamicRange::HdrPq | DynamicRange::HdrHlg | DynamicRange::DolbyVision => blockers.push("hdr-unsupported".into()),
        DynamicRange::Unknown => {
            let t = recipe.color.input.transfer.as_str();
            if t == "smpte2084" || t == "arib-std-b67" {
                blockers.push("hdr-unsupported".into());
            } else if t == UNKNOWN {
                blockers.push("dynamic-range-unknown".into());
            } else if !v.hdr_side_data.is_empty() {
                blockers.push("hdr-unsupported".into());
            }
        }
        DynamicRange::Sdr => {}
    }
    if v.bit_depth.is_some_and(|b| b > 8) {
        notices.push("bit-depth-reduced".into());
    }
    if v.bit_depth.is_none() {
        notices.push("bit-depth-unknown".into());
    }
    let c = &recipe.color.input;
    if !blockers.iter().any(|b| b == "hdr-unsupported" || b == "dynamic-range-unknown") {
        if [cs_matrix(&c.matrix).is_none(), cs_primaries(&c.primaries).is_none(), cs_transfer(&c.transfer).is_none(), cs_range(&c.range).is_none()]
            .into_iter()
            .any(|x| x)
        {
            blockers.push("color-unsupported".into());
        }
        if cs_primaries(&c.primaries) == Some("bt2020") {
            notices.push("wide-gamut-clipped".into());
        }
    }
    if !recipe.color.assumed.is_empty() {
        notices.push("color-assumed".into());
    }
    // field order: an undecided source needs an explicit choice
    let fo = &v.field_order;
    if fo.needs_choice && !recipe.deinterlace.user_confirmed {
        blockers.push("field-order-unconfirmed".into());
    }
    if recipe.deinterlace.filter != DeinterlaceFilter::Off && recipe.deinterlace.field_order == FieldOrder::Unknown {
        blockers.push("field-order-unconfirmed".into());
    }
    if !fo.needs_choice
        && matches!(fo.value, FieldOrder::Tff | FieldOrder::Bff)
        && recipe.deinterlace.filter != DeinterlaceFilter::Off
        && recipe.deinterlace.field_order != fo.value
        && !recipe.deinterlace.user_confirmed
    {
        blockers.push("field-order-mismatch".into());
    }
    if !fo.needs_choice && matches!(fo.value, FieldOrder::Tff | FieldOrder::Bff) && recipe.deinterlace.filter == DeinterlaceFilter::Off {
        notices.push("interlaced-kept".into());
    }
    if v.rotation.rem_euclid(90) != 0 {
        blockers.push("rotation-unsupported".into());
    }
    if v.frame_rate.mode != RateMode::Cfr {
        notices.push(if v.frame_rate.mode == RateMode::Vfr { "vfr-kept" } else { "frame-rate-unknown" }.into());
    }
    // model: none passed the V02 gate yet
    if recipe.model.is_some() {
        blockers.push("model-not-ready".into());
    }
    // scale: aspect kept, at most ×2, even sizes
    let (dw, dh) = (v.display_width.max(2) as f64, v.display_height.max(2) as f64);
    let (w, h) = (recipe.scale.width as f64, recipe.scale.height as f64);
    let factor = (w / dw).max(h / dh);
    if w < 2.0 || h < 2.0 || recipe.scale.width % 2 != 0 || recipe.scale.height % 2 != 0 {
        blockers.push("scale-invalid".into());
    } else {
        if factor > MAX_FACTOR_WITHOUT_MODEL + 0.01 {
            blockers.push("scale-too-large".into());
        }
        let aspect_err = ((w / h) - (dw / dh)).abs() / (dw / dh);
        if aspect_err > 0.01 {
            blockers.push("aspect-changed".into());
        }
    }
    if recipe.scale.method != "lanczos" && recipe.scale.method != "bicubic" {
        blockers.push("scale-method".into());
    }
    // range
    let r = &recipe.range;
    let dur = report.duration;
    if !r.start.is_finite() || r.start < 0.0 || r.end.is_some_and(|e| !e.is_finite() || e <= r.start) {
        blockers.push("range-invalid".into());
    } else if let Some(d) = dur {
        if r.start >= d || r.end.is_some_and(|e| e > d + 0.5) {
            blockers.push("range-invalid".into());
        }
    }
    // streams
    let check = |sel: &StreamSelection, have: &[u32], code: &str, blockers: &mut Vec<String>| {
        if sel.policy == StreamPolicy::Selected && (sel.streams.is_empty() || sel.streams.iter().any(|s| !have.contains(s))) {
            blockers.push(code.into());
        }
    };
    check(&recipe.audio, &report.audio.iter().map(|a| a.index).collect::<Vec<_>>(), "audio-stream", &mut blockers);
    check(&recipe.subtitles, &report.subtitles.iter().map(|s| s.index).collect::<Vec<_>>(), "subtitle-stream", &mut blockers);
    if recipe.output.container != "mkv" && recipe.output.container != "mp4" {
        blockers.push("container".into());
    }
    if recipe.output.container == "mp4" && recipe.subtitles.policy != StreamPolicy::None && report.subtitles.iter().any(|s| !s.text) {
        blockers.push("subtitle-container".into());
    }
    blockers.dedup();
    let status = if !blockers.is_empty() {
        Status::Blocked
    } else if !notices.is_empty() {
        Status::Notify
    } else {
        Status::Ok
    };
    Assessment { status, notices, blockers }
}

// ---------------------------------------------------------------------------
// Filter graph + hash
// ---------------------------------------------------------------------------

fn parity(f: FieldOrder) -> &'static str {
    if f == FieldOrder::Bff { "bff" } else { "tff" }
}

/// ffmpeg `-vf` chain for the recipe. The input must be decoded with `-noautorotate` (fields
/// are lines of the coded picture: deinterlace BEFORE rotation). Order: deinterlace → deblock →
/// denoise → (model, V03) → rotate → scale (SAR → 1:1) → sharpen → colour → 8-bit 4:2:0.
pub fn video_filter(recipe: &Recipe) -> String {
    let mut f: Vec<String> = vec![];
    let d = &recipe.deinterlace;
    if d.filter != DeinterlaceFilter::Off && d.field_order != FieldOrder::Progressive {
        let p = parity(d.field_order);
        let field = d.rate == FieldRate::Field;
        f.push(match d.filter {
            DeinterlaceFilter::Bwdif => format!("bwdif=mode={}:parity={p}:deint=all", if field { "send_field" } else { "send_frame" }),
            DeinterlaceFilter::Yadif => format!("yadif=mode={}:parity={p}:deint=all", if field { "send_field" } else { "send_frame" }),
            DeinterlaceFilter::W3fdif => format!("w3fdif=filter=complex:mode={}:parity={p}:deint=all", if field { "field" } else { "frame" }),
            DeinterlaceFilter::Estdif => format!("estdif=mode={}:parity={p}:deint=all", if field { "field" } else { "frame" }),
            DeinterlaceFilter::Off => unreachable!(),
        });
    }
    match recipe.deblock {
        Level::Off => {}
        Level::Light => f.push("deblock=filter=weak:block=8".into()),
        Level::Medium => f.push("deblock=filter=strong:block=8".into()),
    }
    let s = recipe.denoise.strength;
    match recipe.denoise.filter {
        DenoiseFilter::Off => {}
        DenoiseFilter::Atadenoise => f.push(match s {
            // 5 frames: less ghosting on fast motion than the default 9
            Strength::Light => "atadenoise=s=5".into(),
            Strength::Medium => "atadenoise=0a=0.04:0b=0.08:1a=0.04:1b=0.08:2a=0.04:2b=0.08".into(),
            Strength::Strong => "atadenoise=0a=0.08:0b=0.16:1a=0.08:1b=0.16:2a=0.08:2b=0.16:s=15".into(),
        }),
        DenoiseFilter::Nlmeans => f.push(format!("nlmeans=s={}:p=7:r=15", match s {
            Strength::Light => "1.5",
            Strength::Medium => "3",
            Strength::Strong => "5",
        })),
        DenoiseFilter::Fftdnoiz => f.push(format!("fftdnoiz=sigma={}", match s {
            Strength::Light => 3,
            Strength::Medium => 6,
            Strength::Strong => 10,
        })),
    }
    // display orientation: mirror first, then rotation (counter-clockwise degrees, ffprobe convention)
    if recipe.output.mirror_applied {
        f.push("hflip".into());
    }
    match recipe.output.rotation_applied.rem_euclid(360) {
        90 => f.push("transpose=cclock".into()),
        180 => f.push("hflip,vflip".into()),
        270 => f.push("transpose=clock".into()),
        _ => {}
    }
    f.push(format!("scale={}:{}:flags={},setsar=1", recipe.scale.width, recipe.scale.height, recipe.scale.method));
    // cas: sharpening limited by local contrast (no ringing/halo at strong edges)
    match recipe.sharpen {
        Level::Off => {}
        Level::Light => f.push("cas=strength=0.3".into()),
        Level::Medium => f.push("cas=strength=0.55".into()),
    }
    let c = &recipe.color.input;
    let o = &recipe.color.output;
    if !color_is_output(c) {
        if let (Some(sp), Some(pr), Some(tr), Some(rg)) = (cs_matrix(&c.matrix), cs_primaries(&c.primaries), cs_transfer(&c.transfer), cs_range(&c.range)) {
            f.push(format!(
                "colorspace=ispace={sp}:iprimaries={pr}:itrc={tr}:irange={rg}:space={}:primaries={}:trc={}:range={}:format=yuv420p",
                o.matrix, o.primaries, o.transfer, o.range
            ));
        }
    }
    f.push(format!("format={}", o.pix_fmt));
    f.join(",")
}

/// Filter names the chain needs (for the `ffmpeg -filters` check).
pub fn required_filters(chain: &str) -> Vec<String> {
    let mut v: Vec<String> = chain
        .split(',')
        .filter_map(|p| p.split('=').next())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    v.sort();
    v.dedup();
    v
}

pub fn missing_filters(chain: &str, available: &[String]) -> Vec<String> {
    required_filters(chain).into_iter().filter(|f| !available.contains(f)).collect()
}

#[derive(Serialize)]
struct HashInput<'a> {
    kind: &'static str,
    recipe: &'a Recipe,
    report: &'a SourceReport,
}

/// SHA-256 of the recipe together with the source fingerprint and every measurement.
/// serde_json writes struct fields in declaration order and maps sorted → stable bytes.
pub fn recipe_hash(recipe: &Recipe, report: &SourceReport) -> String {
    let bytes = serde_json::to_vec(&HashInput { kind: "vho-restoration-recipe", recipe, report }).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}
