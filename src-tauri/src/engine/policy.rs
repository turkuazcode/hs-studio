//! What the webview may ask libmpv to do (Plan 14/Q04).
//!
//! `engine_command` / `engine_set` / `engine_load` used to pass anything to mpv. mpv commands
//! and options can start processes (`run`, `subprocess`), load scripts or config files
//! (`load-script`, `load-config-file`, `scripts`, `include`), write files (`screenshot-to-file`,
//! `dump-cache`, `stream-record`, `log-file`), open an IPC server (`input-ipc-server`) or read
//! arbitrary files through lavfi (`movie=`, `amovie=`). Only the commands and properties the UI
//! really uses are allowed here; reads (`engine_get`) stay open because they change nothing.
//! The backend's own mpv calls (screenshots, quit, options at start) do not go through this.

use std::path::Path;

use serde_json::Value;

/// Properties the UI sets (playback, tracks, delays, subtitles style, view, picture, render
/// quality of the "fast" profile toggle). `af` / `vf` are checked separately.
const SETTABLE: &[&str] = &[
    "pause", "volume", "speed", "mute", "ab-loop-a", "ab-loop-b", "aid", "sid", "vid", "chapter",
    "audio-delay", "sub-delay", "sub-scale", "sub-color", "sub-pos", "sub-margin-y",
    "video-rotate", "video-zoom", "video-pan-x", "video-pan-y", "video-aspect-override", "keepaspect",
    "video-margin-ratio-top", "video-margin-ratio-left", "video-margin-ratio-right", "video-margin-ratio-bottom",
    "brightness", "contrast", "saturation", "gamma", "hue", "hwdec",
    "scale", "dscale", "cscale", "dither", "correct-downscaling", "linear-downscaling", "sigmoid-upscaling",
    "hdr-compute-peak",
    // music mode (L03): ReplayGain and gapless playback
    "replaygain", "replaygain-preamp", "replaygain-clip", "gapless-audio", "prefetch-playlist",
];

/// Audio filters of the EQ / sound filter chain (`src/media/engine/engine.js` audioFilterChain).
const AUDIO_FILTERS: &[&str] = &["highpass", "lowpass", "equalizer", "acompressor", "dynaudnorm", "volume", "alimiter"];

/// Video filters of the flip switches (`flipFilter`).
const VIDEO_FILTERS: &[&str] = &["hflip", "vflip"];

/// mpv profiles the UI applies.
const PROFILES: &[&str] = &["fast"];

fn denied(what: &str) -> String {
    format!("[engine-denied] {what}")
}

/// `engine_command`: stop, seek, frame stepping, adding a local subtitle file, applying a known
/// profile. Arguments are positional (JSON array), like the frontend sends them.
pub fn check_command(args: &Value) -> Result<(), String> {
    let list = args.as_array().ok_or_else(|| denied("command must be an array"))?;
    let name = list.first().and_then(Value::as_str).ok_or_else(|| denied("missing command name"))?;
    let rest = &list[1..];
    let scalar = |v: &Value| v.is_number() || v.is_string();
    let ok = match name {
        "stop" | "frame-step" | "frame-back-step" | "playlist-clear" => rest.is_empty(),
        // gapless (L03): the next local track is queued in mpv's own playlist, never replaced
        "loadfile" => rest.len() == 2 && rest[0].as_str().is_some_and(is_local_file) && rest[1].as_str() == Some("append"),
        "seek" => {
            !rest.is_empty()
                && rest.len() <= 2
                && scalar(&rest[0])
                && rest.get(1).is_none_or(|f| f.as_str().is_some_and(|f| f.split('+').all(|p| matches!(p, "relative" | "absolute" | "absolute-percent" | "relative-percent" | "exact" | "keyframes"))))
        }
        "sub-add" => {
            rest.first().and_then(Value::as_str).is_some_and(is_local_file)
                && rest.get(1).is_none_or(|f| matches!(f.as_str(), Some("select" | "auto" | "cached")))
                && rest.len() <= 2
        }
        "apply-profile" => rest.len() == 1 && rest[0].as_str().is_some_and(|p| PROFILES.contains(&p)),
        _ => return Err(denied(&format!("command \"{name}\" is not allowed"))),
    };
    if ok { Ok(()) } else { Err(denied(&format!("bad arguments for \"{name}\""))) }
}

