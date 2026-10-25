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

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: &'static str,
    pub available: bool,
    pub implementation: Option<&'static str>,
    pub verified: bool,
    pub reason_code: Option<&'static str>,
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

/// Features with automated test evidence on a verified platform (Rust and/or E2E suite).
/// Anything not listed stays `verified: false` even where it is available.
const TESTED_ON_VERIFIED_PLATFORM: &[&str] = &[
    "engine.libmpv",
    "engine.html5",
    "video.surface",
    "encode.ffmpeg",
    "photo.avif",
    "photo.avifEncode",
    "photo.raw",
    "actions.ocr",
];

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
    } else if os != "windows" || e.contains("not available on this platform") {
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
    let entry = |id: &'static str, available: bool, implementation: Option<&'static str>, reason: Option<&'static str>| Capability {
        id,
        available,
        implementation,
        verified: available && verified_os && TESTED_ON_VERIFIED_PLATFORM.contains(&id),
        reason_code: if available { reason } else { Some(reason.unwrap_or("unavailable")) },
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
            Some(if i.engine_available { "win32-owned-popup" } else { "webview-video" }),
            engine_reason,
        ),
        // Hardware decoding is requested (hwdec=auto-safe); whether it succeeds per file is
        // reported by mpv's hwdec-current, not measured here
        entry("video.hwdec", i.engine_available, i.engine_available.then_some("mpv-hwdec-auto-safe"), Some(engine_reason.unwrap_or("success-not-measured"))),
        // Legacy-codec transcode for the HTML5 fallback (Media Foundation)
        entry("video.legacyTranscode", windows, windows.then_some("media-foundation"), (!windows).then_some("unsupported-platform")),
        entry("encode.ffmpeg", i.ffmpeg, i.ffmpeg.then_some("ffmpeg-lgpl"), (!i.ffmpeg).then_some("ffmpeg-missing")),
        entry("photo.heic", i.heic, i.heic.then_some(i.os_codec), (!i.heic).then_some("codec-missing")),
        entry(
            "photo.avif",
            i.avif_works,
            i.avif_works.then_some(i.os_codec),
            if i.avif_works { None } else if i.avif_installed { Some("codec-failed") } else { Some("codec-missing") },
        ),
        entry("photo.avifEncode", true, Some("rust-image-ravif"), None),
        // RAW: the embedded JPEG preview always; a full OS RAW decoder only where installed
        entry("photo.raw", true, Some(if i.raw_os { "os-raw-codec" } else { "embedded-jpeg-preview" }), (!i.raw_os).then_some("raw-preview-only")),
        entry("actions.ocr", i.ocr, i.ocr.then_some("windows-media-ocr"), (!i.ocr).then_some("unsupported-platform")),
        entry("actions.share", i.share, i.share.then_some("windows-share-ui"), os_action(i.share)),
        entry("actions.wallpaper", i.wallpaper, i.wallpaper.then_some("os-wallpaper"), os_action(i.wallpaper)),
        entry("actions.lockScreen", i.lock_screen, i.lock_screen.then_some("windows-lockscreen"), os_action(i.lock_screen)),
        entry("actions.openWith", i.open_with, i.open_with.then_some("os-open-with"), os_action(i.open_with)),
        // OS media keys / now-playing integration (SMTC, MPRIS, MPNowPlayingInfoCenter): not implemented
        entry("system.mediaControls", false, None, Some("not-implemented")),
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
            if os != "windows" {
                assert_eq!(get(&r.entries, "engine.libmpv").reason_code, Some("engine-unsupported-platform"));
            }
        }
        assert_eq!(report(&windows()).platform.webview, "webview2");
        assert!(!get(&build(&windows()), "system.mediaControls").available);
    }
}
