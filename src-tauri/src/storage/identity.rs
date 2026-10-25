//! Stable file identity helpers.
//!
//! The media identity is the UUID of its `media` row; the path is only its current location.
//! To recognise a moved/renamed file we use, in order of strength:
//! 1. platform file identity (Windows volume serial + file index, Unix device + inode),
//!    valid while the file stays on the same volume;
//! 2. a content hash (computed by the caller only for ambiguous candidates);
//! 3. size + mtime: a fast pre-filter only, never proof — two different files with the
//!    same name and size are never merged on that basis.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Comparable form of a path: separators unified, `.`/`..` resolved lexically, the Windows
/// verbatim prefix removed and (Windows only, case-insensitive file systems) lower-cased.
/// The original spelling is stored separately (`media.path`) for display and opening.
pub fn normalize_path(path: &str) -> String {
    let mut s = path.trim().to_string();
    if cfg!(windows) {
        s = s.replace('/', "\\");
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            s = format!(r"\\{rest}");
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            s = rest.to_string();
        }
    }
    let mut out = PathBuf::new();
    for c in Path::new(&s).components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // never climb above the root / prefix
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    let mut n = out.to_string_lossy().into_owned();
    if cfg!(windows) {
        n = n.to_lowercase();
    }
    if n.is_empty() { s } else { n }
}

/// What the file system tells us about a file right now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileIdentity {
    pub path_norm: String,
    pub size: Option<u64>,
    pub mtime_ns: Option<i64>,
    /// Platform volume id (Windows volume serial number / Unix st_dev), hex.
    pub volume_id: Option<String>,
    /// Platform file id on that volume (Windows file index / Unix inode), hex.
    pub file_id: Option<String>,
}

impl FileIdentity {
    /// Reads the identity of an existing file (None when it cannot be read).
    pub fn of(path: &str) -> Option<FileIdentity> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_nanos()).ok());
        let (volume_id, file_id) = platform_file_id(path, &meta).unzip();
        Some(FileIdentity { path_norm: normalize_path(path), size: Some(meta.len()), mtime_ns, volume_id, file_id })
    }
}

#[cfg(windows)]
fn platform_file_id(path: &str, _meta: &std::fs::Metadata) -> Option<(String, String)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFileInformationByHandle,
    };
    // metadata-only open: no read access, every share mode (a playing/locked file still works)
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: valid handle owned by `file` for the duration of the call, `info` is writable
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Some((format!("{:08x}", info.dwVolumeSerialNumber), format!("{index:016x}")))
}

#[cfg(unix)]
fn platform_file_id(_path: &str, meta: &std::fs::Metadata) -> Option<(String, String)> {
    use std::os::unix::fs::MetadataExt;
    Some((format!("{:x}", meta.dev()), format!("{:x}", meta.ino())))
}

#[cfg(not(any(windows, unix)))]
fn platform_file_id(_path: &str, _meta: &std::fs::Metadata) -> Option<(String, String)> {
    None
}

/// A stored media row's identity fields (as read from the database).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub media_id: String,
    pub name: String,
    pub size: Option<u64>,
    pub mtime_ns: Option<i64>,
    pub volume_id: Option<String>,
    pub file_id: Option<String>,
    pub content_hash: Option<String>,
}

/// Outcome of looking for the previous record of a file found at a new path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveMatch {
    /// Proven to be the same file (platform file id, or equal content hash).
    Same(String),
    /// Plausible but unproven (size+mtime only, or several candidates): ask for a content
    /// hash or let the user decide. Never merged automatically.
    Ambiguous(Vec<String>),
    None,
}

