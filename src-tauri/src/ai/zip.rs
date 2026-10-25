//! Minimal, defensive zip reader for model archives (stored + deflate, zip64 sizes/offsets).
//!
//! Only entries named in the manifest are extracted, to flat manifest-chosen names: archive
//! paths never become file system paths, so traversal entries cannot write anywhere. Listed
//! entries must not be encrypted, symlinks, duplicated or use other compression methods;
//! decompression stops one byte past the manifest size (zip bombs), and the CRC-32, the
//! exact size and the SHA-256 are checked before the output gets its final name.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::error::{AiError, AiResult, ErrorCode};

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_LOCATOR_SIG: u32 = 0x0706_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const LOCAL_SIG: u32 = 0x0403_4b50;
const MAX_ENTRIES: u64 = 65_536;

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub method: u16,
    pub flags: u16,
    pub crc32: u32,
    pub compressed: u64,
    pub size: u64,
    pub local_offset: u64,
    pub made_by: u16,
    pub external_attr: u32,
}

impl Entry {
    fn is_symlink(&self) -> bool {
        // Unix "made by" + S_IFLNK in the high word of the external attributes
        self.made_by >> 8 == 3 && (self.external_attr >> 16) & 0o170000 == 0o120000
    }
}

fn bad(detail: impl Into<String>) -> AiError {
    AiError::new(ErrorCode::ArchiveInvalid, detail)
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(b[i..i + 8].try_into().unwrap())
}

fn read_exact_at(f: &mut File, pos: u64, len: usize) -> AiResult<Vec<u8>> {
    let mut buf = vec![0u8; len];
    f.seek(SeekFrom::Start(pos)).map_err(|e| AiError::io("zip seek", &e))?;
    f.read_exact(&mut buf).map_err(|_| bad("truncated archive"))?;
    Ok(buf)
}

/// Central directory of the archive.
pub fn entries(f: &mut File) -> AiResult<Vec<Entry>> {
    let len = f.metadata().map_err(|e| AiError::io("zip", &e))?.len();
    if len < 22 {
        return Err(bad("too small"));
    }
    let tail_len = len.min(22 + 65_535) as usize;
    let tail_pos = len - tail_len as u64;
    let tail = read_exact_at(f, tail_pos, tail_len)?;
    let eocd = (0..=tail_len - 22).rev().find(|&i| u32_at(&tail, i) == EOCD_SIG).ok_or_else(|| bad("no end of central directory"))?;
    let e = &tail[eocd..];
    let mut count = u16_at(e, 10) as u64;
    let mut cd_size = u32_at(e, 12) as u64;
    let mut cd_offset = u32_at(e, 16) as u64;

    if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        let loc_pos = (tail_pos + eocd as u64).checked_sub(20).ok_or_else(|| bad("no zip64 locator"))?;
        let loc = read_exact_at(f, loc_pos, 20)?;
        if u32_at(&loc, 0) != EOCD64_LOCATOR_SIG {
            return Err(bad("no zip64 locator"));
        }
        let rec = read_exact_at(f, u64_at(&loc, 8), 56)?;
        if u32_at(&rec, 0) != EOCD64_SIG {
            return Err(bad("bad zip64 end record"));
        }
        count = u64_at(&rec, 32);
        cd_size = u64_at(&rec, 40);
        cd_offset = u64_at(&rec, 48);
    }
    if count > MAX_ENTRIES || cd_offset.checked_add(cd_size).is_none_or(|end| end > len) || cd_size > 64 << 20 {
        return Err(bad("central directory out of range"));
    }

    let cd = read_exact_at(f, cd_offset, cd_size as usize)?;
    let mut out = Vec::with_capacity(count as usize);
    let mut p = 0usize;
    for _ in 0..count {
        if p + 46 > cd.len() || u32_at(&cd, p) != CENTRAL_SIG {
            return Err(bad("bad central directory entry"));
        }
        let name_len = u16_at(&cd, p + 28) as usize;
        let extra_len = u16_at(&cd, p + 30) as usize;
        let comment_len = u16_at(&cd, p + 32) as usize;
        let end = p + 46 + name_len + extra_len + comment_len;
        if end > cd.len() {
            return Err(bad("bad central directory entry"));
        }
        let mut entry = Entry {
            name: String::from_utf8_lossy(&cd[p + 46..p + 46 + name_len]).into_owned(),
            made_by: u16_at(&cd, p + 4),
            flags: u16_at(&cd, p + 8),
            method: u16_at(&cd, p + 10),
            crc32: u32_at(&cd, p + 16),
            compressed: u32_at(&cd, p + 20) as u64,
            size: u32_at(&cd, p + 24) as u64,
            external_attr: u32_at(&cd, p + 38),
            local_offset: u32_at(&cd, p + 42) as u64,
        };
        // zip64 extra field: the 0xFFFFFFFF fields, in the order size, compressed, offset
        let extra = &cd[p + 46 + name_len..p + 46 + name_len + extra_len];
        let mut x = 0usize;
        while x + 4 <= extra.len() {
            let (id, sz) = (u16_at(extra, x), u16_at(extra, x + 2) as usize);
            let body = extra.get(x + 4..x + 4 + sz).ok_or_else(|| bad("bad extra field"))?;
            if id == 0x0001 {
                let mut q = 0usize;
                let mut next = |field: &mut u64| -> AiResult<()> {
                    if *field == 0xFFFF_FFFF {
                        *field = u64_at(body.get(q..q + 8).ok_or_else(|| bad("bad zip64 field"))?, 0);
                        q += 8;
                    }
                    Ok(())
                };
                next(&mut entry.size)?;
                next(&mut entry.compressed)?;
                next(&mut entry.local_offset)?;
            }
            x += 4 + sz;
        }
        out.push(entry);
        p = end;
    }
    Ok(out)
}

