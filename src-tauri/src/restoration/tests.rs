//! V01 tests. Part 1: pure parsers/rules with recorded ffprobe JSON and log text.
//! Part 2 (`fixtures_*`): GENERATED fixtures (ffmpeg lavfi, nothing personal) probed with the
//! real staged LGPL ffmpeg/ffprobe. ffmpeg is looked up via `VHO_FFMPEG`, then next to the test
//! binary's target folder (`npm run stage:mpv` copies it to `src-tauri/target/release`). A
//! missing ffmpeg FAILS these tests (no silent pass).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use super::probe::*;
use super::recipe::*;
use crate::actions::ffmpeg::Tools;

fn fp() -> SourceFingerprint {
    SourceFingerprint { path: "x".into(), size: 1, modified_ms: 2 }
}

fn video_json(extra: serde_json::Value) -> serde_json::Value {
    let mut s = json!({
        "index": 0, "codec_type": "video", "codec_name": "mpeg2video", "width": 720, "height": 576,
        "sample_aspect_ratio": "16:15", "display_aspect_ratio": "4:3", "pix_fmt": "yuv420p",
        "field_order": "tt", "r_frame_rate": "25/1", "avg_frame_rate": "25/1", "time_base": "1/90000",
        "disposition": {"attached_pic": 0}
    });
    for (k, v) in extra.as_object().unwrap() {
        s[k] = v.clone();
    }
    json!({"format": {"format_name": "mpeg", "duration": "10.0"}, "streams": [s]})
}

fn report(extra: serde_json::Value) -> SourceReport {
    parse_streams(&video_json(extra), fp())
}

fn with_analysis(mut r: SourceReport, counts: IdetCounts, cfr: bool) -> SourceReport {
    let v = r.video.as_mut().unwrap();
    v.field_order = classify_field_order(v.field_order.metadata, Some(counts));
    v.frame_rate.mode = if cfr { RateMode::Cfr } else { RateMode::Vfr };
    v.frame_rate.measured_fps = Some(25.0);
    r
}

const TFF: IdetCounts = IdetCounts { tff: 280, bff: 0, progressive: 3, undetermined: 17 };
const BFF: IdetCounts = IdetCounts { tff: 0, bff: 290, progressive: 0, undetermined: 10 };
const PROG: IdetCounts = IdetCounts { tff: 2, bff: 0, progressive: 290, undetermined: 8 };
const STATIC: IdetCounts = IdetCounts { tff: 0, bff: 0, progressive: 2, undetermined: 298 };

// ---------------------------------------------------------------------------
// Part 1: pure
// ---------------------------------------------------------------------------

#[test]
fn parses_stream_basics_and_unknowns() {
    let r = report(json!({}));
    let v = r.video.as_ref().unwrap();
    assert_eq!((v.width, v.height), (720, 576));
    assert_eq!(v.sar, Some(Rational { num: 16, den: 15 }));
    assert_eq!((v.display_width, v.display_height), (768, 576), "SAR applied to the width");
    assert_eq!(v.time_base, Some(Rational { num: 1, den: 90000 }));
    assert_eq!(v.bit_depth, Some(8));
    // no colour tags → unknown, never guessed from codec or extension
    assert_eq!(v.color.primaries, "unknown");
    assert_eq!(v.color.transfer, "unknown");
    assert_eq!(v.color.matrix, "unknown");
    assert_eq!(v.color.range, "unknown");
    assert_eq!(v.dynamic_range, DynamicRange::Unknown);
    assert_eq!(v.frame_rate.mode, RateMode::Unknown, "no sample analysed yet");
    assert_eq!(r.duration, Some(10.0));
}

#[test]
fn garbage_and_empty_input_is_safe() {
    let r = parse_streams(&json!({}), fp());
    assert!(r.video.is_none() && r.audio.is_empty() && r.duration.is_none());
    let r = parse_streams(&json!({"streams": [{"codec_type": "video", "width": "N/A", "sample_aspect_ratio": "0:1",
        "time_base": "0/0", "r_frame_rate": "0/0", "field_order": "weird"}]}), fp());
    let v = r.video.unwrap();
    assert_eq!(v.sar, None);
    assert_eq!(v.time_base, None);
    assert_eq!(v.field_order.metadata, FieldOrder::Unknown);
    assert_eq!(v.bit_depth, None);
    assert_eq!(v.pix_fmt, "unknown");
    assert!(suggest(&parse_streams(&json!({}), fp())).is_none());
}

