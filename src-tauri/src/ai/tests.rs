//! Component manager tests against a local HTTP fixture server (no internet, no real models).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::download::Policy;
use super::error::ErrorCode;
use super::manifest::{self, Component, Download, Extract};
use super::*;

// ---------------------------------------------------------------------------------------
// Fixture HTTP server
// ---------------------------------------------------------------------------------------

#[derive(Default)]
struct ServerState {
    files: HashMap<String, Vec<u8>>,
    /// (path, Range header) of every request
    log: Vec<(String, Option<String>)>,
    /// first response for these paths stops after half of the body
    cut_once: HashSet<String>,
    /// bodies sent in small chunks with pauses
    slow: HashSet<String>,
    /// headers then silence
    hang: HashSet<String>,
    /// no ETag / Last-Modified
    no_validator: HashSet<String>,
    /// every request answers 500
    down: bool,
}

struct Server {
    base: String,
    state: Arc<Mutex<ServerState>>,
}

impl Server {
    fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(ServerState::default()));
        let st = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let st = st.clone();
                std::thread::spawn(move || serve(stream, st));
            }
        });
        Server { base, state }
    }

    fn add(&self, path: &str, data: Vec<u8>) -> String {
        self.state.lock().unwrap().files.insert(path.into(), data);
        format!("{}{}", self.base, path)
    }

    fn with<R>(&self, f: impl FnOnce(&mut ServerState) -> R) -> R {
        f(&mut self.state.lock().unwrap())
    }

    fn requests(&self, path: &str) -> Vec<Option<String>> {
        self.with(|s| s.log.iter().filter(|(p, _)| p == path).map(|(_, r)| r.clone()).collect())
    }
}

fn serve(mut stream: TcpStream, st: Arc<Mutex<ServerState>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return;
    }
    let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut range = None;
    let mut if_range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("range:") {
            range = Some(v.trim().to_string());
        } else if lower.starts_with("if-range:") {
            if_range = Some(line[9..].trim().to_string());
        }
    }
    let (body, etag, cut, slow, hang, down) = {
        let mut s = st.lock().unwrap();
        s.log.push((path.clone(), range.clone()));
        let body = s.files.get(&path).cloned();
        let etag = body.as_ref().map(|b| format!("\"{}\"", &hex(&Sha256::digest(b))[..16]));
        let etag = if s.no_validator.contains(&path) { None } else { etag };
        let cut = s.cut_once.remove(&path);
        (body, etag, cut, s.slow.contains(&path), s.hang.contains(&path), s.down)
    };
    let Some(body) = body.filter(|_| !down) else {
        let code = if down { "500 Internal Server Error" } else { "404 Not Found" };
        let _ = write!(stream, "HTTP/1.1 {code}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let mut start = 0usize;
    let mut status = "200 OK".to_string();
    let mut extra = String::new();
    if let (Some(r), Some(tag)) = (range.as_deref(), etag.as_deref()) {
        let honour = if_range.as_deref().is_none_or(|v| v == tag);
        if let (true, Some(from)) = (honour, r.strip_prefix("bytes=").and_then(|v| v.trim_end_matches('-').parse::<usize>().ok())) {
            start = from.min(body.len());
            status = "206 Partial Content".into();
            extra = format!("Content-Range: bytes {start}-{}/{}\r\n", body.len() - 1, body.len());
        }
    }
    if let Some(tag) = &etag {
        extra.push_str(&format!("ETag: {tag}\r\nAccept-Ranges: bytes\r\n"));
    }
    let part = &body[start..];
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n", part.len());
    if hang {
        let _ = stream.write_all(&part[..part.len().min(1000)]);
        std::thread::sleep(Duration::from_secs(5));
        return;
    }
    let send = if cut { &part[..part.len() / 2] } else { part };
    if slow {
        for chunk in send.chunks(16 * 1024) {
            if stream.write_all(chunk).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    } else {
        let _ = stream.write_all(send);
    }
    let _ = stream.flush();
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

fn data(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + seed as usize * 7) % 251) as u8 ^ (i >> 9) as u8).collect()
}

