//! Music tags, cover art, lyrics and ReplayGain values through `lofty` (MIT OR Apache-2.0):
//! ID3v2 (MP3), Vorbis comments (FLAC/Opus/Ogg), MP4 ilst (M4A), APE, RIFF INFO...

use std::path::{Path, PathBuf};

use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{Accessor, ItemKey, Tag, TagExt};
use serde::{Deserialize, Serialize};

use super::ffmpeg::Loudness;
use super::ERR_UNSUPPORTED;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    pub mime: String,
    pub size: usize,
    /// data: URL for the editor preview (omitted for very large pictures)
    pub data_url: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagData {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub track_total: Option<u32>,
    pub disc: Option<u32>,
    pub comment: String,
    pub lyrics: String,
    pub replaygain_track_gain: String,
    pub replaygain_track_peak: String,
    pub replaygain_album_gain: String,
    pub replaygain_album_peak: String,
    pub cover: Option<Cover>,
    pub tag_type: String,
    pub duration: f64,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}

/// Fields to change: None = keep, Some("") = remove.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TagUpdate {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track: Option<String>,
    pub track_total: Option<String>,
    pub disc: Option<String>,
    pub comment: Option<String>,
    pub lyrics: Option<String>,
    /// Image file to embed as the front cover
    pub cover: Option<String>,
    #[serde(default)]
    pub remove_cover: bool,
}

const MAX_PREVIEW: usize = 4 * 1024 * 1024;

fn text(tag: &Tag, key: &ItemKey) -> String {
    tag.get_string(key).unwrap_or("").to_string()
}

fn mime_str(m: Option<&MimeType>) -> String {
    m.map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into())
}

/// Tag -> UI fields (pure; unit tested together with `apply_update`).
pub fn tag_to_data(tag: &Tag) -> TagData {
    let pic = tag
        .pictures()
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first());
    TagData {
        title: tag.title().map(|s| s.into_owned()).unwrap_or_default(),
        artist: tag.artist().map(|s| s.into_owned()).unwrap_or_default(),
        album: tag.album().map(|s| s.into_owned()).unwrap_or_default(),
        album_artist: text(tag, &ItemKey::AlbumArtist),
        genre: tag.genre().map(|s| s.into_owned()).unwrap_or_default(),
        year: tag.year(),
        track: tag.track(),
        track_total: tag.track_total(),
        disc: tag.disk(),
        comment: tag.comment().map(|s| s.into_owned()).unwrap_or_default(),
        lyrics: text(tag, &ItemKey::Lyrics),
        replaygain_track_gain: text(tag, &ItemKey::ReplayGainTrackGain),
        replaygain_track_peak: text(tag, &ItemKey::ReplayGainTrackPeak),
        replaygain_album_gain: text(tag, &ItemKey::ReplayGainAlbumGain),
        replaygain_album_peak: text(tag, &ItemKey::ReplayGainAlbumPeak),
        cover: pic.map(|p| {
            let mime = mime_str(p.mime_type());
            Cover {
                size: p.data().len(),
                data_url: (p.data().len() <= MAX_PREVIEW).then(|| format!("data:{mime};base64,{}", crate::engine::base64(p.data()))),
                mime,
            }
        }),
        tag_type: format!("{:?}", tag.tag_type()),
        ..Default::default()
    }
}

fn parse_num(v: &str, what: &str) -> Result<Option<u32>, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(None);
    }
    // "3/12" track notation: the first number
    let first = v.split('/').next().unwrap_or("").trim();
    first.parse::<u32>().map(Some).map_err(|_| format!("[invalid] {what} bir sayı olmalı: {v}"))
}

