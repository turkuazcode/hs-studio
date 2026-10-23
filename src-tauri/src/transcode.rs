//! Legacy codec support through the OS media stack (Windows Media Foundation).
//!
//! WebView2 (Chromium) only decodes H.264/HEVC/VP8/VP9/AV1 video. Old phone and
//! camcorder footage often uses MPEG-4 Part 2, H.263, WMV, MJPEG... which play as
//! "audio only". Windows ships decoders for these, so we re-encode them to
//! H.264/AAC MP4 once and cache the result. No extra binaries are bundled.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub needs_transcode: bool,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

/// Containers Chromium cannot demux at all, regardless of the codecs inside.
const UNSUPPORTED_CONTAINERS: &[&str] = &[
    "avi", "wmv", "asf", "flv", "3gp", "3g2", "mpg", "mpeg", "vob", "ts", "m2ts", "mts", "divx", "xvid", "amr",
];

pub fn container_needs_transcode(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    UNSUPPORTED_CONTAINERS.contains(&ext.as_str())
}

#[cfg(target_os = "windows")]
pub use win::{probe, transcode};

#[cfg(all(test, target_os = "windows"))]
mod tests {
    /// Real-file check: `VHO_TEST_MEDIA=<file> cargo test --release --lib -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_and_transcode_real_file() {
        let input = std::env::var("VHO_TEST_MEDIA").expect("VHO_TEST_MEDIA");
        let info = super::probe(&input).expect("probe");
        println!("probe: {info:?}");

        let out = std::env::temp_dir().join("vho_transcode_test.mp4");
        let _ = std::fs::remove_file(&out);
        let started = std::time::Instant::now();
        super::transcode(&input, &out, &mut |_| {}, &|| false).expect("transcode");
        println!("output: {} bytes in {:?}", std::fs::metadata(&out).unwrap().len(), started.elapsed());

        let converted = super::probe(out.to_str().unwrap()).expect("probe output");
        println!("converted: {converted:?}");
        assert!(!converted.needs_transcode);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn probe(path: &str) -> Result<ProbeInfo, String> {
    Ok(ProbeInfo {
        needs_transcode: container_needs_transcode(path),
        video_codec: None,
        audio_codec: None,
    })
}

#[cfg(not(target_os = "windows"))]
pub fn transcode(
    _input: &str,
    _output: &std::path::Path,
    _progress: &mut dyn FnMut(f64),
    _cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    Err("Eski codec dönüştürme şu an yalnızca Windows'ta destekleniyor".into())
}

#[cfg(target_os = "windows")]
mod win {
    use super::{container_needs_transcode, ProbeInfo};
    use std::path::Path;
    use windows::core::{GUID, HSTRING};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    const VIDEO_STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    const AUDIO_STREAM: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
    const ANY_STREAM: u32 = MF_SOURCE_READER_ANY_STREAM.0 as u32;
    const ALL_STREAMS: u32 = MF_SOURCE_READER_ALL_STREAMS.0 as u32;
    const MEDIASOURCE: u32 = MF_SOURCE_READER_MEDIASOURCE.0 as u32;

    // Codecs Chromium/WebView2 can decode natively.
    const CHROMIUM_VIDEO: &[GUID] = &[
        MFVideoFormat_H264,
        MFVideoFormat_HEVC,
        MFVideoFormat_VP80,
        MFVideoFormat_VP90,
        MFVideoFormat_AV1,
    ];
    const CHROMIUM_AUDIO: &[GUID] = &[
        MFAudioFormat_AAC,
        MFAudioFormat_MP3,
        MFAudioFormat_Opus,
        MFAudioFormat_FLAC,
        MFAudioFormat_PCM,
        MFAudioFormat_Float,
        MFAudioFormat_Vorbis,
    ];

    /// COM + Media Foundation lifetime for the current thread.
    struct MfSession;

    impl MfSession {
        fn start() -> Result<Self, String> {
            unsafe {
                // S_FALSE / RPC_E_CHANGED_MODE are fine: COM is usable on this thread either way.
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(|e| format!("MFStartup: {e}"))?;
            }
            Ok(MfSession)
        }
    }