fn sha(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

fn temp_root() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!("vho-ai-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn file_dl(url: &str, name: &str, bytes: &[u8]) -> Download {
    Download { url: url.into(), sha256: sha(bytes), bytes: bytes.len() as u64, name: Some(name.into()), extract: vec![] }
}

fn component(id: &str, downloads: Vec<Download>) -> Component {
    Component {
        id: id.into(),
        version: "v1".into(),
        task: "test".into(),
        title: id.into(),
        author: "VHO tests".into(),
        license: "CC0-1.0".into(),
        source: "local".into(),
        input: String::new(),
        output: String::new(),
        process_version: 0,
        tested_backends: vec![],
        external_data: vec![],
        downloads,
    }
}

struct Fixture {
    m: Arc<Manager>,
    root: PathBuf,
    events: Arc<Mutex<Vec<ProgressEvent>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fast_policy() -> Policy {
    Policy {
        attempts: 3,
        backoff: Duration::from_millis(20),
        connect_timeout: Duration::from_secs(5),
        stall_timeout: Duration::from_millis(600),
    }
}

fn fixture(components: Vec<Component>) -> Fixture {
    fixture_with(components, Arc::new(|_: &Path| None))
}

fn fixture_with(components: Vec<Component>, free: FreeSpace) -> Fixture {
    for c in &components {
        manifest::validate(c, true).unwrap();
    }
    let root = temp_root();
    let events = Arc::new(Mutex::new(vec![]));
    let ev = events.clone();
    let emit: Emit = Arc::new(move |e| ev.lock().unwrap().push(e));
    let m = Manager::new(root.clone(), components, fast_policy(), emit, free);
    Fixture { m, root, events }
}

fn run<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".part")).collect())
        .unwrap_or_default()
}

async fn wait_progress(fx: &Fixture, id: &str, min: u64) {
    for _ in 0..500 {
        if fx.events.lock().unwrap().iter().any(|e| e.id == id && e.phase == "download" && e.done >= min) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no download progress for {id}");
}

// ---------------------------------------------------------------------------------------
// Zip writer (fixtures only)
// ---------------------------------------------------------------------------------------

struct ZipItem<'a> {
    name: &'a str,
    data: &'a [u8],
    deflate: bool,
    symlink: bool,
    /// size written to the central directory (None = real size)
    claimed_size: Option<u64>,
}

fn item<'a>(name: &'a str, data: &'a [u8], deflate: bool) -> ZipItem<'a> {
    ZipItem { name, data, deflate, symlink: false, claimed_size: None }
}

