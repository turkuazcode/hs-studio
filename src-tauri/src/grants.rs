//! Path grants (Q04): commands that write, delete, rename or move files only touch paths the
//! user really chose, never just any path the webview sends.
//!
//! Grant sources (all on the Rust side; the webview cannot claim "the user picked this"):
//! - the open / save / folder dialogs (`dialog_open`, `dialog_save`: shown by Rust),
//! - files handed over by the OS (command line, "Open with", second instance, macOS open events),
//! - the OS file drop (window `DragDrop` event),
//! - library folders (L02, read from `library.db`; adding one needs a granted folder),
//! - the app's own folders (data, cache, `<Videos|Pictures|Music>\HS Studio`).
//!
//! A path that is not covered asks the user once in a native dialog (also not reachable from the
//! webview); "Allow" grants that folder for this session, otherwise `[path-not-granted]`. Tests
//! answer the question with `VHO_GRANT_PROMPT=allow|deny` instead of showing it.
//!
//! Checks work on canonical paths: `..`, symlinks / junctions, 8.3 short names, `\\?\` prefixes
//! and (on Windows) letter case cannot move a target out of its grant.

use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

pub const ERR_NOT_GRANTED: &str = "[path-not-granted]";
const PROMPT_ENV: &str = "VHO_GRANT_PROMPT";
const PERSIST_FILE: &str = "grants.json";
const PERSIST_MAX: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// exactly this file
    File,
    /// entries directly inside this folder (not below)
    Folder,
    /// everything below this folder
    Tree,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    /// canonical comparison key (see [`key_of`])
    pub key: String,
    pub scope: Scope,
}

/// How a command touches its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// the directory entry itself (trash, rename, remove after move): a link is not followed
    Entry,
    /// the file's content (tag writing): a link is followed to the file it points to
    Content,
    /// a new file that may not exist yet (export output, save target)
    Create,
    /// files created inside this folder (output folder)
    IntoFolder,
}

// ---------------------------------------------------------------------------
// Canonical keys
// ---------------------------------------------------------------------------

fn canonical(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

/// Canonical form of an existing ancestor plus the remaining (not yet existing) components.
/// `.` is dropped; `..` in the missing part is refused (it could leave the folder).
fn canonical_lenient(p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if let Some(c) = canonical(&cur) {
            let mut out = c;
            for m in missing.iter().rev() {
                out.push(m);
            }
            return Some(out);
        }
        match cur.components().next_back() {
            Some(Component::Normal(n)) => missing.push(n.to_os_string()),
            Some(Component::CurDir) => {}
            _ => return None, // `..` or a root that does not exist
        }
        cur = cur.parent()?.to_path_buf();
    }
}

/// Comparison key of a canonical path: without the `\\?\` prefix, lower case and with `\` on
/// Windows; without a trailing separator (except a drive / filesystem root).
fn key_of(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    #[cfg(windows)]
    let s = {
        let s = s.replace('/', "\\");
        let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            s
        };
        s.to_lowercase()
    };
    let sep = std::path::MAIN_SEPARATOR;
    let trimmed = s.trim_end_matches(sep);
    if trimmed.is_empty() || trimmed.ends_with(':') { format!("{trimmed}{sep}") } else { trimmed.to_string() }
}

/// Key of the target of an access, or None when it cannot be resolved (refused).
pub fn target_key(path: &Path, access: Access) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let p = match access {
        Access::Content => canonical(path).or_else(|| canonical_lenient(path))?,
        Access::Entry => {
            // the entry itself: its folder canonical, its own name as written
            let name = path.file_name()?;
            if name == ".." || name == "." {
                return None;
            }
            canonical(path.parent()?)?.join(name)
        }
        Access::Create | Access::IntoFolder => canonical_lenient(path)?,
    };
    Some(key_of(&p))
}

fn parent_key(key: &str) -> Option<&str> {
    let sep = std::path::MAIN_SEPARATOR;
    let i = key.trim_end_matches(sep).rfind(sep)?;
    // keep the separator of a root ("c:\", "/")
    let head = &key[..i];
    if head.is_empty() || head.ends_with(':') { Some(&key[..=i]) } else { Some(head) }
}

fn under(key: &str, root: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    if root.ends_with(sep) { key.len() > root.len() && key.starts_with(root) } else { key.len() > root.len() + 1 && key.starts_with(root) && key[root.len()..].starts_with(sep) }
}