/// Applies an update to a tag (pure: no file access except reading the cover image).
pub fn apply_update(tag: &mut Tag, u: &TagUpdate, cover: Option<Picture>) -> Result<(), String> {
    fn set_or_remove(tag: &mut Tag, v: &Option<String>, set: fn(&mut Tag, String), remove: fn(&mut Tag)) {
        if let Some(v) = v {
            if v.trim().is_empty() { remove(tag) } else { set(tag, v.trim().to_string()) }
        }
    }
    set_or_remove(tag, &u.title, |t, v| t.set_title(v), |t| t.remove_title());
    set_or_remove(tag, &u.artist, |t, v| t.set_artist(v), |t| t.remove_artist());
    set_or_remove(tag, &u.album, |t, v| t.set_album(v), |t| t.remove_album());
    set_or_remove(tag, &u.genre, |t, v| t.set_genre(v), |t| t.remove_genre());
    set_or_remove(tag, &u.comment, |t, v| t.set_comment(v), |t| t.remove_comment());
    for (v, key) in [(&u.album_artist, ItemKey::AlbumArtist), (&u.lyrics, ItemKey::Lyrics)] {
        if let Some(v) = v {
            if v.trim().is_empty() {
                tag.remove_key(&key);
            } else {
                // lyrics keep their line breaks; other fields are trimmed
                let value = if key == ItemKey::Lyrics { v.replace("\r\n", "\n") } else { v.trim().to_string() };
                tag.insert_text(key, value);
            }
        }
    }
    let nums: [(&Option<String>, &str, fn(&mut Tag, u32), fn(&mut Tag)); 4] = [
        (&u.year, "Yıl", |t, n| t.set_year(n), |t| t.remove_year()),
        (&u.track, "Parça no", |t, n| t.set_track(n), |t| t.remove_track()),
        (&u.track_total, "Parça sayısı", |t, n| t.set_track_total(n), |t| t.remove_track_total()),
        (&u.disc, "Disk no", |t, n| t.set_disk(n), |t| t.remove_disk()),
    ];
    for (v, what, set, remove) in nums {
        if let Some(v) = v {
            match parse_num(v, what)? {
                Some(n) => set(tag, n),
                None => remove(tag),
            }
        }
    }
    if u.remove_cover {
        while !tag.pictures().is_empty() {
            tag.remove_picture(0);
        }
    }
    if let Some(pic) = cover {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(pic);
    }
    Ok(())
}

fn open(path: &Path) -> Result<TaggedFile, String> {
    lofty::read_from_path(path).map_err(|e| format!("{ERR_UNSUPPORTED} Etiketler okunamadı: {e}"))
}

pub fn read(path: &Path) -> Result<TagData, String> {
    let file = open(path)?;
    let mut data = file
        .primary_tag()
        .or_else(|| file.first_tag())
        .map(tag_to_data)
        .unwrap_or_else(|| TagData { tag_type: format!("{:?}", file.primary_tag_type()), ..Default::default() });
    let p = file.properties();
    data.duration = p.duration().as_secs_f64();
    data.bitrate = p.audio_bitrate();
    data.sample_rate = p.sample_rate();
    data.channels = p.channels();
    Ok(data)
}

fn load_cover(path: &Path) -> Result<Picture, String> {
    let data = std::fs::read(path).map_err(|e| format!("Kapak okunamadı: {e}"))?;
    let mime = match image::guess_format(&data) {
        Ok(image::ImageFormat::Jpeg) => MimeType::Jpeg,
        Ok(image::ImageFormat::Png) => MimeType::Png,
        Ok(image::ImageFormat::Gif) => MimeType::Gif,
        Ok(image::ImageFormat::Bmp) => MimeType::Bmp,
        _ => {
            // anything else (WebP, HEIC...) is re-encoded as JPEG for player compatibility
            let img = crate::photo::decode::decode(path, Some(1200))?.image;
            let bytes = crate::photo::ops::encode(&img, crate::photo::ops::OutFormat::Jpeg, 90, None)?;
            return Ok(Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Jpeg), None, bytes));
        }
    };
    Ok(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, data))
}