fn make_zip(items: &[ZipItem], zip64: bool) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    let mut out = vec![];
    let mut central = vec![];
    for it in items {
        let payload = if it.deflate {
            let mut e = DeflateEncoder::new(vec![], flate2::Compression::default());
            e.write_all(it.data).unwrap();
            e.finish().unwrap()
        } else {
            it.data.to_vec()
        };
        let crc = crc32fast::hash(it.data);
        let method: u16 = if it.deflate { 8 } else { 0 };
        let offset = out.len() as u64;
        let size = it.claimed_size.unwrap_or(it.data.len() as u64);
        // local header (sizes also in the central directory, which is what the reader uses)
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&(it.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(it.name.as_bytes());
        out.extend_from_slice(&payload);

        let mut extra = vec![];
        let (cs, us, off) = if zip64 {
            extra.extend_from_slice(&1u16.to_le_bytes());
            extra.extend_from_slice(&24u16.to_le_bytes());
            extra.extend_from_slice(&size.to_le_bytes());
            extra.extend_from_slice(&(payload.len() as u64).to_le_bytes());
            extra.extend_from_slice(&offset.to_le_bytes());
            (u32::MAX, u32::MAX, u32::MAX)
        } else {
            (payload.len() as u32, size as u32, offset as u32)
        };
        let made_by: u16 = if it.symlink { 3 << 8 | 20 } else { 20 };
        let attr: u32 = if it.symlink { 0o120777 << 16 } else { 0 };
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&made_by.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&[0; 4]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&cs.to_le_bytes());
        central.extend_from_slice(&us.to_le_bytes());
        central.extend_from_slice(&(it.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&(extra.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 6]); // comment len, disk, internal attr
        central.extend_from_slice(&attr.to_le_bytes());
        central.extend_from_slice(&off.to_le_bytes());
        central.extend_from_slice(it.name.as_bytes());
        central.extend_from_slice(&extra);
    }
    let cd_offset = out.len() as u64;
    out.extend_from_slice(&central);
    let n = items.len() as u64;
    if zip64 {
        let rec_offset = out.len() as u64;
        out.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        out.extend_from_slice(&44u64.to_le_bytes());
        out.extend_from_slice(&[20, 0, 20, 0]);
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(central.len() as u64).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&rec_offset.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
    }
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    let (cnt, size, off) = if zip64 { (0xFFFFu16, u32::MAX, u32::MAX) } else { (n as u16, central.len() as u32, cd_offset as u32) };
    out.extend_from_slice(&cnt.to_le_bytes());
    out.extend_from_slice(&cnt.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn zip_dl(url: &str, archive: &[u8], entries: &[(&str, &str, &[u8])]) -> Download {
    Download {
        url: url.into(),
        sha256: sha(archive),
        bytes: archive.len() as u64,
        name: None,
        extract: entries
            .iter()
            .map(|(entry, name, d)| Extract { entry: entry.to_string(), name: name.to_string(), sha256: sha(d), bytes: d.len() as u64 })
            .collect(),
    }
}

// ---------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------

#[test]
fn builtin_manifest_is_valid_and_complete() {
    let all = manifest::builtin();
    for c in &all {
        manifest::validate(c, false).unwrap_or_else(|e| panic!("{e}"));
        assert!(!c.license.is_empty() && !c.author.is_empty());
    }
    let ids: Vec<_> = all.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["ort-web", "photo-x4", "face-restore", "lama", "birefnet-portrait", "birefnet-general", "ddcolor"]);
    // Plan 07 (A06): full hashes, the DDColor zip with its two entries + external data pair
    let dd = all.iter().find(|c| c.id == "ddcolor").unwrap();
    assert!(dd.downloads[0].is_archive());
    assert_eq!(dd.files().iter().map(|f| f.name).collect::<Vec<_>>(), ["ddcolor.onnx", "ddcolor.data"]);
    assert_eq!(dd.external_data[0].data, "ddcolor.data");
    assert_eq!(all.iter().find(|c| c.id == "birefnet-portrait").unwrap().files()[0].sha256.len(), 64);
    // the files the frontend loads by name
    let photo = all.iter().find(|c| c.id == "photo-x4").unwrap();
    assert_eq!(photo.files()[0].name, "4xRealWebPhoto_v4_fp32_opset17.onnx");
}

#[test]
fn manifest_rejects_unsafe_or_abbreviated_entries() {
    let ok = component("test-a", vec![file_dl("http://127.0.0.1:1/a", "a.bin", b"abc")]);
    manifest::validate(&ok, true).unwrap();
    // test components only in test mode, loopback http only for them
    assert!(manifest::validate(&ok, false).is_err());
    let mut c = ok.clone();
    c.downloads[0].url = "http://example.com/a".into();
    assert!(manifest::validate(&c, true).is_err());
    // abbreviated hash (Plan 07 BiRefNet prefixes) is not accepted
    let mut c = ok.clone();
    c.downloads[0].sha256 = "4c05930c0b6f1418".into();
    assert!(manifest::validate(&c, true).is_err());
    for bad in ["../a.bin", "dir/a.bin", "a\\b", ".hidden", "a.bin.part", "", "c:x"] {
        let mut c = ok.clone();
        c.downloads[0].name = Some(bad.into());
        assert!(manifest::validate(&c, true).is_err(), "{bad:?} accepted");
    }
    let mut c = ok.clone();
    c.version = "../v".into();
    assert!(manifest::validate(&c, true).is_err());
    let mut c = ok.clone();
    c.license = " ".into();
    assert!(manifest::validate(&c, true).unwrap_err().contains("license-unavailable"));
    // archive entries: traversal / absolute paths rejected
    for bad in ["../x.onnx", "/x.onnx", "a/../x", "C:/x", "a\\x"] {
        let mut c = ok.clone();
        c.downloads[0] = Download {
            url: "http://127.0.0.1:1/z".into(),
            sha256: sha(b"z"),
            bytes: 1,
            name: None,
            extract: vec![Extract { entry: bad.into(), name: "x.onnx".into(), sha256: sha(b"x"), bytes: 1 }],
        };
        assert!(manifest::validate(&c, true).is_err(), "{bad:?} accepted");
    }
    // the test manifest loader drops invalid entries and keeps valid ones
    let json = serde_json::to_string(&vec![ok.clone(), component("bad", vec![])]).unwrap();
    let (all, problems) = manifest::load(Some(&json));
    assert!(all.iter().any(|c| c.id == "test-a"));
    assert_eq!(problems.len(), 1);
}

// ---------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------

#[test]
fn install_downloads_verifies_and_reports_progress() {
    let srv = Server::start();
    let body = data(700_000, 1);
    let url = srv.add("/m.bin", body.clone());
    let fx = fixture(vec![component("test-m", vec![file_dl(&url, "m.bin", &body)])]);
    assert_eq!(fx.m.status("test-m").unwrap().state, State::Missing);
    let st = run(fx.m.install("test-m", "r1")).unwrap();
    assert_eq!(st.state, State::Ready);
    let dir = PathBuf::from(&st.dir);
    assert_eq!(std::fs::read(dir.join("m.bin")).unwrap(), body);
    assert!(dir.ends_with(Path::new("test-m").join("v1")));
    assert!(leftovers(&dir).is_empty());
    let ev = fx.events.lock().unwrap();
    assert!(ev.iter().any(|e| e.phase == "download" && e.done == body.len() as u64 && e.requests == ["r1"]));
    drop(ev);
    // installed: a second install does not touch the network
    run(fx.m.install("test-m", "r2")).unwrap();
    assert_eq!(srv.requests("/m.bin").len(), 1);
}

#[test]
fn same_size_corrupt_download_is_rejected_without_retry() {
    let srv = Server::start();
    let good = data(200_000, 2);
    let mut evil = good.clone();
    evil[1234] ^= 0xFF;
    let url = srv.add("/c.bin", evil);
    let fx = fixture(vec![component("test-c", vec![file_dl(&url, "c.bin", &good)])]);
    let err = run(fx.m.install("test-c", "r")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Checksum);
    let st = fx.m.status("test-c").unwrap();
    assert_eq!(st.state, State::Missing);
    assert!(!Path::new(&st.dir).join("c.bin").exists(), "final name only after a hash match");
    assert!(leftovers(Path::new(&st.dir)).is_empty());
    assert_eq!(srv.requests("/c.bin").len(), 1, "a hash mismatch is not retried");
}

#[test]
fn server_size_mismatch_and_404_fail_fast() {
    let srv = Server::start();
    let body = data(5000, 3);
    let url = srv.add("/s.bin", body[..4000].to_vec());
    let missing = format!("{}/nothing.bin", srv.base);
    let fx = fixture(vec![
        component("test-s", vec![file_dl(&url, "s.bin", &body)]),
        component("test-404", vec![file_dl(&missing, "n.bin", &body)]),
    ]);
    assert_eq!(run(fx.m.install("test-s", "a")).unwrap_err().code, ErrorCode::Checksum);
    assert_eq!(run(fx.m.install("test-404", "b")).unwrap_err().code, ErrorCode::DownloadNetwork);
    assert_eq!(srv.requests("/nothing.bin").len(), 1, "404 is not retried");
}

#[test]
fn interrupted_download_resumes_with_range() {
    let srv = Server::start();
    let body = data(900_000, 4);
    let url = srv.add("/r.bin", body.clone());
    srv.with(|s| s.cut_once.insert("/r.bin".into()));
    let fx = fixture(vec![component("test-r", vec![file_dl(&url, "r.bin", &body)])]);
    let st = run(fx.m.install("test-r", "r")).unwrap();
    assert_eq!(st.state, State::Ready);
    assert_eq!(std::fs::read(Path::new(&st.dir).join("r.bin")).unwrap(), body);
    let reqs = srv.requests("/r.bin");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0], None);
    assert_eq!(reqs[1].as_deref(), Some(format!("bytes={}-", body.len() / 2).as_str()), "continued, not restarted");
}

