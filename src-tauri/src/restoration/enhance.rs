//! Faithful video enhance (user decision 2026-10-28; the model-free scope of V03). No model:
//! LGPL ffmpeg filters only, chosen by the V01 recipe (`recipe::video_filter`): deinterlace (when
//! the probe says so) → light `deblock` → temporal `atadenoise` → Lanczos scale (none / ×2, short
//! side ≤ 1080) → low-strength `cas` → BT.709 SDR 8-bit 4:2:0. Audio and subtitles are copied.
//!
//! Two runs share the chain:
//! - preview: a short range rendered side by side (left: the source with only the geometry steps,
//!   right: the full chain), MP4 without audio, so the webview can play it;
//! - full: the whole file into a new MKV next to the source (never over it).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::probe::{FieldOrder, SourceReport};
use super::recipe::{self, DenoiseFilter, Level, Recipe, Strength, TimeRange};
use crate::actions::ffmpeg::{self, Tools, VideoEncoder};

/// Length of the side-by-side preview (seconds).
pub const PREVIEW_SECONDS: f64 = 10.0;

/// What the dialog lets the user choose. Defaults are light: fidelity first.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnhanceOptions {
    /// Block clean-up + temporal denoise
    pub denoise: Level,
    pub sharpen: Level,
    /// ×2 (short side ≤ 1080) instead of the source size
    pub upscale: bool,
}

impl Default for EnhanceOptions {
    fn default() -> Self {
        Self { denoise: Level::Light, sharpen: Level::Light, upscale: false }
    }
}

/// Recipe for `opts` on top of the V01 suggestion (deinterlace, colour, rotation, streams).
/// `field_order`: the user's answer when the probe could not decide (`field-order-unconfirmed`).
pub fn build_recipe(report: &SourceReport, opts: EnhanceOptions, range: Option<TimeRange>, field_order: Option<FieldOrder>) -> Option<Recipe> {
    let mut r = recipe::suggest(report)?;
    let v = report.video.as_ref()?;
    if let Some(fo) = field_order {
        r.deinterlace.field_order = fo;
        r.deinterlace.user_confirmed = true;
        if matches!(fo, FieldOrder::Tff | FieldOrder::Bff) && r.deinterlace.filter == recipe::DeinterlaceFilter::Off {
            r.deinterlace.filter = recipe::DeinterlaceFilter::Bwdif;
        }
    }
    // denoise level drives both the block clean-up and the temporal denoiser
    r.deblock = opts.denoise;
    r.denoise = match opts.denoise {
        Level::Off => recipe::Denoise { filter: DenoiseFilter::Off, strength: Strength::Light },
        Level::Light => recipe::Denoise { filter: DenoiseFilter::Atadenoise, strength: Strength::Light },
        Level::Medium => recipe::Denoise { filter: DenoiseFilter::Atadenoise, strength: Strength::Medium },
    };
    r.sharpen = opts.sharpen;
    let targets = recipe::targets(v.display_width, v.display_height);
    let wanted = if opts.upscale { "2x" } else { "1x" };
    let t = targets
        .iter()
        .find(|t| t.id == wanted)
        // ×2 would pass the 1080 short side: the largest offered size instead
        .or_else(|| if opts.upscale { targets.iter().max_by_key(|t| t.width) } else { None })
        .or_else(|| targets.first())?;
    r.scale.target = t.id.clone();
    r.scale.width = t.width;
    r.scale.height = t.height;
    if let Some(range) = range {
        r.range = range;
    }
    recipe::normalize(&mut r, report);
    Some(r)
}

/// Chain of the preview's left half: only what makes the two halves comparable frame by frame
/// (same deinterlace, rotation, size and colour), no clean-up and no sharpening.
pub fn reference_filter(recipe: &Recipe) -> String {
    let mut plain = recipe.clone();
    plain.deblock = Level::Off;
    plain.denoise.filter = DenoiseFilter::Off;
    plain.sharpen = Level::Off;
    recipe::video_filter(&plain)
}

/// Video bit rate for the output size (generous: the point is to keep detail).
pub fn video_kbps(w: u32, h: u32, fps: f64) -> u32 {
    let fps = if fps.is_finite() && fps > 0.0 { fps.min(60.0) } else { 30.0 };
    ((w as f64 * h as f64 * fps * 0.12 / 1000.0) as u32).clamp(1500, 24000)
}

fn secs(t: f64) -> String {
    format!("{t:.3}")
}

fn range_args(r: &TimeRange, preview: bool) -> Vec<String> {
    let mut a = vec![];
    if r.start > 0.0 {
        a.push("-ss".into());
        a.push(secs(r.start));
    }
    let end = if preview { Some(r.end.unwrap_or(r.start + PREVIEW_SECONDS)) } else { r.end };
    if let Some(e) = end {
        a.push("-t".into());
        a.push(secs((e - r.start).max(0.1)));
    }
    a
}