/// Decides whether `found` (a file at a new location) is one of the `missing` media rows.
/// `found_hash` is an optional content hash of the new file.
pub fn match_moved(found: &FileIdentity, found_hash: Option<&str>, missing: &[Candidate]) -> MoveMatch {
    // 1. platform file identity on the same volume
    if let (Some(vol), Some(fid)) = (&found.volume_id, &found.file_id) {
        let hits: Vec<_> = missing
            .iter()
            .filter(|c| c.volume_id.as_ref() == Some(vol) && c.file_id.as_ref() == Some(fid) && c.size == found.size)
            .collect();
        if hits.len() == 1 {
            return MoveMatch::Same(hits[0].media_id.clone());
        }
    }
    // 2. equal content hash (and size)
    if let Some(h) = found_hash {
        let hits: Vec<_> =
            missing.iter().filter(|c| c.content_hash.as_deref() == Some(h) && c.size == found.size).collect();
        if hits.len() == 1 {
            return MoveMatch::Same(hits[0].media_id.clone());
        }
        if hits.len() > 1 {
            return MoveMatch::Ambiguous(hits.iter().map(|c| c.media_id.clone()).collect());
        }
    }
    // 3. size + mtime: only a hint
    let hints: Vec<_> = missing
        .iter()
        .filter(|c| c.size.is_some() && c.size == found.size && c.mtime_ns.is_some() && c.mtime_ns == found.mtime_ns)
        .map(|c| c.media_id.clone())
        .collect();
    if hints.is_empty() { MoveMatch::None } else { MoveMatch::Ambiguous(hints) }
}

/// Camera capture time as stored in `media.taken_*`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureTime {
    /// Local wall-clock time as recorded ("YYYY-MM-DDTHH:MM:SS").
    pub local: String,
    /// UTC offset in minutes when the file states it (EXIF OffsetTimeOriginal); None = unknown.
    pub offset_min: Option<i32>,
}

impl CaptureTime {
    /// Parses EXIF "YYYY:MM:DD HH:MM:SS" (+ optional "+03:00" offset). An absent offset stays
    /// unknown: it is NOT treated as UTC.
    pub fn from_exif(datetime: &str, offset: Option<&str>) -> Option<CaptureTime> {
        let d = datetime.trim();
        let b = d.as_bytes();
        if b.len() < 19 || b[4] != b':' || b[7] != b':' || b[10] != b' ' || b[13] != b':' || b[16] != b':' {
            return None;
        }
        let digits = [0..4, 5..7, 8..10, 11..13, 14..16, 17..19];
        if digits.iter().any(|r| !b[r.clone()].iter().all(u8::is_ascii_digit)) || d.starts_with("0000") {
            return None;
        }
        let local = format!("{}-{}-{}T{}", &d[0..4], &d[5..7], &d[8..10], &d[11..19]);
        Some(CaptureTime { local, offset_min: offset.and_then(parse_offset) })
    }

    /// Unix milliseconds (UTC), only when the offset is known.
    pub fn utc_ms(&self) -> Option<i64> {
        let off = self.offset_min?;
        let b = self.local.as_bytes();
        let num = |r: std::ops::Range<usize>| self.local.get(r)?.parse::<i64>().ok();
        let (y, mo, d, h, mi, s) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
        if b.len() < 19 || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
            return None;
        }
        let days = days_from_civil(y, mo, d);
        let secs = days * 86400 + h * 3600 + mi * 60 + s - off as i64 * 60;
        Some(secs * 1000)
    }
}

