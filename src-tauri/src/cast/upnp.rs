//! UPnP AV MediaRenderer: device description and AVTransport / ConnectionManager SOAP calls.

use std::net::IpAddr;
use std::time::Duration;

use serde::Serialize;

use super::{http, xml};

pub const AVT: &str = "urn:schemas-upnp-org:service:AVTransport:1";
pub const CM: &str = "urn:schemas-upnp-org:service:ConnectionManager:1";
/// Description / SOAP answers larger than this are refused.
pub const MAX_XML: usize = 256 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renderer {
    /// UDN (stable device id)
    pub id: String,
    pub name: String,
    pub model: String,
    #[serde(skip)]
    pub ip: Option<IpAddr>,
    #[serde(skip)]
    pub avt_control: String,
    #[serde(skip)]
    pub cm_control: Option<String>,
}

/// Parses a device description fetched from `location` (device at `ip`). Control URLs must stay
/// on the same host as the description.
pub fn parse_description(body: &str, location: &str, ip: IpAddr) -> Result<Renderer, String> {
    let root = xml::parse(body)?;
    let base = root.child_text("URLBase").filter(|s| !s.is_empty()).unwrap_or(location).to_string();
    let mut devices = Vec::new();
    root.find_all("device", &mut devices);
    for d in devices {
        if !d.child_text("deviceType").is_some_and(|t| t.contains(":device:MediaRenderer:")) {
            continue;
        }
        let mut services = Vec::new();
        if let Some(list) = d.child("serviceList") {
            list.find_all("service", &mut services);
        }
        let control = |kind: &str| -> Option<String> {
            let s = services.iter().find(|s| s.child_text("serviceType").is_some_and(|t| t.starts_with(&kind[..kind.len() - 1])))?;
            let url = http::join(&base, s.child_text("controlURL")?);
            let u = http::parse_url(&url).ok()?;
            (u.host.parse::<IpAddr>().ok()? == ip).then_some(url)
        };
        let Some(avt) = control(AVT) else { continue };
        return Ok(Renderer {
            id: d.child_text("UDN").unwrap_or(location).to_string(),
            name: d.child_text("friendlyName").filter(|s| !s.is_empty()).unwrap_or("UPnP").chars().take(80).collect(),
            model: [d.child_text("manufacturer"), d.child_text("modelName")].into_iter().flatten().collect::<Vec<_>>().join(" ").chars().take(80).collect(),
            ip: Some(ip),
            avt_control: avt,
            cm_control: control(CM),
        });
    }
    Err("[cast-not-renderer] no MediaRenderer with AVTransport".into())
}

pub fn describe(location: &str, ip: IpAddr) -> Result<Renderer, String> {
    let r = http::request("GET", location, &[], &[], TIMEOUT, MAX_XML)?;
    if r.status != 200 {
        return Err(format!("[cast-unreachable] HTTP {}", r.status));
    }
    parse_description(&String::from_utf8_lossy(&r.body), location, ip)
}

pub fn envelope(service: &str, action: &str, args: &[(&str, &str)]) -> String {
    let mut body = String::new();
    for (k, v) in args {
        body.push_str(&format!("<{k}>{}</{k}>", xml::escape(v)));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{body}</u:{action}></s:Body></s:Envelope>"
    )
}

/// One SOAP action; returns the `<action>Response` node. A UPnP fault becomes `[cast-rejected] <code> <text>`.
pub fn soap(control: &str, service: &str, action: &str, args: &[(&str, &str)]) -> Result<xml::Node, String> {
    let body = envelope(service, action, args);
    let soap_action = format!("\"{service}#{action}\"");
    let r = http::request(
        "POST",
        control,
        &[("Content-Type", "text/xml; charset=\"utf-8\""), ("SOAPACTION", &soap_action)],
        body.as_bytes(),
        TIMEOUT,
        MAX_XML,
    )?;
    let text = String::from_utf8_lossy(&r.body);
    if r.status != 200 {
        let detail = xml::parse(&text).ok().map(|n| {
            let code = n.find("errorCode").map(|c| c.text.trim().to_string()).unwrap_or_default();
            let desc = n.find("errorDescription").map(|c| c.text.trim().to_string()).unwrap_or_default();
            format!("{code} {desc}").trim().to_string()
        });
        return Err(format!("[cast-rejected] {action}: {}", detail.filter(|d| !d.is_empty()).unwrap_or_else(|| format!("HTTP {}", r.status))));
    }
    let root = xml::parse(&text)?;
    root.find(&format!("{action}Response")).cloned().ok_or_else(|| format!("[cast-bad-response] {action}"))
}

