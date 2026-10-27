//! L02 library tests on generated fixtures in temp folders only (never user folders).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use rusqlite::params;

use super::scan::{self, Dir, Limits, ScanReport, Target};
use super::*;
use crate::storage::library::{LibraryDoc, save_doc, load_doc, upsert_media};
use crate::storage::{Storage, now_ms};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp(tag: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("vho-lib-{tag}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

fn write(p: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

fn open_db(dir: &Tmp) -> Storage {
    Storage::open(&dir.0.join("data")).unwrap()
}

fn add(s: &Storage, path: &Path) -> folders::AddResult {
    s.write(|tx| folders::add(tx, &path.to_string_lossy())).unwrap()
}

fn scan_all(s: &Storage) -> ScanReport {
    let targets: Vec<Target> = s
        .read(folders::library_folders)
        .unwrap()
        .into_iter()
        .map(|f| Target { folder_id: f.id, root: PathBuf::from(f.path), dirs: None })
        .collect();
    scan::scan(s, &targets, Limits::default(), &AtomicBool::new(false), &mut |_| {}).unwrap()
}

fn id_of(s: &Storage, path: &Path) -> Option<(String, String)> {
    let norm = crate::storage::identity::normalize_path(&path.to_string_lossy());
    s.read(|c| {
        use rusqlite::OptionalExtension;
        c.query_row("SELECT id, status FROM media WHERE path_norm = ?1", [norm], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    })
    .unwrap()
}

fn status_of_id(s: &Storage, id: &str) -> (String, String) {
    s.read(|c| c.query_row("SELECT status, path FROM media WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))).unwrap()
}

fn count(s: &Storage, sql: &str) -> i64 {
    s.read(|c| c.query_row(sql, [], |r| r.get(0))).unwrap()
}

/// 5,200 media files in nested folders + noise (text files, temp files, empty file).
/// Returns (media files, videos).
fn big_fixture(root: &Path) -> (usize, usize) {
    let (mut n, mut videos) = (0, 0);
    for d in 0..26 {
        for i in 0..200 {
            let ext = ["mp4", "mkv", "mp3", "flac", "jpg", "png"][(i + d) % 6];
            write(&root.join(format!("d{d:02}")).join(format!("sub{}", i % 4)).join(format!("file-{d}-{i}.{ext}")), format!("{d}/{i}").as_bytes());
            n += 1;
            if ext.starts_with('m') && ext != "mp3" {
                videos += 1;
            }
        }
    }
    write(&root.join("notes.txt"), b"x");
    write(&root.join("d00").join("movie.mp4.part"), b"partial");
    write(&root.join("d00").join("~$lock.mp4"), b"x");
    write(&root.join("d00").join("empty.mp4"), b"");
    (n, videos)
}

#[test]
fn scans_5000_files_and_a_second_scan_changes_nothing() {
    let t = tmp("big");
    let root = t.0.join("lib");
    let (n, videos) = big_fixture(&root);
    let s = open_db(&t);
    assert_eq!(add(&s, &root).status, "added");
    let r1 = scan_all(&s);
    assert_eq!(r1.found, n, "{r1:?}");
    assert_eq!(r1.added, n);
    assert_eq!((r1.missing, r1.moved, r1.truncated, r1.cancelled), (0, 0, false, false));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE in_library = 1 AND status = 'present'"), n as i64);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_fts"), count(&s, "SELECT COUNT(*) FROM media"));
    let f = s.read(folders::library_folders).unwrap().remove(0);
    assert_eq!((f.status.as_str(), f.file_count), ("online", n as i64));
    eprintln!("[bench] first scan of {n} files: {} ms", r1.elapsed_ms);

    // the same folder again: nothing to write, no duplicates
    let before = count(&s, "SELECT MAX(updated_at) FROM media");
    let r2 = scan_all(&s);
    assert_eq!((r2.found, r2.unchanged, r2.added, r2.updated, r2.missing), (n, n, 0, 0, 0));
    assert_eq!(count(&s, "SELECT MAX(updated_at) FROM media"), before);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media"), n as i64);
    eprintln!("[bench] rescan of {n} unchanged files: {} ms", r2.elapsed_ms);

    // paged query + FTS over 5k rows
    let started = std::time::Instant::now();
    let page = s.read(|c| query::query(c, &query::Query { kind: Some("video".into()), limit: 200, ..Default::default() })).unwrap();
    assert_eq!(page.items.len(), 200);
    assert_eq!(page.total as usize, videos);
    let hit = s.read(|c| query::query(c, &query::Query { search: Some("file-7-12".into()), ..Default::default() })).unwrap();
    assert!(hit.items.iter().any(|i| i.name == "file-7-12.mkv"), "{:?}", hit.items.iter().map(|i| &i.name).collect::<Vec<_>>());
    eprintln!("[bench] first page + search: {} ms", started.elapsed().as_millis());
}

#[test]
fn rename_move_delete_outside_the_app_are_reconciled() {
    // the watcher is not running here: these are "missed events"; the scan repairs them
    let t = tmp("moves");
    let root = t.0.join("lib");
    for name in ["a.mp4", "b.mp4", "c.mp4", "twin1/same.mp4"] {
        write(&root.join(name), name.as_bytes());
    }
    write(&root.join("twin2").join("same.mp4"), b"twin1/same.mp4"); // same name + size, different file
    let s = open_db(&t);
    add(&s, &root);
    scan_all(&s);
    let (a, _) = id_of(&s, &root.join("a.mp4")).unwrap();
    let (b, _) = id_of(&s, &root.join("b.mp4")).unwrap();
    let (c, _) = id_of(&s, &root.join("c.mp4")).unwrap();
    // user data on a / b: favorite, rating, tag, resume position + bookmark (player key)
    s.write(|tx| {
        tx.execute("UPDATE media SET favorite = 1, favorited_at = 1 WHERE id = ?1", [&a])?;
        query::set_rating(tx, &[root.join("b.mp4").to_string_lossy().into_owned()], 4)?;
        query::set_tags(tx, &[root.join("b.mp4").to_string_lossy().into_owned()], &["Tatil".into()], &[])?;
        tx.execute("INSERT INTO resume_positions (key, seconds, seq, updated_at) VALUES (?1, 42, 0, 0)", [ops::resume_key("a.mp4", Some(5))])?;
        tx.execute("INSERT INTO bookmarks (file_key, time, label, created_at) VALUES (?1, 3, 'x', 0)", [ops::resume_key("a.mp4", Some(5))])?;
        Ok(())
    })
    .unwrap();

    std::fs::rename(root.join("a.mp4"), root.join("renamed.mp4")).unwrap();
    std::fs::create_dir_all(root.join("moved")).unwrap();
    std::fs::rename(root.join("b.mp4"), root.join("moved").join("b.mp4")).unwrap();
    std::fs::remove_file(root.join("c.mp4")).unwrap();
    std::fs::remove_file(root.join("twin1").join("same.mp4")).unwrap();

    let r = scan_all(&s);
    assert_eq!((r.moved, r.missing), (2, 2), "{r:?}");
    assert_eq!(r.added, 0, "{r:?}");
    assert_eq!(status_of_id(&s, &a), ("present".into(), root.join("renamed.mp4").to_string_lossy().into_owned()));
    assert_eq!(status_of_id(&s, &b).0, "present");
    assert_eq!(status_of_id(&s, &c).0, "missing");
    // favorite / rating / tag stay on the identity
    let fav: i64 = s.read(|c2| c2.query_row("SELECT favorite FROM media WHERE id = ?1", [&a], |r| r.get(0))).unwrap();
    assert_eq!(fav, 1);
    let meta = s.read(|c2| query::meta_by_paths(c2, &[root.join("moved").join("b.mp4").to_string_lossy().into_owned()])).unwrap();
    assert_eq!((meta[0].rating, meta[0].tags.clone()), (Some(4), vec!["Tatil".to_string()]));
    // resume position + bookmark follow the rename (new player key)
    let new_key = ops::resume_key("renamed.mp4", Some(5));
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM resume_positions WHERE key = '{new_key}' AND seconds = 42")), 1);
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM bookmarks WHERE file_key = '{new_key}'")), 1);
    assert_eq!(r.moves.len(), 2);
    // the look-alike twin (same name/size, other file) was not merged with the deleted one
    let twin = id_of(&s, &root.join("twin2").join("same.mp4")).unwrap();
    assert_eq!(twin.1, "present");

    // the file comes back: same identity again
    write(&root.join("c.mp4"), b"c.mp4");
    let r = scan_all(&s);
    assert_eq!(r.updated, 1, "{r:?}");
    assert_eq!(status_of_id(&s, &c).0, "present");
}

#[test]
fn a_stale_frontend_document_follows_the_rename() {
    let t = tmp("doc");
    let root = t.0.join("lib");
    write(&root.join("film.mp4"), b"12345");
    let s = open_db(&t);
    add(&s, &root);
    scan_all(&s);
    let old = root.join("film.mp4").to_string_lossy().into_owned();
    let old_key = ops::resume_key("film.mp4", Some(5));
    let doc = LibraryDoc { favorites: vec![old.clone()], resume: vec![(old_key.clone(), 30.0)], ..Default::default() };
    s.write(|tx| save_doc(tx, &doc)).unwrap();
    let (id, _) = id_of(&s, &root.join("film.mp4")).unwrap();

    // D1 rename through the operation log
    let new = root.join("Yeni ad – ğüşİ.mp4");
    let op = s.write(|tx| Ok(ops::begin(tx, "rename", &old, Some(&new.to_string_lossy()))?)).unwrap();
    std::fs::rename(&old, &new).unwrap();
    let moved = s.write(|tx| Ok(ops::finish_rename(tx, op, &old, &new.to_string_lossy())?)).unwrap().unwrap();
    assert_eq!(moved.media_id, id);
    // the frontend saves its old document once more (before it heard of the rename)
    s.write(|tx| save_doc(tx, &doc)).unwrap();
    let loaded = s.read(load_doc).unwrap();
    assert_eq!(loaded.favorites, vec![new.to_string_lossy().into_owned()]);
    assert_eq!(loaded.resume, vec![(ops::resume_key("Yeni ad – ğüşİ.mp4", Some(5)), 30.0)]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media"), 1, "no ghost row at the old path");
    assert_eq!(status_of_id(&s, &id).0, "present");
}

#[test]
fn crash_between_disk_change_and_database_is_reconciled() {
    let t = tmp("crash");
    let root = t.0.join("lib");
    write(&root.join("a.mp4"), b"a");
    write(&root.join("b.mp4"), b"b");
    write(&root.join("c.mp4"), b"c");
    let s = open_db(&t);
    add(&s, &root);
    scan_all(&s);
    let p = |n: &str| root.join(n).to_string_lossy().into_owned();
    let (a, _) = id_of(&s, &root.join("a.mp4")).unwrap();
    let (b, _) = id_of(&s, &root.join("b.mp4")).unwrap();
    // rename done on disk, app "crashed" before finish
    s.write(|tx| Ok(ops::begin(tx, "rename", &p("a.mp4"), Some(&p("a2.mp4")))?)).unwrap();
    std::fs::rename(p("a.mp4"), p("a2.mp4")).unwrap();
    // trash done on disk (simulated by delete), crash
    s.write(|tx| Ok(ops::begin(tx, "trash", &p("b.mp4"), None)?)).unwrap();
    std::fs::remove_file(p("b.mp4")).unwrap();
    // rename that never happened on disk
    s.write(|tx| Ok(ops::begin(tx, "rename", &p("c.mp4"), Some(&p("c2.mp4")))?)).unwrap();
    drop(s);

    let s = open_db(&t);
    let (done, failed, moves) = ops::reconcile_pending(&s).unwrap();
    assert_eq!((done, failed, moves.len()), (2, 1, 1));
    assert_eq!(status_of_id(&s, &a), ("present".into(), p("a2.mp4")));
    assert_eq!(status_of_id(&s, &b).0, "deleted");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_ops WHERE state = 'pending'"), 0);
    // "deleted" (recycle bin) is not turned into "missing" by a scan
    scan_all(&s);
    assert_eq!(status_of_id(&s, &b).0, "deleted");
}

#[test]
fn same_folder_twice_nested_and_parent_folders() {
    let t = tmp("twice");
    let root = t.0.join("lib");
    write(&root.join("sub").join("x.mp3"), b"x");
    write(&root.join("y.mp3"), b"y");
    let s = open_db(&t);
    // the subfolder first, then the parent: merged into one library folder
    assert_eq!(add(&s, &root.join("sub")).status, "added");
    scan_all(&s);
    let parent = add(&s, &root);
    assert_eq!(parent.status, "added");
    assert_eq!(parent.merged.len(), 1);
    assert_eq!(add(&s, &root).status, "exists");
    let with_slash = format!("{}{}", root.to_string_lossy(), std::path::MAIN_SEPARATOR);
    assert_eq!(s.write(|tx| folders::add(tx, &with_slash)).unwrap().status, "exists");
    assert_eq!(add(&s, &root.join("sub")).status, "covered");
    assert_eq!(s.read(folders::library_folders).unwrap().len(), 1);
    let r = scan_all(&s);
    assert_eq!((r.found, r.added), (2, 1), "{r:?}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media"), 2);
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM media WHERE folder_id = '{}'", parent.folder.id)), 2);
    // a missing folder is refused
    assert!(s.write(|tx| folders::add(tx, &root.join("nope").to_string_lossy())).is_err());

    // removing the folder keeps user data, drops the rest of the index
    s.write(|tx| query::set_rating(tx, &[root.join("y.mp3").to_string_lossy().into_owned()], 5)).unwrap();
    let dropped = s.write(|tx| folders::remove(tx, &parent.folder.id)).unwrap();
    assert_eq!(dropped, 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE in_library = 0 AND rating = 5"), 1);
    assert!(s.read(folders::library_folders).unwrap().is_empty());
}

#[test]
fn deleted_library_folder_is_missing_not_offline() {
    let t = tmp("folder-gone");
    let root = t.0.join("lib");
    write(&root.join("a.jpg"), b"a");
    let s = open_db(&t);
    add(&s, &root);
    scan_all(&s);
    std::fs::rename(&root, t.0.join("lib-renamed")).unwrap();
    let r = scan_all(&s);
    assert_eq!((r.missing_folders, r.offline_folders), (1, 0));
    assert_eq!(s.read(folders::library_folders).unwrap()[0].status, "missing");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE status = 'missing'"), 1);
    std::fs::rename(t.0.join("lib-renamed"), &root).unwrap();
    scan_all(&s);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE status = 'present'"), 1);
    assert_eq!(s.read(folders::library_folders).unwrap()[0].status, "online");
}

/// Simulated external disk: a `subst` drive letter created and removed by the test itself.
#[cfg(windows)]
#[test]
fn ejected_disk_is_offline_and_comes_back_with_the_same_identity() {
    use std::process::Command;
    let t = tmp("eject");
    let disk = t.0.join("disk");
    write(&disk.join("Filmler").join("film.mkv"), b"film");
    write(&disk.join("Filmler").join("klip.mp4"), b"klip");
    let letter = ('P'..='Z').rev().find(|l| !Path::new(&format!("{l}:\\")).exists()).expect("a free drive letter");
    let drive = format!("{letter}:");
    let mount = |on: bool| {
        let st = if on {
            Command::new("subst").arg(&drive).arg(&disk).status()
        } else {
            Command::new("subst").arg(&drive).arg("/d").status()
        }
        .expect("subst");
        assert!(st.success(), "subst {on}");
    };
    struct Unmount(String);
    impl Drop for Unmount {
        fn drop(&mut self) {
            let _ = std::process::Command::new("subst").arg(&self.0).arg("/d").status();
        }
    }
    mount(true);
    let _guard = Unmount(drive.clone());
    let root = PathBuf::from(format!("{drive}\\Filmler"));
    let s = open_db(&t);
    add(&s, &root);
    assert_eq!(scan_all(&s).added, 2);
    let (id, _) = id_of(&s, &root.join("film.mkv")).unwrap();
    s.write(|tx| query::set_rating(tx, &[root.join("film.mkv").to_string_lossy().into_owned()], 3)).unwrap();

    mount(false); // "eject"
    assert_eq!(scan::root_state(&root), scan::RootState::Offline);
    let r = scan_all(&s);
    assert_eq!((r.offline_folders, r.missing), (1, 0), "{r:?}");
    assert_eq!(s.read(folders::library_folders).unwrap()[0].status, "offline");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE status = 'offline'"), 2);
    // offline items stay visible (greyed in the UI), never "missing"
    let page = s.read(|c| query::query(c, &query::Query::default())).unwrap();
    assert_eq!(page.total, 2);

    mount(true); // plugged in again
    let r = scan_all(&s);
    assert_eq!((r.added, r.updated), (0, 2), "{r:?}");
    assert_eq!(status_of_id(&s, &id).0, "present");
    let meta = s.read(|c| query::meta_by_paths(c, &[root.join("film.mkv").to_string_lossy().into_owned()])).unwrap();
    assert_eq!(meta[0].rating, Some(3));
    assert_eq!(s.read(folders::library_folders).unwrap()[0].status, "online");
}

#[cfg(windows)]
#[test]
fn junction_loops_are_not_followed() {
    let t = tmp("loop");
    let root = t.0.join("lib");
    write(&root.join("a").join("x.mp4"), b"x");
    let st = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(root.join("a").join("loop"))
        .arg(&root)
        .output()
        .expect("mklink");
    assert!(st.status.success(), "{}", String::from_utf8_lossy(&st.stdout));
    let s = open_db(&t);
    add(&s, &root);
    let r = scan_all(&s);
    assert_eq!((r.found, r.skipped_links), (1, 1), "{r:?}");
    let _ = std::fs::remove_dir(root.join("a").join("loop"));
}

#[test]
fn cancel_keeps_committed_batches_and_limits_truncate_without_missing() {
    let t = tmp("cancel");
    let root = t.0.join("lib");
    for i in 0..1200 {
        write(&root.join(format!("f{i:04}.mp3")), b"x");
    }
    let s = open_db(&t);
    let f = add(&s, &root).folder;
    let targets = vec![Target { folder_id: f.id.clone(), root: root.clone(), dirs: None }];
    // cancel when the second batch is about to start
    let cancel = AtomicBool::new(false);
    let r = scan::scan(&s, &targets, Limits::default(), &cancel, &mut |p| {
        if p.phase == "write" && p.done >= 500 {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    })
    .unwrap();
    assert!(r.cancelled);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media"), 500, "exactly the committed batch");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_fts"), 500);
    let r = scan_all(&s);
    assert_eq!((r.added, r.unchanged), (700, 500));

    // a truncated walk (file limit) never declares the unseen rest missing
    let r = scan::scan(&s, &targets, Limits { max_depth: 48, max_files: 100 }, &AtomicBool::new(false), &mut |_| {}).unwrap();
    assert!(r.truncated);
    assert_eq!(r.missing, 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media WHERE status = 'present'"), 1200);
}

#[test]
fn partial_scope_scans_only_given_dirs() {
    let t = tmp("partial");
    let root = t.0.join("lib");
    write(&root.join("a").join("1.mp4"), b"1");
    write(&root.join("b").join("2.mp4"), b"2");
    let s = open_db(&t);
    let f = add(&s, &root).folder;
    scan_all(&s);
    std::fs::rename(root.join("a").join("1.mp4"), root.join("b").join("1.mp4")).unwrap();
    std::fs::remove_file(root.join("b").join("2.mp4")).unwrap();
    write(&root.join("c").join("3.mp4"), b"3");
    // watcher-style scope: both directories of the move, shallow + the new dir
    let dirs = vec![
        Dir { path: root.join("a"), recursive: false },
        Dir { path: root.join("b"), recursive: false },
        Dir { path: root.join("c"), recursive: true },
    ];
    let r = scan::scan(&s, &[Target { folder_id: f.id, root: root.clone(), dirs: Some(dirs) }], Limits::default(), &AtomicBool::new(false), &mut |_| {})
        .unwrap();
    assert_eq!((r.moved, r.missing, r.added), (1, 1, 1), "{r:?}");
}

#[test]
fn shared_query_views_search_and_music_groups() {
    let t = tmp("query");
    let root = t.0.join("lib");
    write(&root.join("İstanbul Gezisi.mp4"), b"v1");
    write(&root.join("Kedi.mp4"), b"v22");
    write(&root.join("Şarkı.mp3"), b"a1");
    write(&root.join("other.mp3"), b"a22");
    write(&root.join("foto.jpg"), b"p");
    let s = open_db(&t);
    add(&s, &root);
    scan_all(&s);
    let p = |n: &str| root.join(n).to_string_lossy().into_owned();
    let (song, _) = id_of(&s, &root.join("Şarkı.mp3")).unwrap();
    let (other, _) = id_of(&s, &root.join("other.mp3")).unwrap();
    s.write(|tx| {
        let m = scan::AudioMeta { title: Some("Gül Pembe".into()), artist: Some("Barış Manço".into()), album: Some("Sakla Samanı".into()), track: Some(2), ..Default::default() };
        scan::store_audio_meta(tx, &song, &m, 0)?;
        let m = scan::AudioMeta { title: Some("Song".into()), artist: Some("Other".into()), album: Some("X".into()), ..Default::default() };
        scan::store_audio_meta(tx, &other, &m, 0)?;
        query::set_tags(tx, &[p("foto.jpg")], &["Aile".into(), " aile ".into(), "Yaz 2024".into()], &[])?;
        query::set_rating(tx, &[p("foto.jpg")], 5)?;
        tx.execute(
            "INSERT INTO resume_positions (key, seconds, seq, updated_at) VALUES (?1, 61, 0, 5)",
            [ops::resume_key("Kedi.mp4", Some(3))],
        )?;
        Ok(())
    })
    .unwrap();
    let q = |q: query::Query| s.read(|c| query::query(c, &q)).unwrap();
    let names = |pg: query::Page| pg.items.into_iter().map(|i| i.name).collect::<Vec<_>>();
    // FTS: diacritics/case folded, Turkish İ, title/artist/tag fields, prefix match
    assert_eq!(names(q(query::Query { search: Some("istanbul".into()), ..Default::default() })), vec!["İstanbul Gezisi.mp4"]);
    assert_eq!(names(q(query::Query { search: Some("İSTANBUL gez".into()), ..Default::default() })), vec!["İstanbul Gezisi.mp4"]);
    assert_eq!(names(q(query::Query { search: Some("baris".into()), ..Default::default() })), vec!["Şarkı.mp3"]);
    assert_eq!(names(q(query::Query { search: Some("gul pem".into()), ..Default::default() })), vec!["Şarkı.mp3"]);
    assert_eq!(names(q(query::Query { search: Some("aile".into()), ..Default::default() })), vec!["foto.jpg"]);
    assert_eq!(names(q(query::Query { search: Some("\" OR * NEAR(".into()), ..Default::default() })).len(), 0, "no FTS syntax injection");
    // tags: case-insensitive, one per spelling
    let meta = s.read(|c| query::meta_by_paths(c, &[p("foto.jpg"), p("Kedi.mp4")])).unwrap();
    assert_eq!(meta.len(), 1);
    assert_eq!(meta[0].tags, vec!["Aile".to_string(), "Yaz 2024".to_string()]);
    assert_eq!(names(q(query::Query { tag: Some("AİLE".into()), ..Default::default() })), vec!["foto.jpg"]);
    assert_eq!(names(q(query::Query { kind: Some("image".into()), min_rating: Some(4), ..Default::default() })), vec!["foto.jpg"]);
    // continue watching (resume key computed from name + size like the player)
    let cont = q(query::Query { kind: Some("video".into()), view: Some("continue".into()), ..Default::default() });
    assert_eq!(cont.items.len(), 1);
    assert_eq!((cont.items[0].name.as_str(), cont.items[0].resume_seconds), ("Kedi.mp4", Some(61.0)));
    // music for L03
    let artists = s.read(|c| query::music_groups(c, "artist", None)).unwrap();
    assert_eq!(artists.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), vec!["Barış Manço", "Other"]);
    let albums = s.read(|c| query::music_groups(c, "album", Some("barış"))).unwrap();
    assert_eq!((albums.len(), albums[0].name.as_str()), (1, "Sakla Samanı"));
    let by_artist = q(query::Query { kind: Some("audio".into()), artist: Some("barış manço".into()), sort: Some("track".into()), ..Default::default() });
    assert_eq!(by_artist.items[0].title.as_deref(), Some("Gül Pembe"));
    // paging
    let pg = q(query::Query { limit: 2, offset: 2, ..Default::default() });
    assert_eq!((pg.total, pg.items.len()), (5, 2));
    // played count
    s.write(|tx| query::mark_played(tx, &p("Kedi.mp4"))).unwrap();
    assert_eq!(names(q(query::Query { view: Some("mostPlayed".into()), ..Default::default() })), vec!["Kedi.mp4"]);
    // FTS repair
    s.read(|c| c.execute("DELETE FROM media_fts", [])).unwrap();
    assert!(s.read(query::check_fts).unwrap());
    assert!(!s.read(query::check_fts).unwrap());
    assert_eq!(names(q(query::Query { search: Some("kedi".into()), ..Default::default() })), vec!["Kedi.mp4"]);
}

#[test]
fn folder_favorites_import_once_and_toggle() {
    let t = tmp("favs");
    let s = open_db(&t);
    let a = t.0.join("A").to_string_lossy().into_owned();
    let b = t.0.join("B").to_string_lossy().into_owned();
    assert!(s.write(|tx| folders::import_studio_favorites(tx, &[a.clone(), b.clone()])).unwrap());
    assert!(!s.write(|tx| folders::import_studio_favorites(tx, &["Z:\\x".into()])).unwrap());
    assert_eq!(s.read(folders::favorites).unwrap(), vec![a.clone(), b.clone()]);
    s.write(|tx| folders::set_favorite(tx, &a, false)).unwrap();
    s.write(|tx| folders::set_favorite(tx, &a, true)).unwrap();
    assert_eq!(s.read(folders::favorites).unwrap(), vec![b, a]);
    assert!(s.read(folders::library_folders).unwrap().is_empty(), "a favorite folder is not a library folder");
}

#[test]
fn playlist_round_trip_relative_unicode_bom_missing_and_urls() {
    use playlist::{Entry, Format};
    let t = tmp("pl");
    let music = t.0.join("Müzik");
    let song = music.join("Albüm").join("01 Şarkı.mp3");
    let other = t.0.join("Diğer").join("ses.flac");
    write(&song, b"s");
    write(&other, b"o");
    let missing = music.join("yok.mp3");
    let list_path = music.join("liste.m3u8");
    let entries = vec![
        Entry { path: Some(song.to_string_lossy().into()), title: Some("Şarkı Bir".into()), duration: Some(201.0), ..Default::default() },
        Entry { url: Some("https://radyo.example/stream?a=1".into()), title: Some("Radyo".into()), ..Default::default() },
        Entry { path: Some(missing.to_string_lossy().into()), ..Default::default() },
        Entry { path: Some(other.to_string_lossy().into()), ..Default::default() },
    ];
    for (name, fmt) in [("liste.m3u8", Format::M3u8), ("liste.m3u", Format::M3u), ("liste.pls", Format::Pls)] {
        let out = music.join(name);
        let text = playlist::write(&entries, fmt, &out, true);
        assert!(text.contains(&format!("Albüm{}01 Şarkı.mp3", std::path::MAIN_SEPARATOR)), "relative: {text}");
        assert!(text.contains(&format!("..{}Diğer", std::path::MAIN_SEPARATOR)), "{text}");
        assert_eq!(text.starts_with('\u{feff}'), fmt == Format::M3u, "BOM only for .m3u");
        playlist::write_file(&entries, &out, true).unwrap();
        let back = playlist::read_file(&out).unwrap();
        assert_eq!(back.entries.len(), 4, "{name}");
        assert_eq!(back.entries[0].path.as_deref(), Some(&*song.to_string_lossy()));
        assert_eq!(back.entries[0].title.as_deref(), Some("Şarkı Bir"));
        assert_eq!(back.entries[0].duration, Some(201.0));
        assert_eq!(back.entries[1].url.as_deref(), Some("https://radyo.example/stream?a=1"));
        assert_eq!(back.entries[2].path.as_deref(), Some(&*missing.to_string_lossy()));
        assert_eq!(back.entries[3].path.as_deref(), Some(&*other.to_string_lossy()));
    }

    // foreign files: UTF-16 BOM, Windows-1254 bytes, file:// URIs, forbidden schemes
    let base = music.clone();
    let utf16: Vec<u8> = [0xFF, 0xFE].into_iter().chain("#EXTM3U\r\nAlbüm\\01 Şarkı.mp3\r\n".encode_utf16().flat_map(u16::to_le_bytes)).collect();
    let p = playlist::parse(&playlist::decode(&utf16), Format::M3u, &base);
    assert_eq!(p.entries[0].path.as_deref(), Some(&*song.to_string_lossy()));
    let ansi = b"#EXTINF:5,\xdeark\xfd\r\nAlb\xfcm/01 \xdeark\xfd.mp3\r\n";
    let p = playlist::parse(&playlist::decode(ansi), Format::M3u, &base);
    assert_eq!(p.entries[0].title.as_deref(), Some("Şarkı"));
    assert_eq!(p.entries[0].path.as_deref(), Some(&*song.to_string_lossy()));
    let uri = format!("file:///{}", song.to_string_lossy().replace('\\', "/").replace(' ', "%20").trim_start_matches('/'));
    let text = format!("\u{feff}#EXTM3U\n{uri}\njavascript:alert(1)\ndata:text/html,x\nrtsp://cam.local/live\n");
    let p = playlist::parse(&text, Format::M3u8, &base);
    assert_eq!(p.entries.len(), 2, "{p:?}");
    assert_eq!(p.entries[0].path.as_deref(), Some(&*song.to_string_lossy()));
    assert_eq!(p.skipped.len(), 2);
    let pls = "[playlist]\nFile2=b.mp3\nTitle1=Bir\nFile1=a.mp3\nNumberOfEntries=2\n";
    let p = playlist::parse(pls, Format::Pls, &base);
    assert_eq!(p.entries.iter().map(|e| e.path.clone().unwrap()).collect::<Vec<_>>(), vec![
        base.join("a.mp3").to_string_lossy().into_owned(),
        base.join("b.mp3").to_string_lossy().into_owned()
    ]);
    assert_eq!(p.entries[0].title.as_deref(), Some("Bir"));

    // saved list keeps order, marks the missing file, follows a rename of a member
    let s = open_db(&t);
    let id = s.write(|tx| playlist::save(tx, None, "Yol", &entries)).unwrap();
    let got = s.read(|c| playlist::get(c, &id)).unwrap().unwrap();
    assert_eq!(got.items.iter().map(|i| i.missing).collect::<Vec<_>>(), vec![false, false, true, false]);
    let new = music.join("Albüm").join("01 Şarkı (yeni).mp3");
    let op = s.write(|tx| Ok(ops::begin(tx, "rename", &song.to_string_lossy(), None)?)).unwrap();
    std::fs::rename(&song, &new).unwrap();
    s.write(|tx| Ok(ops::finish_rename(tx, op, &song.to_string_lossy(), &new.to_string_lossy())?)).unwrap();
    let got = s.read(|c| playlist::get(c, &id)).unwrap().unwrap();
    assert_eq!(got.items[0].path.as_deref(), Some(&*new.to_string_lossy()));
    assert!(!got.items[0].missing);
    assert_eq!(s.read(playlist::list).unwrap()[0].count, 4);
    assert!(s.write(|tx| Ok(playlist::delete(tx, &id)?)).unwrap());
    let _ = list_path;
}

#[test]
fn watcher_reports_changes_as_scopes() {
    use std::sync::mpsc::channel;
    let t = tmp("watch");
    let root = t.0.join("lib");
    std::fs::create_dir_all(&root).unwrap();
    let (tx, rx) = channel();
    let mut w = watch::start(tx).unwrap();
    assert!(w.set_roots(std::slice::from_ref(&root)).is_empty());
    std::thread::sleep(std::time::Duration::from_millis(200));
    write(&root.join("sub").join("new.mp4"), b"n");
    let (out_tx, out_rx) = channel();
    let roots = vec![root.clone()];
    std::thread::spawn(move || watch::debounce(rx, move || roots.clone(), move |b| { let _ = out_tx.send(b); }));
    let batch = out_rx.recv_timeout(std::time::Duration::from_secs(10)).expect("watcher event");
    match batch {
        watch::Batch::Dirs(d) => {
            assert_eq!(d[0].0, root);
            assert!(d[0].1.iter().any(|x| x.path == root.join("sub") || x.path == root), "{d:?}");
        }
        other => panic!("{other:?}"),
    }
    drop(w);
}

#[test]
fn upsert_of_a_returned_file_marks_it_present() {
    let t = tmp("upsert");
    let f = t.0.join("x.mp4");
    write(&f, b"x");
    let s = open_db(&t);
    let id = s.write(|tx| upsert_media(tx, Some(&f.to_string_lossy()), None, None, None)).unwrap();
    s.write(|tx| Ok(tx.execute("UPDATE media SET status = 'deleted' WHERE id = ?1", params![id])?)).unwrap();
    s.write(|tx| upsert_media(tx, Some(&f.to_string_lossy()), None, None, None)).unwrap();
    assert_eq!(status_of_id(&s, &id).0, "present");
}
