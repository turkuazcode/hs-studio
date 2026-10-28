//! Minimal HTTP/1.1 client for the local network (UPnP description and SOAP control).
//!
//! Plain `http://` only (UPnP devices do not use TLS), one request per connection, hard limits:
//! connect/read timeouts, response size cap (`max`), chunked bodies decoded within the same cap.
//! No redirects are followed (a device must answer itself).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub struct Url {
    pub host: String,
    pub port: u16,
    /// path + query, starts with '/'
    pub path: String,
}

/// Parses `http://host[:port]/path`. Userinfo, other schemes and IPv6 literals are rejected.
pub fn parse_url(url: &str) -> Result<Url, String> {
    let rest = url.strip_prefix("http://").ok_or_else(|| format!("[cast-bad-url] only http:// is allowed"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') || authority.contains('[') {
        return Err("[cast-bad-url] host".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| "[cast-bad-url] port".to_string())?),
        None => (authority, 80),
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("[cast-bad-url] host".into());
    }
    Ok(Url { host: host.to_string(), port, path: path.to_string() })
}

/// Resolves `rel` (absolute URL, absolute path or relative path) against `base`.
pub fn join(base: &str, rel: &str) -> String {
    if rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    let Ok(b) = parse_url(base) else { return rel.to_string() };
    let origin = format!("http://{}:{}", b.host, b.port);
    if rel.starts_with('/') {
        return format!("{origin}{rel}");
    }
    let dir = b.path.split('?').next().unwrap_or("/");
    let dir = &dir[..dir.rfind('/').map(|i| i + 1).unwrap_or(1)];
    format!("{origin}{dir}{rel}")
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One request; the whole exchange must finish within `timeout` and the response within `max` bytes.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: &[u8], timeout: Duration, max: usize) -> Result<Response, String> {
    let u = parse_url(url)?;
    let deadline = Instant::now() + timeout;
    let addr: SocketAddr = (u.host.as_str(), u.port)
        .to_socket_addrs()
        .map_err(|e| format!("[cast-unreachable] {e}"))?
        .next()
        .ok_or("[cast-unreachable] no address")?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("[cast-unreachable] {e}"))?;
    let mut head = format!("{method} {} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nUser-Agent: VHO/1 UPnP/1.0\r\n", u.path, u.host, u.port);
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    s.set_write_timeout(Some(timeout)).ok();
    s.write_all(head.as_bytes()).and_then(|_| s.write_all(body)).map_err(|e| format!("[cast-timeout] {e}"))?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("[cast-timeout] response".into());
        }
        s.set_read_timeout(Some(left)).ok();
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > max + 8192 {
                    return Err("[cast-too-large] response".into());
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err("[cast-timeout] response".into())
            }
            Err(e) => return Err(format!("[cast-unreachable] {e}")),
        }
    }
    parse_response(&raw, max)
}

fn parse_response(raw: &[u8], max: usize) -> Result<Response, String> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("[cast-bad-response] header")?;
    let head = std::str::from_utf8(&raw[..end]).map_err(|_| "[cast-bad-response] header")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or("[cast-bad-response] status")?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    let mut body = raw[end + 4..].to_vec();
    let chunked = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        body = dechunk(&body)?;
    } else if let Some(n) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse::<usize>().ok()) {
        body.truncate(n);
    }
    if body.len() > max {
        return Err("[cast-too-large] response".into());
    }
    Ok(Response { status, body })
}

fn dechunk(mut b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = b.windows(2).position(|w| w == b"\r\n").ok_or("[cast-bad-response] chunk")?;
        let size_txt = std::str::from_utf8(&b[..eol]).map_err(|_| "[cast-bad-response] chunk")?;
        let size = usize::from_str_radix(size_txt.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "[cast-bad-response] chunk")?;
        b = &b[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        if b.len() < size {
            return Err("[cast-bad-response] chunk".into());
        }
        out.extend_from_slice(&b[..size]);
        b = b.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_url_parse_and_join() {
        let u = parse_url("http://192.168.1.5:49152/desc.xml").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.path.as_str()), ("192.168.1.5", 49152, "/desc.xml"));
        assert!(parse_url("https://x/").is_err());
        assert!(parse_url("http://user:pw@x/").is_err());
        assert!(parse_url("file:///c:/x").is_err());
        assert_eq!(join("http://10.0.0.2:80/dev/desc.xml", "ctl/av"), "http://10.0.0.2:80/dev/ctl/av");
        assert_eq!(join("http://10.0.0.2:80/dev/desc.xml", "/av"), "http://10.0.0.2:80/av");
        assert_eq!(join("http://10.0.0.2/desc.xml", "http://10.0.0.2:81/av"), "http://10.0.0.2:81/av");
    }

    #[test]
    fn cast_chunked_and_limits() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n2\r\nef\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw, 100).unwrap().body, b"abcdef");
        assert!(parse_response(raw, 3).unwrap_err().starts_with("[cast-too-large]"));
        let raw = b"HTTP/1.1 500 Internal\r\nContent-Length: 2\r\n\r\nokEXTRA";
        let r = parse_response(raw, 100).unwrap();
        assert_eq!((r.status, r.body.as_slice()), (500, b"ok".as_slice()));
    }
}
