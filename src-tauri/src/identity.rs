//! App-data migration for a changed bundle identifier (product rename VHO → HS Studio,
//! docs/release/rename-hs-studio.md).
//!
//! Tauri keeps per-user data in folders named after the bundle identifier
//! (`%APPDATA%\<id>`: settings.json, library.db + backups, ai\ models, window state;
//! `%LOCALAPPDATA%\<id>`: WebView2 profile, caches). When the identifier changes, the new
//! identity would start empty. On the first start of the new identity this module copies every
//! legacy folder to the new location:
//!
//! - only when the legacy folder exists and the new one does NOT (never merges, never overwrites);
//! - the legacy folder is never deleted or modified (a downgrade still finds its data);
//! - crash-safe: the copy goes to `<new>.migrating-<pid>` and is renamed at the end; leftovers of
//!   an interrupted run are removed and the copy is redone on the next start;
//! - idempotent: once `<new>` exists nothing happens;
//! - regenerable caches (thumbnails, transcode/photo caches, WebView2 HTTP/GPU caches) are skipped.
//!
//! The table below is empty until the rename: `scripts/rename-product.mjs --apply` adds
//! `("<new id>", &["com.vho.app"])`. Only an exact identifier match migrates, so test identities
//! (`com.vho.app.packagetest`, `<id>.test<hash>`) can never pick up the user's real data, and test
//! instances (`VHO_DATA_DIR`) are skipped anyway.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// (current identifier, identifiers whose data it takes over, newest first). Empty until the rename.
pub const MIGRATIONS: &[(&str, &[&str])] = &[
    // RENAME-PRODUCT: migration entry (inserted by scripts/rename-product.mjs)
    ("com.turkuazcode.hsstudio", &["com.vho.app"]),
];

/// Folder names never copied (regenerable caches).
const SKIP_DIRS: &[&str] = &[
    "transcode", "thumbs", "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache",
    "DawnWebGPUCache", "GrShaderCache", "GraphiteDawnCache", "ShaderCache", "Crashpad",
];
const MARKER: &str = "migrated-from.txt";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to take over in this base folder.
    NoLegacy,
    /// The new folder already exists (migrated before, or the new identity already ran).
    AlreadyPresent,
    /// Copied `files` files from the legacy folder.
    Migrated { files: usize },
}

fn copy_tree(from: &Path, to: &Path, top: bool) -> io::Result<usize> {
    fs::create_dir_all(to)?;
    let mut n = 0;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let ty = entry.file_type()?;
        let dst = to.join(&name);
        if ty.is_dir() {
            let s = name.to_string_lossy();
            if SKIP_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&s)) || (top && s.eq_ignore_ascii_case("photo") && is_cache(from)) {
                continue;
            }
            n += copy_tree(&entry.path(), &dst, false)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &dst)?;
            n += 1;
        }
        // symlinks/junctions are not followed (the app never creates them)
    }
    Ok(n)
}

/// The photo cache lives in the cache base (`<cache>\<id>\photo`), not in roaming data.
fn is_cache(dir: &Path) -> bool {
    dirs::cache_dir().is_some_and(|c| dir.starts_with(c))
}

/// Copies `<base>/<old_id>` to `<base>/<new_id>` (see module docs).
pub fn migrate_base(base: &Path, old_id: &str, new_id: &str) -> io::Result<Outcome> {
    let old = base.join(old_id);
    let new = base.join(new_id);
    // leftovers of an interrupted copy
    if let Ok(rd) = fs::read_dir(base) {
        let prefix = format!("{new_id}.migrating-");
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    if old_id == new_id || !old.is_dir() {
        return Ok(Outcome::NoLegacy);
    }
    if new.exists() {
        return Ok(Outcome::AlreadyPresent);
    }
    let tmp = base.join(format!("{new_id}.migrating-{}", std::process::id()));
    let files = copy_tree(&old, &tmp, true).inspect_err(|_| {
        let _ = fs::remove_dir_all(&tmp);
    })?;
    fs::write(tmp.join(MARKER), format!("{old_id}\n"))?;
    fs::rename(&tmp, &new).inspect_err(|_| {
        let _ = fs::remove_dir_all(&tmp);
    })?;
    Ok(Outcome::Migrated { files })
}

/// Base folders Tauri derives app folders from (deduplicated: on Windows config = data =
/// Roaming, local data = cache = Local).
fn bases() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir(), dirs::cache_dir()]
        .into_iter()
        .flatten()
        .collect();
    #[cfg(target_os = "macos")]
    if let Some(h) = dirs::home_dir() {
        v.push(h.join("Library").join("Logs"));
    }
    v.sort();
    v.dedup();
    v
}

