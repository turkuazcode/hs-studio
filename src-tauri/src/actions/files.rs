//! File actions: rename (validation + conflict check), unique output names, recycle bin,
//! file system properties.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{ERR_EXISTS, ERR_INVALID};

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
    "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Checks a new file name (no folder part). Rules are the strictest of the three platforms
/// (Windows), so a name accepted here works everywhere. Returns the trimmed name.
pub fn validate_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    let invalid = |why: &str| Err(format!("{ERR_INVALID} {why}"));
    if n.is_empty() || n == "." || n == ".." {
        return invalid("Dosya adı boş olamaz");
    }
    if let Some(c) = n.chars().find(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
        return invalid(&format!("Dosya adı şu karakteri içeremez: {c}"));
    }
    if n.ends_with('.') {
        return invalid("Dosya adı nokta ile bitemez");
    }
    if n.len() > 255 {
        return invalid("Dosya adı çok uzun");
    }
    let stem = n.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return invalid(&format!("{stem} Windows'ta ayrılmış bir addır"));
    }
    Ok(n.to_string())
}

/// True when `a` and `b` name the same file (case-only renames on case-insensitive systems).
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Target path of renaming `path` to `new_name` in the same folder.
/// `exists(target)` decides conflicts (injected for tests); a case-only change of the same
/// file is not a conflict.
pub fn rename_target(path: &Path, new_name: &str, exists: impl Fn(&Path) -> bool, same: impl Fn(&Path, &Path) -> bool) -> Result<PathBuf, String> {
    let name = validate_name(new_name)?;
    let dir = path.parent().ok_or_else(|| format!("{ERR_INVALID} Geçersiz yol"))?;
    let target = dir.join(&name);
    if target == path {
        return Ok(target);
    }
    if exists(&target) && !same(path, &target) {
        return Err(format!("{ERR_EXISTS} Bu klasörde \"{name}\" adlı bir dosya zaten var"));
    }
    Ok(target)
}

pub fn rename(path: &Path, new_name: &str) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    let target = rename_target(path, new_name, |p| p.exists(), same_file)?;
    if target != path {
        retry_busy(|| std::fs::rename(path, &target)).map_err(|e| format!("Yeniden adlandırılamadı: {e}"))?;
    }
    Ok(target)
}

/// Retries an operation while the file is still held open (the player releases it a moment
/// after `stop`): Windows sharing violation / access denied, up to ~2 s.
fn retry_busy<T, E: std::fmt::Display>(mut op: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    let mut tries = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) if tries < 12 => {
                let _ = e;
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(170));
            }
            Err(e) => return Err(e),
        }
    }
}

/// `dir/stem<suffix>.ext`, or with " (2)", " (3)"... appended when taken.
pub fn unique_path(dir: &Path, stem: &str, suffix: &str, ext: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let make = |n: u32| {
        let base = if n < 2 { format!("{stem}{suffix}") } else { format!("{stem}{suffix} ({n})") };
        if ext.is_empty() { dir.join(base) } else { dir.join(format!("{base}.{ext}")) }
    };
    let mut n = 1;
    loop {
        let p = make(n);
        if !exists(&p) || n > 9999 {
            return p;
        }
        n += 1;
    }
}

