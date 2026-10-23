//! Camera RAW support through the JPEG previews cameras embed in every RAW file.
//!
//! Full RAW development is intentionally not done: the Rust RAW decoders (`rawler`,
//! `rawloader`) are LGPL-2.1 and would be statically linked, which VHO's license
//! policy forbids. The embedded preview is usually full-size (Canon/Nikon/Sony/Fuji/
//! Olympus/Panasonic/DNG) and is what most photo browsers show anyway. On Windows the
//! Microsoft "Raw Image Extension" (WIC) is tried as a fallback (see `decode`).
//!
//! Strategy: walk the TIFF structure (IFD chain, SubIFDs, EXIF IFD) for JPEG streams,
//! handle Fuji RAF's header, and finally brute-force scan for `FF D8 FF` streams
//! (CR3 and other ISO-BMFF / proprietary containers).

pub const RAW_EXTS: &[&str] = &[
    "3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "dcr", "dng", "erf", "fff", "iiq", "k25", "kdc", "mef",
    "mos", "mrw", "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf", "srw", "x3f",
];

pub fn is_raw_ext(ext: &str) -> bool {
    RAW_EXTS.contains(&ext)
}

/// A JPEG stream found inside a RAW file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preview {
    pub offset: usize,
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

/// Facts about a JPEG stream from walking its marker segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegInfo {
    /// Total length including SOI..EOI
    pub len: usize,
    pub width: u32,
    pub height: u32,
    /// SOF3/7/11/15: lossless JPEG (raw sensor data in DNG/CR2), not a viewable preview
    pub lossless: bool,
}

fn be16(d: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_be_bytes([*d.get(at)?, *d.get(at + 1)?]) as usize)
}

/// Walks a JPEG stream starting at `d[0]` (must be `FF D8`) and returns its extent and
/// frame size. Entropy-coded data is skipped by scanning for a marker that is neither
/// a stuffed `FF 00` nor a restart marker.
pub fn jpeg_info(d: &[u8]) -> Option<JpegInfo> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let (mut width, mut height, mut lossless, mut have_sof) = (0u32, 0u32, false, false);
    let mut pos = 2usize;
    loop {
        // Marker (allow fill bytes)
        if *d.get(pos)? != 0xFF {
            return None;
        }
        while *d.get(pos)? == 0xFF {
            pos += 1;
        }
        let marker = *d.get(pos)?;
        pos += 1;
        match marker {
            0xD9 => {
                return have_sof.then_some(JpegInfo { len: pos, width, height, lossless });
            }
            0x01 | 0xD0..=0xD7 => continue,
            0x00 => return None,
            _ => {}
        }
        let len = be16(d, pos)?;
        if len < 2 {
            return None;
        }
        let seg_end = pos.checked_add(len)?;
        if seg_end > d.len() {
            return None;
        }
        match marker {
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                height = be16(d, pos + 3)? as u32;
                width = be16(d, pos + 5)? as u32;
                lossless = matches!(marker, 0xC3 | 0xC7 | 0xCB | 0xCF);
                have_sof = width > 0 && height > 0;
            }
            _ => {}
        }
        pos = seg_end;
        if marker == 0xDA {
            // Entropy-coded segment: find the next real marker
            loop {
                let rel = d.get(pos..)?.iter().position(|&b| b == 0xFF)?;
                pos += rel;
                let next = *d.get(pos + 1)?;
                if next == 0x00 || (0xD0..=0xD7).contains(&next) || next == 0xFF {
                    pos += if next == 0xFF { 1 } else { 2 };
                    continue;
                }
                break;
            }
        }
    }
}

struct Tiff<'a> {
    d: &'a [u8],
    le: bool,
}

impl Tiff<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let b = [*self.d.get(at)?, *self.d.get(at + 1)?];
        Some(if self.le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    }
    fn u32(&self, at: usize) -> Option<u32> {
        let b: [u8; 4] = self.d.get(at..at + 4)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }
    /// First value of a SHORT/LONG entry (inline).
    fn entry_value(&self, entry: usize) -> Option<u32> {
        match self.u16(entry + 2)? {
            3 => self.u16(entry + 8).map(u32::from),
            4 | 13 => self.u32(entry + 8),
            _ => None,
        }
    }
    /// All values of a LONG/SHORT/IFD array entry (SubIFDs).
    fn entry_values(&self, entry: usize) -> Vec<u32> {
        let (Some(ty), Some(count)) = (self.u16(entry + 2), self.u32(entry + 4)) else { return vec![] };
        let size = match ty {
            3 => 2,
            4 | 13 => 4,
            _ => return vec![],
        };
        let count = count.min(64) as usize;
        let base = if size * count <= 4 {
            entry + 8
        } else {
            match self.u32(entry + 8) {
                Some(o) => o as usize,
                None => return vec![],
            }
        };
        (0..count)
            .filter_map(|i| if size == 2 { self.u16(base + i * 2).map(u32::from) } else { self.u32(base + i * 4) })
            .collect()
    }
}

