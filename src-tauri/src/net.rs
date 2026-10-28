//! Network streams (Plan 13/L04): allowed URL schemes, per-file reconnect options for libmpv,
//! and removal of secrets from anything that is logged.
//!
//! * Only `http`/`https` URLs are opened as network streams (the URL dialog checks the same
//!   list, src/media/net-url.js). A URL is passed to libmpv as data, never to a shell.
//! * Private / LAN addresses are allowed on purpose (home NAS, local HLS server).
//! * Secrets: userinfo (`user:password@`) and token-like query values are replaced by `***`
//!   in log lines (mpv messages included).

pub const SCHEMES: &[&str] = &["http", "https"];

/// Query parameter names whose values are treated as secrets.
fn secret_param(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const EXACT: &[&str] = &["key", "sig", "auth", "code", "pwd", "pass", "jwt", "session", "sessionid", "sid", "hash", "hdnts", "hdnea", "policy"];
    EXACT.contains(&n.as_str()) || ["token", "secret", "password", "signature", "credential", "apikey", "api_key", "auth"].iter().any(|s| n.contains(s))
}

/// `scheme://` prefix of an allowed stream URL.
pub fn is_stream_url(url: &str) -> bool {
    url.split_once("://").is_some_and(|(s, rest)| SCHEMES.contains(&s.to_ascii_lowercase().as_str()) && !rest.is_empty() && !url.chars().any(char::is_whitespace))
}

fn redact_one(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return url.to_string() };
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(auth_end);
    let authority = match authority.rfind('@') {
        Some(i) => format!("***@{}", &authority[i + 1..]),
        None => authority.to_string(),
    };
    let (path, query) = match tail.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (tail, None),
    };
    let mut out = format!("{scheme}://{authority}{path}");
    if let Some(q) = query {
        let (q, frag) = match q.split_once('#') {
            Some((q, f)) => (q, Some(f)),
            None => (q, None),
        };
        let parts: Vec<String> = q
            .split('&')
            .map(|kv| match kv.split_once('=') {
                Some((k, _)) if secret_param(k) => format!("{k}=***"),
                _ => kv.to_string(),
            })
            .collect();
        out.push('?');
        out.push_str(&parts.join("&"));
        if let Some(f) = frag {
            out.push('#');
            out.push_str(f);
        }
    }
    out
}

/// Replaces secrets in every `scheme://…` URL inside `text`.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        // scheme = the letters right before "://"
        let start = rest[..i].rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')).map(|p| p + 1).unwrap_or(0);
        let end = rest[i..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>').map(|p| i + p).unwrap_or(rest.len());
        out.push_str(&rest[..start]);
        out.push_str(&redact_one(&rest[start..end]));
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// An HLS playlist URL (`.m3u8` / `.m3u` path, query and fragment ignored).
pub fn is_hls_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    path.ends_with(".m3u8") || path.ends_with(".m3u")
}

/// Per-file libmpv options for a network URL: reconnect after a dropped connection (bounded),
/// network timeout. Local files get none. (An HLS segment that fails is skipped by FFmpeg;
/// `seg_max_retry` through `demuxer-lavf-o` made libmpv re-open every segment and stall.)
///
/// HLS gets no `reconnect_streamed` (audit D02): the HLS demuxer passes these options on to every
/// segment, and FFmpeg's http treats the normal end of a segment sent without Content-Length
/// (chunked) as a premature disconnect when `reconnect_streamed` is set: it downloaded the
/// segment again with 1 / 3 / 7 s back-off and playback stalled after the first segment. A
/// failed segment connection is still retried (`reconnect_on_network_error`). Radio and other
/// endless streams keep `reconnect_streamed`: there an end of data is a dropped connection.
pub fn load_options(url: &str) -> Vec<(&'static str, String)> {
    if !is_stream_url(url) {
        return Vec::new();
    }
    let streamed = if is_hls_url(url) { "" } else { "reconnect_streamed=1," };
    vec![
        ("network-timeout", "20".to_string()),
        (
            "stream-lavf-o",
            format!("reconnect=1,{streamed}reconnect_on_network_error=1,reconnect_delay_max=8,reconnect_max_retries=6"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_redacts_credentials_and_tokens() {
        let s = "[ffmpeg] http: Opening 'https://user:p%40ss@cdn.example.com/live/a.m3u8?token=abc123&quality=hd&X-Amz-Signature=zzz#t=1' for reading";
        let r = redact(s);
        assert!(!r.contains("p%40ss") && !r.contains("user:") && !r.contains("abc123") && !r.contains("zzz"), "{r}");
        assert!(r.contains("https://***@cdn.example.com/live/a.m3u8?token=***&quality=hd&X-Amz-Signature=***#t=1"), "{r}");
        assert_eq!(redact("no url here"), "no url here");
        assert_eq!(redact("file:///C:/a b.mkv"), "file:///C:/a b.mkv");
        assert_eq!(redact("x http://h/p?api_key=1&sid=2&a=3 y"), "x http://h/p?api_key=***&sid=***&a=3 y");
    }

    #[test]
    fn net_allowed_schemes_and_options() {
        assert!(is_stream_url("http://192.168.1.2:8080/a.m3u8"));
        assert!(is_stream_url("HTTPS://x/y"));
        for bad in ["file:///c:/x", "rtmp://x/y", "javascript:alert(1)", "http://", "http://a b", "smb://nas/x", "C:\\x.mkv"] {
            assert!(!is_stream_url(bad), "{bad}");
        }
        assert!(load_options("C:\\film.mkv").is_empty());
        let o = load_options("http://h/live.m3u8?x=1");
        assert!(o.iter().any(|(k, v)| *k == "stream-lavf-o" && v.contains("reconnect=1") && v.contains("reconnect_on_network_error=1")));
        assert!(!o.iter().any(|(k, _)| *k == "demuxer-lavf-o"));
        // HLS: a chunked segment's normal end must not count as a dropped connection
        for hls in ["http://h/live.m3u8?x=1", "https://h/a/B.M3U8#t=3", "http://h/list.m3u"] {
            assert!(is_hls_url(hls), "{hls}");
            assert!(load_options(hls).iter().all(|(_, v)| !v.contains("reconnect_streamed")), "{hls}");
        }
        // radio / progressive: an end of data is a dropped connection, reconnect
        for other in ["http://h/radio", "http://h/live.m3u8.mp3", "http://h/x.mp4?f=.m3u8"] {
            assert!(!is_hls_url(other), "{other}");
            assert!(load_options(other).iter().any(|(_, v)| v.contains("reconnect_streamed=1")), "{other}");
        }
    }
}