/// Moves a finished `partial` file to `target` WITHOUT replacing an existing file (job queue,
/// A02). If `target` was taken meanwhile, `stem (2).ext`, `stem (3).ext`... are tried. Uses a
/// hard link (fails atomically when the name exists) and falls back to exists-check + rename
/// on file systems without hard links. `partial` must be on the same volume. Returns the
/// final path; on error `partial` is left in place for the caller to remove.
pub fn place_no_clobber(partial: &Path, target: &Path) -> Result<PathBuf, String> {
    let dir = target.parent().ok_or("Geçersiz çıktı yolu")?;
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let candidate = |n: u32| {
        let base = if n < 2 { stem.clone() } else { format!("{stem} ({n})") };
        if ext.is_empty() { dir.join(base) } else { dir.join(format!("{base}.{ext}")) }
    };
    for n in 1..10_000u32 {
        let p = candidate(n);
        match std::fs::hard_link(partial, &p) {
            Ok(()) => {
                let _ = std::fs::remove_file(partial);
                return Ok(p);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists || p.exists() => continue,
            Err(_) => {
                // no hard links here (FAT/exFAT, some network shares)
                if p.exists() {
                    continue;
                }
                return std::fs::rename(partial, &p).map(|_| p).map_err(|e| format!("Çıktı yazılamadı: {e}"));
            }
        }
    }
    Err(format!("{ERR_EXISTS} Boş bir çıktı adı bulunamadı"))
}

pub fn trash_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("Dosya bulunamadı".into());
    }
    retry_busy(|| if path.exists() { trash::delete(path) } else { Ok(()) })
        .map_err(|e| format!("Geri Dönüşüm Kutusu'na taşınamadı: {e}"))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileProps {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub ext: String,
    pub size: u64,
    pub modified_ms: i64,
    pub created_ms: i64,
    pub readonly: bool,
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

pub fn properties(path: &Path) -> Result<FileProps, String> {
    let m = std::fs::metadata(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    Ok(FileProps {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        folder: path.parent().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        ext: crate::photo::ext_lower(path),
        size: m.len(),
        modified_ms: ms(m.modified()),
        created_ms: ms(m.created()),
        readonly: m.permissions().readonly(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_rules() {
        assert_eq!(validate_name("  tatil.jpg ").unwrap(), "tatil.jpg");
        assert_eq!(validate_name("Çiçek ğüşıöç.mp4").unwrap(), "Çiçek ğüşıöç.mp4");
        for bad in ["", "  ", ".", "..", "a/b.jpg", "a\\b", "a:b", "x?.mp4", "a*", "\"q\"", "<a>", "a|b", "ab.", "con", "CON.txt", "lpt1.mp3", "a\u{7}b"] {
            let e = validate_name(bad).unwrap_err();
            assert!(e.starts_with(ERR_INVALID), "{bad:?} -> {e}");
        }
        assert!(validate_name(&"a".repeat(256)).is_err());
        assert!(validate_name("console.txt").is_ok()); // only exact device names are reserved
    }

    #[test]
    fn rename_target_conflicts() {
        let src = Path::new("/m/a.mp4");
        let taken = |p: &Path| p == Path::new("/m/b.mp4") || p == Path::new("/m/A.mp4");
        let never_same = |_: &Path, _: &Path| false;
        assert_eq!(rename_target(src, "c.mp4", taken, never_same).unwrap(), Path::new("/m/c.mp4"));
        assert!(rename_target(src, "b.mp4", taken, never_same).unwrap_err().starts_with(ERR_EXISTS));
        // unchanged name: no-op, no conflict
        assert_eq!(rename_target(src, "a.mp4", |_| true, never_same).unwrap(), src);
        // case-only rename of the same file (case-insensitive file system) is allowed
        assert_eq!(rename_target(src, "A.mp4", taken, |_, _| true).unwrap(), Path::new("/m/A.mp4"));
        assert!(rename_target(src, "x/y.mp4", |_| false, never_same).unwrap_err().starts_with(ERR_INVALID));
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = Path::new("/out");
        let taken = ["/out/v_kesit.mp4", "/out/v_kesit (2).mp4"];
        let p = unique_path(dir, "v", "_kesit", "mp4", |p| taken.iter().any(|t| Path::new(t) == p));
        assert_eq!(p, Path::new("/out/v_kesit (3).mp4"));
        assert_eq!(unique_path(dir, "v", "", "gif", |_| false), Path::new("/out/v.gif"));
    }

    #[test]
    fn place_no_clobber_never_replaces() {
        let dir = std::env::temp_dir().join(format!("vho_actions_place_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("out.mp4");
        std::fs::write(&target, b"existing").unwrap();
        std::fs::write(dir.join("out (2).mp4"), b"existing 2").unwrap();
        let part = dir.join(".part");
        std::fs::write(&part, b"new").unwrap();
        let placed = place_no_clobber(&part, &target).unwrap();
        assert_eq!(placed, dir.join("out (3).mp4"));
        assert_eq!(std::fs::read(&target).unwrap(), b"existing");
        assert_eq!(std::fs::read(dir.join("out (2).mp4")).unwrap(), b"existing 2");
        assert_eq!(std::fs::read(&placed).unwrap(), b"new");
        assert!(!part.exists());
        // free name: placed as is
        std::fs::write(&part, b"x").unwrap();
        assert_eq!(place_no_clobber(&part, &dir.join("free.mp4")).unwrap(), dir.join("free.mp4"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_on_temp_files() {
        let dir = std::env::temp_dir().join(format!("vho_actions_files_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"1").unwrap();
        std::fs::write(&b, b"2").unwrap();
        assert!(rename(&a, "b.txt").unwrap_err().starts_with(ERR_EXISTS));
        let c = rename(&a, "c.txt").unwrap();
        assert!(c.is_file() && !a.exists());
        let props = properties(&c).unwrap();
        assert_eq!((props.name.as_str(), props.size, props.ext.as_str()), ("c.txt", 1, "txt"));
        // case-only rename keeps the file
        let upper = rename(&c, "C.txt").unwrap();
        assert!(upper.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