// ---------------------------------------------------------------------------
// Grant set (pure, unit tested)
// ---------------------------------------------------------------------------

#[derive(Default, Debug, Clone)]
pub struct GrantSet {
    grants: Vec<Grant>,
}

impl GrantSet {
    pub fn add_key(&mut self, key: String, scope: Scope) -> bool {
        if self.grants.iter().any(|g| g.key == key && g.scope == scope) {
            return false;
        }
        self.grants.push(Grant { key, scope });
        true
    }

    /// Grants an existing or new path; false when it cannot be resolved.
    pub fn add(&mut self, path: &Path, scope: Scope) -> bool {
        let access = if scope == Scope::File { Access::Create } else { Access::IntoFolder };
        match target_key(path, access) {
            Some(k) => {
                self.add_key(k, scope);
                true
            }
            None => false,
        }
    }

    /// Does a grant cover this target key? `into_folder`: the key is a folder that receives new files.
    pub fn allows_key(&self, key: &str, into_folder: bool) -> bool {
        self.grants.iter().any(|g| match (g.scope, into_folder) {
            (Scope::File, false) => key == g.key,
            (Scope::File, true) => false,
            (Scope::Folder, false) => parent_key(key) == Some(g.key.as_str()),
            (Scope::Folder, true) => key == g.key,
            (Scope::Tree, false) => under(key, &g.key),
            (Scope::Tree, true) => key == g.key || under(key, &g.key),
        })
    }

    pub fn allows(&self, path: &Path, access: Access) -> bool {
        target_key(path, access).is_some_and(|k| self.allows_key(&k, access == Access::IntoFolder))
    }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Session grants + the persisted ones (user sources only, never prompt answers).
pub struct Grants {
    session: RwLock<GrantSet>,
    persisted: Mutex<Vec<Grant>>,
    file: Option<PathBuf>,
    prompt: Mutex<()>,
}

impl Grants {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let file = crate::platform::data_dir(app).ok().map(|d| d.join(PERSIST_FILE));
        let persisted: Vec<Grant> = file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut set = GrantSet::default();
        for g in &persisted {
            set.add_key(g.key.clone(), g.scope);
        }
        // the app's own folders
        if let Ok(d) = crate::platform::data_dir(app) {
            set.add(&d, Scope::Tree);
        }
        if let Ok(d) = crate::platform::cache_dir(app) {
            set.add(&d, Scope::Tree);
        }
        let p = app.path();
        for base in [p.video_dir(), p.picture_dir(), p.audio_dir()].into_iter().flatten() {
            set.add(&base.join("HS Studio"), Scope::Tree);
        }
        Grants { session: RwLock::new(set), persisted: Mutex::new(persisted), file, prompt: Mutex::new(()) }
    }

    fn add(&self, path: &Path, scope: Scope, persist: bool) {
        let access = if scope == Scope::File { Access::Create } else { Access::IntoFolder };
        let Some(key) = target_key(path, access) else { return };
        let added = self.session.write().unwrap_or_else(|e| e.into_inner()).add_key(key.clone(), scope);
        if persist && added {
            let mut list = self.persisted.lock().unwrap_or_else(|e| e.into_inner());
            list.retain(|g| !(g.key == key && g.scope == scope));
            list.push(Grant { key, scope });
            if list.len() > PERSIST_MAX {
                let extra = list.len() - PERSIST_MAX;
                list.drain(..extra);
            }
            if let Some(f) = &self.file {
                if let Ok(json) = serde_json::to_vec(&*list) {
                    let tmp = f.with_extension("json.tmp");
                    if std::fs::write(&tmp, json).is_ok() {
                        let _ = std::fs::rename(&tmp, f);
                    }
                }
            }
        }
    }

