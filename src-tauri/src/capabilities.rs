//! Capability matrix / platform contract (Plan 10 / P01).
//!
//! One query (`platform_capabilities`) answers "what works on this machine?" for the engine,
//! video surface, encoder, photo codecs and OS actions. It is an adapter over the existing
//! sources (`engine_status`, `photo::decode`/`heic` probes, `actions_capabilities`), not a
//! second capability system: the front end (`src/core/capabilities.js`) adds what only the
//! WebView knows (WebGL2/WebGPU, the engine of the current item) and the UI asks that one view.
//!
//! Every entry keeps three things apart:
//!   - `available`: usable now (build flag AND runtime presence/probe),
//!   - `implementation`: what does the work,
//!   - `verified`: a real-device test exists for this OS/arch (see docs/platform-support.md);
//!     a successful build or runtime probe never sets it.
//!
//! `reason_code` says why something is unavailable or limited (stable, machine readable).
//!
//! P04: `support` is the per-OS claim from the ONE feature table (`SUPPORT`, mirrored in
//! docs/platform-support.md and checked against it by a test): `supported-tested`,
//! `supported-untested` (code exists, no real-device test) or `unsupported` (the platform
//! does not offer it or VHO does not implement it: never imitated by another action). An
//! `unsupported` feature is never `available`, whatever the runtime inputs say.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: &'static str,
    pub available: bool,
    pub implementation: Option<&'static str>,
    pub verified: bool,
    pub reason_code: Option<&'static str>,
    /// `supported-tested` | `supported-untested` | `unsupported` for this OS (`SUPPORT`)
    pub support: &'static str,
}

/// Per-OS support of a feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    /// Implemented and covered by automated tests on a real device of that OS
    Tested,
    /// Implemented (compiles for that OS) but not tested on a real device
    Untested,
    /// Not offered on that OS
    No,
}

impl Support {
    pub fn code(self) -> &'static str {
        match self {
            Support::Tested => "supported-tested",
            Support::Untested => "supported-untested",
            Support::No => "unsupported",
        }
    }
    /// Text used in docs/platform-support.md
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn doc(self) -> &'static str {
        match self {
            Support::Tested => "destekli/testli",
            Support::Untested => "destekli/test bekliyor",
            Support::No => "desteklenmiyor",
        }
    }
}

use Support::{No, Tested as T, Untested as U};

/// THE feature table: (id, Windows x64, macOS arm64, Linux x64). Backend entries only; the
/// WebView entries (`video.gpuFilter`, `video.compare`...) live in src/core/capabilities.js.
/// Changing a cell needs the matching row in docs/platform-support.md (test
/// `caps_support_table_matches_docs`) and, for `T`, the test that proves it.
pub const SUPPORT: &[(&str, Support, Support, Support)] = &[
    ("engine.libmpv", T, No, U),
    ("engine.html5", T, U, U),
    ("video.surface", T, No, U),
    ("video.hwdec", U, No, U),
    ("video.legacyTranscode", T, No, No),
    ("encode.ffmpeg", T, U, U),
    ("encode.h264", T, U, U),
    ("photo.heic", U, U, U),
    ("photo.avif", T, U, U),
    ("photo.avifEncode", T, U, U),
    ("photo.heicEncode", No, No, No),
    ("photo.raw", T, U, U),
    ("photo.rawEncode", No, No, No),
    ("photo.exifOrientation", T, U, U),
    ("photo.colorProfile", T, U, U),
    ("actions.ocr", T, No, U),
    ("actions.share", U, No, No),
    ("actions.openWith", U, No, U),
    ("actions.reveal", U, U, U),
    ("actions.clipboardText", T, U, U),
    ("actions.clipboardFiles", T, U, U),
    ("actions.clipboardImage", T, U, U),
    ("actions.print", U, No, U),
    ("actions.wallpaper", U, U, U),
    ("actions.lockScreen", U, No, No),
    ("system.mediaControls", T, No, No),
    ("audio.gapless", T, No, No),
    ("audio.replayGain", T, U, U),
    ("net.streams", T, U, U),
    ("cast.dlna", U, U, U),
    ("cast.chromecast", No, No, No),
];