#[test]
fn interrupted_download_without_validator_restarts_safely() {
    let srv = Server::start();
    let body = data(400_000, 5);
    let url = srv.add("/n.bin", body.clone());
    srv.with(|s| {
        s.cut_once.insert("/n.bin".into());
        s.no_validator.insert("/n.bin".into());
    });
    let fx = fixture(vec![component("test-n", vec![file_dl(&url, "n.bin", &body)])]);
    let st = run(fx.m.install("test-n", "r")).unwrap();
    assert_eq!(st.state, State::Ready);
    assert_eq!(srv.requests("/n.bin"), vec![None, None], "no Range without ETag/Last-Modified");
}

#[test]
fn part_left_by_an_earlier_session_is_resumed() {
    let srv = Server::start();
    let body = data(600_000, 6);
    let url = srv.add("/p.bin", body.clone());
    srv.with(|s| s.down = true);
    let fx = fixture(vec![component("test-p", vec![file_dl(&url, "p.bin", &body)])]);
    // first session: the server is down -> network error after bounded retries, nothing final
    let err = run(fx.m.install("test-p", "a")).unwrap_err();
    assert_eq!(err.code, ErrorCode::DownloadNetwork);
    assert_eq!(srv.requests("/p.bin").len(), 3, "bounded retries");
    // a half part with matching sidecar (as left by a crash) is continued
    srv.with(|s| {
        s.down = false;
        s.log.clear();
    });
    let dir = fx.root.join("test-p").join("v1");
    std::fs::write(dir.join("p.bin.part"), &body[..250_000]).unwrap();
    let etag = format!("\"{}\"", &sha(&body)[..16]);
    let meta = serde_json::json!({"owner":"vho-ai","url":url,"sha256":sha(&body),"bytes":body.len(),"validator":etag});
    std::fs::write(dir.join("p.bin.part.json"), meta.to_string()).unwrap();
    let st = run(fx.m.install("test-p", "b")).unwrap();
    assert_eq!(st.state, State::Ready);
    assert_eq!(srv.requests("/p.bin"), vec![Some("bytes=250000-".to_string())]);
    // a part whose sidecar names another file is never continued
    run(async { fx.m.remove("test-p") }).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("p.bin.part"), &body[..100]).unwrap();
    let meta = serde_json::json!({"owner":"vho-ai","url":"http://127.0.0.1:1/other","sha256":sha(&body),"bytes":body.len(),"validator":etag});
    std::fs::write(dir.join("p.bin.part.json"), meta.to_string()).unwrap();
    srv.with(|s| s.log.clear());
    run(fx.m.install("test-p", "c")).unwrap();
    assert_eq!(srv.requests("/p.bin"), vec![None]);
}

