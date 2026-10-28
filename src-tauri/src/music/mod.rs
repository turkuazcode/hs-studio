//! Music mode backend (Plan 13/L03): album ReplayGain and the system media controls adapter.
//!
//! ReplayGain policy (documented in docs/music.md):
//! * measurement: EBU R128 integrated loudness (ffmpeg `ebur128`), reference -18 LUFS
//!   (ReplayGain 2.0): gain = -18 - LUFS. The LUFS value itself is never written as a gain.
//! * peaks: REPLAYGAIN_*_PEAK hold the linear SAMPLE peak; the true peak (dBTP) is only shown.
//! * album gain: one joint measurement over all tracks of the album (not a mean of track gains).
//! * playback: libmpv `replaygain` (track/album) + `replaygain-preamp` + `replaygain-clip`
//!   (prevent clipping with the peak); the HTML5 engine applies the same formula
//!   (src/music/music-logic.js `replayGainFactor`).

pub mod controls;

use std::path::Path;

use crate::actions::{ffmpeg, tags};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Measures an album (track + joint album loudness); `write`: stores track and album
/// ReplayGain tags in every file (the caller releases a file the player holds open).
#[tauri::command]
pub async fn replaygain_album(paths: Vec<String>, write: Option<bool>) -> Result<ffmpeg::AlbumLoudness, String> {
    blocking(move || {
        let mut channels = Vec::new();
        let mut durations = Vec::new();
        for p in &paths {
            let t = tags::read(Path::new(p))?;
            channels.push(t.channels.unwrap_or(2) as u32);
            durations.push(t.duration);
        }
        let refs: Vec<&Path> = paths.iter().map(Path::new).collect();
        let album = ffmpeg::album_loudness(&refs, &channels, &durations)?;
        if write.unwrap_or(false) {
            for (p, t) in paths.iter().zip(&album.tracks) {
                tags::write_replaygain(Path::new(p), t)?;
                tags::write_replaygain_album(Path::new(p), album.album_gain_db, album.album_peak)?;
            }
        }
        Ok(album)
    })
    .await
}

#[cfg(test)]
mod tests;