/// Offsets of JPEG streams referenced by the TIFF structure of a RAW file.
fn tiff_candidates(d: &[u8]) -> Vec<(usize, Option<usize>)> {
    let le = match d.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return vec![],
    };
    let t = Tiff { d, le };
    // 42 = TIFF, 0x4F52/0x5352 = Olympus ORF, 0x55 = Panasonic RW2
    if !matches!(t.u16(2), Some(42 | 0x4F52 | 0x5352 | 0x55)) {
        return vec![];
    }
    let mut out = Vec::new();
    let mut queue: Vec<usize> = t.u32(4).map(|o| o as usize).into_iter().collect();
    let mut seen = std::collections::HashSet::new();
    let mut chain_budget = 64;
    while let Some(ifd) = queue.pop() {
        if ifd == 0 || ifd >= d.len() || !seen.insert(ifd) || chain_budget == 0 {
            continue;
        }
        chain_budget -= 1;
        let Some(n) = t.u16(ifd) else { continue };
        let n = n.min(1000) as usize;
        let (mut jpeg_off, mut jpeg_len, mut compression) = (None, None, None);
        let (mut strip_off, mut strip_len) = (Vec::new(), Vec::new());
        for i in 0..n {
            let e = ifd + 2 + i * 12;
            let Some(tag) = t.u16(e) else { break };
            match tag {
                0x0103 => compression = t.entry_value(e),
                0x0111 => strip_off = t.entry_values(e),
                0x0117 => strip_len = t.entry_values(e),
                0x0201 => jpeg_off = t.entry_value(e),
                0x0202 => jpeg_len = t.entry_value(e),
                // Panasonic RW2 JpgFromRaw: UNDEFINED blob holding the JPEG
                0x002E if t.u16(2) == Some(0x55) => {
                    if let Some(o) = t.u32(e + 8) {
                        out.push((o as usize, t.u32(e + 4).map(|c| c as usize)));
                    }
                }
                // SubIFDs, EXIF IFD
                0x014A | 0x8769 => queue.extend(t.entry_values(e).into_iter().map(|o| o as usize)),
                _ => {}
            }
        }
        if let Some(o) = jpeg_off {
            out.push((o as usize, jpeg_len.map(|l| l as usize)));
        }
        if matches!(compression, Some(6 | 7)) && strip_off.len() == 1 {
            out.push((strip_off[0] as usize, strip_len.first().map(|&l| l as usize)));
        }
        if let Some(next) = t.u32(ifd + 2 + n * 12) {
            queue.push(next as usize);
        }
    }
    out
}

/// All viewable (non-lossless) JPEG previews in a RAW file, largest first.
pub fn find_previews(d: &[u8]) -> Vec<Preview> {
    let mut found: Vec<Preview> = Vec::new();
    let push = |offset: usize, found: &mut Vec<Preview>| {
        if found.iter().any(|p| p.offset == offset) {
            return;
        }
        if let Some(info) = d.get(offset..).and_then(jpeg_info).filter(|i| !i.lossless) {
            found.push(Preview { offset, len: info.len, width: info.width, height: info.height });
        }
    };

    for (offset, _len) in tiff_candidates(d) {
        push(offset, &mut found);
    }
    // Fuji RAF: big-endian JPEG offset/length at 84/88
    if d.starts_with(b"FUJIFILMCCD-RAW") && d.len() > 92 {
        let off = u32::from_be_bytes(d[84..88].try_into().unwrap()) as usize;
        push(off, &mut found);
    }
    if found.is_empty() {
        // Unknown container (CR3, X3F...): scan for JPEG streams
        let mut pos = 0;
        while pos + 3 < d.len() {
            let Some(rel) = d[pos..].windows(3).position(|w| w == [0xFF, 0xD8, 0xFF]) else { break };
            let at = pos + rel;
            match jpeg_info(&d[at..]) {
                Some(info) => {
                    if !info.lossless {
                        found.push(Preview { offset: at, len: info.len, width: info.width, height: info.height });
                    }
                    pos = at + info.len;
                }
                None => pos = at + 2,
            }
        }
    }
    found.sort_by_key(|p| std::cmp::Reverse(p.width as u64 * p.height as u64));
    found
}

