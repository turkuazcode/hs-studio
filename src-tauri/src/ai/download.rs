//! One verified HTTP download into a `.part` file next to its final name (same volume).
//!
//! - Cancellation reaches the HTTP stream (select on every chunk), also while connecting or
//!   waiting between retries.
//! - Connect + stall timeouts, bounded retries with backoff for network errors only; a size or
//!   SHA-256 mismatch is final (no endless re-download).
//! - Resume: an interrupted `.part` is continued with `Range` only when the server sent a
//!   strong validator (ETag or Last-Modified) and answers `If-Range` with a matching 206;
//!   anything else restarts from byte 0. The `.part.json` sidecar records url/hash/validator,
//!   so a part file from another version or URL is never continued.
//! - The final hash covers the whole file, so a resumed download is as safe as a fresh one.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::StatusCode;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::error::{AiError, AiResult, ErrorCode};

#[derive(Debug, Clone)]
pub struct Policy {
    pub attempts: u32,
    pub backoff: Duration,
    pub connect_timeout: Duration,
    pub stall_timeout: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            attempts: 4,
            backoff: Duration::from_secs(1),
            connect_timeout: Duration::from_secs(20),
            stall_timeout: Duration::from_secs(45),
        }
    }
}

pub struct Target<'a> {
    pub url: &'a str,
    pub sha256: &'a str,
    pub bytes: u64,
    pub part: PathBuf,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct PartMeta {
    owner: String,
    url: String,
    sha256: String,
    bytes: u64,
    validator: Option<String>,
}

const OWNER: &str = "vho-ai";

pub fn meta_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(".json");
    PathBuf::from(s)
}

/// Removes a part file and its sidecar.
pub fn discard(part: &Path) {
    let _ = std::fs::remove_file(part);
    let _ = std::fs::remove_file(meta_path(part));
}

fn read_meta(part: &Path) -> Option<PartMeta> {
    serde_json::from_slice(&std::fs::read(meta_path(part)).ok()?).ok()
}

fn write_meta(part: &Path, meta: &PartMeta) -> AiResult<()> {
    std::fs::write(meta_path(part), serde_json::to_vec(meta).unwrap_or_default()).map_err(|e| AiError::io("write part meta", &e))
}

enum Attempt {
    Done,
    /// Network-level problem: worth another attempt (resuming if possible)
    Retry(AiError),
}