/// DIDL-Lite metadata for SetAVTransportURI (title, class, one resource).
pub fn didl(title: &str, mime: &str, url: &str) -> String {
    let class = if mime.starts_with("audio/") {
        "object.item.audioItem.musicTrack"
    } else if mime.starts_with("image/") {
        "object.item.imageItem.photo"
    } else {
        "object.item.videoItem"
    };
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\">\
         <dc:title>{}</dc:title><upnp:class>{class}</upnp:class><res protocolInfo=\"http-get:*:{mime}:*\">{}</res></item></DIDL-Lite>",
        xml::escape(title),
        xml::escape(url)
    )
}

/// `Some(false)` when the renderer's sink list names formats and `mime` is not among them;
/// `None` when it does not tell (no ConnectionManager, failed call, wildcard).
pub fn sink_accepts(sink_csv: &str, mime: &str) -> Option<bool> {
    let entries: Vec<&str> = sink_csv.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if entries.is_empty() {
        return None;
    }
    let mut any_http = false;
    for e in entries {
        let parts: Vec<&str> = e.split(':').collect();
        if parts.len() < 3 || !(parts[0] == "http-get" || parts[0] == "*") {
            continue;
        }
        any_http = true;
        let m = parts[2];
        if m == "*" || m.eq_ignore_ascii_case(mime) || (m.ends_with("/*") && mime.starts_with(&m[..m.len() - 1])) {
            return Some(true);
        }
    }
    any_http.then_some(false)
}

/// `HH:MM:SS` (also `H:MM:SS.mmm`) -> seconds.
pub fn parse_time(s: &str) -> Option<f64> {
    let p: Vec<&str> = s.trim().split(':').collect();
    if p.len() != 3 {
        return None;
    }
    Some(p[0].parse::<f64>().ok()? * 3600.0 + p[1].parse::<f64>().ok()? * 60.0 + p[2].parse::<f64>().ok()?)
}

pub fn format_time(sec: f64) -> String {
    let s = sec.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

#[cfg(test)]
pub const TEST_DESC: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major></specVersion>
<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Salon TV &amp; Ses</friendlyName>
<manufacturer>Acme</manufacturer><modelName>R1</modelName><UDN>uuid:1234</UDN>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/avt</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>cm</controlURL></service>
</serviceList></device></root>"#;

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn cast_description_and_soap_shapes() {
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let r = parse_description(TEST_DESC, "http://192.168.1.9:8080/dev/desc.xml", ip).unwrap();
        assert_eq!((r.id.as_str(), r.name.as_str(), r.model.as_str()), ("uuid:1234", "Salon TV & Ses", "Acme R1"));
        assert_eq!(r.avt_control, "http://192.168.1.9:8080/upnp/control/avt");
        assert_eq!(r.cm_control.as_deref(), Some("http://192.168.1.9:8080/dev/cm"));
        // a control URL on another host is not accepted
        let evil = TEST_DESC.replace("/upnp/control/avt", "http://10.0.0.1/avt");
        assert!(parse_description(&evil, "http://192.168.1.9:8080/dev/desc.xml", ip).is_err());
        let server = TEST_DESC.replace("MediaRenderer", "MediaServer");
        assert!(parse_description(&server, "http://192.168.1.9:8080/d", ip).unwrap_err().starts_with("[cast-not-renderer]"));

        let env = envelope(AVT, "SetAVTransportURI", &[("InstanceID", "0"), ("CurrentURIMetaData", &didl("A<B", "video/mp4", "http://h/m?a=1&b=2"))]);
        // the DIDL document is escaped once inside the envelope, so the envelope is well formed
        let n = xml::parse(&env).unwrap();
        let meta = &n.find("CurrentURIMetaData").unwrap().text;
        let d = xml::parse(meta).unwrap();
        assert_eq!(d.find("title").unwrap().text, "A<B");
        assert_eq!(d.find("res").unwrap().text, "http://h/m?a=1&b=2");

        assert_eq!(sink_accepts("http-get:*:video/mp4:*,http-get:*:audio/mpeg:*", "video/mp4"), Some(true));
        assert_eq!(sink_accepts("http-get:*:video/mp4:*", "video/x-matroska"), Some(false));
        assert_eq!(sink_accepts("http-get:*:video/*:*", "video/webm"), Some(true));
        assert_eq!(sink_accepts("http-get:*:*:*", "audio/flac"), Some(true));
        assert_eq!(sink_accepts("", "audio/flac"), None);
        assert_eq!(parse_time("01:02:03.500"), Some(3723.5));
        assert_eq!(format_time(3723.4), "1:02:03");
    }
}