/// Called first thing at startup with the identifier of this build.
pub fn migrate_legacy_data(identifier: &str) {
    if crate::platform::data_dir_override().is_some() {
        return; // isolated test instance
    }
    let Some((_, olds)) = MIGRATIONS.iter().find(|(new, _)| *new == identifier) else {
        return;
    };
    for old in olds.iter().filter(|o| **o != identifier) {
        for base in bases() {
            match migrate_base(&base, old, identifier) {
                Ok(Outcome::Migrated { files }) => eprintln!("[identity] copied {files} files from {} to {}", base.join(old).display(), base.join(identifier).display()),
                Ok(_) => {}
                Err(e) => eprintln!("[identity] could not copy {} (the old data is unchanged): {e}", base.join(old).display()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "com.vho.test-old";
    const NEW: &str = "com.hsstudio.test-new";

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("vho-identity-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }
    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }

    fn legacy(base: &Path) {
        let o = base.join(OLD);
        write(&o.join("settings.json"), r#"{"settings":{"version":1}}"#);
        write(&o.join("library.db"), "db");
        write(&o.join("library.db-wal"), "wal");
        write(&o.join("backups").join("library-2026.db"), "bak");
        write(&o.join("ai").join("photo-x4").join("rwp4").join("model.onnx"), "weights");
        write(&o.join("window-state.json"), "{}");
        write(&o.join("EBWebView").join("Default").join("Local Storage").join("leveldb").join("000003.log"), "ls");
        write(&o.join("EBWebView").join("Default").join("Cache").join("data_0"), "cache");
        write(&o.join("transcode").join("x.mp4"), "big");
        write(&o.join("thumbs").join("a.jpg"), "thumb");
    }

    #[test]
    fn copies_everything_but_caches_and_keeps_the_old_folder() {
        let base = tmp();
        legacy(&base);
        assert_eq!(migrate_base(&base, OLD, NEW).unwrap(), Outcome::Migrated { files: 7 });
        let n = base.join(NEW);
        for f in ["settings.json", "library.db", "library.db-wal", "backups/library-2026.db", "ai/photo-x4/rwp4/model.onnx", "window-state.json", "EBWebView/Default/Local Storage/leveldb/000003.log", MARKER] {
            assert!(n.join(f).is_file(), "{f} copied");
        }
        for f in ["EBWebView/Default/Cache", "transcode", "thumbs"] {
            assert!(!n.join(f).exists(), "{f} skipped");
        }
        assert_eq!(fs::read_to_string(n.join("ai/photo-x4/rwp4/model.onnx")).unwrap(), "weights");
        assert!(base.join(OLD).join("library.db").is_file(), "old data untouched");
        assert!(base.join(OLD).join("transcode").join("x.mp4").is_file());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn idempotent_and_never_overwrites_the_new_identity() {
        let base = tmp();
        legacy(&base);
        assert!(matches!(migrate_base(&base, OLD, NEW).unwrap(), Outcome::Migrated { .. }));
        write(&base.join(NEW).join("settings.json"), "new settings");
        write(&base.join(OLD).join("settings.json"), "changed by an old build later");
        assert_eq!(migrate_base(&base, OLD, NEW).unwrap(), Outcome::AlreadyPresent);
        assert_eq!(fs::read_to_string(base.join(NEW).join("settings.json")).unwrap(), "new settings");
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn interrupted_copy_is_cleaned_up_and_redone() {
        let base = tmp();
        legacy(&base);
        // a crash left a half-copied temp folder behind
        write(&base.join(format!("{NEW}.migrating-999999")).join("settings.json"), "partial");
        assert!(matches!(migrate_base(&base, OLD, NEW).unwrap(), Outcome::Migrated { .. }));
        assert!(!base.join(format!("{NEW}.migrating-999999")).exists());
        assert!(base.join(NEW).join("library.db").is_file());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn nothing_to_migrate_before_the_rename() {
        assert!(MIGRATIONS.iter().all(|(new, _)| *new != "com.vho.app"), "the current identity never migrates");
        assert!(MIGRATIONS.iter().all(|(new, _)| !new.contains("packagetest") && !new.contains(".test")));
    }

    #[test]
    fn no_legacy_or_same_identifier_is_a_no_op() {
        let base = tmp();
        assert_eq!(migrate_base(&base, OLD, NEW).unwrap(), Outcome::NoLegacy);
        assert!(!base.join(NEW).exists());
        legacy(&base);
        assert_eq!(migrate_base(&base, OLD, OLD).unwrap(), Outcome::NoLegacy);
        fs::remove_dir_all(&base).unwrap();
    }
}