/// Tag of the file's primary type, created when missing.
fn primary_tag_mut(file: &mut TaggedFile) -> &mut Tag {
    if file.primary_tag().is_none() {
        let tt = file.primary_tag_type();
        file.insert_tag(Tag::new(tt));
    }
    file.primary_tag_mut().expect("primary tag inserted")
}

pub fn write(path: &Path, u: &TagUpdate) -> Result<(), String> {
    let cover = u.cover.as_deref().filter(|c| !c.is_empty()).map(|c| load_cover(Path::new(c))).transpose()?;
    let mut file = open(path)?;
    let tag = primary_tag_mut(&mut file);
    apply_update(tag, u, cover)?;
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("Etiketler yazılamadı: {e}"))
}

/// Album ReplayGain tags (gain in dB, linear sample peak) next to the track values.
pub fn write_replaygain_album(path: &Path, album_gain_db: f64, album_peak: f64) -> Result<(), String> {
    let mut file = open(path)?;
    let tag = primary_tag_mut(&mut file);
    tag.insert_text(ItemKey::ReplayGainAlbumGain, format!("{album_gain_db:.2} dB"));
    tag.insert_text(ItemKey::ReplayGainAlbumPeak, format!("{album_peak:.6}"));
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("Etiketler yazılamadı: {e}"))
}

pub fn write_replaygain(path: &Path, l: &Loudness) -> Result<(), String> {
    let mut file = open(path)?;
    let tag = primary_tag_mut(&mut file);
    tag.insert_text(ItemKey::ReplayGainTrackGain, format!("{:.2} dB", l.track_gain_db));
    tag.insert_text(ItemKey::ReplayGainTrackPeak, format!("{:.6}", l.track_peak));
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("Etiketler yazılamadı: {e}"))
}

pub fn save_cover(path: &Path, output: &Path) -> Result<PathBuf, String> {
    let file = open(path)?;
    let tag = file.primary_tag().or_else(|| file.first_tag()).ok_or("Dosyada kapak yok")?;
    let pic = tag
        .pictures()
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first())
        .ok_or("Dosyada kapak yok")?;
    let ext = match pic.mime_type() {
        Some(MimeType::Png) => "png",
        Some(MimeType::Gif) => "gif",
        Some(MimeType::Bmp) => "bmp",
        _ => "jpg",
    };
    let out = output.with_extension(ext);
    crate::photo::write_atomic(&out, pic.data())?;
    Ok(out)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub text: String,
    /// "lrc" (side file) or "embedded"
    pub source: String,
    pub path: Option<String>,
}

/// UTF-8 (BOM stripped) or Windows-1254 (Turkish) text.
pub fn decode_text(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b
            .iter()
            .map(|&c| match c {
                0xD0 => 'Ğ',
                0xDD => 'İ',
                0xDE => 'Ş',
                0xF0 => 'ğ',
                0xFD => 'ı',
                0xFE => 'ş',
                c => c as char, // Latin-1 for the rest (ç, ö, ü, Ç, Ö, Ü match)
            })
            .collect(),
    }
}

/// `.lrc` with the same stem next to the file (any case of the extension).
pub fn lrc_path(path: &Path) -> Option<PathBuf> {
    let dir = path.parent()?;
    let stem = path.file_stem()?.to_string_lossy().to_lowercase();
    let direct = path.with_extension("lrc");
    if direct.is_file() {
        return Some(direct);
    }
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("lrc"))
            && p.file_stem().is_some_and(|s| s.to_string_lossy().to_lowercase() == stem)
    })
}

