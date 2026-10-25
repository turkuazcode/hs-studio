//! File system watcher for library folders: an ACCELERATOR only. Events are coalesced into
//! small scan scopes (the directories that changed); an overflow / error asks for a full
//! reconciliation of the folder. Missed events are repaired by the periodic and manual
//! reconciliation scans, which are the source of truth.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::storage::identity::normalize_path;

use super::scan::{Dir, media_kind_of, prefix_range};

/// Quiet time before a batch of events is scanned, and the longest wait under constant churn.
const QUIET: Duration = Duration::from_millis(700);
const MAX_WAIT: Duration = Duration::from_secs(4);
/// More changed paths than this in one batch: rescan the whole folder instead.
const MAX_PATHS: usize = 2000;

pub enum Signal {
    Paths(Vec<PathBuf>),
    /// The OS dropped events (buffer overflow) or reported an error.
    Rescan,
}

pub struct FolderWatcher {
    watcher: RecommendedWatcher,
    roots: Vec<PathBuf>,
}

/// What the debounce thread hands to the scanner.
#[derive(Debug, Clone, PartialEq)]
pub enum Batch {
    /// (folder root, dirs to check)
    Dirs(Vec<(PathBuf, Vec<Dir>)>),
    /// Full reconciliation of these roots (None = all library folders).
    Full(Option<Vec<PathBuf>>),
}

pub fn start(tx: Sender<Signal>) -> notify::Result<FolderWatcher> {
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = match res {
            Ok(ev) if ev.need_rescan() => tx.send(Signal::Rescan),
            Ok(ev) if matches!(ev.kind, EventKind::Access(_)) => Ok(()),
            Ok(ev) => tx.send(Signal::Paths(ev.paths)),
            Err(_) => tx.send(Signal::Rescan),
        };
    })?;
    Ok(FolderWatcher { watcher, roots: Vec::new() })
}

impl FolderWatcher {
    /// Watches exactly `roots` (online library folders). Roots that cannot be watched (offline)
    /// are skipped; the periodic check adds them back when they return.
    pub fn set_roots(&mut self, roots: &[PathBuf]) -> Vec<PathBuf> {
        let want: HashSet<&PathBuf> = roots.iter().collect();
        for old in std::mem::take(&mut self.roots) {
            if want.contains(&old) {
                self.roots.push(old);
            } else {
                let _ = self.watcher.unwatch(&old);
            }
        }
        let mut failed = Vec::new();
        for r in roots {
            if self.roots.contains(r) {
                continue;
            }
            match self.watcher.watch(r, RecursiveMode::Recursive) {
                Ok(()) => self.roots.push(r.clone()),
                Err(_) => failed.push(r.clone()),
            }
        }
        failed
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }
}

/// Groups changed paths by library folder into scan scopes: a media file -> its directory
/// (shallow); anything else (a directory created / removed / renamed, unknown) -> that path
/// recursively plus its parent shallow. Paths outside every root are ignored.
pub fn scopes(paths: &[PathBuf], roots: &[PathBuf]) -> Batch {
    if paths.len() > MAX_PATHS {
        return Batch::Full(Some(roots_of(paths, roots)));
    }
    let norms: Vec<(String, &PathBuf)> = roots.iter().map(|r| (normalize_path(&r.to_string_lossy()), r)).collect();
    let mut out: Vec<(PathBuf, Vec<Dir>)> = Vec::new();
    for p in paths {
        let pn = normalize_path(&p.to_string_lossy());
        // the deepest root containing the path
        let Some((_, root)) = norms
            .iter()
            .filter(|(rn, _)| pn == *rn || pn.starts_with(&prefix_range(rn).0))
            .max_by_key(|(rn, _)| rn.len())
        else {
            continue;
        };
        let mut dirs = Vec::new();
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_media = !p.is_dir() && media_kind_of(&name).is_some();
        if !is_media && pn != normalize_path(&root.to_string_lossy()) {
            dirs.push(Dir { path: p.clone(), recursive: true });
        }
        if let Some(parent) = p.parent().filter(|_| pn != normalize_path(&root.to_string_lossy())) {
            dirs.push(Dir { path: parent.to_path_buf(), recursive: false });
        } else {
            dirs.push(Dir { path: (*root).clone(), recursive: false });
        }
        match out.iter_mut().find(|(r, _)| r == *root) {
            Some((_, list)) => {
                for d in dirs {
                    if !list.contains(&d) {
                        list.push(d);
                    }
                }
            }
            None => out.push(((*root).clone(), dirs)),
        }
    }
    Batch::Dirs(out)
}

fn roots_of(paths: &[PathBuf], roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|r| {
            let rn = prefix_range(&normalize_path(&r.to_string_lossy())).0;
            paths.iter().any(|p| normalize_path(&p.to_string_lossy()).starts_with(&rn))
        })
        .cloned()
        .collect()
}

/// Debounce loop: collects signals until QUIET, then hands one batch to `deliver`.
/// `roots()` returns the currently watched roots. Ends when the channel closes.
pub fn debounce(rx: Receiver<Signal>, roots: impl Fn() -> Vec<PathBuf>, mut deliver: impl FnMut(Batch)) {
    loop {
        let first = match rx.recv() {
            Ok(s) => s,
            Err(_) => return,
        };
        let started = Instant::now();
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut full = false;
        let mut take = |s: Signal, paths: &mut Vec<PathBuf>| match s {
            Signal::Paths(p) => paths.extend(p),
            Signal::Rescan => full = true,
        };
        take(first, &mut paths);
        loop {
            let left = MAX_WAIT.saturating_sub(started.elapsed());
            match rx.recv_timeout(QUIET.min(left)) {
                Ok(s) => take(s, &mut paths),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
            if started.elapsed() >= MAX_WAIT {
                break;
            }
        }
        let roots = roots();
        if full {
            deliver(Batch::Full(None));
        } else {
            paths.sort();
            paths.dedup();
            deliver(scopes(&paths, &roots));
        }
    }
}

#[allow(dead_code)]
pub fn is_under(path: &Path, root: &Path) -> bool {
    let pn = normalize_path(&path.to_string_lossy());
    let rn = normalize_path(&root.to_string_lossy());
    pn == rn || pn.starts_with(&prefix_range(&rn).0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_group_by_root() {
        let base = std::env::temp_dir().join("vho-watch-scope");
        let a = base.join("A");
        let b = base.join("B");
        let paths = vec![a.join("x").join("film.mp4"), a.join("newdir"), b.join("song.mp3"), base.join("elsewhere.mp4")];
        let Batch::Dirs(out) = scopes(&paths, &[a.clone(), b.clone()]) else { panic!("dirs") };
        assert_eq!(out.len(), 2);
        let (ra, da) = &out[0];
        assert_eq!(ra, &a);
        assert!(da.contains(&Dir { path: a.join("x"), recursive: false }));
        assert!(da.contains(&Dir { path: a.join("newdir"), recursive: true }));
        assert!(da.contains(&Dir { path: a.clone(), recursive: false }));
        assert_eq!(out[1].1, vec![Dir { path: b.clone(), recursive: false }]);
        let many: Vec<PathBuf> = (0..MAX_PATHS + 1).map(|i| a.join(format!("{i}.mp4"))).collect();
        assert_eq!(scopes(&many, &[a.clone(), b]), Batch::Full(Some(vec![a])));
    }
}