/// Extracts `entry_name` to `out` (created / truncated), checking size, CRC-32 and SHA-256.
/// `cancelled` is polled between blocks. On any error the output file is removed.
pub fn extract(
    archive: &Path,
    entry_name: &str,
    out: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    cancelled: &dyn Fn() -> bool,
    on_bytes: &mut dyn FnMut(u64),
) -> AiResult<()> {
    let r = extract_inner(archive, entry_name, out, expected_bytes, expected_sha256, cancelled, on_bytes);
    if r.is_err() {
        let _ = std::fs::remove_file(out);
    }
    r
}

fn extract_inner(
    archive: &Path,
    entry_name: &str,
    out: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    cancelled: &dyn Fn() -> bool,
    on_bytes: &mut dyn FnMut(u64),
) -> AiResult<()> {
    let mut f = File::open(archive).map_err(|e| AiError::io("open archive", &e))?;
    let list = entries(&mut f)?;
    let mut matches = list.iter().filter(|e| e.name == entry_name);
    let entry = matches.next().ok_or_else(|| bad(format!("entry {entry_name} missing")))?;
    if matches.next().is_some() {
        return Err(bad(format!("entry {entry_name} appears twice")));
    }
    if entry.flags & 1 != 0 {
        return Err(bad("encrypted entry"));
    }
    if entry.is_symlink() {
        return Err(bad("symlink entry"));
    }
    if entry.size != expected_bytes {
        return Err(AiError::new(ErrorCode::Checksum, format!("{entry_name}: {} bytes in archive, manifest {expected_bytes}", entry.size)));
    }

    let local = read_exact_at(&mut f, entry.local_offset, 30)?;
    if u32_at(&local, 0) != LOCAL_SIG {
        return Err(bad("bad local header"));
    }
    let (name_len, extra_len) = (u16_at(&local, 26) as u64, u16_at(&local, 28) as u64);
    let local_name = read_exact_at(&mut f, entry.local_offset + 30, name_len as usize)?;
    if local_name != entry_name.as_bytes() {
        return Err(bad("local header name differs from the central directory"));
    }
    let data_start = entry.local_offset + 30 + name_len + extra_len;
    let archive_len = f.metadata().map_err(|e| AiError::io("zip", &e))?.len();
    if data_start.checked_add(entry.compressed).is_none_or(|end| end > archive_len) {
        return Err(bad("entry data out of range"));
    }
    f.seek(SeekFrom::Start(data_start)).map_err(|e| AiError::io("zip seek", &e))?;
    let raw = (&mut f).take(entry.compressed);
    let mut reader: Box<dyn Read + '_> = match entry.method {
        0 => Box::new(raw),
        8 => Box::new(flate2::read::DeflateDecoder::new(raw)),
        m => return Err(bad(format!("compression method {m} not supported"))),
    };

    let mut file = File::create(out).map_err(|e| AiError::io("create", &e))?;
    let mut sha = Sha256::new();
    let mut crc = crc32fast::Hasher::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancelled() {
            return Err(AiError::new(ErrorCode::Cancelled, "extract cancelled"));
        }
        let n = reader.read(&mut buf).map_err(|e| bad(format!("inflate: {e}")))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > expected_bytes {
            return Err(AiError::new(ErrorCode::Checksum, format!("{entry_name}: larger than the manifest size")));
        }
        file.write_all(&buf[..n]).map_err(|e| AiError::io("write", &e))?;
        sha.update(&buf[..n]);
        crc.update(&buf[..n]);
        on_bytes(n as u64);
    }
    file.sync_all().map_err(|e| AiError::io("sync", &e))?;
    drop(file);
    let digest = super::hex(&sha.finalize());
    if total != expected_bytes || digest != expected_sha256 {
        return Err(AiError::new(ErrorCode::Checksum, format!("{entry_name}: {total} bytes / {digest}")));
    }
    if crc.finalize() != entry.crc32 {
        return Err(bad(format!("{entry_name}: CRC mismatch")));
    }
    Ok(())
}