/// Support of `id` on `os` (unknown OS or id: unsupported).
pub fn support(id: &str, os: &str) -> Support {
    SUPPORT
        .iter()
        .find(|r| r.0 == id)
        .map(|&(_, w, m, l)| match os {
            "windows" => w,
            "macos" => m,
            "linux" => l,
            _ => No,
        })
        .unwrap_or(No)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub webview: &'static str,
    /// Real-device test evidence exists for this OS/arch pair (only Windows x64 so far)
    pub verified_platform: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub platform: PlatformInfo,
    pub entries: Vec<Capability>,
}

/// Runtime facts the matrix is computed from (gathered by `gather`, faked in tests).
#[derive(Clone, Debug, Default)]
pub struct Inputs {
    pub os: &'static str,
    pub arch: &'static str,
    pub engine_available: bool,
    /// libmpv load error (engine_status.error), e.g. "libmpv-2.dll not found ..."
    pub engine_error: Option<String>,
    pub ffmpeg: bool,
    pub heic: bool,
    /// AVIF decoder registered with the OS
    pub avif_installed: bool,
    /// ... and a real 16x16 decode succeeded (heic::avif_works)
    pub avif_works: bool,
    pub raw_os: bool,
    pub os_codec: &'static str,
    pub ocr: bool,
    /// OCR engine found at run time ("windows-media-ocr", "tesseract")
    pub ocr_engine: Option<&'static str>,
    /// Video encoder chosen by the runtime probe and whether it is the non-H.264 fallback
    pub video_encoder: Option<(&'static str, bool)>,
    pub print: bool,
    pub share: bool,
    pub wallpaper: bool,
    pub lock_screen: bool,
    pub open_with: bool,
    /// VHO_DISABLE_SYSTEM_CHANGES: OS actions are only logged (tests)
    pub system_changes_disabled: bool,
}

/// OS/arch pairs with real-device test evidence. Add a pair only together with the test
/// report in docs/platform-support.md; CI builds or VMs alone do not qualify.
pub fn verified_platform(os: &str, arch: &str) -> bool {
    matches!((os, arch), ("windows", "x86_64"))
}

pub fn webview_for(os: &str) -> &'static str {
    match os {
        "windows" => "webview2",
        "macos" => "wkwebview",
        "linux" => "webkitgtk",
        _ => "unknown",
    }
}

/// Classifies a libmpv load failure (engine_status.error) into a reason code.
pub fn engine_reason(os: &str, error: Option<&str>) -> &'static str {
    let e = error.unwrap_or("");
    if e.contains("VHO_DISABLE_MPV") {
        "engine-disabled"
    } else if !matches!(os, "windows" | "linux") || e.contains("not available on this platform") {
        "engine-unsupported-platform"
    } else if e.contains("not found") {
        "engine-missing"
    } else {
        "engine-failed"
    }
}

