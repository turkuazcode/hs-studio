//! L03 music backend tests on generated audio only (temp folders, staged ffmpeg + libmpv).
//!
//! Gapless: two halves of one continuous sine are played back to back by libmpv with
//! `gapless-audio=yes` into `ao=pcm`; the written PCM must be the uninterrupted sine (no lost
//! or inserted samples, no silent run at the boundary). Lossless (FLAC) must be sample exact;
//! AAC (encoder delay/padding trimmed via the MP4 edit list) within a small tolerance.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::actions::ffmpeg;
use crate::engine::mpv::Mpv;

const RATE: u32 = 48000;
const FREQ: f64 = 441.0;

fn staged(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let deps = exe.parent().unwrap();
    let dir = if deps.file_name().is_some_and(|n| n == "deps") { deps.parent().unwrap() } else { deps };
    dir.join(name)
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vho-music-{tag}-{}-{}", std::process::id(), crate::storage::now_ms()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn run_ffmpeg(args: &[&str]) {
    let out = Command::new(staged("ffmpeg.exe"))
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(args)
        .output()
        .expect("ffmpeg (npm run stage:mpv)");
    assert!(out.status.success(), "ffmpeg {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// One second of the continuous sine starting at `offset` seconds.
fn sine_part(out: &Path, offset: u32, codec: &[&str]) {
    let src = format!("aevalsrc=0.5*sin(2*PI*{FREQ}*(t+{offset})):s={RATE}:d=1:c=mono");
    let o = out.to_string_lossy().into_owned();
    let mut args = vec!["-f", "lavfi", "-i", src.as_str()];
    args.extend_from_slice(codec);
    args.push(&o);
    run_ffmpeg(&args);
}

/// Plays `files` back to back into a float WAV and returns the samples.
fn play_to_pcm(files: &[PathBuf], out: &Path, gapless: &str) -> Vec<f32> {
    let dll = staged("libmpv-2.dll");
    assert!(dll.is_file(), "libmpv not staged next to the test binary (npm run stage:mpv)");
    let o = out.to_string_lossy().into_owned();
    let m = Mpv::new(
        &dll,
        &[
            ("config", "no"),
            ("terminal", "no"),
            ("vo", "null"),
            ("vid", "no"),
            ("ao", "pcm"),
            ("ao-pcm-file", &o),
            ("ao-pcm-waveheader", "yes"),
            ("audio-format", "float"),
            ("audio-samplerate", "48000"),
            ("audio-channels", "mono"),
            ("gapless-audio", gapless),
            ("prefetch-playlist", "yes"),
            ("idle", "yes"),
        ],
    )
    .expect("libmpv");
    m.command(&json!(["loadfile", files[0].to_string_lossy(), "replace"])).unwrap();
    for f in &files[1..] {
        m.command(&json!(["loadfile", f.to_string_lossy(), "append"])).unwrap();
    }
    // wait for playback to start, then for the playlist to finish (ao=pcm runs untimed)
    let start = Instant::now();
    let mut started = false;
    while start.elapsed() < Duration::from_secs(30) {
        let idle = m.get_property("idle-active").ok().and_then(|v| v.as_bool()).unwrap_or(true);
        if !idle {
            started = true;
        } else if started {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(started, "playback did not start");
    drop(m); // ao_pcm finalizes the WAV header on uninit
    let bytes = std::fs::read(out).unwrap();
    let data = bytes.windows(4).position(|w| w == b"data").expect("data chunk") + 8;
    bytes[data..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

struct Boundary {
    samples: usize,
    /// longest run of near-silent samples within ±50 ms of the joint
    silent_run: usize,
    /// largest deviation from the ideal sine within ±50 ms of the joint
    max_error: f64,
}

fn measure(pcm: &[f32], joint: usize) -> Boundary {
    let w = (RATE / 20) as usize;
    let (a, b) = (joint.saturating_sub(w), (joint + w).min(pcm.len()));
    let (mut run, mut best, mut err) = (0usize, 0usize, 0f64);
    for (n, &x) in pcm.iter().enumerate().take(b).skip(a) {
        if x.abs() < 0.01 {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
        let ideal = 0.5 * (2.0 * std::f64::consts::PI * FREQ * n as f64 / RATE as f64).sin();
        err = err.max((x as f64 - ideal).abs());
    }
    Boundary { samples: pcm.len(), silent_run: best, max_error: err }
}

#[test]
fn gapless_boundary_is_measured_flac_exact_aac_trimmed() {
    let d = tmp("gapless");
    let flac = [d.join("a.flac"), d.join("b.flac")];
    sine_part(&flac[0], 0, &["-c:a", "flac"]);
    sine_part(&flac[1], 1, &["-c:a", "flac"]);
    let pcm = play_to_pcm(&flac, &d.join("flac.wav"), "yes");
    let m = measure(&pcm, RATE as usize);
    eprintln!(
        "[gapless] flac: {} samples (ideal {}), silent run {} samples, max error {:.5}",
        m.samples,
        2 * RATE,
        m.silent_run,
        m.max_error
    );
    assert_eq!(m.samples, 2 * RATE as usize, "no sample lost or inserted");
    assert!(m.silent_run <= 1 && m.max_error < 1e-3, "sample exact across the joint");

    let aac = [d.join("a.m4a"), d.join("b.m4a")];
    sine_part(&aac[0], 0, &["-c:a", "aac", "-b:a", "192k"]);
    sine_part(&aac[1], 1, &["-c:a", "aac", "-b:a", "192k"]);
    let pcm = play_to_pcm(&aac, &d.join("aac.wav"), "yes");
    let m = measure(&pcm, RATE as usize);
    let extra = m.samples as i64 - 2 * RATE as i64;
    eprintln!("[gapless] aac: {} samples ({extra:+} vs ideal), silent run {} samples, max error {:.4}", m.samples, m.silent_run, m.max_error);
    // AAC priming (1024) and padding are trimmed: far less than one 1024-sample frame left
    assert!(extra.abs() < 1024, "encoder delay/padding not trimmed: {extra:+} samples");
    assert!(m.silent_run < 48, "audible gap at the joint: {} silent samples", m.silent_run);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn album_replaygain_is_one_joint_measurement_and_tags_round_trip() {
    let d = tmp("rg");
    let quiet = d.join("01 quiet.flac");
    let loud = d.join("02 loud.flac");
    for (p, vol) in [(&quiet, "volume=-20dB"), (&loud, "volume=-6dB")] {
        let o = p.to_string_lossy().into_owned();
        run_ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=6", "-af", vol, "-ac", "2", "-c:a", "flac", &o]);
    }
    let album = ffmpeg::album_loudness(&[&quiet, &loud], &[2, 2], &[6.0, 6.0]).unwrap();
    let (q, l) = (&album.tracks[0], &album.tracks[1]);
    eprintln!(
        "[rg] quiet {:.1} LUFS gain {:+.2}; loud {:.1} LUFS gain {:+.2}; album {:.1} LUFS gain {:+.2} ({})",
        q.integrated_lufs, q.track_gain_db, l.integrated_lufs, l.track_gain_db, album.integrated_lufs, album.album_gain_db, album.method
    );
    assert_eq!(album.method, "joint");
    // track gains differ by the 14 dB level difference; gain = -18 - LUFS (not the LUFS value)
    assert!((q.track_gain_db - l.track_gain_db - 14.0).abs() < 0.3, "{q:?} {l:?}");
    assert!((q.track_gain_db - (-18.0 - q.integrated_lufs)).abs() < 0.01);
    // the album is one measurement: dominated by the loud track, not the mean of the gains
    let mean = (q.track_gain_db + l.track_gain_db) / 2.0;
    assert!(album.album_gain_db < mean - 2.0 && (album.album_gain_db - l.track_gain_db).abs() < 3.5, "{album:?}");
    // peaks: sample peak (linear) of the loud track; the true peak is only reported
    assert!((album.album_peak - 10f64.powf(-6.0 / 20.0)).abs() < 0.02, "{}", album.album_peak);
    assert!(l.true_peak_dbfs >= l.sample_peak_dbfs - 0.01);
    // the tags written on the generated copies read back as written (track + album)
    for (p, t) in [(&quiet, q), (&loud, l)] {
        crate::actions::tags::write_replaygain(p, t).unwrap();
        crate::actions::tags::write_replaygain_album(p, album.album_gain_db, album.album_peak).unwrap();
        let back = crate::actions::tags::read(p).unwrap();
        assert_eq!(back.replaygain_track_gain, format!("{:.2} dB", t.track_gain_db));
        assert_eq!(back.replaygain_album_gain, format!("{:.2} dB", album.album_gain_db));
        assert_eq!(back.replaygain_album_peak, format!("{:.6}", album.album_peak));
        // the library scanner reads the same values as numbers
        let meta = crate::library::scan::read_audio_meta(p).unwrap();
        assert!((meta.rg_album_gain.unwrap() - album.album_gain_db).abs() < 0.006);
        assert!((meta.rg_track_peak.unwrap() - t.track_peak).abs() < 1e-5);
    }
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn batch_tag_edit_on_copies_round_trips() {
    let d = tmp("tags");
    let files: Vec<PathBuf> = (1..=3).map(|i| d.join(format!("{i:02} parça.flac"))).collect();
    for f in &files {
        let o = f.to_string_lossy().into_owned();
        run_ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:duration=1", "-c:a", "flac", &o]);
    }
    for (i, f) in files.iter().enumerate() {
        let u = crate::actions::tags::TagUpdate {
            title: Some(format!("Şarkı {}", i + 1)),
            artist: Some("Barış Manço".into()),
            album: Some("Sakla Samanı".into()),
            genre: Some("Anadolu Rock".into()),
            ..Default::default()
        };
        crate::actions::tags::write(f, &u).unwrap();
    }
    for (i, f) in files.iter().enumerate() {
        let t = crate::actions::tags::read(f).unwrap();
        assert_eq!((t.artist.as_str(), t.album.as_str(), t.genre.as_str()), ("Barış Manço", "Sakla Samanı", "Anadolu Rock"));
        assert_eq!(t.title, format!("Şarkı {}", i + 1));
    }
    let _ = std::fs::remove_dir_all(&d);
}