pub fn lyrics(path: &Path) -> Result<Option<Lyrics>, String> {
    if let Some(lrc) = lrc_path(path) {
        let bytes = std::fs::read(&lrc).map_err(|e| e.to_string())?;
        return Ok(Some(Lyrics { text: decode_text(&bytes), source: "lrc".into(), path: Some(lrc.to_string_lossy().into_owned()) }));
    }
    let Ok(file) = lofty::read_from_path(path) else { return Ok(None) };
    let embedded = file.tags().iter().find_map(|t| t.get_string(&ItemKey::Lyrics).filter(|s| !s.trim().is_empty()).map(str::to_string));
    Ok(embedded.map(|text| Lyrics { text, source: "embedded".into(), path: None }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::tag::TagType;

    fn upd() -> TagUpdate {
        TagUpdate {
            title: Some("Uzun İnce Bir Yoldayım".into()),
            artist: Some("Âşık Veysel".into()),
            album: Some("Türküler".into()),
            album_artist: Some("Çeşitli".into()),
            genre: Some("Halk".into()),
            year: Some("1970".into()),
            track: Some("3/12".into()),
            track_total: Some("12".into()),
            disc: Some("1".into()),
            comment: Some("not".into()),
            lyrics: Some("[00:01.00]Uzun ince\r\n[00:05.50]bir yoldayım".into()),
            ..Default::default()
        }
    }

    #[test]
    fn update_maps_every_field_for_each_tag_format() {
        for tt in [TagType::Id3v2, TagType::VorbisComments, TagType::Mp4Ilst, TagType::Ape] {
            let mut tag = Tag::new(tt);
            let cover = Picture::new_unchecked(PictureType::CoverFront, Some(MimeType::Png), None, vec![1, 2, 3]);
            apply_update(&mut tag, &upd(), Some(cover)).unwrap();
            let d = tag_to_data(&tag);
            assert_eq!(d.title, "Uzun İnce Bir Yoldayım", "{tt:?}");
            assert_eq!(d.artist, "Âşık Veysel");
            assert_eq!(d.album, "Türküler");
            assert_eq!(d.album_artist, "Çeşitli", "{tt:?}");
            assert_eq!(d.genre, "Halk");
            assert_eq!(d.year, Some(1970), "{tt:?}");
            assert_eq!((d.track, d.track_total, d.disc), (Some(3), Some(12), Some(1)), "{tt:?}");
            assert_eq!(d.lyrics, "[00:01.00]Uzun ince\n[00:05.50]bir yoldayım", "{tt:?}");
            let c = d.cover.unwrap();
            assert_eq!((c.mime.as_str(), c.size), ("image/png", 3));
            assert_eq!(c.data_url.unwrap(), "data:image/png;base64,AQID");

            // "" removes, None keeps
            let rm = TagUpdate { title: Some(String::new()), year: Some(" ".into()), remove_cover: true, ..Default::default() };
            apply_update(&mut tag, &rm, None).unwrap();
            let d = tag_to_data(&tag);
            assert_eq!((d.title.as_str(), d.year, d.cover.is_none()), ("", None, true), "{tt:?}");
            assert_eq!(d.artist, "Âşık Veysel");
        }
    }

    #[test]
    fn invalid_numbers_are_rejected() {
        let mut tag = Tag::new(TagType::Id3v2);
        let e = apply_update(&mut tag, &TagUpdate { year: Some("bin dokuz yüz".into()), ..Default::default() }, None).unwrap_err();
        assert!(e.starts_with("[invalid]"), "{e}");
    }

    #[test]
    fn text_decoding_and_lrc_lookup() {
        assert_eq!(decode_text(b"\xEF\xBB\xBF[00:01]a"), "[00:01]a");
        assert_eq!(decode_text(&[0xDD, 0x73, 0x74, 0x61, 0x6E, 0x62, 0x75, 0x6C, 0x20, 0xFE, 0xF0]), "İstanbul şğ");
        let dir = std::env::temp_dir().join(format!("vho_lrc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let song = dir.join("Şarkı.mp3");
        std::fs::write(&song, b"x").unwrap();
        assert!(lrc_path(&song).is_none());
        std::fs::write(dir.join("şarkı.LRC"), "[00:02.00]söz").unwrap();
        let l = lyrics(&song).unwrap().unwrap();
        assert_eq!((l.text.as_str(), l.source.as_str()), ("[00:02.00]söz", "lrc"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