#[test]
fn rotation_and_cover_art() {
    let r = parse_streams(&json!({"streams": [
        {"index": 0, "codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600, "disposition": {"attached_pic": 1}},
        {"index": 1, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "pix_fmt": "yuv420p",
         "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]}]}), fp());
    let v = r.video.unwrap();
    assert_eq!(v.index, 1, "cover art skipped");
    assert_eq!(v.rotation, 270);
    assert_eq!((v.display_width, v.display_height), (1080, 1920));
}

#[test]
fn bit_depth_sources() {
    assert_eq!(bit_depth(&json!("10"), "yuv420p"), Some(10));
    assert_eq!(bit_depth(&json!("N/A"), "yuv420p10le"), Some(10));
    assert_eq!(bit_depth(&json!(null), "p010le"), Some(10));
    assert_eq!(bit_depth(&json!(null), "yuv422p12be"), Some(12));
    assert_eq!(bit_depth(&json!(null), "nv12"), Some(8));
    assert_eq!(bit_depth(&json!(null), "yuvj420p"), Some(8));
    assert_eq!(bit_depth(&json!(null), "gray10le"), Some(10));
    assert_eq!(bit_depth(&json!(null), ""), None);
}

#[test]
fn field_order_flags() {
    assert_eq!(field_order_flag("tt"), FieldOrder::Tff);
    assert_eq!(field_order_flag("bt"), FieldOrder::Tff);
    assert_eq!(field_order_flag("bb"), FieldOrder::Bff);
    assert_eq!(field_order_flag("tb"), FieldOrder::Bff);
    assert_eq!(field_order_flag("progressive"), FieldOrder::Progressive);
    assert_eq!(field_order_flag("unknown"), FieldOrder::Unknown);
}

#[test]
fn idet_log_parsing_takes_last_summary() {
    let log = "[Parsed_idet_0 @ 1] Multi frame detection: TFF:     0 BFF:     0 Progressive:     0 Undetermined:     0\n\
               [Parsed_idet_0 @ 2] Single frame detection: TFF:    38 BFF:     3 Progressive:     9 Undetermined:     0\n\
               [Parsed_idet_0 @ 2] Multi frame detection: TFF:    41 BFF:     0 Progressive:     9 Undetermined:     0\n";
    assert_eq!(parse_idet(log), Some(IdetCounts { tff: 41, bff: 0, progressive: 9, undetermined: 0 }));
    assert_eq!(parse_idet("nothing"), None);
    assert_eq!(idet_verdict(&TFF), Some(FieldOrder::Tff));
    assert_eq!(idet_verdict(&STATIC), None, "static picture: no verdict");
    assert_eq!(idet_verdict(&IdetCounts { tff: 60, bff: 0, progressive: 40, undetermined: 0 }), None, "mixed: no verdict");
}

#[test]
fn field_order_classification_matrix() {
    use FieldOrder::*;
    let c = |m, k| classify_field_order(m, Some(k));
    // agree
    let f = c(Tff, TFF);
    assert_eq!((f.value, f.source, f.needs_choice), (Tff, FieldOrderSource::MetadataAndAnalysis, false));
    // flag missing, analysis clear
    let f = c(Unknown, BFF);
    assert_eq!((f.value, f.source, f.needs_choice), (Bff, FieldOrderSource::Analysis, false));
    // flag lies (progressive flag on interlaced content) → conflict, user decides
    let f = c(Progressive, TFF);
    assert_eq!((f.value, f.source, f.needs_choice, f.suggestion), (Unknown, FieldOrderSource::Conflict, true, Tff));
    // wrong parity flag
    let f = c(Tff, BFF);
    assert_eq!((f.value, f.needs_choice, f.suggestion), (Unknown, true, Bff));
    // static picture: progressive flag trusted, interlaced flag needs confirmation, nothing → unknown
    assert_eq!(c(Progressive, STATIC).needs_choice, false);
    let f = c(Tff, STATIC);
    assert_eq!((f.value, f.needs_choice, f.suggestion), (Unknown, true, Tff));
    let f = c(Unknown, STATIC);
    assert_eq!((f.value, f.source, f.needs_choice), (Unknown, FieldOrderSource::Unknown, true));
}

#[test]
fn timestamps_cfr_vfr() {
    let tb = Some(Rational { num: 1, den: 1000 });
    // 29.97 fps in a millisecond timebase: 33/34 ms alternation is still CFR
    let pts: Vec<i64> = (0..300).map(|i| (i as f64 * 1000.0 / 29.97).round() as i64).collect();
    let (mode, fps, n, _) = analyze_timestamps(&pts, tb);
    assert_eq!(mode, RateMode::Cfr);
    assert!((fps.unwrap() - 30.3).abs() < 0.5, "{fps:?}");
    assert_eq!(n, 299);
    // B-frame order (unsorted) still CFR
    let (mode, fps, ..) = analyze_timestamps(&[0, 120, 40, 80, 240, 160, 200, 280], Some(Rational { num: 1, den: 1000 }));
    assert_eq!((mode, fps.map(|f| f.round())), (RateMode::Cfr, Some(25.0)));
    // 25 fps then 10 fps
    let mut pts: Vec<i64> = (0..25).map(|i| i * 40).collect();
    pts.extend((0..20).map(|i| 1000 + i * 100));
    assert_eq!(analyze_timestamps(&pts, tb).0, RateMode::Vfr);
    assert_eq!(analyze_timestamps(&[0, 40], tb).0, RateMode::Unknown);
    assert_eq!(parse_pts_csv("0\nN/A\n40,\n80\n"), vec![0, 40, 80]);
}

#[test]
fn dynamic_range_classification() {
    let c = |p: &str, t: &str| ColorInfo { primaries: p.into(), transfer: t.into(), matrix: "bt2020nc".into(), range: "tv".into() };
    assert_eq!(dynamic_range(&c("bt2020", "smpte2084"), &[]), DynamicRange::HdrPq);
    assert_eq!(dynamic_range(&c("bt2020", "arib-std-b67"), &[]), DynamicRange::HdrHlg);
    assert_eq!(dynamic_range(&c("bt709", "bt709"), &[]), DynamicRange::Sdr);
    assert_eq!(dynamic_range(&c("unknown", "unknown"), &[]), DynamicRange::Unknown);
    assert_eq!(dynamic_range(&c("unknown", "unknown"), &["Mastering display metadata".into()]), DynamicRange::HdrPq);
    assert_eq!(dynamic_range(&c("bt709", "bt709"), &["DOVI configuration record".into()]), DynamicRange::DolbyVision);
}

#[test]
fn targets_never_auto_4k() {
    // 144p: only 1x and 2x, recommended 2x, nothing near 4K
    let t = targets(256, 144);
    assert_eq!(t.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["1x", "2x"]);
    assert!(t.iter().find(|t| t.recommended).unwrap().id == "2x");
    assert!(t.iter().all(|t| t.width.min(t.height) <= MAX_SUGGESTED_SHORT_SIDE && t.factor <= 2.0));
    // PAL SD with SAR (768x576 display): 720p recommended, 1080p offered, 2x (1152) not
    let t = targets(768, 576);
    let ids: Vec<_> = t.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["1x", "720p", "1080p"]);
    let r = t.iter().find(|t| t.recommended).unwrap();
    assert_eq!((r.id.as_str(), r.width, r.height), ("720p", 960, 720));
    // 1080p source: only 1x
    let t = targets(1920, 1080);
    assert_eq!(t.len(), 1);
    assert!(t[0].recommended);
    // portrait keeps orientation; sizes even
    let t = targets(360, 640);
    let r = t.iter().find(|t| t.recommended).unwrap();
    assert_eq!((r.width, r.height), (720, 1280));
    assert!(targets(255, 143).iter().all(|t| t.width % 2 == 0 && t.height % 2 == 0));
}

#[test]
fn suggested_recipe_for_interlaced_pal() {
    let r = with_analysis(report(json!({})), TFF, true);
    let rec = suggest(&r).unwrap();
    assert_eq!(rec.deinterlace.filter, DeinterlaceFilter::Bwdif);
    assert_eq!(rec.deinterlace.field_order, FieldOrder::Tff);
    assert_eq!(rec.output.fps, Some(Rational { num: 50, den: 1 }), "field rate: 25i → 50p");
    assert_eq!((rec.scale.width, rec.scale.height), (960, 720));
    assert_eq!(rec.color.input.matrix, "bt470bg");
    assert_eq!(rec.color.assumed, ["primaries", "transfer", "matrix", "range"]);
    assert_eq!(rec.audio.policy, StreamPolicy::CopyAll);
    assert!(rec.model.is_none());
    let a = assess(&rec, &r);
    assert_eq!(a.status, Status::Notify, "{a:?}");
    assert_eq!(a.notices, ["color-assumed"]);
    let f = video_filter(&rec);
    assert_eq!(
        f,
        "bwdif=mode=send_field:parity=tff:deint=all,scale=960:720:flags=lanczos,setsar=1,\
         colorspace=ispace=bt470bg:iprimaries=bt470bg:itrc=smpte170m:irange=tv:space=bt709:primaries=bt709:trc=bt709:range=tv:format=yuv420p,format=yuv420p"
    );
    // frame rate option
    let mut rec2 = rec.clone();
    rec2.deinterlace.rate = FieldRate::Frame;
    normalize(&mut rec2, &r);
    assert_eq!(rec2.output.fps, Some(Rational { num: 25, den: 1 }));
}

#[test]
fn unknown_field_order_needs_explicit_choice() {
    let r = with_analysis(report(json!({"field_order": "progressive"})), TFF, true); // lying flag
    let mut rec = suggest(&r).unwrap();
    let a = assess(&rec, &r);
    assert_eq!(a.status, Status::Blocked);
    assert!(a.blockers.contains(&"field-order-unconfirmed".to_string()));
    // the user confirms (any of TFF / BFF / progressive) → runs
    rec.deinterlace.user_confirmed = true;
    assert_ne!(assess(&rec, &r).status, Status::Blocked);
    rec.deinterlace.filter = DeinterlaceFilter::Off;
    normalize(&mut rec, &r);
    assert_eq!(rec.deinterlace.field_order, FieldOrder::Progressive);
    assert_ne!(assess(&rec, &r).status, Status::Blocked);
    // known TFF: choosing BFF without confirmation is refused
    let r = with_analysis(report(json!({})), TFF, true);
    let mut rec = suggest(&r).unwrap();
    rec.deinterlace.field_order = FieldOrder::Bff;
    assert!(assess(&rec, &r).blockers.contains(&"field-order-mismatch".to_string()));
}

#[test]
fn hdr_blocked_and_never_relabelled() {
    let r = with_analysis(
        report(json!({"pix_fmt": "yuv420p10le", "color_primaries": "bt2020", "color_transfer": "smpte2084", "color_space": "bt2020nc",
            "color_range": "tv", "field_order": "progressive"})),
        PROG,
        true,
    );
    let rec = suggest(&r).unwrap();
    assert_eq!(r.video.as_ref().unwrap().dynamic_range, DynamicRange::HdrPq);
    let a = assess(&rec, &r);
    assert_eq!(a.status, Status::Blocked);
    assert!(a.blockers.contains(&"hdr-unsupported".to_string()));
    // output colour is fixed SDR BT.709 8-bit, whatever the UI sends
    let mut forged = rec.clone();
    forged.color.output.transfer = "smpte2084".into();
    normalize(&mut forged, &r);
    assert_eq!(forged.color.output, output_color());
    // editing the input transfer to SDR does not bypass the measured HDR
    forged.color.input.transfer = "bt709".into();
    assert!(assess(&forged, &r).blockers.contains(&"hdr-unsupported".to_string()));
    // 10-bit untagged: dynamic range unknown → stop until the user states the transfer
    let r = with_analysis(report(json!({"pix_fmt": "yuv420p10le", "field_order": "progressive"})), PROG, true);
    let mut rec = suggest(&r).unwrap();
    assert!(assess(&rec, &r).blockers.contains(&"dynamic-range-unknown".to_string()));
    rec.color.input.transfer = "bt709".into();
    normalize(&mut rec, &r);
    let a = assess(&rec, &r);
    assert_eq!(a.status, Status::Notify, "{a:?}");
    assert!(a.notices.contains(&"bit-depth-reduced".to_string()) && a.notices.contains(&"color-assumed".to_string()));
    // 10-bit SDR tagged: notify only
    let r = with_analysis(
        report(json!({"pix_fmt": "yuv420p10le", "color_primaries": "bt709", "color_transfer": "bt709", "color_space": "bt709",
            "color_range": "tv", "field_order": "progressive", "height": 720, "width": 1280, "sample_aspect_ratio": "1:1"})),
        PROG,
        true,
    );
    let rec = suggest(&r).unwrap();
    let a = assess(&rec, &r);
    assert_eq!((a.status, a.notices.clone()), (Status::Notify, vec!["bit-depth-reduced".to_string()]));
    assert!(!video_filter(&rec).contains("colorspace"), "already BT.709");
}

#[test]
fn rotation_vfr_scale_range_streams_model() {
    let r = with_analysis(
        report(json!({"field_order": "progressive", "width": 640, "height": 360, "sample_aspect_ratio": "1:1",
            "side_data_list": [{"side_data_type": "Display Matrix", "rotation": 90}]})),
        PROG,
        false,
    );
    let mut rec = suggest(&r).unwrap();
    assert_eq!((rec.scale.width, rec.scale.height), (720, 1280));
    assert_eq!(rec.output.fps_mode, FpsMode::Passthrough);
    assert!(video_filter(&rec).starts_with("transpose=cclock,scale=720:1280"));
    let a = assess(&rec, &r);
    assert!(a.notices.contains(&"vfr-kept".to_string()), "{a:?}");
    // too large / aspect change / odd size
    rec.scale.width = 1440;
    rec.scale.height = 2560;
    assert!(assess(&rec, &r).blockers.contains(&"scale-too-large".to_string()));
    rec.scale.width = 720;
    rec.scale.height = 720;
    assert!(assess(&rec, &r).blockers.contains(&"aspect-changed".to_string()));
    rec.scale.width = 721;
    assert!(assess(&rec, &r).blockers.contains(&"scale-invalid".to_string()));
    // range
    let mut rec = suggest(&r).unwrap();
    rec.range = TimeRange { start: 5.0, end: Some(4.0) };
    assert!(assess(&rec, &r).blockers.contains(&"range-invalid".to_string()));
    rec.range = TimeRange { start: 2.0, end: Some(7.0) };
    assert!(assess(&rec, &r).blockers.is_empty());
    rec.range = TimeRange { start: f64::NAN, end: None };
    assert!(assess(&rec, &r).blockers.contains(&"range-invalid".to_string()));
    // streams that do not exist
    let mut rec = suggest(&r).unwrap();
    rec.audio = StreamSelection { policy: StreamPolicy::Selected, streams: vec![7] };
    assert!(assess(&rec, &r).blockers.contains(&"audio-stream".to_string()));
    // a model before the V02 gate
    let mut rec = suggest(&r).unwrap();
    rec.model = Some(ModelRef { id: "basicvsrpp".into(), version: "1".into() });
    assert!(assess(&rec, &r).blockers.contains(&"model-not-ready".to_string()));
}

#[test]
fn hash_covers_recipe_and_measurements() {
    let r = with_analysis(report(json!({})), TFF, true);
    let rec = suggest(&r).unwrap();
    let h = recipe_hash(&rec, &r);
    assert!(h.starts_with("sha256:") && h.len() == 7 + 64);
    assert_eq!(h, recipe_hash(&rec.clone(), &r.clone()), "stable");
    let mut rec2 = rec.clone();
    rec2.denoise.filter = DenoiseFilter::Atadenoise;
    assert_ne!(h, recipe_hash(&rec2, &r), "recipe change");
    let mut r2 = r.clone();
    r2.source.modified_ms += 1;
    assert_ne!(h, recipe_hash(&rec, &r2), "source changed");
    let mut r3 = r.clone();
    r3.video.as_mut().unwrap().field_order.counts = Some(BFF);
    assert_ne!(h, recipe_hash(&rec, &r3), "measurement changed");
    // round trip through the UI (JSON) keeps the hash
    let back: Recipe = serde_json::from_value(serde_json::to_value(&rec).unwrap()).unwrap();
    assert_eq!(h, recipe_hash(&back, &r));
}

#[test]
fn filter_list_parsing() {
    let out = " TS bwdif             V->V       Deinterlace the input image.\n .. scale  V->V  Scale\n T. fieldorder        V->V       Set\n\
               ... = Filters:\n  T.. = Timeline\n";
    assert_eq!(parse_filters(out), ["bwdif", "scale", "fieldorder"]);
    assert_eq!(required_filters("bwdif=mode=1,hflip,vflip,scale=2:2,format=yuv420p"), ["bwdif", "format", "hflip", "scale", "vflip"]);
    assert_eq!(missing_filters("hqdn3d,scale=2:2", &["scale".to_string()]), ["hqdn3d"]);
}

// ---------------------------------------------------------------------------
// Part 2: generated fixtures + real ffmpeg
// ---------------------------------------------------------------------------

fn tools() -> Tools {
    crate::actions::ffmpeg::test_tools()
}

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let d = std::env::temp_dir().join(format!("vho-restoration-test-{}-{}", std::process::id(), rand_tag()));
    std::fs::create_dir_all(&d).unwrap();
    TempDir(d)
}

fn rand_tag() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 % 1_000_000_007
}

fn ff(t: &Tools, args: &[&str]) {
    let out = Command::new(&t.ffmpeg)
        .current_dir(t.ffmpeg.parent().unwrap())
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "ffmpeg {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// Progressive content idet classifies reliably (scaled testsrc2; plain testsrc2 at full size
/// has line-pattern detail that idet misreads as combing).
const PROG_SRC: &str = "testsrc2=size=640x480:rate=25,scale=320:240";
/// Real interlaced content: two 50 Hz half-height pictures woven into one frame.
const TFF_SRC: &str = "testsrc2=size=320x120:rate=50,weave=first_field=top";
const BFF_SRC: &str = "testsrc2=size=320x120:rate=50,weave=first_field=bottom";

fn make(t: &Tools, dir: &Path, name: &str, args: &[&str]) -> PathBuf {
    let p = dir.join(name);
    let mut a: Vec<&str> = args.to_vec();
    let s = p.to_string_lossy().into_owned();
    a.push(&s);
    ff(t, &a);
    p
}

fn probe(t: &Tools, p: &Path) -> SourceReport {
    probe_source_with(t, p, &|| false).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

#[test]
fn fixtures_field_order_and_progressive() {
    let t = tools();
    let d = temp_dir();
    let prog = make(&t, &d.0, "prog.mpg", &["-f", "lavfi", "-i", PROG_SRC, "-t", "2", "-c:v", "mpeg2video", "-q:v", "3"]);
    let tff = make(&t, &d.0, "tff.mpg", &["-f", "lavfi", "-i", TFF_SRC, "-t", "2", "-c:v", "mpeg2video", "-flags", "+ildct+ilme", "-top", "1", "-q:v", "3"]);
    let bff = make(&t, &d.0, "bff.mpg", &["-f", "lavfi", "-i", BFF_SRC, "-t", "2", "-c:v", "mpeg2video", "-flags", "+ildct+ilme", "-top", "0", "-q:v", "3"]);
    // interlaced content, flag says progressive (lying container/encoder)
    let lying = make(&t, &d.0, "lying.mkv", &["-f", "lavfi", "-i", &format!("{TFF_SRC},setfield=prog"), "-t", "2", "-c:v", "mpeg4", "-q:v", "3"]);
    // interlaced content, no flag at all (mpeg4 in mp4 → field_order unknown)
    let noflag = make(&t, &d.0, "noflag.mp4", &["-f", "lavfi", "-i", &format!("{BFF_SRC},setfield=prog"), "-t", "2", "-c:v", "mpeg4", "-q:v", "3"]);
    // static picture, no flag: nothing can be decided
    let still = make(&t, &d.0, "still.mp4", &["-f", "lavfi", "-i", "color=c=gray:size=320x240:rate=25", "-t", "2", "-c:v", "mpeg4"]);

    let fo = |p: &Path| probe(&t, p).video.unwrap().field_order;
    let f = fo(&prog);
    assert_eq!((f.value, f.needs_choice), (FieldOrder::Progressive, false), "{f:?}");
    let f = fo(&tff);
    assert_eq!((f.value, f.source, f.needs_choice), (FieldOrder::Tff, FieldOrderSource::MetadataAndAnalysis, false), "{f:?}");
    let f = fo(&bff);
    assert_eq!((f.value, f.source, f.needs_choice), (FieldOrder::Bff, FieldOrderSource::MetadataAndAnalysis, false), "{f:?}");
    let f = fo(&lying);
    assert_eq!((f.metadata, f.value, f.source, f.needs_choice, f.suggestion),
        (FieldOrder::Progressive, FieldOrder::Unknown, FieldOrderSource::Conflict, true, FieldOrder::Tff), "{f:?}");
    let f = fo(&noflag);
    assert_eq!((f.metadata, f.value, f.source), (FieldOrder::Unknown, FieldOrder::Bff, FieldOrderSource::Analysis), "{f:?}");
    let f = fo(&still);
    assert_eq!((f.value, f.needs_choice), (FieldOrder::Unknown, true), "{f:?}");

    // the suggested recipe of the TFF file runs in this ffmpeg build: 2 s of 25i → 100 frames 50p
    let r = probe(&t, &tff);
    let resp = super::evaluate(&t, r.clone(), suggest(&r));
    assert_eq!(resp.assessment.status, Status::Notify, "{:?}", resp.assessment);
    let rec = resp.recipe.unwrap();
    assert_eq!(rec.output.fps, Some(Rational { num: 50, den: 1 }));
    let out = d.0.join("out.mkv");
    ff(&t, &["-noautorotate", "-i", &tff.to_string_lossy(), "-vf", &resp.filter, "-c:v", "ffv1", &out.to_string_lossy()]);
    let o = probe(&t, &out).video.unwrap();
    assert_eq!((o.width, o.height), (rec.scale.width, rec.scale.height));
    assert_eq!(o.field_order.value, FieldOrder::Progressive, "{:?}", o.field_order);
    assert_eq!(o.pix_fmt, "yuv420p");
    let frames = Command::new(&t.ffprobe)
        .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"])
        .arg(&out)
        .output()
        .unwrap();
    let n: u32 = String::from_utf8_lossy(&frames.stdout).trim().trim_end_matches(',').parse().unwrap();
    assert!((98..=100).contains(&n), "field-rate output frames: {n}");
}

#[test]
fn fixtures_geometry_rate_audio_color() {
    let t = tools();
    let d = temp_dir();
    let src = PROG_SRC;
    // non-square pixels (CIF 352x288, SAR 16:11 → 512x288)
    let sar = make(&t, &d.0, "sar.mp4", &["-f", "lavfi", "-i", "testsrc2=size=704x576:rate=25,scale=352:288,setsar=16/11", "-t", "1", "-c:v", "mpeg4"]);
    // rotation (display matrix 90° counter-clockwise)
    let base = make(&t, &d.0, "base.mp4", &["-f", "lavfi", "-i", src, "-t", "1", "-c:v", "mpeg4"]);
    let rot = make(&t, &d.0, "rot.mp4", &["-display_rotation", "90", "-i", &base.to_string_lossy(), "-c", "copy"]);
    // VFR: 25 fps for 1 s, then 10 fps
    let vfr = make(&t, &d.0, "vfr.mkv", &["-f", "lavfi", "-i", src, "-t", "3", "-vf", "setpts='if(lt(N\\,25)\\,N/25\\,1+(N-25)/10)/TB'", "-fps_mode", "vfr", "-c:v", "mpeg4"]);
    // two audio tracks + text subtitle
    let srt = d.0.join("s.srt");
    std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:00,800\nhello\n").unwrap();
    let multi = make(&t, &d.0, "multi.mkv", &[
        "-f", "lavfi", "-i", src, "-f", "lavfi", "-i", "sine=frequency=440", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
        "-i", &srt.to_string_lossy(), "-t", "1", "-map", "0", "-map", "1", "-map", "2", "-map", "3", "-c:v", "mpeg4", "-c:a", "aac", "-c:s", "srt",
        "-metadata:s:a:0", "language=tur", "-metadata:s:a:1", "language=eng", "-ac:a:1", "1",
    ]);
    // HDR-tagged (PQ, BT.2020, 10-bit)
    let hdr = make(&t, &d.0, "hdr.mkv", &["-f", "lavfi", "-i", src, "-t", "1", "-vf",
        "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv", "-c:v", "ffv1"]);
    // HLG-tagged
    let hlg = make(&t, &d.0, "hlg.mkv", &["-f", "lavfi", "-i", src, "-t", "1", "-vf",
        "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc:range=tv", "-c:v", "ffv1"]);
    // BT.709-tagged SDR
    let sdr = make(&t, &d.0, "sdr709.mpg", &["-f", "lavfi", "-i", src, "-t", "1", "-vf",
        "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "-c:v", "mpeg2video"]);

    // SAR
    let r = probe(&t, &sar);
    let v = r.video.as_ref().unwrap();
    assert_eq!((v.width, v.height, v.sar), (352, 288, Some(Rational { num: 16, den: 11 })));
    assert_eq!((v.display_width, v.display_height), (512, 288));
    let rec = suggest(&r).unwrap();
    assert_eq!((rec.scale.target.as_str(), rec.scale.width, rec.scale.height), ("2x", 1024, 576));
    assert_eq!(v.color.matrix, "unknown", "mpeg4/mp4 without tags stays unknown");

    // rotation: our chain (no autorotate) == ffmpeg's own autorotation, pixel for pixel
    let r = probe(&t, &rot);
    let v = r.video.as_ref().unwrap();
    assert_eq!((v.rotation, v.display_width, v.display_height), (90, 240, 320));
    let md5 = |args: &[&str]| -> String {
        let out = Command::new(&t.ffmpeg)
            .current_dir(t.ffmpeg.parent().unwrap())
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(args)
            .args(["-frames:v", "3", "-f", "md5", "-"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    let rot_s = rot.to_string_lossy().into_owned();
    let auto = md5(&["-i", &rot_s, "-vf", "format=yuv420p"]);
    let ours = md5(&["-noautorotate", "-i", &rot_s, "-vf", "transpose=cclock,format=yuv420p"]);
    assert!(auto.starts_with("MD5="), "{auto}");
    assert_eq!(auto, ours, "transpose direction matches the display matrix");
    let rec = suggest(&r).unwrap();
    assert!(super::recipe::video_filter(&rec).starts_with("transpose=cclock,"));

    // CFR vs VFR
    let r = probe(&t, &base);
    let fr = &r.video.as_ref().unwrap().frame_rate;
    assert_eq!(fr.mode, RateMode::Cfr, "{fr:?}");
    assert!((fr.measured_fps.unwrap() - 25.0).abs() < 0.1);
    let r = probe(&t, &vfr);
    let fr = &r.video.as_ref().unwrap().frame_rate;
    assert_eq!(fr.mode, RateMode::Vfr, "{fr:?}");
    assert_eq!(suggest(&r).unwrap().output.fps_mode, FpsMode::Passthrough);

    // multiple audio + subtitle
    let r = probe(&t, &multi);
    assert_eq!(r.audio.len(), 2);
    assert_eq!((r.audio[0].language.as_str(), r.audio[1].language.as_str()), ("tur", "eng"));
    assert_eq!((r.audio[1].channels, r.audio[1].sample_rate), (1, 44100));
    assert_eq!(r.subtitles.len(), 1);
    assert!(r.subtitles[0].text);
    let mut rec = suggest(&r).unwrap();
    assert_eq!(rec.audio.policy, StreamPolicy::CopyAll);
    rec.audio = StreamSelection { policy: StreamPolicy::Selected, streams: vec![r.audio[1].index] };
    assert!(!assess(&rec, &r).blockers.iter().any(|b| b == "audio-stream"));

    // HDR → blocked; HLG too
    for (p, dr) in [(&hdr, DynamicRange::HdrPq), (&hlg, DynamicRange::HdrHlg)] {
        let r = probe(&t, p);
        let v = r.video.as_ref().unwrap();
        assert_eq!((v.dynamic_range, v.bit_depth, v.color.primaries.as_str()), (dr, Some(10), "bt2020"));
        let resp = super::evaluate(&t, r.clone(), suggest(&r));
        assert_eq!(resp.assessment.status, Status::Blocked);
        assert!(resp.assessment.blockers.contains(&"hdr-unsupported".to_string()));
    }

    // tagged SDR: measured, nothing assumed, no conversion
    let r = probe(&t, &sdr);
    let v = r.video.as_ref().unwrap();
    assert_eq!((v.color.primaries.as_str(), v.color.transfer.as_str(), v.color.matrix.as_str(), v.color.range.as_str()),
        ("bt709", "bt709", "bt709", "tv"));
    assert_eq!(v.dynamic_range, DynamicRange::Sdr);
    let resp = super::evaluate(&t, r.clone(), suggest(&r));
    assert!(resp.recipe.as_ref().unwrap().color.assumed.is_empty());
    assert!(!resp.filter.contains("colorspace"));

    // every recipe filter this module can emit exists in this LGPL build
    let avail = available_filters(&t);
    for f in ["bwdif", "yadif", "w3fdif", "estdif", "idet", "atadenoise", "nlmeans", "fftdnoiz", "transpose", "hflip", "vflip",
        "scale", "setsar", "colorspace", "format"] {
        assert!(avail.iter().any(|a| a == f), "filter {f} missing from the ffmpeg build");
    }
    for gpl in ["hqdn3d", "kerndeint", "mcdeint", "pp7", "spp", "owdenoise", "tinterlace"] {
        assert!(!avail.iter().any(|a| a == gpl), "GPL-only filter {gpl} in the build: not an LGPL build");
    }
}

#[test]
fn fixtures_bad_input_is_an_error_not_a_guess() {
    let t = tools();
    let d = temp_dir();
    let junk = d.0.join("junk.mp4");
    std::fs::write(&junk, b"not a video at all").unwrap();
    let e = probe_source_with(&t, &junk, &|| false).unwrap_err();
    assert!(e.starts_with("[unsupported]"), "{e}");
    let e = probe_source_with(&t, &d.0.join("missing.mp4"), &|| false).unwrap_err();
    assert!(e.starts_with("[invalid]"), "{e}");
    // audio only: report without video, recipe blocked
    let a = make(&t, &d.0, "a.m4a", &["-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-c:a", "aac"]);
    let r = probe(&t, &a);
    assert!(r.video.is_none());
    let resp = super::evaluate(&t, r.clone(), suggest(&r));
    assert_eq!(resp.assessment.blockers, ["no-video"]);
}