    fn allows(&self, path: &Path, access: Access) -> bool {
        self.session.read().unwrap_or_else(|e| e.into_inner()).allows(path, access)
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, Grants>> {
    app.try_state::<Grants>()
}

/// Files the user opened (dialog, OS hand-over, drop): the file and its folder (photos and
/// playlists move on to the files next to it; exports default to that folder). Persisted.
pub fn grant_opened<R: Runtime, P: AsRef<Path>>(app: &AppHandle<R>, paths: &[P]) {
    let Some(g) = state(app) else { return };
    for p in paths {
        let p = p.as_ref();
        if p.is_dir() {
            g.add(p, Scope::Tree, true);
        } else {
            g.add(p, Scope::File, true);
            if let Some(dir) = p.parent() {
                g.add(dir, Scope::Folder, true);
            }
        }
    }
}

/// A save target or a picked folder. Persisted (a remembered output folder is used again).
pub fn grant_picked<R: Runtime>(app: &AppHandle<R>, path: &Path, scope: Scope) {
    if let Some(g) = state(app) {
        g.add(path, scope, true);
    }
}

fn prompt_text(path: &Path, access: Access) -> String {
    let folder = if access == Access::IntoFolder { path } else { path.parent().unwrap_or(path) };
    let f = folder.to_string_lossy();
    format!(
        "HS Studio bu klasördeki dosyaları değiştirmek istiyor:\n{f}\n\nBu klasöre bu oturum boyunca izin verilsin mi?\n\n\
         HS Studio wants to change files in this folder:\n{f}\n\nAllow it for this session?"
    )
}

/// Refuses (`[path-not-granted]`) unless a grant covers `path` or the user allows its folder now.
/// Call from a blocking context (the question is a native, blocking dialog).
pub fn not_granted(path: &Path) -> String {
    format!("{ERR_NOT_GRANTED} ({})", path.display())
}

pub fn require(app: &AppHandle, path: &Path, access: Access) -> Result<(), String> {
    let Some(g) = state(app) else { return Err(not_granted(path)) };
    if target_key(path, access).is_none() {
        return Err(not_granted(path));
    }
    if g.allows(path, access) || in_library(app, path, access) {
        return Ok(());
    }
    let _one_question_at_a_time = g.prompt.lock().unwrap_or_else(|e| e.into_inner());
    if g.allows(path, access) {
        return Ok(()); // answered while this call waited
    }
    let allowed = match std::env::var(PROMPT_ENV).as_deref() {
        Ok("allow") => true,
        Ok("deny") => false,
        _ => ask(app, path, access),
    };
    if !allowed {
        return Err(not_granted(path));
    }
    let folder = if access == Access::IntoFolder { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
    g.add(&folder, Scope::Folder, false);
    if g.allows(path, access) { Ok(()) } else { Err(not_granted(path)) }
}

/// Same check for several targets (one question per folder at most).
pub fn require_all<P: AsRef<Path>>(app: &AppHandle, paths: &[P], access: Access) -> Result<(), String> {
    paths.iter().try_for_each(|p| require(app, p.as_ref(), access))
}

fn in_library(app: &AppHandle, path: &Path, access: Access) -> bool {
    let Some(key) = target_key(path, access) else { return false };
    let mut set = GrantSet::default();
    for root in crate::library::library_roots(app) {
        set.add(&root, Scope::Tree);
    }
    set.allows_key(&key, access == Access::IntoFolder)
}

fn ask(app: &AppHandle, path: &Path, access: Access) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut d = app
        .dialog()
        .message(prompt_text(path, access))
        .title("HS Studio")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("İzin ver / Allow".into(), "İptal / Cancel".into()));
    if let Some(w) = app.webview_windows().values().next() {
        d = d.parent(w);
    }
    d.blocking_show()
}

// ---------------------------------------------------------------------------
// Dialogs shown by Rust (replace the dialog plugin's JS commands)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DialogOptions {
    pub title: Option<String>,
    #[serde(default)]
    pub filters: Vec<DialogFilter>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub directory: bool,
    pub default_path: Option<PathBuf>,
}

fn builder<R: Runtime>(app: &AppHandle<R>, o: &DialogOptions) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    use tauri_plugin_dialog::DialogExt;
    let mut b = app.dialog().file();
    if let Some(w) = app.webview_windows().values().next() {
        b = b.set_parent(w);
    }
    if let Some(t) = &o.title {
        b = b.set_title(t);
    }
    for f in &o.filters {
        let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &ext);
    }
    if let Some(p) = &o.default_path {
        // same rule as the plugin: an existing folder opens there, otherwise folder + file name
        if p.is_dir() {
            b = b.set_directory(p);
        } else if let (Some(dir), Some(name)) = (p.parent(), p.file_name()) {
            if !dir.as_os_str().is_empty() {
                b = b.set_directory(dir);
            }
            b = b.set_file_name(name.to_string_lossy());
        }
    }
    b
}