fn parse_offset(s: &str) -> Option<i32> {
    let s = s.trim();
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let (h, m) = rest.split_once(':')?;
    let (h, m): (i32, i32) = (h.parse().ok()?, m.parse().ok()?);
    if h > 14 || m > 59 {
        return None;
    }
    Some(sign * (h * 60 + m))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize() {
        if cfg!(windows) {
            assert_eq!(normalize_path(r"C:\Videos\.\A\..\Film.MKV"), r"c:\videos\film.mkv");
            assert_eq!(normalize_path("C:/Videos/Film.mkv"), r"c:\videos\film.mkv");
            assert_eq!(normalize_path(r"\\?\C:\Videos\Film.mkv"), r"c:\videos\film.mkv");
            assert_eq!(normalize_path(r"\\?\UNC\nas\share\a.mp4"), r"\\nas\share\a.mp4");
            assert_eq!(normalize_path(r"C:\..\x.mp4"), r"c:\x.mp4");
            assert_eq!(normalize_path(r"C:\Müzik\Şarkı.mp3"), r"c:\müzik\şarkı.mp3");
        } else {
            assert_eq!(normalize_path("/home/u/./A/../Film.MKV"), "/home/u/Film.MKV");
        }
    }

    fn cand(id: &str, size: u64, mtime: i64, vol: Option<&str>, fid: Option<&str>, hash: Option<&str>) -> Candidate {
        Candidate {
            media_id: id.into(),
            name: "clip.mp4".into(),
            size: Some(size),
            mtime_ns: Some(mtime),
            volume_id: vol.map(Into::into),
            file_id: fid.map(Into::into),
            content_hash: hash.map(Into::into),
        }
    }

    fn found(size: u64, mtime: i64, vol: Option<&str>, fid: Option<&str>) -> FileIdentity {
        FileIdentity {
            path_norm: "new".into(),
            size: Some(size),
            mtime_ns: Some(mtime),
            volume_id: vol.map(Into::into),
            file_id: fid.map(Into::into),
        }
    }

    #[test]
    fn file_id_proves_a_move() {
        let missing = [cand("a", 10, 1, Some("v"), Some("1"), None), cand("b", 10, 1, Some("v"), Some("2"), None)];
        assert_eq!(match_moved(&found(10, 1, Some("v"), Some("2")), None, &missing), MoveMatch::Same("b".into()));
    }

    #[test]
    fn same_name_and_size_is_never_merged_automatically() {
        // two different files, same name/size/mtime, no platform id (e.g. other volume)
        let missing = [cand("a", 10, 5, None, None, None)];
        assert_eq!(match_moved(&found(10, 5, None, None), None, &missing), MoveMatch::Ambiguous(vec!["a".into()]));
        // a different file id on the same volume is a different file even with equal size/mtime
        let missing = [cand("a", 10, 5, Some("v"), Some("1"), None)];
        assert!(matches!(match_moved(&found(10, 5, Some("v"), Some("9")), None, &missing), MoveMatch::Ambiguous(_)));
        // a hash that differs settles it: no match
        let missing = [cand("a", 10, 5, None, None, Some("h1"))];
        assert_eq!(match_moved(&found(10, 5, None, None), Some("h2"), &missing), MoveMatch::Ambiguous(vec!["a".into()]));
        assert_eq!(match_moved(&found(11, 5, None, None), Some("h2"), &missing), MoveMatch::None);
    }

    #[test]
    fn hash_resolves_ambiguity() {
        let missing = [cand("a", 10, 5, None, None, Some("h1")), cand("b", 10, 5, None, None, Some("h2"))];
        assert_eq!(match_moved(&found(10, 5, None, None), Some("h2"), &missing), MoveMatch::Same("b".into()));
    }

    #[test]
    fn real_file_identity() {
        let dir = std::env::temp_dir().join(format!("vho-ident-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, b"12345").unwrap();
        let ia = FileIdentity::of(a.to_str().unwrap()).unwrap();
        assert_eq!(ia.size, Some(5));
        assert!(ia.file_id.is_some() && ia.volume_id.is_some());
        // rename keeps the platform id
        let b = dir.join("b.bin");
        std::fs::rename(&a, &b).unwrap();
        let ib = FileIdentity::of(b.to_str().unwrap()).unwrap();
        assert_eq!((ia.volume_id.clone(), ia.file_id.clone()), (ib.volume_id.clone(), ib.file_id.clone()));
        assert_ne!(ia.path_norm, ib.path_norm);
        // a copy with the same content and size is a different file
        let c = dir.join("c.bin");
        std::fs::copy(&b, &c).unwrap();
        let ic = FileIdentity::of(c.to_str().unwrap()).unwrap();
        assert_ne!(ib.file_id, ic.file_id);
        assert!(FileIdentity::of(dir.join("none").to_str().unwrap()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn capture_time_keeps_unknown_offset_unknown() {
        let t = CaptureTime::from_exif("2024:07:01 14:30:05", None).unwrap();
        assert_eq!(t.local, "2024-07-01T14:30:05");
        assert_eq!(t.offset_min, None);
        assert_eq!(t.utc_ms(), None, "unknown offset must not become UTC");
        let t = CaptureTime::from_exif("2024:07:01 14:30:05", Some("+03:00")).unwrap();
        assert_eq!(t.offset_min, Some(180));
        // 2024-07-01T11:30:05Z
        assert_eq!(t.utc_ms(), Some(1_719_833_405_000));
        assert_eq!(CaptureTime::from_exif("2024:07:01 14:30:05", Some("-05:30")).unwrap().offset_min, Some(-330));
        assert!(CaptureTime::from_exif("0000:00:00 00:00:00", None).is_none());
        assert!(CaptureTime::from_exif("garbage", None).is_none());
        assert_eq!(CaptureTime::from_exif("2024:07:01 14:30:05", Some("bad")).unwrap().offset_min, None);
    }
}