/// `engine_set`: only [`SETTABLE`] properties with plain values, plus checked `af` / `vf` chains.
pub fn check_set(name: &str, value: &Value) -> Result<(), String> {
    match name {
        "af" => check_chain(value, Some("lavfi"), AUDIO_FILTERS),
        "vf" => check_chain(value, None, VIDEO_FILTERS),
        _ if SETTABLE.contains(&name) => {
            if value.is_array() || value.is_object() {
                Err(denied(&format!("\"{name}\" takes a plain value")))
            } else {
                Ok(())
            }
        }
        _ => Err(denied(&format!("property \"{name}\" is not settable"))),
    }
}

/// `"" | f1,f2` (vf) or `"" | lavfi=[f1=a:b,f2]` (af) where every filter is in `allowed` and its
/// arguments are plain numbers / words (no file names, no nested graphs, no `sendcmd`).
fn check_chain(value: &Value, wrapper: Option<&str>, allowed: &[&str]) -> Result<(), String> {
    let s = value.as_str().ok_or_else(|| denied("filter chain must be a string"))?;
    if s.is_empty() {
        return Ok(());
    }
    let inner = match wrapper {
        Some(w) => s
            .strip_prefix(w)
            .and_then(|r| r.strip_prefix("=["))
            .and_then(|r| r.strip_suffix(']'))
            .ok_or_else(|| denied("unexpected filter chain"))?,
        None => s,
    };
    for f in inner.split(',') {
        let (fname, fargs) = f.split_once('=').unwrap_or((f, ""));
        if !allowed.contains(&fname) {
            return Err(denied(&format!("filter \"{fname}\" is not allowed")));
        }
        if !fargs.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '=' | ':' | '.' | '-' | '_')) {
            return Err(denied(&format!("bad arguments for filter \"{fname}\"")));
        }
    }
    Ok(())
}

/// `engine_load`: an existing local file (incl. UNC shares) or a stream URL with one of the
/// playlist's stream schemes. mpv pseudo protocols (`lavfi://`, `av://`, `memory://`, `fd://`,
/// `edl://`, `ytdl://`, `file://` ...) are refused.
pub fn check_load(path: &str) -> Result<(), String> {
    if let Some((scheme, _)) = path.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if crate::library::playlist::URL_SCHEMES.contains(&scheme.as_str()) {
            return Ok(());
        }
        return Err(denied(&format!("\"{scheme}://\" cannot be opened")));
    }
    if is_local_file(path) { Ok(()) } else { Err(denied("not an existing file")) }
}