    impl Drop for MfSession {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
                CoUninitialize();
            }
        }
    }

    /// Human readable codec name from a Media Foundation subtype GUID.
    fn codec_name(g: &GUID) -> String {
        let known: &[(GUID, &str)] = &[
            (MFVideoFormat_H264, "H.264"),
            (MFVideoFormat_HEVC, "HEVC"),
            (MFVideoFormat_VP80, "VP8"),
            (MFVideoFormat_VP90, "VP9"),
            (MFVideoFormat_AV1, "AV1"),
            (MFVideoFormat_MP4V, "MPEG-4 Part 2"),
            (MFVideoFormat_M4S2, "MPEG-4 Part 2"),
            (MFVideoFormat_H263, "H.263"),
            (MFVideoFormat_MPEG2, "MPEG-2"),
            (MFVideoFormat_MJPG, "MJPEG"),
            (MFVideoFormat_WMV1, "WMV7"),
            (MFVideoFormat_WMV2, "WMV8"),
            (MFVideoFormat_WMV3, "WMV9"),
            (MFVideoFormat_WVC1, "VC-1"),
            (MFAudioFormat_AAC, "AAC"),
            (MFAudioFormat_MP3, "MP3"),
            (MFAudioFormat_AMR_NB, "AMR-NB"),
            (MFAudioFormat_AMR_WB, "AMR-WB"),
            (MFAudioFormat_Dolby_AC3, "AC-3"),
            (MFAudioFormat_Dolby_DDPlus, "E-AC-3"),
            (MFAudioFormat_WMAudioV8, "WMA"),
            (MFAudioFormat_WMAudioV9, "WMA Pro"),
            (MFAudioFormat_PCM, "PCM"),
        ];
        if let Some((_, n)) = known.iter().find(|(k, _)| k == g) {
            return (*n).to_string();
        }
        // FourCC-based subtypes keep the code in Data1
        let b = g.data1.to_le_bytes();
        if b.iter().all(|c| c.is_ascii_graphic()) {
            String::from_utf8_lossy(&b).into_owned()
        } else {
            format!("0x{:X}", g.data1)
        }
    }

    fn open_reader(path: &str) -> Result<IMFSourceReader, String> {
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 2).map_err(|e| e.to_string())?;
            let attrs = attrs.ok_or("MFCreateAttributes")?;
            // Lets the reader convert/scale decoded frames to NV12 in software
            attrs
                .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
                .map_err(|e| e.to_string())?;
            MFCreateSourceReaderFromURL(&HSTRING::from(path), &attrs)
                .map_err(|e| format!("Dosya Media Foundation ile açılamadı: {e}"))
        }
    }

    fn native_subtype(reader: &IMFSourceReader, stream: u32) -> Option<GUID> {
        unsafe {
            reader
                .GetNativeMediaType(stream, 0)
                .ok()
                .and_then(|t| t.GetGUID(&MF_MT_SUBTYPE).ok())
        }
    }

    pub fn probe(path: &str) -> Result<ProbeInfo, String> {
        let _mf = MfSession::start()?;
        let reader = open_reader(path)?;
        let video = native_subtype(&reader, VIDEO_STREAM);
        let audio = native_subtype(&reader, AUDIO_STREAM);

        let video_bad = video.is_some_and(|g| !CHROMIUM_VIDEO.contains(&g));
        let audio_bad = audio.is_some_and(|g| !CHROMIUM_AUDIO.contains(&g));
        Ok(ProbeInfo {
            needs_transcode: video_bad || audio_bad || container_needs_transcode(path),
            video_codec: video.as_ref().map(codec_name),
            audio_codec: audio.as_ref().map(codec_name),
        })
    }

    fn split_u64(v: u64) -> (u32, u32) {
        ((v >> 32) as u32, v as u32)
    }

    fn join_u32(hi: u32, lo: u32) -> u64 {
        ((hi as u64) << 32) | lo as u64
    }

    fn duration_100ns(reader: &IMFSourceReader) -> u64 {
        unsafe {
            match reader.GetPresentationAttribute(MEDIASOURCE, &MF_PD_DURATION) {
                Ok(pv) => pv.Anonymous.Anonymous.Anonymous.uhVal,
                Err(_) => 0,
            }
        }
    }

    struct VideoSetup {
        out_type: IMFMediaType,
        in_type: IMFMediaType,
    }

    /// Configures the reader to output NV12 and builds the matching H.264 encoder type.
    fn setup_video(reader: &IMFSourceReader) -> Result<Option<VideoSetup>, String> {
        unsafe {
            let Ok(native) = reader.GetNativeMediaType(VIDEO_STREAM, 0) else {
                return Ok(None);
            };
            let (w, h) = split_u64(native.GetUINT64(&MF_MT_FRAME_SIZE).map_err(|e| e.to_string())?);
            // H.264 needs even dimensions
            let (w, h) = ((w & !1).max(2), (h & !1).max(2));
            let (fr_n, fr_d) = native
                .GetUINT64(&MF_MT_FRAME_RATE)
                .map(split_u64)
                .ok()
                .filter(|(n, d)| *n > 0 && *d > 0)
                .unwrap_or((30, 1));
            let par = native.GetUINT64(&MF_MT_PIXEL_ASPECT_RATIO).unwrap_or(join_u32(1, 1));

            let decoded = MFCreateMediaType().map_err(|e| e.to_string())?;
            decoded.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            decoded.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            decoded.SetUINT64(&MF_MT_FRAME_SIZE, join_u32(w, h)).map_err(|e| e.to_string())?;
            decoded.SetUINT64(&MF_MT_FRAME_RATE, join_u32(fr_n, fr_d)).map_err(|e| e.to_string())?;
            decoded.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, par).map_err(|e| e.to_string())?;
            decoded
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            reader
                .SetCurrentMediaType(VIDEO_STREAM, None, &decoded)
                .map_err(|e| format!("Video çözücü bulunamadı: {e}"))?;
            let in_type = reader.GetCurrentMediaType(VIDEO_STREAM).map_err(|e| e.to_string())?;

            // Generous bitrate: the source is already lossy, don't add visible artifacts
            let fps = fr_n as f64 / fr_d as f64;
            let bitrate = ((w as f64 * h as f64 * fps * 0.2) as u32).clamp(1_500_000, 40_000_000);

            let out_type = MFCreateMediaType().map_err(|e| e.to_string())?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| e.to_string())?;
            out_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(|e| e.to_string())?;
            out_type
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .map_err(|e| e.to_string())?;
            out_type.SetUINT64(&MF_MT_FRAME_SIZE, join_u32(w, h)).map_err(|e| e.to_string())?;
            out_type.SetUINT64(&MF_MT_FRAME_RATE, join_u32(fr_n, fr_d)).map_err(|e| e.to_string())?;
            out_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, par).map_err(|e| e.to_string())?;
            out_type
                .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                .map_err(|e| e.to_string())?;

            Ok(Some(VideoSetup { out_type, in_type }))
        }
    }

    struct AudioSetup {
        out_type: IMFMediaType,
        in_type: IMFMediaType,
    }

    fn pcm_type(rate: u32, channels: u32) -> windows::core::Result<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType()?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
            t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
            t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, channels * 2)?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * channels * 2)?;
            Ok(t)
        }
    }

    /// Decodes audio to 16-bit PCM at a rate the AAC encoder accepts (44.1/48 kHz, mono/stereo).
    fn setup_audio(reader: &IMFSourceReader) -> Option<AudioSetup> {
        unsafe {
            let native = reader.GetNativeMediaType(AUDIO_STREAM, 0).ok()?;
            let native_rate = native.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(48_000);
            let native_ch = native.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(2).clamp(1, 2);

            // Prefer the native rate when AAC accepts it, otherwise ask the reader to resample
            let rates: &[u32] = if matches!(native_rate, 44_100 | 48_000) {
                &[native_rate, 48_000]
            } else {
                &[48_000, 44_100]
            };
            for &rate in rates {
                for ch in [native_ch, 2] {
                    let Ok(pcm) = pcm_type(rate, ch) else { continue };
                    if reader.SetCurrentMediaType(AUDIO_STREAM, None, &pcm).is_err() {
                        continue;
                    }
                    let Ok(in_type) = reader.GetCurrentMediaType(AUDIO_STREAM) else { continue };
                    let Ok(out_type) = MFCreateMediaType() else { continue };
                    let ok = out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).is_ok()
                        && out_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).is_ok()
                        && out_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).is_ok()
                        && out_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).is_ok()
                        && out_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, ch).is_ok()
                        // 24000 B/s = 192 kbps
                        && out_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000).is_ok();
                    if ok {
                        return Some(AudioSetup { out_type, in_type });
                    }
                }
            }
            None
        }
    }

    /// Re-encodes `input` to an H.264/AAC MP4 at `output`.
    pub fn transcode(
        input: &str,
        output: &Path,
        progress: &mut dyn FnMut(f64),
        cancelled: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        let _mf = MfSession::start()?;
        let reader = open_reader(input)?;
        let duration = duration_100ns(&reader);

        unsafe {
            reader.SetStreamSelection(ALL_STREAMS, false).map_err(|e| e.to_string())?;
            let _ = reader.SetStreamSelection(VIDEO_STREAM, true);
            let _ = reader.SetStreamSelection(AUDIO_STREAM, true);
        }

        let video = setup_video(&reader)?;
        let audio = setup_audio(&reader);
        if video.is_none() && audio.is_none() {
            return Err("Dosyada çözülebilir video veya ses akışı bulunamadı".into());
        }
        unsafe {
            if video.is_none() {
                let _ = reader.SetStreamSelection(VIDEO_STREAM, false);
            }
            if audio.is_none() {
                let _ = reader.SetStreamSelection(AUDIO_STREAM, false);
            }
        }

        let writer = unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 2).map_err(|e| e.to_string())?;
            let attrs = attrs.ok_or("MFCreateAttributes")?;
            attrs
                .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
                .map_err(|e| e.to_string())?;
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(|e| e.to_string())?;
            MFCreateSinkWriterFromURL(&HSTRING::from(output.as_os_str()), None, &attrs)
                .map_err(|e| format!("Çıktı dosyası oluşturulamadı: {e}"))?
        };

        // reader stream index -> writer stream index
        let mut video_sink = None;
        let mut audio_sink = None;
        unsafe {
            if let Some(v) = &video {
                let idx = writer.AddStream(&v.out_type).map_err(|e| format!("H.264 kodlayıcı: {e}"))?;
                writer
                    .SetInputMediaType(idx, &v.in_type, None)
                    .map_err(|e| format!("H.264 giriş türü: {e}"))?;
                video_sink = Some(idx);
            }
            if let Some(a) = &audio {
                let idx = writer.AddStream(&a.out_type).map_err(|e| format!("AAC kodlayıcı: {e}"))?;
                writer
                    .SetInputMediaType(idx, &a.in_type, None)
                    .map_err(|e| format!("AAC giriş türü: {e}"))?;
                audio_sink = Some(idx);
            }
            writer.BeginWriting().map_err(|e| e.to_string())?;
        }

        let mut video_done = video_sink.is_none();
        let mut audio_done = audio_sink.is_none();
        let mut last_reported = -1.0;

        while !(video_done && audio_done) {
            if cancelled() {
                return Err("cancelled".into());
            }
            let mut stream_index = 0u32;
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                reader
                    .ReadSample(
                        ANY_STREAM,
                        0,
                        Some(&mut stream_index),
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .map_err(|e| format!("Okuma hatası: {e}"))?;
            }

            let (sink, done) = match (video_sink, audio_sink) {
                (Some(v), _) if is_stream(&reader, stream_index, VIDEO_STREAM) => (v, &mut video_done),
                (_, Some(a)) if is_stream(&reader, stream_index, AUDIO_STREAM) => (a, &mut audio_done),
                _ => continue,
            };

            if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                return Err("Kaynak okunurken hata oluştu".into());
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                *done = true;
                continue;
            }
            unsafe {
                if flags & MF_SOURCE_READERF_STREAMTICK.0 as u32 != 0 {
                    let _ = writer.SendStreamTick(sink, timestamp);
                }
                if let Some(s) = &sample {
                    writer.WriteSample(sink, s).map_err(|e| format!("Yazma hatası: {e}"))?;
                }
            }

            if duration > 0 {
                let p = (timestamp.max(0) as f64 / duration as f64).clamp(0.0, 0.99);
                if p - last_reported >= 0.01 {
                    last_reported = p;
                    progress(p);
                }
            }
        }

        unsafe {
            writer.Finalize().map_err(|e| format!("Dosya tamamlanamadı: {e}"))?;
        }
        progress(1.0);
        Ok(())
    }

    /// The reader reports real stream indices; map them back to "first video/audio".
    fn is_stream(reader: &IMFSourceReader, actual: u32, wanted: u32) -> bool {
        unsafe {
            let Ok(t) = reader.GetCurrentMediaType(actual) else { return false };
            let Ok(major) = t.GetGUID(&MF_MT_MAJOR_TYPE) else { return false };
            if wanted == VIDEO_STREAM {
                major == MFMediaType_Video
            } else {
                major == MFMediaType_Audio
            }
        }
    }
}