/// Pure: inputs -> entries. Unit tested with the Windows scenarios of P01.
pub fn build(i: &Inputs) -> Vec<Capability> {
    let verified_os = verified_platform(i.os, i.arch);
    let entry = |id: &'static str, available: bool, implementation: Option<&'static str>, reason: Option<&'static str>| {
        let sup = support(id, i.os);
        // the table wins: an unsupported feature is never offered, whatever a probe says
        let available = available && sup != No;
        Capability {
            id,
            available,
            implementation: if available { implementation } else { None },
            verified: available && verified_os && sup == T,
            reason_code: if available {
                reason
            } else if sup == No {
                Some(match reason {
                    Some(r) if r != "unavailable" && !r.starts_with("system-") => r,
                    _ => "unsupported-platform",
                })
            } else {
                Some(reason.unwrap_or("unavailable"))
            },
            support: sup.code(),
        }
    };
    let windows = i.os == "windows";
    let engine_reason = (!i.engine_available).then(|| engine_reason(i.os, i.engine_error.as_deref()));
    let os_action = |supported: bool| -> Option<&'static str> {
        if !supported {
            Some("unsupported-platform")
        } else if i.system_changes_disabled {
            Some("system-changes-disabled")
        } else {
            None
        }
    };

    vec![
        entry("engine.libmpv", i.engine_available, i.engine_available.then_some("libmpv-lgpl"), engine_reason),
        // The <video> fallback always exists; its codec range is the WebView's, not mpv's
        entry("engine.html5", true, Some("webview-video"), Some("webview-codecs-only")),
        entry(
            "video.surface",
            true,
            Some(match (i.engine_available, i.os) {
                (true, "linux") => "gtk-glarea-render-api",
                (true, _) => "win32-owned-popup",
                _ => "webview-video",
            }),
            engine_reason,
        ),
        // Hardware decoding is requested (hwdec=auto-safe); whether it succeeds per file is
        // reported by mpv's hwdec-current, not measured here
        // Linux: copy-back only (auto-copy-safe), software decoding when VAAPI is missing (ADR 0002)
        entry(
            "video.hwdec",
            i.engine_available,
            i.engine_available.then_some(if i.os == "linux" { "mpv-hwdec-auto-copy-safe" } else { "mpv-hwdec-auto-safe" }),
            Some(engine_reason.unwrap_or("success-not-measured")),
        ),
        // Legacy-codec transcode for the HTML5 fallback (Media Foundation)
        entry("video.legacyTranscode", windows, windows.then_some("media-foundation"), (!windows).then_some("unsupported-platform")),
        entry("encode.ffmpeg", i.ffmpeg, i.ffmpeg.then_some("ffmpeg-lgpl"), (!i.ffmpeg).then_some("ffmpeg-missing")),
        // H.264 export: runtime-probed encoder (P04); the mpeg4 fallback keeps exports working
        entry(
            "encode.h264",
            i.ffmpeg && i.video_encoder.is_some_and(|(_, fallback)| !fallback),
            i.video_encoder.map(|(name, _)| name),
            Some(match i.video_encoder {
                _ if !i.ffmpeg => "ffmpeg-missing",
                Some((_, true)) => "h264-unavailable-fallback-mpeg4",
                Some((_, false)) => "runtime-probed",
                None => "not-probed",
            }),
        ),
        entry("photo.heic", i.heic, i.heic.then_some(i.os_codec), (!i.heic).then_some("codec-missing")),
        entry(
            "photo.avif",
            i.avif_works,
            i.avif_works.then_some(i.os_codec),
            if i.avif_works { None } else if i.avif_installed { Some("codec-failed") } else { Some("codec-missing") },
        ),
        entry("photo.avifEncode", true, Some("rust-image-ravif"), None),
        // Viewable is not exportable: HEIC/RAW sources are written as JPEG (or another chosen format)
        entry("photo.heicEncode", false, None, Some("export-as-jpeg")),
        entry("photo.rawEncode", false, None, Some("export-as-jpeg")),
        // EXIF orientation: applied by VHO for native/RAW decodes; the OS HEIF decoder applies irot/imir
        entry("photo.exifOrientation", true, Some("exif-and-os-heif"), None),
        // ICC profiles pass through native decodes and (Windows) WIC decodes into the display copy and exports
        entry(
            "photo.colorProfile",
            true,
            Some(if windows { "icc-passthrough-wic" } else { "icc-passthrough-native" }),
            (!windows).then_some("os-decoder-icc-dropped"),
        ),
        // RAW: the embedded JPEG preview always; a full OS RAW decoder only where installed
        entry("photo.raw", true, Some(if i.raw_os { "os-raw-codec" } else { "embedded-jpeg-preview" }), (!i.raw_os).then_some("raw-preview-only")),
        entry(
            "actions.ocr",
            i.ocr,
            i.ocr_engine,
            if i.ocr { Some("installed-languages-only") } else if i.os == "linux" { Some("tesseract-missing") } else { Some("not-implemented") },
        ),
        entry("actions.share", i.share, i.share.then_some("windows-share-ui"), os_action(i.share)),
        entry("actions.reveal", true, Some("os-file-manager"), os_action(true)),
        entry("actions.clipboardText", true, Some("arboard"), None),
        entry("actions.clipboardFiles", true, Some(if windows { "arboard-cf-hdrop" } else { "arboard-file-list" }), None),
        entry("actions.clipboardImage", true, Some("arboard"), None),
        entry("actions.print", i.print, i.print.then_some("webview-print"), os_action(i.print)),
        entry("actions.wallpaper", i.wallpaper, i.wallpaper.then_some("os-wallpaper"), os_action(i.wallpaper)),
        entry("actions.lockScreen", i.lock_screen, i.lock_screen.then_some("windows-lockscreen"), os_action(i.lock_screen)),
        entry("actions.openWith", i.open_with, i.open_with.then_some("os-open-with"), os_action(i.open_with)),
        // OS media keys / now-playing card (Plan 13/L03): Windows SMTC; MPRIS / MPNowPlayingInfoCenter not implemented
        entry("system.mediaControls", windows, windows.then_some("windows-smtc"), (!windows).then_some("not-implemented")),
        // Gapless track change needs mpv's internal playlist (gapless-audio); the HTML5 element reloads per file
        entry("audio.gapless", i.engine_available, i.engine_available.then_some("mpv-gapless-audio"), engine_reason.map(|_| "needs-libmpv")),
        // ReplayGain: libmpv applies gain + clipping prevention; the HTML5 element can only attenuate
        entry(
            "audio.replayGain",
            true,
            Some(if i.engine_available { "mpv-replaygain" } else { "webview-volume" }),
            (!i.engine_available).then_some("attenuation-only"),
        ),
        // Network streams (L04): http(s) only; libmpv reconnects and plays HLS, the <video> fallback plays what the WebView can
        entry(
            "net.streams",
            true,
            Some(if i.engine_available { "mpv-lavf-reconnect" } else { "webview-video" }),
            (!i.engine_available).then_some("webview-codecs-only"),
        ),
        // UPnP/DLNA renderer: tested against a simulated renderer only (no real device yet)
        entry("cast.dlna", true, Some("upnp-avtransport"), None),
        // Chromecast (CASTV2: TLS + protobuf) is not implemented
        entry("cast.chromecast", false, None, Some("not-implemented")),
    ]
}

