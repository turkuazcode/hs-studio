//! Folder scanning: lists images (+ optionally videos), sorts them and streams the
//! result in pages so 5,000+ file folders render progressively.

use std::cmp::Ordering;
use std::path::Path;
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use super::{decode, exif, ext_lower, raw, ERR_CANCELLED};

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortKey {
    /// Natural, case-insensitive file name order ("IMG_2" < "IMG_10")
    #[default]
    Name,
    /// Modification time
    Date,
    Size,
    /// EXIF capture date (falls back to the modification time)
    ExifDate,
    /// Directory order, streamed while walking (fastest first paint for huge trees)
    None,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    /// Id used in events and for `photo_cancel`; generated when omitted
    pub scan_id: Option<String>,
    pub recursive: bool,
    pub sort: SortKey,
    pub descending: bool,
    pub include_videos: bool,
    /// Include dot-files / hidden folders
    pub include_hidden: bool,
    /// Items per `photo-scan-page` event
    pub page_size: usize,
    /// Read EXIF capture dates for every item (always done for `sort: "exifDate"`)
    pub exif_dates: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            scan_id: None,
            recursive: false,
            sort: SortKey::Name,
            descending: false,
            include_videos: false,
            include_hidden: false,
            page_size: 500,
            exif_dates: false,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    pub path: String,
    pub name: String,
    /// Lower-case extension without dot
    pub ext: String,
    /// "image" | "raw" | "heif" | "video"
    pub kind: &'static str,
    pub size: u64,
    /// Modification time, ms since epoch
    pub mtime: i64,
    /// EXIF capture date as local-wall-clock ms since epoch (only when requested)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exif_date: Option<i64>,
    /// The webview can display the original directly (else use photo_decode)
    pub browser_native: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub scan_id: String,
    pub dir: String,
    pub total: usize,
    /// Immediate sub-folders of `dir` (names, natural order), for folder navigation
    pub folders: Vec<String>,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

fn kind_of(ext: &str, include_videos: bool) -> Option<&'static str> {
    if raw::is_raw_ext(ext) {
        Some("raw")
    } else if matches!(ext, "heic" | "heif" | "hif") {
        Some("heif")
    } else if decode::IMAGE_EXTS.contains(&ext) {
        Some("image")
    } else if include_videos && decode::VIDEO_EXTS.contains(&ext) {
        Some("video")
    } else {
        None
    }
}

fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    name.starts_with('.')
}

/// Natural order comparison: digit runs compare numerically, the rest case-insensitively.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = a.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    a.next();
                }
                let mut nb = String::new();
                while let Some(c) = b.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    b.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)).then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

struct Walker<'a> {
    opts: &'a ScanOptions,
    cancelled: &'a dyn Fn() -> bool,
    items: Vec<ScanItem>,
    /// Streaming mode (sort = none): emit pages while walking
    stream: Option<&'a mut dyn FnMut(usize, &[ScanItem])>,
    emitted: usize,
    progress: &'a mut dyn FnMut(&'static str, usize, usize),
    last_progress: usize,
}

impl Walker<'_> {
    fn walk(&mut self, dir: &Path, folders: Option<&mut Vec<String>>, depth: usize) -> Result<(), String> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            // Unreadable sub-folders (permissions) are skipped; the root must be readable
            Err(e) if depth > 0 => {
                let _ = e;
                return Ok(());
            }
            Err(e) => return Err(format!("Klasör okunamadı: {e}")),
        };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            if (self.cancelled)() {
                return Err(ERR_CANCELLED.into());
            }
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            // On Windows this metadata comes from the directory listing (no extra I/O)
            let Ok(meta) = entry.metadata() else { continue };
            if !self.opts.include_hidden && is_hidden(&name, &meta) {
                continue;
            }
            if ft.is_dir() {
                subdirs.push((name, entry.path()));
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let path = entry.path();
            let ext = ext_lower(&path);
            let Some(kind) = kind_of(&ext, self.opts.include_videos) else { continue };
            let browser_native = kind == "video"
                || matches!(ext.as_str(), "jpg" | "jpeg" | "jpe" | "jfif" | "png" | "apng" | "webp" | "gif" | "bmp" | "dib" | "ico" | "avif" | "svg");
            self.items.push(ScanItem {
                path: path.to_string_lossy().into_owned(),
                name,
                ext,
                kind,
                size: meta.len(),
                mtime: super::mtime_ms(&meta),
                exif_date: None,
                browser_native,
            });
            if let Some(emit) = self.stream.as_mut() {
                if self.items.len() - self.emitted >= self.opts.page_size {
                    emit(self.emitted, &self.items[self.emitted..]);
                    self.emitted = self.items.len();
                }
            } else if self.items.len() - self.last_progress >= 1000 {
                self.last_progress = self.items.len();
                (self.progress)("list", self.items.len(), 0);
            }
        }
        subdirs.sort_by(|a, b| natural_cmp(&a.0, &b.0));
        if let Some(f) = folders {
            f.extend(subdirs.iter().map(|(n, _)| n.clone()));
        }
        if self.opts.recursive && depth < 64 {
            for (_, path) in subdirs {
                self.walk(&path, None, depth + 1)?;
            }
        }
        Ok(())
    }
}

