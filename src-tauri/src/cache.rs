//! Settings > General > Cache: size and clearing of the regenerable caches (Plan 14/Q04).
//!
//! Kinds (folders under [`crate::platform::cache_dir`]):
//! - `photo`: photo thumbnails and display copies of HEIC/AVIF/RAW (`photo/`)
//! - `video`: video thumbnails / frame grabs (`thumbs/`)
//! - `transcode`: legacy videos converted for playback (`transcode/`)
//!
//! AI models are not a cache (they are downloaded on purpose); they are removed per component in
//! Settings > AI models, where a model in use is protected by its lease.
//!
//! A file in use is never deleted: files still being written (`.part.`) are skipped, and on
//! Windows a file that another handle has open (the player streaming a converted video) cannot
//! be opened exclusively and is skipped. Elsewhere files touched in the last 10 minutes are kept.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

pub const KINDS: &[(&str, &str)] = &[("photo", "photo"), ("video", "thumbs"), ("transcode", "transcode")];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub kind: &'static str,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cleared {
    pub removed: u64,
    pub bytes: u64,
    /// files kept because they are in use
    pub skipped: u64,
}

fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // never follow links out of the cache folder
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(&e.path(), out);
        } else if ft.is_file() {
            out.push((e.path(), e.metadata().map_or(0, |m| m.len())));
        }
    }
}

fn folder(root: &Path, kind: &str) -> Result<PathBuf, String> {
    KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, sub)| root.join(sub))
        .ok_or_else(|| format!("[unsupported] cache kind {kind}"))
}

pub fn usage(root: &Path) -> Vec<Usage> {
    KINDS
        .iter()
        .map(|(kind, sub)| {
            let mut files = vec![];
            walk(&root.join(sub), &mut files);
            Usage { kind, bytes: files.iter().map(|f| f.1).sum(), files: files.len() as u64 }
        })
        .collect()
}

#[cfg(windows)]
fn in_use(p: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // share mode 0: fails with a sharing violation while any other handle is open
    std::fs::OpenOptions::new().read(true).share_mode(0).open(p).is_err()
}

#[cfg(not(windows))]
fn in_use(p: &Path) -> bool {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_none_or(|age| age < std::time::Duration::from_secs(600))
}

pub fn clear(root: &Path, kind: &str) -> Result<Cleared, String> {
    let dir = folder(root, kind)?;
    let mut files = vec![];
    walk(&dir, &mut files);
    let mut r = Cleared::default();
    for (p, len) in files {
        let partial = p.file_name().is_some_and(|n| n.to_string_lossy().contains(".part."));
        if partial || in_use(&p) || std::fs::remove_file(&p).is_err() {
            r.skipped += 1;
        } else {
            r.removed += 1;
            r.bytes += len;
        }
    }
    remove_empty_dirs(&dir);
    Ok(r)
}

fn remove_empty_dirs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            remove_empty_dirs(&e.path());
            let _ = std::fs::remove_dir(e.path()); // only succeeds when empty
        }
    }
}

#[tauri::command]
pub async fn cache_usage(app: AppHandle) -> Result<Vec<Usage>, String> {
    let root = crate::platform::cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || usage(&root)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cache_clear(app: AppHandle, kind: String) -> Result<Cleared, String> {
    let root = crate::platform::cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || clear(&root, &kind)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_clear_removes_only_its_kind_and_keeps_files_in_use() {
        let root = std::env::temp_dir().join(format!("vho-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let put = |rel: &str, n: usize| {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, vec![7u8; n]).unwrap();
            p
        };
        put("photo/thumbs/ab/1.jpg", 100);
        put("photo/display/2.jpg", 50);
        put("thumbs/v.jpg", 10);
        let playing = put("transcode/0123.mp4", 1000);
        put("transcode/0456.mp4", 500);
        let writing = put("transcode/0789.3.part.mp4", 70);
        // outside the cache kinds: never touched
        let other = put("ai/model.onnx", 5);

        let u = usage(&root);
        assert_eq!(u, vec![
            Usage { kind: "photo", bytes: 150, files: 2 },
            Usage { kind: "video", bytes: 10, files: 1 },
            Usage { kind: "transcode", bytes: 1570, files: 3 },
        ]);

        assert_eq!(clear(&root, "photo").unwrap(), Cleared { removed: 2, bytes: 150, skipped: 0 });
        assert!(!root.join("photo/thumbs/ab").exists(), "empty folders are removed");
        assert!(root.join("thumbs/v.jpg").exists());

        #[cfg(windows)]
        {
            let open = std::fs::File::open(&playing).unwrap(); // the player streams it
            let r = clear(&root, "transcode").unwrap();
            assert_eq!(r, Cleared { removed: 1, bytes: 500, skipped: 2 });
            assert!(playing.exists() && writing.exists());
            drop(open);
            assert_eq!(clear(&root, "transcode").unwrap(), Cleared { removed: 1, bytes: 1000, skipped: 1 });
        }
        #[cfg(not(windows))]
        let _ = (&playing, &writing);
        assert!(other.exists());
        assert!(clear(&root, "../ai").is_err() && clear(&root, "ai").is_err());
        std::fs::remove_dir_all(&root).ok();
    }
}