fn to_paths(v: Vec<tauri_plugin_dialog::FilePath>) -> Vec<PathBuf> {
    v.into_iter().filter_map(|p| p.into_path().ok()).collect()
}

/// Open dialog (files or a folder). Returns a path, a list (`multiple`) or null like the
/// plugin's `open`; every picked path is granted and readable through the asset protocol.
#[tauri::command]
pub async fn dialog_open(app: AppHandle, options: Option<DialogOptions>) -> Result<serde_json::Value, String> {
    let o = options.unwrap_or_default();
    crate::actions::blocking(move || {
        let b = builder(&app, &o);
        let picked: Vec<PathBuf> = match (o.directory, o.multiple) {
            (true, false) => b.blocking_pick_folder().map(|p| to_paths(vec![p])).unwrap_or_default(),
            (true, true) => b.blocking_pick_folders().map(to_paths).unwrap_or_default(),
            (false, false) => b.blocking_pick_file().map(|p| to_paths(vec![p])).unwrap_or_default(),
            (false, true) => b.blocking_pick_files().map(to_paths).unwrap_or_default(),
        };
        let scope = app.asset_protocol_scope();
        for p in &picked {
            if o.directory {
                grant_picked(&app, p, Scope::Tree);
                let _ = scope.allow_directory(p, true);
            } else {
                grant_opened(&app, std::slice::from_ref(p));
                let _ = scope.allow_file(p);
            }
        }
        let s: Vec<String> = picked.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        Ok(if o.multiple {
            if s.is_empty() { serde_json::Value::Null } else { serde_json::json!(s) }
        } else {
            s.into_iter().next().map(serde_json::Value::from).unwrap_or(serde_json::Value::Null)
        })
    })
    .await
}