#[test]
fn stalled_connection_times_out_as_network_error() {
    let srv = Server::start();
    let body = data(100_000, 7);
    let url = srv.add("/h.bin", body.clone());
    srv.with(|s| s.hang.insert("/h.bin".into()));
    let fx = fixture(vec![component("test-h", vec![file_dl(&url, "h.bin", &body)])]);
    let t0 = std::time::Instant::now();
    let err = run(fx.m.install("test-h", "r")).unwrap_err();
    assert_eq!(err.code, ErrorCode::DownloadNetwork);
    assert!(t0.elapsed() < Duration::from_secs(4), "stall timeout, not the 5 s server hang");
}

#[test]
fn cancel_reaches_the_stream_and_old_events_do_not_leak() {
    let srv = Server::start();
    let body = data(3_000_000, 8);
    let url = srv.add("/slow.bin", body.clone());
    srv.with(|s| s.slow.insert("/slow.bin".into()));
    let fx = fixture(vec![component("test-x", vec![file_dl(&url, "slow.bin", &body)])]);
    let m = fx.m.clone();
    let err = run(async {
        let h = tauri::async_runtime::spawn(async move { m.install("test-x", "first").await });
        wait_progress(&fx, "test-x", 100_000).await;
        assert!(fx.m.cancel("first"));
        h.await.unwrap()
    })
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    // the job winds down: nothing final, no part files
    run(async {
        for _ in 0..300 {
            if fx.m.status("test-x").unwrap().state != State::Downloading {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let st = fx.m.status("test-x").unwrap();
    assert_eq!(st.state, State::Missing);
    assert!(leftovers(Path::new(&st.dir)).is_empty(), "{:?}", leftovers(Path::new(&st.dir)));
    assert!(!fx.m.cancel("first"), "finished request is unknown");

    let first_job = fx.events.lock().unwrap().iter().find(|e| e.requests.contains(&"first".to_string())).unwrap().job;
    srv.with(|s| s.slow.clear());
    let st = run(fx.m.install("test-x", "second")).unwrap();
    assert_eq!(st.state, State::Ready);
    let ev = fx.events.lock().unwrap();
    assert!(ev.iter().filter(|e| e.requests.contains(&"second".to_string())).all(|e| e.job != first_job));
    assert!(ev.iter().filter(|e| e.job == first_job).all(|e| !e.requests.contains(&"second".to_string())));
}

#[test]
fn concurrent_requests_share_one_download() {
    let srv = Server::start();
    let body = data(1_000_000, 9);
    let url = srv.add("/two.bin", body.clone());
    srv.with(|s| s.slow.insert("/two.bin".into()));
    let fx = fixture(vec![component("test-two", vec![file_dl(&url, "two.bin", &body)])]);
    let (a, b) = run(async {
        let (m1, m2) = (fx.m.clone(), fx.m.clone());
        let h1 = tauri::async_runtime::spawn(async move { m1.install("test-two", "a").await });
        wait_progress(&fx, "test-two", 1).await;
        let h2 = tauri::async_runtime::spawn(async move { m2.install("test-two", "b").await });
        (h1.await.unwrap(), h2.await.unwrap())
    });
    assert_eq!(a.unwrap().state, State::Ready);
    assert_eq!(b.unwrap().state, State::Ready);
    assert_eq!(srv.requests("/two.bin").len(), 1, "one HTTP download for both requests");
    assert!(fx.events.lock().unwrap().iter().any(|e| e.requests.len() == 2));
}

#[test]
fn cancelling_one_request_keeps_the_other_running() {
    let srv = Server::start();
    let body = data(1_500_000, 10);
    let url = srv.add("/keep.bin", body.clone());
    srv.with(|s| s.slow.insert("/keep.bin".into()));
    let fx = fixture(vec![component("test-k", vec![file_dl(&url, "keep.bin", &body)])]);
    let (a, b) = run(async {
        let (m1, m2) = (fx.m.clone(), fx.m.clone());
        let h1 = tauri::async_runtime::spawn(async move { m1.install("test-k", "a").await });
        wait_progress(&fx, "test-k", 1).await;
        let h2 = tauri::async_runtime::spawn(async move { m2.install("test-k", "b").await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(fx.m.cancel("a"));
        (h1.await.unwrap(), h2.await.unwrap())
    });
    assert_eq!(a.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(b.unwrap().state, State::Ready);
    assert_eq!(srv.requests("/keep.bin").len(), 1);
}

#[test]
fn disk_space_is_checked_before_downloading() {
    let srv = Server::start();
    let body = data(50_000, 11);
    let url = srv.add("/big.bin", body.clone());
    let fx = fixture_with(vec![component("test-d", vec![file_dl(&url, "big.bin", &body)])], Arc::new(|_: &Path| Some(10_000_000)));
    let err = run(fx.m.install("test-d", "r")).unwrap_err();
    assert_eq!(err.code, ErrorCode::DiskFull, "margin + file does not fit into 10 MB");
    assert!(srv.requests("/big.bin").is_empty(), "no byte downloaded");
    let fx2 = fixture_with(vec![component("test-d", vec![file_dl(&url, "big.bin", &body)])], Arc::new(|_: &Path| Some(1 << 30)));
    assert_eq!(run(fx2.m.install("test-d", "r")).unwrap().state, State::Ready);
    // real volume query works on the test machine
    assert!(volume_free_bytes(&std::env::temp_dir()).is_some_and(|b| b > 0));
}

#[test]
fn io_errors_are_classified() {
    use std::io::{Error, ErrorKind};
    assert_eq!(error::io_code(&Error::from(ErrorKind::StorageFull)), ErrorCode::DiskFull);
    assert_eq!(error::io_code(&Error::from(ErrorKind::PermissionDenied)), ErrorCode::Permission);
    let os_full = if cfg!(windows) { 112 } else { 28 };
    assert_eq!(error::io_code(&Error::from_raw_os_error(os_full)), ErrorCode::DiskFull);
    assert_eq!(error::io_code(&Error::from(ErrorKind::NotFound)), ErrorCode::Io);
}

// ---------------------------------------------------------------------------------------
// Verify / repair / leases / removal
// ---------------------------------------------------------------------------------------

#[test]
fn verify_detects_same_size_damage_and_install_repairs_only_that_file() {
    let srv = Server::start();
    let (a, b) = (data(300_000, 12), data(200_000, 13));
    let (ua, ub) = (srv.add("/a.bin", a.clone()), srv.add("/b.bin", b.clone()));
    let fx = fixture(vec![component("test-v", vec![file_dl(&ua, "a.bin", &a), file_dl(&ub, "b.bin", &b)])]);
    let st = run(fx.m.install("test-v", "1")).unwrap();
    let dir = PathBuf::from(&st.dir);
    let mut damaged = a.clone();
    damaged[10] ^= 1;
    std::fs::write(dir.join("a.bin"), &damaged).unwrap();

    let st = run(fx.m.verify("test-v")).unwrap();
    assert_eq!(st.state, State::Corrupt);
    assert_eq!(st.bad_files, ["a.bin"]);
    assert_eq!(st.download_bytes, a.len() as u64);

    let st = run(fx.m.install("test-v", "2")).unwrap();
    assert_eq!(st.state, State::Ready);
    assert_eq!(std::fs::read(dir.join("a.bin")).unwrap(), a);
    assert_eq!(srv.requests("/a.bin").len(), 2);
    assert_eq!(srv.requests("/b.bin").len(), 1, "intact file kept");
}

#[test]
fn acquire_hashes_once_per_session_detects_changes_and_needs_no_network() {
    let srv = Server::start();
    let body = data(250_000, 14);
    let url = srv.add("/o.bin", body.clone());
    let fx = fixture(vec![component("test-o", vec![file_dl(&url, "o.bin", &body)])]);
    let st = run(fx.m.install("test-o", "1")).unwrap();
    srv.with(|s| s.down = true); // offline from here on

    // a fresh session (new manager, same folder) only trusts a hash, not the size
    let fresh = Manager::new(fx.root.clone(), fx.m.components().to_vec(), fast_policy(), Arc::new(|_| {}), Arc::new(|_: &Path| None));
    assert_eq!(fresh.status("test-o").unwrap().state, State::Installed);
    let a = run(fresh.acquire("test-o")).unwrap();
    assert_eq!(a.status.state, State::Ready);
    assert!(fresh.release(a.lease));

    // same size, different content: detected through the changed mtime/size stamp
    let mut damaged = body.clone();
    damaged[0] ^= 1;
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(Path::new(&st.dir).join("o.bin"), &damaged).unwrap();
    let err = run(fresh.acquire("test-o")).unwrap_err();
    assert_eq!(err.code, ErrorCode::Checksum, "a damaged file is never handed to inference");
    assert_eq!(fresh.status("test-o").unwrap().state, State::Corrupt);
    assert_eq!(run(fresh.acquire("test-missing")).unwrap_err().code, ErrorCode::UnknownComponent);
}

#[test]
fn removal_is_refused_while_leased_and_cleans_everything_after() {
    let srv = Server::start();
    let body = data(120_000, 15);
    let url = srv.add("/l.bin", body.clone());
    let fx = fixture(vec![component("test-l", vec![file_dl(&url, "l.bin", &body)])]);
    run(fx.m.install("test-l", "1")).unwrap();
    let a = run(fx.m.acquire("test-l")).unwrap();
    assert!(fx.m.status("test-l").unwrap().in_use);
    assert_eq!(fx.m.remove("test-l").unwrap_err().code, ErrorCode::InUse);
    fx.m.release(a.lease);
    let st = fx.m.remove("test-l").unwrap();
    assert_eq!(st.state, State::Missing);
    assert!(!fx.root.join("test-l").exists());
    assert_eq!(run(fx.m.acquire("test-l")).unwrap_err().code, ErrorCode::NotInstalled);
}

#[test]
fn legacy_layout_and_old_versions_are_migrated_and_cleaned() {
    let srv = Server::start();
    let body = data(80_000, 16);
    let url = srv.add("/g.bin", body.clone());
    let fx = fixture(vec![component("test-g", vec![file_dl(&url, "g.bin", &body)])]);
    let base = fx.root.join("test-g");
    std::fs::create_dir_all(base.join("v0")).unwrap();
    std::fs::write(base.join("v0").join("old.bin"), b"old").unwrap();
    std::fs::write(base.join("g.bin"), &body).unwrap(); // pre-A01 layout
    std::fs::write(base.join("g.bin.part"), b"stale").unwrap();
    let st = run(fx.m.install("test-g", "1")).unwrap();
    assert_eq!(st.state, State::Ready);
    assert!(srv.requests("/g.bin").is_empty(), "verified legacy file reused");
    assert!(!base.join("v0").exists() && !base.join("g.bin").exists() && !base.join("g.bin.part").exists());
}

// ---------------------------------------------------------------------------------------
// Zip archives (Plan 07 DDColor-style: archive hash + per-entry hashes + external data)
// ---------------------------------------------------------------------------------------

#[test]
fn zip_extracts_only_listed_entries_and_deletes_the_archive() {
    let srv = Server::start();
    let (model, weights) = (data(150_000, 17), data(400_000, 18));
    let evil = b"should never be written".to_vec();
    let archive = make_zip(
        &[item("pkg/model.onnx", &model, true), item("pkg/model.data", &weights, false), item("../../evil.txt", &evil, false)],
        false,
    );
    let url = srv.add("/pack.zip", archive.clone());
    let mut c = component("test-z", vec![zip_dl(&url, &archive, &[("pkg/model.onnx", "model.onnx", &model), ("pkg/model.data", "model.data", &weights)])]);
    c.external_data = vec![manifest::ExternalData { model: "model.onnx".into(), data: "model.data".into() }];
    let fx = fixture(vec![c]);
    let st = run(fx.m.install("test-z", "1")).unwrap();
    assert_eq!(st.state, State::Ready);
    let dir = PathBuf::from(&st.dir);
    assert_eq!(std::fs::read(dir.join("model.onnx")).unwrap(), model);
    assert_eq!(std::fs::read(dir.join("model.data")).unwrap(), weights);
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["model.data", "model.onnx"], "archive deleted, nothing else written");
    assert!(!fx.root.join("evil.txt").exists() && !fx.root.join("test-z").join("evil.txt").exists());
    assert!(fx.events.lock().unwrap().iter().any(|e| e.phase == "extract"));

    // repair re-extracts only the damaged entry (one more archive download)
    std::fs::write(dir.join("model.data"), data(400_000, 99)).unwrap();
    assert_eq!(run(fx.m.verify("test-z")).unwrap().bad_files, ["model.data"]);
    assert_eq!(run(fx.m.install("test-z", "2")).unwrap().state, State::Ready);
    assert_eq!(std::fs::read(dir.join("model.data")).unwrap(), weights);
}

#[test]
fn zip64_archives_are_read() {
    let srv = Server::start();
    let model = data(90_000, 19);
    let archive = make_zip(&[item("model.onnx", &model, true)], true);
    let url = srv.add("/z64.zip", archive.clone());
    let fx = fixture(vec![component("test-z64", vec![zip_dl(&url, &archive, &[("model.onnx", "model.onnx", &model)])])]);
    assert_eq!(run(fx.m.install("test-z64", "1")).unwrap().state, State::Ready);
}

#[test]
fn zip_rejects_symlinks_wrong_entry_hashes_bombs_and_missing_entries() {
    let srv = Server::start();
    let model = data(60_000, 20);
    let case = |name: &str, archive: Vec<u8>, entry_data: &[u8]| {
        let url = srv.add(&format!("/{name}.zip"), archive.clone());
        let fx = fixture(vec![component(&format!("test-{name}"), vec![zip_dl(&url, &archive, &[("m.onnx", "m.onnx", entry_data)])])]);
        let err = run(fx.m.install(&format!("test-{name}"), "1")).unwrap_err();
        let st = fx.m.status(&format!("test-{name}")).unwrap();
        assert!(std::fs::read_dir(&st.dir).map(|r| r.count()).unwrap_or(0) == 0, "{name}: nothing left behind");
        err.code
    };
    let mut link = item("m.onnx", &model, false);
    link.symlink = true;
    assert_eq!(case("link", make_zip(&[link], false), &model), ErrorCode::ArchiveInvalid);

    let mut other = model.clone();
    other[5] ^= 1;
    assert_eq!(case("hash", make_zip(&[item("m.onnx", &other, true)], false), &model), ErrorCode::Checksum);

    // central directory claims the manifest size, the deflate stream inflates to far more
    let bomb_data = vec![0u8; 5_000_000];
    let mut bomb = item("m.onnx", &bomb_data, true);
    bomb.claimed_size = Some(model.len() as u64);
    assert_eq!(case("bomb", make_zip(&[bomb], false), &model), ErrorCode::Checksum);

    assert_eq!(case("absent", make_zip(&[item("other.onnx", &model, true)], false), &model), ErrorCode::ArchiveInvalid);
    assert_eq!(case("dup", make_zip(&[item("m.onnx", &model, true), item("m.onnx", &model, false)], false), &model), ErrorCode::ArchiveInvalid);
    assert_eq!(case("garbage", data(10_000, 21), &model), ErrorCode::ArchiveInvalid);
}
