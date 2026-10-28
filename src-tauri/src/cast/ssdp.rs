//! SSDP discovery of UPnP media renderers (only when the user asks: "Cast to device…").
//!
//! One M-SEARCH to the multicast group (or, in tests, to `VHO_SSDP_TARGET`), answers collected
//! for a fixed window. An answer is kept only when its LOCATION is plain http on the SAME IP the
//! answer came from (a spoofed answer cannot point the app at another host), datagrams are
//! capped at 2 KB and at most `MAX_DEVICES` distinct locations are kept.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use super::http;

pub const MULTICAST: &str = "239.255.255.250:1900";
pub const RENDERER: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
const MAX_DEVICES: usize = 32;

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub location: String,
    pub from: IpAddr,
}

pub fn search_message(st: &str) -> String {
    format!("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n")
}

/// Parses one SSDP answer from `from`; `None` for anything that is not a usable 200 answer.
pub fn parse_answer(data: &[u8], from: IpAddr) -> Option<Found> {
    let text = std::str::from_utf8(data).ok()?;
    let mut lines = text.split("\r\n");
    let status = lines.next()?;
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        return None;
    }
    let location = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("location"))
        .map(|(_, v)| v.trim().to_string());
    let location = location?;
    let u = http::parse_url(&location).ok()?;
    if u.host.parse::<IpAddr>().ok()? != from {
        return None;
    }
    Some(Found { location, from })
}

/// Sends one search and collects answers for `window`.
pub fn search(target: SocketAddr, st: &str, window: Duration) -> Result<Vec<Found>, String> {
    let bind: SocketAddr = if target.ip().is_loopback() { "127.0.0.1:0" } else { "0.0.0.0:0" }.parse().unwrap();
    let sock = UdpSocket::bind(bind).map_err(|e| format!("[cast-network] {e}"))?;
    sock.set_multicast_ttl_v4(2).ok();
    let msg = search_message(st);
    // UDP may drop the datagram: send twice, as UPnP recommends
    for _ in 0..2 {
        sock.send_to(msg.as_bytes(), target).map_err(|e| format!("[cast-network] {e}"))?;
    }
    let end = Instant::now() + window;
    let mut out: Vec<Found> = Vec::new();
    let mut buf = [0u8; 2048];
    while let Some(left) = end.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) {
        sock.set_read_timeout(Some(left)).ok();
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                if n == buf.len() {
                    continue; // truncated: ignore
                }
                if let Some(f) = parse_answer(&buf[..n], from.ip()) {
                    if !out.iter().any(|o| o.location == f.location) && out.len() < MAX_DEVICES {
                        out.push(f);
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            // Windows reports ICMP "port unreachable" of an earlier datagram as an error: keep listening
            Err(_) => continue,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_ssdp_answer_rules() {
        let ip: IpAddr = "192.168.1.20".parse().unwrap();
        let ok = b"HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.20:49152/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc::urn\r\n\r\n";
        let f = parse_answer(ok, ip).unwrap();
        assert_eq!(f.location, "http://192.168.1.20:49152/desc.xml");
        // LOCATION pointing at another host (spoofed / SSRF), https, NOTIFY and garbage are dropped
        let other = b"HTTP/1.1 200 OK\r\nLOCATION: http://10.0.0.1/desc.xml\r\n\r\n";
        assert!(parse_answer(other, ip).is_none());
        assert!(parse_answer(b"HTTP/1.1 200 OK\r\nLOCATION: https://192.168.1.20/d\r\n\r\n", ip).is_none());
        assert!(parse_answer(b"NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.20/d\r\n\r\n", ip).is_none());
        assert!(parse_answer(&[0xff, 0xfe, 0x00], ip).is_none());
        assert!(search_message(RENDERER).contains("ST: urn:schemas-upnp-org:device:MediaRenderer:1"));
    }
}