fn color_tags(recipe: &Recipe) -> Vec<String> {
    let o = &recipe.color.output;
    [
        ("-color_primaries", o.primaries.as_str()),
        ("-color_trc", o.transfer.as_str()),
        ("-colorspace", o.matrix.as_str()),
        ("-color_range", o.range.as_str()),
    ]
    .into_iter()
    .flat_map(|(k, v)| [k.to_string(), v.to_string()])
    .collect()
}

fn fps_args(recipe: &Recipe) -> Vec<String> {
    match (&recipe.output.fps_mode, &recipe.output.fps) {
        (recipe::FpsMode::Cfr, Some(r)) => vec!["-r".into(), format!("{}/{}", r.num, r.den)],
        _ => vec!["-fps_mode".into(), "passthrough".into()],
    }
}

fn out_fps(recipe: &Recipe, report: &SourceReport) -> f64 {
    recipe.output.fps.map(|r| r.value()).or_else(|| report.video.as_ref().and_then(|v| v.frame_rate.measured_fps)).unwrap_or(30.0)
}

/// ffmpeg arguments (after the global options of `run_ffmpeg`).
pub fn ffmpeg_args(input: &Path, recipe: &Recipe, report: &SourceReport, encoder: &VideoEncoder, output: &Path, preview: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-noautorotate".into()];
    a.extend(range_args(&recipe.range, preview));
    a.push("-i".into());
    a.push(input.to_string_lossy().into_owned());
    let chain = recipe::video_filter(recipe);
    let (w, h) = (recipe.scale.width, recipe.scale.height);
    if preview {
        // left half: reference, right half: enhanced (same frame, same size)
        let half = (w / 2) & !1;
        let graph = format!(
            "[0:{v}]split=2[a][b];[a]{refc},crop={half}:{h}:0:0[l];[b]{chain},crop={rw}:{h}:{half}:0[r];[l][r]hstack=inputs=2,format=yuv420p[out]",
            v = recipe.video_stream,
            refc = reference_filter(recipe),
            rw = w - half,
        );
        a.extend(["-filter_complex".into(), graph, "-map".into(), "[out]".into(), "-an".into(), "-sn".into()]);
    } else {
        a.extend(["-map".into(), format!("0:{}", recipe.video_stream), "-vf".into(), chain]);
        if recipe.audio.policy != recipe::StreamPolicy::None {
            a.extend(["-map".into(), "0:a?".into(), "-c:a".into(), "copy".into()]);
        }
        if recipe.subtitles.policy != recipe::StreamPolicy::None {
            a.extend(["-map".into(), "0:s?".into(), "-c:s".into(), "copy".into()]);
        }
        a.extend(["-map_metadata".into(), "0".into(), "-map_chapters".into(), "0".into()]);
    }
    a.extend(fps_args(recipe));
    a.extend(ffmpeg::video_codec_args(encoder, video_kbps(w, h, out_fps(recipe, report)), false));
    a.extend(color_tags(recipe));
    if preview {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.extend(["-loglevel".into(), "error".into()]);
    a.push(output.to_string_lossy().into_owned());
    a
}

/// Seconds the run covers (progress denominator).
pub fn expected_seconds(recipe: &Recipe, report: &SourceReport, preview: bool) -> f64 {
    let total = report.duration.unwrap_or(0.0);
    let end = if preview { recipe.range.end.unwrap_or(recipe.range.start + PREVIEW_SECONDS) } else { recipe.range.end.unwrap_or(total) };
    (end.min(if total > 0.0 { total } else { end }) - recipe.range.start).max(0.0)
}

/// Runs the chain into `output` (a temporary name; the caller places it). Errors are coded.
pub fn render(
    tools: &Tools,
    input: &Path,
    recipe: &Recipe,
    report: &SourceReport,
    encoder: &VideoEncoder,
    output: &Path,
    preview: bool,
    cancelled: &dyn Fn() -> bool,
    progress: impl Fn(f64) + Send + 'static,
) -> Result<u64, String> {
    let args = ffmpeg_args(input, recipe, report, encoder, output, preview);
    let r = ffmpeg::run_ffmpeg(&tools.ffmpeg, &args, expected_seconds(recipe, report, preview), cancelled, progress);
    if let Err(e) = r {
        let _ = std::fs::remove_file(output);
        return Err(e);
    }
    let size = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(output);
        return Err("ffmpeg boş bir dosya üretti".into());
    }
    Ok(size)
}

/// File name of the result: `<stem>_enhanced.mkv` (full) / `<stem>_preview.mp4` (preview).
pub fn output_name(input: &Path, preview: bool) -> (String, &'static str) {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "video".into());
    if preview { (format!("{stem}_preview"), "mp4") } else { (format!("{stem}_enhanced"), "mkv") }
}

/// Folder of the full result when none is given: next to the source.
pub fn default_dir(input: &Path) -> PathBuf {
    input.parent().map(Path::to_path_buf).unwrap_or_default()
}
