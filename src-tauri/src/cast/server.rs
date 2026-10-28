//! Short-lived HTTP server that lets ONE renderer fetch ONE selected file.
//!
//! * The only valid path is `/m/<random 128-bit token>/<name>`; anything else is 404. The file
//!   path is fixed when the server starts and never comes from the request (no directory
//!   listing, no traversal).
//! * Bound to the one local interface that routes to the renderer, ephemeral port.
//! * GET/HEAD with a single `Range` (206/416), DLNA streaming headers, timeouts per connection,
//!   at most `MAX_CONN` concurrent connections.
//! * `stop()` closes the listener and aborts running transfers; the URL stops working.
//! * The firewall is never changed: if Windows blocks the inbound connection the renderer simply
//!   cannot fetch, which `requests()` == 0 lets the caller report.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MAX_CONN: usize = 8;
const IO_TIMEOUT: Duration = Duration::from_secs(20);

pub struct MediaServer {
    pub url: String,
    stopped: Arc<AtomicBool>,
    requests: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// Content type by extension (renderers decide by it); `None` = not offered for casting.
pub fn mime_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "ts" | "m2ts" | "mts" => "video/mp2t",
        "mpg" | "mpeg" => "video/mpeg",
        "wmv" => "video/x-ms-wmv",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg",
        "wma" => "audio/x-ms-wma",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// URL-safe display name for the path segment (renderers show it).
fn url_name(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "media".into());
    let mut o = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// The local address the OS would use to reach `peer` (no packet is sent).
pub fn local_ip_towards(peer: IpAddr) -> Result<IpAddr, String> {
    let s = std::net::UdpSocket::bind(if peer.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }).map_err(|e| format!("[cast-network] {e}"))?;
    s.connect(SocketAddr::new(peer, 9)).map_err(|e| format!("[cast-network] {e}"))?;
    Ok(s.local_addr().map_err(|e| format!("[cast-network] {e}"))?.ip())
}

impl MediaServer {
    pub fn start(path: &Path, bind_ip: IpAddr) -> Result<Self, String> {
        let mime = mime_of(path).ok_or("[cast-format] not a castable file type")?;
        let len = std::fs::metadata(path).map_err(|e| format!("[cast-file] {e}"))?.len();
        let listener = TcpListener::bind(SocketAddr::new(bind_ip, 0)).map_err(|e| format!("[cast-network] {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let route = format!("/m/{token}/{}", url_name(path));
        let url = format!("http://{bind_ip}:{port}{route}");
        let stopped = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicU64::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let (st, rq, file) = (stopped.clone(), requests.clone(), path.to_path_buf());
        let thread = std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((conn, _)) => {
                        if active.load(Ordering::SeqCst) >= MAX_CONN {
                            continue; // dropped: closes the connection
                        }
                        active.fetch_add(1, Ordering::SeqCst);
                        let (st, rq, act, file, route) = (st.clone(), rq.clone(), active.clone(), file.clone(), route.clone());
                        std::thread::spawn(move || {
                            let _ = serve(conn, &route, &file, mime, len, &st, &rq);
                            act.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
            // listener dropped here: new connections are refused
        });
        Ok(Self { url, stopped, requests, thread: Some(thread) })
    }

    /// Media requests that reached the file (not 404s).
    pub fn requests(&self) -> u64 {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for MediaServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` -> inclusive range; `Err(())` = unsatisfiable.
pub fn parse_range(h: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = h.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None; // multiple ranges: answer with the whole file
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let r = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 {
            return Some(Err(()));
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
        if start >= len || end < start {
            return Some(Err(()));
        }
        (start, end)
    };
    Some(Ok(r))
}

fn serve(mut c: TcpStream, route: &str, file: &PathBuf, mime: &str, len: u64, stopped: &AtomicBool, requests: &AtomicU64) -> std::io::Result<()> {
    c.set_nonblocking(false)?;
    c.set_read_timeout(Some(IO_TIMEOUT))?;
    c.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut head = Vec::new();
    let mut b = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = c.read(&mut b)?;
        if n == 0 || head.len() > 8192 {
            return Ok(());
        }
        head.extend_from_slice(&b[..n]);
    }
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let range = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("range"))
        .map(|(_, v)| v.trim().to_string());
    let reply = |c: &mut TcpStream, status: &str| c.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
    if stopped.load(Ordering::SeqCst) || target != route {
        return reply(&mut c, "404 Not Found");
    }
    if method != "GET" && method != "HEAD" {
        return reply(&mut c, "405 Method Not Allowed");
    }
    let (status, start, end) = match range.as_deref().and_then(|r| parse_range(r, len)) {
        Some(Ok((a, z))) => ("206 Partial Content", a, z),
        Some(Err(())) => {
            return c.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
        }
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    requests.fetch_add(1, Ordering::SeqCst);
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut h = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\
         transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n"
    );
    if status.starts_with("206") {
        h.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    h.push_str("\r\n");
    c.write_all(h.as_bytes())?;
    if method == "HEAD" || count == 0 {
        return Ok(());
    }
    let mut f = File::open(file)?;
    f.seek(SeekFrom::Start(start))?;
    let mut left = count;
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        if stopped.load(Ordering::SeqCst) {
            return Ok(()); // stop: the transfer is cut
        }
        let want = left.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        c.write_all(&buf[..n])?;
        left -= n as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some(Ok((0, 99))));
        assert_eq!(parse_range("bytes=900-", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=-100", 1000), Some(Ok((900, 999))));
        assert_eq!(parse_range("bytes=990-5000", 1000), Some(Ok((990, 999))));
        assert_eq!(parse_range("bytes=1000-", 1000), Some(Err(())));
        assert_eq!(parse_range("bytes=50-10", 1000), Some(Err(())));
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(url_name(Path::new("C:/x/Şarkı 1.mp3")), "%C5%9Eark%C4%B1%201.mp3");
        assert_eq!(mime_of(Path::new("a.MKV")), Some("video/x-matroska"));
        assert_eq!(mime_of(Path::new("a.exe")), None);
    }
}