/// Collects the runtime facts from the existing probes (AVIF probe is cached after the first call).
pub fn gather(engine: &serde_json::Value) -> Inputs {
    use crate::actions;
    use crate::photo::heic;
    let os_support = heic::os_support();
    let acts = actions::actions_capabilities();
    let flag = |k: &str| acts.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    Inputs {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        engine_available: engine.get("available").and_then(|v| v.as_bool()).unwrap_or(false),
        engine_error: engine.get("error").and_then(|v| v.as_str()).map(str::to_owned),
        ffmpeg: flag("ffmpeg"),
        heic: os_support.heic,
        avif_installed: os_support.avif,
        avif_works: heic::avif_works(),
        raw_os: os_support.raw,
        os_codec: heic::OS_CODEC,
        ocr: flag("ocr"),
        share: flag("share"),
        wallpaper: flag("wallpaper"),
        lock_screen: flag("lockScreen"),
        open_with: flag("openWith"),
        print: flag("print"),
        ocr_engine: actions::ocr::engine_name(),
        video_encoder: if flag("ffmpeg") {
            actions::ffmpeg::encoder_choice().map(|c| (c.encoder.name, c.fallback))
        } else {
            None
        },
        system_changes_disabled: flag("systemChangesDisabled"),
    }
}

pub fn report(i: &Inputs) -> Report {
    Report {
        platform: PlatformInfo { os: i.os, arch: i.arch, webview: webview_for(i.os), verified_platform: verified_platform(i.os, i.arch) },
        entries: build(i),
    }
}