/// Picks the preview to decode: the smallest one whose longest side covers `min_side`
/// (fast thumbnails), or the largest when `min_side` is `None` / nothing is big enough.
pub fn best_preview(d: &[u8], min_side: Option<u32>) -> Option<&[u8]> {
    let previews = find_previews(d);
    let pick = match min_side {
        Some(min) => previews
            .iter()
            .filter(|p| p.width.max(p.height) >= min)
            .last()
            .or(previews.first()),
        None => previews.first(),
    }?;
    d.get(pick.offset..pick.offset + pick.len)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::photo::testutil::*;

    /// Builds a little-endian TIFF ("fake RAW") with a full-size JPEG in IFD0
    /// (JPEGInterchangeFormat) and a small one in a SubIFD, plus raw junk data.
    pub fn fake_raw(big: &[u8], small: &[u8], orientation: u16) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(b"II*\0");
        d.extend_from_slice(&8u32.to_le_bytes());
        // IFD0 at 8: 4 entries
        let ifd0_entries = 4u16;
        let ifd0_size = 2 + 12 * ifd0_entries as usize + 4;
        let sub_ifd = 8 + ifd0_size;
        let sub_size = 2 + 12 * 3 + 4;
        let big_off = sub_ifd + sub_size + 1000; // 1000 bytes of "sensor data" first
        let small_off = big_off + big.len();
        let entry = |tag: u16, ty: u16, count: u32, val: u32| {
            let mut e = Vec::new();
            e.extend_from_slice(&tag.to_le_bytes());
            e.extend_from_slice(&ty.to_le_bytes());
            e.extend_from_slice(&count.to_le_bytes());
            e.extend_from_slice(&val.to_le_bytes());
            e
        };
        d.extend_from_slice(&ifd0_entries.to_le_bytes());
        d.extend(entry(0x0112, 3, 1, orientation as u32));
        d.extend(entry(0x014A, 4, 1, sub_ifd as u32));
        d.extend(entry(0x0201, 4, 1, big_off as u32));
        d.extend(entry(0x0202, 4, 1, big.len() as u32));
        d.extend_from_slice(&0u32.to_le_bytes());
        // SubIFD: old-style JPEG strip
        d.extend_from_slice(&3u16.to_le_bytes());
        d.extend(entry(0x0103, 3, 1, 6));
        d.extend(entry(0x0111, 4, 1, small_off as u32));
        d.extend(entry(0x0117, 4, 1, small.len() as u32));
        d.extend_from_slice(&0u32.to_le_bytes());
        // Fake sensor data containing a lossless-JPEG-looking header and stray FF D8 bytes
        let mut junk = vec![0x5Au8; 1000];
        junk[10..14].copy_from_slice(&[0xFF, 0xD8, 0xFF, 0xC3]);
        d.extend_from_slice(&junk);
        d.extend_from_slice(big);
        d.extend_from_slice(small);
        d
    }

    #[test]
    fn jpeg_info_reads_size_and_extent() {
        let jpg = jpeg_bytes(&pattern(64, 48), 90);
        let mut padded = jpg.clone();
        padded.extend_from_slice(b"trailing garbage");
        let info = jpeg_info(&padded).unwrap();
        assert_eq!((info.width, info.height, info.len, info.lossless), (64, 48, jpg.len(), false));
        assert!(jpeg_info(b"\xFF\xD8\xFF\xC3").is_none());
    }

    #[test]
    fn photo_raw_preview_from_tiff_structure() {
        let big = jpeg_bytes(&pattern(640, 480), 85);
        let small = jpeg_bytes(&pattern(160, 120), 85);
        let raw = fake_raw(&big, &small, 1);
        let previews = find_previews(&raw);
        assert_eq!(previews.len(), 2, "{previews:?}");
        assert_eq!((previews[0].width, previews[0].height), (640, 480));
        assert_eq!(best_preview(&raw, None).unwrap(), &big[..]);
        assert_eq!(best_preview(&raw, Some(128)).unwrap(), &small[..]);
        assert_eq!(best_preview(&raw, Some(256)).unwrap(), &big[..]);
        assert_eq!(best_preview(&raw, Some(4000)).unwrap(), &big[..]);
    }

    #[test]
    fn photo_raw_preview_brute_force_scan() {
        // Unknown container (like CR3): JPEG somewhere in the middle
        let big = jpeg_bytes(&pattern(320, 200), 85);
        let mut blob = b"\0\0\0\x18ftypcrx \0\0\0\x01crx isom".to_vec();
        blob.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0x00, 0x11]); // false positive
        blob.extend_from_slice(&big);
        blob.extend_from_slice(&[0u8; 100]);
        let p = best_preview(&blob, None).unwrap();
        assert_eq!(p, &big[..]);
        assert!(find_previews(b"nothing here").is_empty());
    }
}