/// Resolves when the requester cancels (never if the sender is gone).
pub async fn cancelled(rx: &mut watch::Receiver<bool>) {
    if rx.wait_for(|c| *c).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn is_cancelled(rx: &watch::Receiver<bool>) -> bool {
    *rx.borrow()
}

pub fn client(url: &str, policy: &Policy) -> AiResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .user_agent(concat!("HS-Studio/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(policy.connect_timeout)
        .read_timeout(policy.stall_timeout);
    if url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost") {
        b = b.no_proxy();
    }
    b.build().map_err(|e| AiError::new(ErrorCode::DownloadNetwork, e.to_string()))
}

/// Downloads `t.url` into `t.part` and verifies size + SHA-256. `on_progress(bytes_in_part)`.
/// On success the part file holds exactly the expected bytes (the sidecar is removed).
pub async fn fetch(
    t: &Target<'_>,
    policy: &Policy,
    cancel: &mut watch::Receiver<bool>,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> AiResult<()> {
    let client = client(t.url, policy)?;
    let mut last_err = None;
    for attempt in 0..policy.attempts.max(1) {
        if attempt > 0 {
            let wait = policy.backoff * (1u32 << (attempt - 1).min(4));
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = cancelled(cancel) => {}
            }
        }
        if is_cancelled(cancel) {
            discard(&t.part);
            return Err(AiError::new(ErrorCode::Cancelled, "download cancelled"));
        }
        match attempt_once(&client, t, cancel, on_progress).await {
            Ok(Attempt::Done) => {
                let _ = std::fs::remove_file(meta_path(&t.part));
                return Ok(());
            }
            Ok(Attempt::Retry(e)) => {
                eprintln!("[ai] {} attempt {} failed: {}", t.url, attempt + 1, e.detail);
                last_err = Some(e);
            }
            Err(e) => {
                // Final: cancelled, checksum, disk full, permission... (never resumed from)
                discard(&t.part);
                return Err(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| AiError::new(ErrorCode::DownloadNetwork, "download failed")))
}

/// Bytes of an existing part that may be continued, plus their running hash.
async fn resumable(t: &Target<'_>) -> (u64, Sha256, Option<String>) {
    let fresh = (0, Sha256::new(), None);
    let Some(meta) = read_meta(&t.part) else {
        discard(&t.part);
        return fresh;
    };
    let same = meta.owner == OWNER && meta.url == t.url && meta.sha256 == t.sha256 && meta.bytes == t.bytes;
    let len = std::fs::metadata(&t.part).map(|m| m.len()).unwrap_or(0);
    if !same || meta.validator.is_none() || len == 0 || len > t.bytes {
        discard(&t.part);
        return fresh;
    }
    let part = t.part.clone();
    let hashed = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Sha256> {
        let mut f = std::fs::File::open(&part)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut left = len;
        while left > 0 {
            let n = f.read(&mut buf[..(left.min(1 << 20)) as usize])?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            left -= n as u64;
        }
        if left != 0 { Err(std::io::Error::other("part changed")) } else { Ok(h) }
    })
    .await;
    match hashed {
        Ok(Ok(h)) => (len, h, meta.validator),
        _ => {
            discard(&t.part);
            fresh
        }
    }
}

fn network(detail: impl Into<String>) -> Attempt {
    Attempt::Retry(AiError::new(ErrorCode::DownloadNetwork, detail))
}

/// "bytes START-END/TOTAL" -> (start, total)
fn parse_content_range(v: &str) -> Option<(u64, u64)> {
    let rest = v.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    Some((start.trim().parse().ok()?, total.trim().parse().ok()?))
}

async fn attempt_once(
    client: &reqwest::Client,
    t: &Target<'_>,
    cancel: &mut watch::Receiver<bool>,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> AiResult<Attempt> {
    let (mut have, mut hasher, validator) = resumable(t).await;
    if have == t.bytes {
        return finish(t, have, hasher);
    }
    let mut req = client.get(t.url);
    if let (true, Some(v)) = (have > 0, validator.as_ref()) {
        req = req.header(RANGE, format!("bytes={have}-")).header(IF_RANGE, v.as_str());
    }
    let sent = tokio::select! {
        r = req.send() => r,
        _ = cancelled(cancel) => return Err(AiError::new(ErrorCode::Cancelled, "download cancelled")),
    };
    let mut resp = match sent {
        Ok(r) => r,
        Err(e) => return Ok(network(format!("request: {e}"))),
    };
    let status = resp.status();
    let header = |name| resp.headers().get(name).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok()).map(str::to_string);
    let content_len = header(CONTENT_LENGTH).and_then(|v| v.parse::<u64>().ok());
    let etag = header(ETAG).filter(|e| !e.starts_with("W/"));
    let new_validator = etag.or_else(|| header(LAST_MODIFIED));

    let append = if status == StatusCode::PARTIAL_CONTENT && have > 0 {
        match header(CONTENT_RANGE).as_deref().and_then(parse_content_range) {
            Some((start, total)) if start == have && total == t.bytes => true,
            _ => {
                discard(&t.part);
                return Ok(network("unexpected Content-Range; restarting"));
            }
        }
    } else if status == StatusCode::OK {
        false
    } else if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::RANGE_NOT_SATISFIABLE {
        if status == StatusCode::RANGE_NOT_SATISFIABLE {
            discard(&t.part);
        }
        return Ok(network(format!("HTTP {status}")));
    } else {
        // 404/403...: the pinned file is not available; retrying will not help
        return Err(AiError::new(ErrorCode::DownloadNetwork, format!("HTTP {status}")));
    };
    if !append {
        have = 0;
        hasher = Sha256::new();
    }
    if let Some(len) = content_len {
        if have + len != t.bytes {
            return Err(AiError::new(ErrorCode::Checksum, format!("server size {} != manifest {}", have + len, t.bytes)));
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&t.part)
        .map_err(|e| AiError::io("open part", &e))?;
    write_meta(&t.part, &PartMeta {
        owner: OWNER.into(),
        url: t.url.into(),
        sha256: t.sha256.into(),
        bytes: t.bytes,
        validator: new_validator,
    })?;
    on_progress(have);

    loop {
        let next = tokio::select! {
            c = resp.chunk() => c,
            _ = cancelled(cancel) => {
                drop(file);
                return Err(AiError::new(ErrorCode::Cancelled, "download cancelled"));
            }
        };
        let chunk = match next {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = file.flush();
                return Ok(network(format!("connection: {e}")));
            }
        };
        if have + chunk.len() as u64 > t.bytes {
            return Err(AiError::new(ErrorCode::Checksum, "larger than the manifest size"));
        }
        file.write_all(&chunk).map_err(|e| AiError::io("write part", &e))?;
        hasher.update(&chunk);
        have += chunk.len() as u64;
        on_progress(have);
    }
    file.sync_all().map_err(|e| AiError::io("sync part", &e))?;
    drop(file);
    if have < t.bytes {
        return Ok(network(format!("connection closed at {have}/{} bytes", t.bytes)));
    }
    finish(t, have, hasher)
}

fn finish(t: &Target<'_>, have: u64, hasher: Sha256) -> AiResult<Attempt> {
    let digest = super::hex(&hasher.finalize());
    if have != t.bytes || digest != t.sha256 {
        return Err(AiError::new(ErrorCode::Checksum, format!("{}: got {have} bytes / {digest}", t.url)));
    }
    Ok(Attempt::Done)
}