/// The capability matrix of this machine (engine + photo codecs + OS actions).
#[tauri::command]
pub async fn platform_capabilities(st: tauri::State<'_, crate::engine::Engine>) -> Result<Report, String> {
    let engine = crate::engine::engine_status(st);
    tauri::async_runtime::spawn_blocking(move || report(&gather(&engine)))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows() -> Inputs {
        Inputs {
            os: "windows",
            arch: "x86_64",
            engine_available: true,
            ffmpeg: true,
            heic: true,
            avif_installed: true,
            avif_works: true,
            os_codec: "wic",
            ocr: true,
            share: true,
            wallpaper: true,
            lock_screen: true,
            open_with: true,
            print: true,
            ocr_engine: Some("windows-media-ocr"),
            video_encoder: Some(("h264_mf", false)),
            ..Default::default()
        }
    }

    fn get(list: &[Capability], id: &str) -> Capability {
        list.iter().find(|c| c.id == id).cloned().unwrap_or_else(|| panic!("no capability {id}"))
    }

    #[test]
    fn caps_every_entry_has_a_reason_when_unavailable() {
        let mut i = windows();
        i.engine_available = false;
        i.engine_error = Some("libmpv-2.dll not found".into());
        for c in build(&i) {
            if !c.available {
                assert!(c.reason_code.is_some(), "{} has no reason", c.id);
                assert!(!c.verified, "{} unavailable but verified", c.id);
            }
        }
    }

    #[test]
    fn caps_windows_engine_present_vs_missing_vs_disabled() {
        let with = build(&windows());
        let e = get(&with, "engine.libmpv");
        assert!(e.available && e.verified);
        assert_eq!(e.implementation, Some("libmpv-lgpl"));
        assert_eq!(get(&with, "video.surface").implementation, Some("win32-owned-popup"));

        let mut i = windows();
        i.engine_available = false;
        i.engine_error = Some("libmpv-2.dll not found (run `npm run stage:mpv`)".into());
        let missing = build(&i);
        assert_eq!(get(&missing, "engine.libmpv").reason_code, Some("engine-missing"));
        assert_eq!(get(&missing, "video.surface").implementation, Some("webview-video"));
        assert!(!get(&missing, "video.hwdec").available);
        assert!(get(&missing, "engine.html5").available, "HTML5 fallback stays");

        i.engine_error = Some("libmpv disabled by VHO_DISABLE_MPV".into());
        assert_eq!(get(&build(&i), "engine.libmpv").reason_code, Some("engine-disabled"));
        i.engine_error = Some("mpv_initialize: error -1".into());
        assert_eq!(get(&build(&i), "engine.libmpv").reason_code, Some("engine-failed"));
        assert_ne!(with, missing);
    }

    #[test]
    fn caps_windows_codec_present_vs_missing_vs_failed() {
        let ok = build(&windows());
        assert!(get(&ok, "photo.avif").available);
        assert!(get(&ok, "photo.heic").available);

        let mut i = windows();
        i.avif_works = false; // installed, decode failed (0x88982F8B, S03)
        assert_eq!(get(&build(&i), "photo.avif").reason_code, Some("codec-failed"));
        i.avif_installed = false;
        i.heic = false;
        let none = build(&i);
        assert_eq!(get(&none, "photo.avif").reason_code, Some("codec-missing"));
        assert_eq!(get(&none, "photo.heic").reason_code, Some("codec-missing"));
        // RAW is a labelled preview unless an OS RAW codec exists
        assert_eq!(get(&none, "photo.raw").reason_code, Some("raw-preview-only"));
        i.raw_os = true;
        assert_eq!(get(&build(&i), "photo.raw").implementation, Some("os-raw-codec"));
    }

    #[test]
    fn caps_ffmpeg_and_test_guard() {
        let mut i = windows();
        i.ffmpeg = false;
        i.system_changes_disabled = true;
        let c = build(&i);
        assert_eq!(get(&c, "encode.ffmpeg").reason_code, Some("ffmpeg-missing"));
        let share = get(&c, "actions.share");
        assert!(share.available);
        assert_eq!(share.reason_code, Some("system-changes-disabled"));
        assert!(!share.verified, "share is never applied by the tests");
    }

    #[test]
    fn caps_untested_platforms_are_never_verified() {
        for (os, arch) in [("macos", "aarch64"), ("linux", "x86_64"), ("windows", "aarch64"), ("macos", "x86_64")] {
            let mut i = windows();
            i.os = os;
            i.arch = arch;
            if os != "windows" {
                i.engine_available = false;
                i.engine_error = Some("libmpv embedding is not available on this platform yet (path B)".into());
            }
            let r = report(&i);
            assert!(!r.platform.verified_platform, "{os}/{arch}");
            assert!(r.entries.iter().all(|c| !c.verified), "{os}/{arch}: verified entry without device test");
            if os == "macos" {
                assert_eq!(get(&r.entries, "engine.libmpv").reason_code, Some("engine-unsupported-platform"));
            }
        }
        assert_eq!(report(&windows()).platform.webview, "webview2");
        let mc = get(&build(&windows()), "system.mediaControls");
        assert_eq!((mc.available, mc.implementation), (true, Some("windows-smtc")));
        let mut mac = windows();
        mac.os = "macos";
        assert_eq!(get(&build(&mac), "system.mediaControls").reason_code, Some("not-implemented"));
        let mut no_mpv = windows();
        no_mpv.engine_available = false;
        assert_eq!(get(&build(&no_mpv), "audio.gapless").reason_code, Some("needs-libmpv"));
        assert_eq!(get(&build(&no_mpv), "audio.replayGain").implementation, Some("webview-volume"));
    }

    #[test]
    fn caps_support_table_rules() {
        // every built entry has a table row (and vice versa)
        let built = build(&windows());
        for c in &built {
            assert!(SUPPORT.iter().any(|r| r.0 == c.id), "{} missing in SUPPORT", c.id);
        }
        for r in SUPPORT {
            assert!(built.iter().any(|c| c.id == r.0), "{} in SUPPORT but not built", r.0);
        }
        // an unsupported cell is never available, even when the probe inputs say yes
        for os in ["windows", "macos", "linux"] {
            let mut i = windows();
            i.os = os;
            i.arch = if os == "macos" { "aarch64" } else { "x86_64" };
            for c in build(&i) {
                let sup = support(c.id, os);
                assert_eq!(c.support, sup.code());
                if sup == No {
                    assert!(!c.available && c.implementation.is_none() && c.reason_code.is_some(), "{os} {}", c.id);
                }
                if c.verified {
                    assert!(os == "windows" && sup == T, "{os} {}", c.id);
                }
            }
        }
        // no imitation: macOS share / open-with / lock screen / OCR / print are unsupported
        for id in ["actions.share", "actions.openWith", "actions.lockScreen", "actions.ocr", "actions.print"] {
            assert_eq!(support(id, "macos"), No, "{id}");
        }
        // viewable != exportable
        for id in ["photo.heicEncode", "photo.rawEncode"] {
            let c = get(&built, id);
            assert!(!c.available);
            assert_eq!(c.reason_code, Some("export-as-jpeg"));
        }
    }

    #[test]
    fn caps_encoder_and_ocr_runtime_inputs() {
        let c = get(&build(&windows()), "encode.h264");
        assert!(c.available && c.verified);
        assert_eq!((c.implementation, c.reason_code), (Some("h264_mf"), Some("runtime-probed")));
        let mut i = windows();
        i.video_encoder = Some(("mpeg4", true));
        let c = get(&build(&i), "encode.h264");
        assert!(!c.available);
        assert_eq!(c.reason_code, Some("h264-unavailable-fallback-mpeg4"));
        i.ffmpeg = false;
        assert_eq!(get(&build(&i), "encode.h264").reason_code, Some("ffmpeg-missing"));
        // Linux OCR: only with a tesseract binary found at run time
        let mut l = windows();
        l.os = "linux";
        l.ocr = false;
        l.ocr_engine = None;
        assert_eq!(get(&build(&l), "actions.ocr").reason_code, Some("tesseract-missing"));
        l.ocr = true;
        l.ocr_engine = Some("tesseract");
        let c = get(&build(&l), "actions.ocr");
        assert!(c.available && !c.verified);
        assert_eq!((c.implementation, c.support), (Some("tesseract"), "supported-untested"));
    }

    /// docs/platform-support.md shows the same three cells for every `SUPPORT` id.
    #[test]
    fn caps_support_table_matches_docs() {
        let doc = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/platform-support.md")).unwrap();
        for &(id, w, m, l) in SUPPORT {
            let tick = format!("(`{id}`)");
            // the matrix row: first cell "<name> (`id`)" and five cells (reason-code rows also mention ids)
            let cells: Vec<&str> = doc
                .lines()
                .filter(|r| r.starts_with('|'))
                .map(|r| r.split('|').map(str::trim).collect::<Vec<_>>())
                .find(|c| c.len() == 7 && c[1].ends_with(&tick))
                .unwrap_or_else(|| panic!("docs: no matrix row for {id}"));
            for (k, sup) in [(2, w), (3, m), (4, l)] {
                assert!(cells[k].starts_with(sup.doc()), "docs {id} column {k}: '{}' should start with '{}'", cells[k], sup.doc());
                // "destekli/test" must not match "destekli/testli" and vice versa
                if sup == U {
                    assert!(!cells[k].starts_with("destekli/testli"), "{id}");
                }
            }
        }
    }

    #[test]
    fn caps_linux_engine_render_api() {
        let mut i = windows();
        i.os = "linux";
        let c = build(&i);
        let e = get(&c, "engine.libmpv");
        assert!(e.available && !e.verified, "WSLg/VM evidence never makes Linux verified");
        assert_eq!(e.support, "supported-untested");
        assert_eq!(get(&c, "video.surface").implementation, Some("gtk-glarea-render-api"));
        assert_eq!(get(&c, "video.hwdec").implementation, Some("mpv-hwdec-auto-copy-safe"));
        i.engine_available = false;
        i.engine_error = Some("libmpv.so.2 not found (run `bash scripts/linux/stage-mpv.sh`)".into());
        assert_eq!(get(&build(&i), "engine.libmpv").reason_code, Some("engine-missing"));
    }
}