/// Absolute path of an existing regular file; never an mpv protocol (`x://`, `x:/...` with
/// more than one letter) or an option-like string.
fn is_local_file(p: &str) -> bool {
    let path = Path::new(p);
    !p.contains("://") && !p.starts_with('-') && path.is_absolute() && path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn engine_policy_allows_what_the_ui_sends() {
        for c in [
            json!(["stop"]),
            json!(["frame-step"]),
            json!(["frame-back-step"]),
            json!(["seek", 12.5, "absolute+exact"]),
            json!(["seek", -5, "relative+exact"]),
            json!(["seek", 0, "absolute"]),
            json!(["apply-profile", "fast"]),
        ] {
            assert_eq!(check_command(&c), Ok(()), "{c}");
        }
        for (k, v) in [
            ("pause", json!(true)), ("volume", json!(80)), ("aid", json!("no")), ("sid", json!(2)),
            ("ab-loop-a", json!("no")), ("sub-color", json!("#ffffff")), ("video-aspect-override", json!("16:9")),
            ("keepaspect", json!(false)), ("hwdec", json!("auto-safe")), ("scale", json!("lanczos")),
            ("video-margin-ratio-top", json!(0.05)),
            ("vf", json!("")), ("vf", json!("hflip,vflip")),
            ("af", json!("")),
            ("af", json!("lavfi=[highpass=f=90,lowpass=f=7500,equalizer=f=2400:t=q:w=1.1:g=5.5,equalizer=f=31:t=o:w=1:g=-3.5,acompressor=threshold=0.063:ratio=4:attack=3:release=250:knee=4,dynaudnorm=f=250:g=15:p=0.9,volume=1.500,alimiter=limit=0.944:attack=5:release=50:level=0]")),
        ] {
            assert_eq!(check_set(k, &v), Ok(()), "{k}={v}");
        }
        let dir = std::env::temp_dir().join(format!("vho-policy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sub = dir.join("altyazı ç.srt");
        std::fs::write(&sub, "1\n00:00:00,000 --> 00:00:01,000\nx\n").unwrap();
        let s = sub.to_string_lossy().into_owned();
        assert_eq!(check_command(&json!(["sub-add", s, "select"])), Ok(()));
        assert_eq!(check_load(&s), Ok(()));
        for u in ["https://example.org/a.m3u8", "HTTP://x/y.mp4", "rtsp://cam.local/live"] {
            assert_eq!(check_load(u), Ok(()), "{u}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn engine_policy_refuses_process_script_file_and_ipc_access() {
        for c in [
            json!(["run", "cmd.exe", "/c", "calc"]),
            json!({"name": "subprocess", "args": ["calc"]}),
            json!(["subprocess", ["calc"]]),
            json!(["load-script", "C:/x.lua"]),
            json!(["load-config-file", "C:/x.conf"]),
            json!(["screenshot-to-file", "C:/Windows/x.png"]),
            json!(["dump-cache", 0, "no", "C:/x.ts"]),
            json!(["loadfile", "C:/x.mp4"]),
            json!(["quit"]),
            json!(["change-list", "script-opts", "append", "a=b"]),
            json!(["set", "input-ipc-server", "\\\\.\\pipe\\x"]),
            json!(["keypress", "q"]),
            json!(["overlay-add", 0, 0, 0, "&123", 0, "bgra", 1, 1, 4]),
            json!(["seek", 1, "absolute", "extra"]),
            json!(["seek", [1], "absolute"]),
            json!(["sub-add", "C:/does/not/exist.srt"]),
            json!(["sub-add", "http://x/y.srt"]),
            json!(["sub-add", "memory://x"]),
            json!(["apply-profile", "gpu-hq"]),
            json!(["stop", "keep-playlist"]),
            json!([]),
            json!("stop"),
        ] {
            assert!(check_command(&c).is_err(), "allowed: {c}");
            assert!(check_command(&c).unwrap_err().starts_with("[engine-denied]"));
        }
        for (k, v) in [
            ("input-ipc-server", json!("\\\\.\\pipe\\vho")),
            ("scripts", json!("C:/x.lua")),
            ("script-opts", json!("a=b")),
            ("include", json!("C:/x.conf")),
            ("log-file", json!("C:/x.log")),
            ("stream-record", json!("C:/x.ts")),
            ("screenshot-directory", json!("C:/Windows")),
            ("glsl-shaders", json!("C:/x.glsl")),
            ("sub-files", json!("C:/x.srt")),
            ("ytdl-path", json!("C:/x.exe")),
            ("volume", json!([1])),
            ("af", json!("lavfi=[amovie=C\\:/secret.wav]")),
            ("af", json!("lavfi=[volume=2,sendcmd=f=C\\:/x.cmd]")),
            ("af", json!("lavfi=[volume=2],lavfi=[x]")),
            ("af", json!("volume=2")),
            ("af", json!("lavfi=[equalizer=f=1;movie=x]")),
            ("vf", json!("lavfi=[movie=C\\:/x.png]")),
            ("vf", json!("hflip,scale=1:1")),
            ("vf", json!(1)),
        ] {
            assert!(check_set(k, &v).is_err(), "allowed: {k}={v}");
        }
        for p in [
            "lavfi://sine", "av://lavfi:sine", "memory://abc", "fd://3", "edl://a.mp4,0,1", "ytdl://x",
            "file:///C:/Windows/win.ini", "smb://host/share/a.mp4", "javascript:alert(1)",
            "C:/does/not/exist.mp4", "relative.mp4", "--script=x.lua", "",
        ] {
            assert!(check_load(p).is_err(), "allowed: {p}");
        }
        let dir = std::env::temp_dir();
        assert!(check_load(&dir.to_string_lossy()).is_err(), "a folder is not a file");
    }

    /// Music mode (L03): queue the next LOCAL track for gapless playback, ReplayGain options.
    #[test]
    fn engine_policy_allows_gapless_queue_and_replaygain_only() {
        let dir = std::env::temp_dir().join(format!("vho-policy-gapless-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let track = dir.join("02 parça.flac");
        std::fs::write(&track, b"x").unwrap();
        let t = track.to_string_lossy().into_owned();
        assert_eq!(check_command(&json!(["playlist-clear"])), Ok(()));
        assert_eq!(check_command(&json!(["loadfile", t, "append"])), Ok(()));
        for c in [
            json!(["loadfile", t, "replace"]),
            json!(["loadfile", "http://x/y.mp3", "append"]),
            json!(["loadfile", "lavfi://sine", "append"]),
            json!(["loadfile", dir.join("missing.flac").to_string_lossy(), "append"]),
            json!(["playlist-clear", "x"]),
        ] {
            assert!(check_command(&c).is_err(), "allowed: {c}");
        }
        for (k, v) in [("replaygain", json!("album")), ("replaygain-preamp", json!(-3)), ("replaygain-clip", json!("yes")), ("gapless-audio", json!("yes")), ("prefetch-playlist", json!("no"))] {
            assert_eq!(check_set(k, &v), Ok(()), "{k}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
