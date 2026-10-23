//! Synthetic test clips for VHO, written with the Windows Media Foundation SinkWriter
//! (encoders that ship with Windows, no third-party media or binaries):
//!
//!   sample-h264.mp4   3 s, 320x240 @ 30 fps H.264 + 48 kHz stereo AAC (Chromium plays it)
//!   legacy-wmv9.wmv   3 s, 320x240 @ 30 fps WMV9 (+ WMA when available) in ASF:
//!                     Chromium cannot demux/decode it -> exercises VHO's transcode path
//!
//! Usage: vho-fixture-gen <output-dir>

#[cfg(not(windows))]
fn main() {
    eprintln!("vho-fixture-gen needs Windows Media Foundation");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    if let Err(e) = win::run(std::path::Path::new(&dir)) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod win {
    use std::path::Path;
    use windows::core::{GUID, HSTRING, Interface};
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

    const W: u32 = 320;
    const H: u32 = 240;
    const FPS: u32 = 30;
    const SECONDS: u32 = 3;
    const FRAME_100NS: i64 = 10_000_000 / FPS as i64;
    const RATE: u32 = 48_000;
    const CHANNELS: u32 = 2;
    const AUDIO_CHUNK: u32 = RATE / 10; // 100 ms of PCM per sample

    type Res<T> = Result<T, String>;

    fn e<E: std::fmt::Display>(ctx: &'static str) -> impl Fn(E) -> String {
        move |err| format!("{ctx}: {err}")
    }

    const fn pack(hi: u32, lo: u32) -> u64 {
        ((hi as u64) << 32) | lo as u64
    }

    pub fn run(dir: &Path) -> Res<()> {
        std::fs::create_dir_all(dir).map_err(e("create dir"))?;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(e("MFStartup"))?;
        }
        write_clip(&dir.join("sample-h264.mp4"), &MFVideoFormat_H264, Some(AudioOut::Aac))?;
        // WMA is optional: the clip only has to be undecodable by Chromium
        let wmv = dir.join("legacy-wmv9.wmv");
        if let Err(err) = write_clip(&wmv, &MFVideoFormat_WMV3, Some(AudioOut::Wma)) {
            eprintln!("WMV9 + WMA failed ({err}); writing video-only WMV9");
            write_clip(&wmv, &MFVideoFormat_WMV3, None)?;
        }
        unsafe {
            let _ = MFShutdown();
        }
        Ok(())
    }

    #[derive(Clone, Copy)]
    enum AudioOut {
        Aac,
        Wma,
    }

    // ---- synthetic content -------------------------------------------------

    /// BT.601 limited-range RGB -> YUV.
    fn yuv(r: f32, g: f32, b: f32) -> (u8, u8, u8) {
        let y = 16.0 + 65.481 * r + 128.553 * g + 24.966 * b;
        let u = 128.0 - 37.797 * r - 74.203 * g + 112.0 * b;
        let v = 128.0 + 112.0 * r - 93.786 * g - 18.214 * b;
        (y as u8, u as u8, v as u8)
    }

    /// Colour bars with a white square moving left to right (frame-dependent picture).
    fn pixel(x: u32, y: u32, frame: u32) -> (u8, u8, u8) {
        const BARS: [(f32, f32, f32); 8] = [
            (0.75, 0.75, 0.75), (0.75, 0.75, 0.0), (0.0, 0.75, 0.75), (0.0, 0.75, 0.0),
            (0.75, 0.0, 0.75), (0.75, 0.0, 0.0), (0.0, 0.0, 0.75), (0.1, 0.1, 0.1),
        ];
        let box_x = frame * (W - 48) / (FPS * SECONDS);
        if x >= box_x && x < box_x + 48 && (96..144).contains(&y) {
            return yuv(1.0, 1.0, 1.0);
        }
        // Bottom strip: one segment per second, so seeks land on visibly different pictures
        if y >= H - 24 {
            let second = frame / FPS;
            return if x / (W / SECONDS) == second { yuv(1.0, 0.4, 0.0) } else { yuv(0.0, 0.0, 0.0) };
        }
        let (r, g, b) = BARS[(x * 8 / W) as usize];
        yuv(r, g, b)
    }

    /// NV12 frame: Y plane then interleaved UV at half resolution.
    fn nv12_frame(frame: u32) -> Vec<u8> {
        let mut buf = vec![0u8; (W * H * 3 / 2) as usize];
        let (luma, chroma) = buf.split_at_mut((W * H) as usize);
        for y in 0..H {
            for x in 0..W {
                luma[(y * W + x) as usize] = pixel(x, y, frame).0;
            }
        }
        for y in 0..H / 2 {
            for x in 0..W / 2 {
                let (_, u, v) = pixel(x * 2, y * 2, frame);
                let i = (y * W + x * 2) as usize;
                chroma[i] = u;
                chroma[i + 1] = v;
            }
        }
        buf
    }

    /// 16-bit stereo PCM: 440 Hz left, 660 Hz right, at -12 dBFS.
    fn pcm_chunk(first_frame: u32, frames: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity((frames * CHANNELS * 2) as usize);
        for i in first_frame..first_frame + frames {
            let t = i as f32 / RATE as f32;
            for hz in [440.0f32, 660.0] {
                let s = (t * hz * std::f32::consts::TAU).sin() * 0.25 * i16::MAX as f32;
                out.extend_from_slice(&(s as i16).to_le_bytes());
            }
        }
        out
    }

    // ---- Media Foundation plumbing ----------------------------------------

    fn video_type(subtype: &GUID, encoded: bool) -> Res<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType().map_err(e("MFCreateMediaType"))?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(e("major"))?;
            t.SetGUID(&MF_MT_SUBTYPE, subtype).map_err(e("subtype"))?;
            t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(e("interlace"))?;
            t.SetUINT64(&MF_MT_FRAME_SIZE, pack(W, H)).map_err(e("frame size"))?;
            t.SetUINT64(&MF_MT_FRAME_RATE, pack(FPS, 1)).map_err(e("frame rate"))?;
            t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)).map_err(e("par"))?;
            if encoded {
                t.SetUINT32(&MF_MT_AVG_BITRATE, 300_000).map_err(e("bitrate"))?;
            } else {
                t.SetUINT32(&MF_MT_DEFAULT_STRIDE, W).map_err(e("stride"))?;
            }
            Ok(t)
        }
    }

    fn pcm_type() -> Res<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType().map_err(e("MFCreateMediaType"))?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(e("major"))?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(e("subtype"))?;
            t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(e("bits"))?;
            t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE).map_err(e("rate"))?;
            t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS).map_err(e("channels"))?;
            t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, CHANNELS * 2).map_err(e("align"))?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE * CHANNELS * 2).map_err(e("bytes/s"))?;
            Ok(t)
        }
    }

    fn aac_type() -> Res<IMFMediaType> {
        unsafe {
            let t = MFCreateMediaType().map_err(e("MFCreateMediaType"))?;
            t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(e("major"))?;
            t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(e("subtype"))?;
            t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(e("bits"))?;
            t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE).map_err(e("rate"))?;
            t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, CHANNELS).map_err(e("channels"))?;
            t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 12_000).map_err(e("bytes/s"))?; // 96 kbps
            Ok(t)
        }
    }

    /// First WMA (v8) output type the encoder offers for 48 kHz stereo.
    fn wma_type() -> Res<IMFMediaType> {
        unsafe {
            let types = MFTranscodeGetAudioOutputAvailableTypes(&MFAudioFormat_WMAudioV8, MFT_ENUM_FLAG_ALL.0 as u32, None)
                .map_err(e("WMA output types"))?;
            let n = types.GetElementCount().map_err(e("count"))?;
            for i in 0..n {
                let Ok(t) = types.GetElement(i).and_then(|u| u.cast::<IMFMediaType>()) else { continue };
                let rate = t.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(0);
                let ch = t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(0);
                if rate == RATE && ch == CHANNELS {
                    return Ok(t);
                }
            }
            Err("no 48 kHz stereo WMA type".into())
        }
    }

    fn sample(data: &[u8], time: i64, duration: i64) -> Res<IMFSample> {
        unsafe {
            let buf = MFCreateMemoryBuffer(data.len() as u32).map_err(e("buffer"))?;
            let mut ptr = std::ptr::null_mut();
            buf.Lock(&mut ptr, None, None).map_err(e("lock"))?;
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
            buf.Unlock().map_err(e("unlock"))?;
            buf.SetCurrentLength(data.len() as u32).map_err(e("length"))?;
            let s = MFCreateSample().map_err(e("sample"))?;
            s.AddBuffer(&buf).map_err(e("add buffer"))?;
            s.SetSampleTime(time).map_err(e("time"))?;
            s.SetSampleDuration(duration).map_err(e("duration"))?;
            Ok(s)
        }
    }

    fn write_clip(path: &Path, video_subtype: &GUID, audio: Option<AudioOut>) -> Res<()> {
        let _ = std::fs::remove_file(path);
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1).map_err(e("attributes"))?;
            let attrs = attrs.ok_or("attributes")?;
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1).map_err(e("throttling"))?;
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attrs)
                .map_err(e("sink writer"))?;

            let v = writer.AddStream(&video_type(video_subtype, true)?).map_err(e("video encoder"))?;
            writer
                .SetInputMediaType(v, &video_type(&MFVideoFormat_NV12, false)?, None)
                .map_err(e("video input type"))?;

            let a = match audio {
                Some(kind) => {
                    let out = match kind {
                        AudioOut::Aac => aac_type()?,
                        AudioOut::Wma => wma_type()?,
                    };
                    let a = writer.AddStream(&out).map_err(e("audio encoder"))?;
                    writer.SetInputMediaType(a, &pcm_type()?, None).map_err(e("audio input type"))?;
                    Some(a)
                }
                None => None,
            };

            writer.BeginWriting().map_err(e("begin"))?;
            let mut audio_frames_written = 0u32;
            for frame in 0..FPS * SECONDS {
                let t = frame as i64 * FRAME_100NS;
                writer.WriteSample(v, &sample(&nv12_frame(frame), t, FRAME_100NS)?).map_err(e("write video"))?;
                // Keep audio ahead of video by up to one chunk (interleaving for the muxer)
                if let Some(a) = a {
                    let video_end = (frame + 1) as u64 * RATE as u64 / FPS as u64;
                    while (audio_frames_written as u64) < video_end {
                        let at = audio_frames_written as i64 * 10_000_000 / RATE as i64;
                        let dur = AUDIO_CHUNK as i64 * 10_000_000 / RATE as i64;
                        writer
                            .WriteSample(a, &sample(&pcm_chunk(audio_frames_written, AUDIO_CHUNK), at, dur)?)
                            .map_err(e("write audio"))?;
                        audio_frames_written += AUDIO_CHUNK;
                    }
                }
            }
            writer.Finalize().map_err(e("finalize"))?;
        }
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        println!("{} ({len} bytes)", path.display());
        Ok(())
    }
}