/// Save dialog; the chosen target is granted. Returns the path or null.
#[tauri::command]
pub async fn dialog_save(app: AppHandle, options: Option<DialogOptions>) -> Result<Option<String>, String> {
    let o = options.unwrap_or_default();
    crate::actions::blocking(move || {
        let picked = builder(&app, &o).blocking_save_file().and_then(|p| p.into_path().ok());
        if let Some(p) = &picked {
            // the target and its folder (exports write a temp file next to it; "save as" names
            // the output folder)
            grant_opened(&app, std::slice::from_ref(p));
            let _ = app.asset_protocol_scope().allow_file(p);
        }
        Ok(picked.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vho-grants-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn grants_file_folder_and_tree_scopes() {
        let d = tmp("scopes");
        let a = d.join("a");
        let sub = a.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        for f in [d.join("x.jpg"), a.join("y.jpg"), sub.join("z.jpg")] {
            std::fs::write(f, b"x").unwrap();
        }
        let mut file = GrantSet::default();
        assert!(file.add(&d.join("x.jpg"), Scope::File));
        assert!(file.allows(&d.join("x.jpg"), Access::Entry));
        assert!(!file.allows(&d.join("other.jpg"), Access::Create), "only that file");
        assert!(!file.allows(&d, Access::IntoFolder), "a file grant is no output folder");

        let mut folder = GrantSet::default();
        folder.add(&a, Scope::Folder);
        assert!(folder.allows(&a.join("y.jpg"), Access::Entry));
        assert!(folder.allows(&a.join("new.png"), Access::Create));
        assert!(folder.allows(&a, Access::IntoFolder));
        assert!(!folder.allows(&sub.join("z.jpg"), Access::Entry), "not below");
        assert!(!folder.allows(&d.join("x.jpg"), Access::Entry), "not above");

        let mut tree = GrantSet::default();
        tree.add(&a, Scope::Tree);
        assert!(tree.allows(&sub.join("z.jpg"), Access::Entry));
        assert!(tree.allows(&sub.join("new").join("deep.png"), Access::Create), "new folders below");
        assert!(tree.allows(&sub, Access::IntoFolder));
        assert!(!tree.allows(&a, Access::Entry), "not the granted folder itself");
        assert!(!tree.allows(&d.join("x.jpg"), Access::Entry));
        // a sibling whose name starts like the granted folder
        let a2 = d.join("a2");
        std::fs::create_dir_all(&a2).unwrap();
        assert!(!tree.allows(&a2.join("q.jpg"), Access::Create));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn grants_dot_dot_and_relative_paths_cannot_escape() {
        let d = tmp("dotdot");
        let a = d.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(d.join("secret.txt"), b"x").unwrap();
        let mut set = GrantSet::default();
        set.add(&a, Scope::Tree);
        // existing `..` resolves outside
        assert!(!set.allows(&a.join("..").join("secret.txt"), Access::Entry));
        assert!(!set.allows(&a.join("..").join("secret.txt"), Access::Content));
        // `..` behind a not yet existing part: refused, or (Windows resolves `..` before opening)
        // keyed at the real place outside the grant
        let escaped = target_key(&a.join("missing").join("..").join("..").join("secret.txt"), Access::Create);
        assert!(escaped.as_deref().is_none_or(|k| k == key_of(&canonical(&d.join("secret.txt")).unwrap())), "{escaped:?}");
        assert!(!set.allows(&a.join("missing").join("..").join("..").join("x.txt"), Access::Create));
        // relative paths are never granted
        assert!(!set.allows(Path::new("a/secret.txt"), Access::Create));
        assert!(!set.allows(Path::new("..\\secret.txt"), Access::Entry));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn grants_windows_case_prefixes_and_short_names() {
        let d = tmp("winforms");
        let a = d.join("Long Folder Name");
        std::fs::create_dir_all(&a).unwrap();
        let f = a.join("Photo File.jpg");
        std::fs::write(&f, b"x").unwrap();
        let mut set = GrantSet::default();
        set.add(&a, Scope::Folder);
        let upper = PathBuf::from(f.to_string_lossy().to_uppercase());
        assert!(set.allows(&upper, Access::Entry), "case-insensitive");
        let verbatim = PathBuf::from(format!(r"\\?\{}", f.display()));
        assert!(set.allows(&verbatim, Access::Entry), "\\\\?\\ prefix");
        assert!(set.allows(&PathBuf::from(f.to_string_lossy().replace('\\', "/")), Access::Entry), "forward slashes");
        // 8.3 short name of the folder (when the volume creates them)
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("cmd")
            .raw_arg(format!("/c for %I in (\"{}\") do @echo %~sI", a.display()))
            .output()
            .unwrap();
        let short = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !short.is_empty() && !short.eq_ignore_ascii_case(&a.to_string_lossy()) {
            assert!(set.allows(&PathBuf::from(&short).join("Photo File.jpg"), Access::Entry), "short name {short}");
        }
        // another folder in the same parent is not covered
        let other = d.join("Other");
        std::fs::create_dir_all(&other).unwrap();
        assert!(!set.allows(&other.join("x.jpg"), Access::Create));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn grants_junction_cannot_lead_out_of_a_grant() {
        let d = tmp("junction");
        let granted = d.join("granted");
        let outside = d.join("outside");
        std::fs::create_dir_all(&granted).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("victim.txt"), b"x").unwrap();
        let link = granted.join("link");
        use std::os::windows::process::CommandExt;
        let ok = std::process::Command::new("cmd")
            .raw_arg(format!("/c mklink /J \"{}\" \"{}\"", link.display(), outside.display()))
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "mklink /J");
        let mut set = GrantSet::default();
        set.add(&granted, Scope::Tree);
        let through = link.join("victim.txt");
        assert!(!set.allows(&through, Access::Entry), "trash through a junction");
        assert!(!set.allows(&through, Access::Content), "tag write through a junction");
        assert!(!set.allows(&link.join("new.png"), Access::Create), "output through a junction");
        assert!(!set.allows(&link, Access::IntoFolder));
        // the junction entry itself lives in the granted folder (removing the link is fine)
        assert!(set.allows(&link, Access::Entry));
        let _ = std::process::Command::new("cmd").raw_arg(format!("/c rmdir \"{}\"", link.display())).output();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn grants_root_folder_grant() {
        let d = tmp("root");
        let root = d.ancestors().last().unwrap().to_path_buf();
        let mut set = GrantSet::default();
        set.add(&root, Scope::Tree);
        assert!(set.allows(&d.join("x.txt"), Access::Create));
        assert!(set.allows(&root, Access::IntoFolder));
        let _ = std::fs::remove_dir_all(&d);
    }
}