fn compare(a: &ScanItem, b: &ScanItem, key: SortKey) -> Ordering {
    let by_name = || natural_cmp(&a.name, &b.name).then_with(|| a.path.cmp(&b.path));
    match key {
        SortKey::Name | SortKey::None => by_name(),
        SortKey::Date => a.mtime.cmp(&b.mtime).then_with(by_name),
        SortKey::Size => a.size.cmp(&b.size).then_with(by_name),
        SortKey::ExifDate => a.exif_date.unwrap_or(a.mtime).cmp(&b.exif_date.unwrap_or(b.mtime)).then_with(by_name),
    }
}

/// Scans `dir`. Pages are delivered through `on_page(offset, items)` in final order;
/// `on_progress(phase, done, total)` reports "list" (files found) and "exif" phases.
pub fn scan(
    dir: &Path,
    opts: &ScanOptions,
    scan_id: &str,
    cancelled: &(dyn Fn() -> bool + Sync),
    on_page: &mut dyn FnMut(usize, &[ScanItem]),
    on_progress: &mut dyn FnMut(&'static str, usize, usize),
) -> Result<ScanSummary, String> {
    let started = Instant::now();
    if !dir.is_dir() {
        return Err("Klasör bulunamadı".into());
    }
    let opts = ScanOptions { page_size: opts.page_size.clamp(1, 10_000), ..opts.clone() };
    let streaming = opts.sort == SortKey::None && !opts.exif_dates;
    let mut folders = Vec::new();
    let summary = |total: usize, folders: Vec<String>, cancelled: bool| ScanSummary {
        scan_id: scan_id.to_string(),
        dir: dir.to_string_lossy().into_owned(),
        total,
        folders,
        cancelled,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };

    let mut walker = Walker {
        opts: &opts,
        cancelled,
        items: Vec::new(),
        stream: if streaming { Some(&mut *on_page) } else { None },
        emitted: 0,
        progress: &mut *on_progress,
        last_progress: 0,
    };
    let walked = walker.walk(dir, Some(&mut folders), 0);
    let (mut items, emitted) = (std::mem::take(&mut walker.items), walker.emitted);
    drop(walker);
    match walked {
        Err(e) if e == ERR_CANCELLED => return Ok(summary(emitted, folders, true)),
        Err(e) => return Err(e),
        Ok(()) => {}
    }

    if streaming {
        if items.len() > emitted {
            on_page(emitted, &items[emitted..]);
        }
        return Ok(summary(items.len(), folders, false));
    }

    if opts.sort == SortKey::ExifDate || opts.exif_dates {
        let total = items.len();
        on_progress("exif", 0, total);
        let done = std::sync::atomic::AtomicUsize::new(0);
        let (tx, rx) = std::sync::mpsc::channel::<usize>();
        // Read dates on all cores while this thread forwards progress
        let worker = |items: &mut Vec<ScanItem>| {
            items.par_iter_mut().for_each_with(tx, |tx, it| {
                if cancelled() {
                    return;
                }
                if it.kind != "video" {
                    it.exif_date = exif::file_date_taken_ms(Path::new(&it.path));
                }
                let d = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                if d % 250 == 0 {
                    let _ = tx.send(d);
                }
            });
        };
        std::thread::scope(|s| {
            let handle = s.spawn(|| worker(&mut items));
            for d in rx {
                on_progress("exif", d, total);
            }
            handle.join().expect("exif worker panicked");
        });
        if cancelled() {
            return Ok(summary(0, folders, true));
        }
        on_progress("exif", total, total);
    }

    let key = opts.sort;
    items.par_sort_by(|a, b| compare(a, b, key));
    if opts.descending {
        items.reverse();
    }
    for (i, page) in items.chunks(opts.page_size).enumerate() {
        if cancelled() {
            return Ok(summary(i * opts.page_size, folders, true));
        }
        on_page(i * opts.page_size, page);
    }
    Ok(summary(items.len(), folders, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photo::testutil::*;

    fn run(dir: &Path, opts: ScanOptions) -> (ScanSummary, Vec<ScanItem>) {
        let mut all: Vec<ScanItem> = Vec::new();
        let mut on_page = |offset: usize, items: &[ScanItem]| {
            assert_eq!(offset, all.len(), "pages arrive in order");
            all.extend_from_slice(items);
        };
        let s = scan(dir, &opts, "t", &|| false, &mut on_page, &mut |_, _, _| {}).unwrap();
        (s, all)
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["IMG_10.jpg", "img_2.jpg", "IMG_1.jpg", "b.jpg", "a10b", "a9b", "IMG_01.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a9b", "a10b", "b.jpg", "IMG_1.jpg", "IMG_01.jpg", "img_2.jpg", "IMG_10.jpg"]);
    }

    #[test]
    fn photo_scan_sorting_recursion_and_paging() {
        let dir = temp_dir("scan");
        std::fs::create_dir_all(dir.join("sub/deeper")).unwrap();
        let tiny = jpeg_bytes(&pattern(8, 8), 80);
        for (name, extra) in [("IMG_10.jpg", 300), ("IMG_2.jpg", 100), ("IMG_1.JPG", 200)] {
            let mut b = tiny.clone();
            b.extend(std::iter::repeat_n(0u8, extra));
            std::fs::write(dir.join(name), b).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        std::fs::write(dir.join("clip.mp4"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.join(".hidden.jpg"), &tiny).unwrap();
        std::fs::write(dir.join("shot.CR2"), b"II*\0").unwrap();
        std::fs::write(dir.join("sub/x.heic"), b"x").unwrap();
        std::fs::write(dir.join("sub/deeper/y.png"), b"x").unwrap();

        let (s, items) = run(&dir, ScanOptions::default());
        let names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["IMG_1.JPG", "IMG_2.jpg", "IMG_10.jpg", "shot.CR2"]);
        assert_eq!(s.total, 4);
        assert_eq!(s.folders, ["sub"]);
        assert_eq!(items[3].kind, "raw");
        assert!(!items[3].browser_native && items[0].browser_native);

        let (_, items) = run(&dir, ScanOptions { sort: SortKey::Size, descending: true, ..Default::default() });
        assert_eq!(items[0].name, "IMG_10.jpg");
        let (_, items) = run(&dir, ScanOptions { sort: SortKey::Date, ..Default::default() });
        assert_eq!(items[0].name, "IMG_10.jpg");
        assert_eq!(items[2].name, "IMG_1.JPG");

        let (s, items) = run(
            &dir,
            ScanOptions { recursive: true, include_videos: true, include_hidden: true, page_size: 2, ..Default::default() },
        );
        assert_eq!(s.total, 8);
        assert!(items.iter().any(|i| i.kind == "heif" && i.name == "x.heic"));
        assert!(items.iter().any(|i| i.kind == "video"));
        assert!(items.iter().any(|i| i.name == "y.png"));

        let (s, items) = run(&dir, ScanOptions { sort: SortKey::None, recursive: true, page_size: 1, ..Default::default() });
        assert_eq!((s.total, items.len()), (6, 6));
    }

    #[test]
    fn photo_scan_exif_date_sort() {
        use crate::photo::exif::tests::{jpeg_with_exif, sample_exif_tiff};
        let dir = temp_dir("scan_exif");
        let jpg = jpeg_bytes(&pattern(8, 8), 80);
        // "a" has an EXIF date in 2024; "b" (no EXIF) has mtime = now -> a sorts first
        std::fs::write(dir.join("b.jpg"), &jpg).unwrap();
        std::fs::write(dir.join("a.jpg"), jpeg_with_exif(&jpg, &sample_exif_tiff(1))).unwrap();
        let (_, items) = run(&dir, ScanOptions { sort: SortKey::ExifDate, descending: true, ..Default::default() });
        assert_eq!(items[0].name, "b.jpg");
        assert_eq!(items[1].exif_date, Some(1_715_956_205_000));
    }

    #[test]
    fn photo_scan_5000_files_streams_pages() {
        let dir = temp_dir("scan5000");
        for i in 0..5000 {
            std::fs::write(dir.join(format!("P{i:05}.jpg")), b"").unwrap();
        }
        let started = Instant::now();
        let mut pages = 0;
        let mut first_page_at = None;
        let mut on_page = |_: usize, items: &[ScanItem]| {
            pages += 1;
            first_page_at.get_or_insert(started.elapsed());
            assert!(items.len() <= 500);
        };
        let s = scan(&dir, &ScanOptions::default(), "t", &|| false, &mut on_page, &mut |_, _, _| {}).unwrap();
        println!("5000 files: total {:?}, first page after {:?}", started.elapsed(), first_page_at.unwrap());
        assert_eq!((s.total, pages), (5000, 10));
        assert!(started.elapsed().as_secs_f64() < 2.0);
        // Cancellation
        let s = scan(&dir, &ScanOptions::default(), "t", &|| true, &mut |_, _| {}, &mut |_, _, _| {}).unwrap();
        assert!(s.cancelled);
    }
}
