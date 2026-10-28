//! Cast flow against a FAKE UPnP renderer on loopback (SSDP answer, description, AVTransport,
//! ConnectionManager). The fake fetches the media URL like a TV would. A simulator is not a
//! real device: real-renderer compatibility is checked by hand (docs/network.md).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;

#[derive(Default)]
struct Log {
    actions: Vec<String>,
    uri: Option<String>,
    fetched: Option<(u16, Vec<u8>)>,
}

struct Fake {
    ssdp: SocketAddr,
    log: Arc<Mutex<Log>>,
    sink: Arc<Mutex<String>>,
    hang: Arc<AtomicBool>,
}

fn desc(port: u16) -> String {
    upnp::TEST_DESC.replace("/upnp/control/avt", &format!("http://127.0.0.1:{port}/avt")).replace("<controlURL>cm<", "<controlURL>/cm<")
}

fn read_request(c: &mut TcpStream) -> (String, String) {
    let mut data = Vec::new();
    let mut b = [0u8; 4096];
    loop {
        let n = c.read(&mut b).unwrap_or(0);
        if n == 0 {
            break;
        }
        data.extend_from_slice(&b[..n]);
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]).to_string();
            let len = head
                .lines()
                .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length")).map(|(_, v)| v.trim().parse::<usize>().unwrap()))
                .unwrap_or(0);
            if data.len() >= end + 4 + len {
                return (head, String::from_utf8_lossy(&data[end + 4..end + 4 + len]).to_string());
            }
        }
    }
    (String::from_utf8_lossy(&data).to_string(), String::new())
}

fn respond(c: &mut TcpStream, status: &str, body: &str) {
    let _ = c.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes());
}

fn soap_ok(action: &str, inner: &str) -> String {
    format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"x\">{inner}</u:{action}Response></s:Body></s:Envelope>")
}

fn fake_renderer() -> Fake {
    let http = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = http.local_addr().unwrap().port();
    let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let ssdp = udp.local_addr().unwrap();
    let log = Arc::new(Mutex::new(Log::default()));
    let sink = Arc::new(Mutex::new("http-get:*:video/mp4:*,http-get:*:audio/mpeg:*".to_string()));
    let hang = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        let mut b = [0u8; 2048];
        while let Ok((n, from)) = udp.recv_from(&mut b) {
            if String::from_utf8_lossy(&b[..n]).contains("MediaRenderer") {
                let a = format!("HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:{port}/desc.xml\r\nST: {}\r\nUSN: uuid:fake-1::x\r\n\r\n", ssdp::RENDERER);
                let _ = udp.send_to(a.as_bytes(), from);
            }
        }
    });
    let (lg, sk, hg) = (log.clone(), sink.clone(), hang.clone());
    std::thread::spawn(move || {
        for c in http.incoming() {
            let Ok(mut c) = c else { continue };
            let (lg, sk, hg) = (lg.clone(), sk.clone(), hg.clone());
            std::thread::spawn(move || {
                let (head, body) = read_request(&mut c);
                if hg.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_secs(30)); // a device that stopped answering
                    return;
                }
                if head.starts_with("GET /desc.xml") {
                    return respond(&mut c, "200 OK", &desc(port));
                }
                let action = head.lines().find_map(|l| l.split_once('#').map(|(_, a)| a.trim_end_matches('"').to_string())).unwrap_or_default();
                lg.lock().unwrap().actions.push(action.clone());
                let reply = match action.as_str() {
                    "GetProtocolInfo" => soap_ok(&action, &format!("<Source></Source><Sink>{}</Sink>", sk.lock().unwrap())),
                    "SetAVTransportURI" => {
                        let n = xml::parse(&body).unwrap();
                        let uri = n.find("CurrentURI").unwrap().text.clone();
                        // like a TV: fetch the first bytes with a Range request
                        let r = http::request("GET", &uri, &[("Range", "bytes=0-99")], &[], Duration::from_secs(5), 1 << 20).unwrap();
                        let mut l = lg.lock().unwrap();
                        l.uri = Some(uri);
                        l.fetched = Some((r.status, r.body));
                        soap_ok(&action, "")
                    }
                    "GetTransportInfo" => soap_ok(&action, "<CurrentTransportState>PLAYING</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>"),
                    "GetPositionInfo" => soap_ok(&action, "<TrackDuration>0:01:00</TrackDuration><RelTime>0:00:05</RelTime>"),
                    "Seek" if body.contains("99:00:00") => {
                        return respond(&mut c, "500 Internal Server Error", "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"x\"><s:Body><s:Fault><detail><UPnPError><errorCode>711</errorCode><errorDescription>Illegal seek target</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
                    }
                    a => soap_ok(a, ""),
                };
                respond(&mut c, "200 OK", &reply);
            });
        }
    });
    Fake { ssdp, log, sink, hang }
}

fn get(url: &str) -> Result<http::Response, String> {
    http::request("GET", url, &[], &[], Duration::from_secs(3), 1 << 20)
}

#[test]
fn cast_fake_renderer_full_flow() {
    let dir = std::env::temp_dir().join(format!("vho-cast-{}-{}", std::process::id(), crate::storage::now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let media = dir.join("klip 1.mp4");
    let bytes: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&media, &bytes).unwrap();
    let fake = fake_renderer();

    // discovery (unicast to the fake instead of the multicast group)
    let devs = discover(fake.ssdp, Duration::from_millis(800)).unwrap();
    assert_eq!(devs.len(), 1, "one renderer");
    assert_eq!(devs[0].name, "Salon TV & Ses");
    let id = devs[0].id.clone();

    // start: format check, URI, play, seek to the local position
    start(&id, &media, "Klip <1>", 12.0).unwrap();
    {
        let l = fake.log.lock().unwrap();
        assert_eq!(l.actions, ["GetProtocolInfo", "SetAVTransportURI", "Play", "Seek"]);
        let (status, body) = l.fetched.clone().unwrap();
        assert_eq!(status, 206, "Range answered with 206");
        assert_eq!(body, bytes[..100].to_vec());
    }
    let uri = fake.log.lock().unwrap().uri.clone().unwrap();
    assert!(uri.starts_with("http://127.0.0.1:") && uri.ends_with("/klip%201.mp4"), "{uri}");

    // only the exact token URL serves the file
    let token_dir = &uri[..uri.rfind('/').unwrap()];
    assert_eq!(get(&uri).unwrap().body, bytes);
    assert_eq!(get(&format!("{token_dir}/other.mp4")).unwrap().status, 404);
    assert_eq!(get(&format!("{token_dir}/../klip%201.mp4")).unwrap().status, 404);
    let origin = &uri[..uri.find("/m/").unwrap()];
    assert_eq!(get(&format!("{origin}/m/{}/klip%201.mp4", "0".repeat(32))).unwrap().status, 404);
    assert_eq!(get(&format!("{origin}/")).unwrap().status, 404, "no listing");

    let st = status().unwrap();
    assert!(st.active);
    assert_eq!((st.state.as_deref(), st.position, st.duration), (Some("PLAYING"), Some(5.0), Some(60.0)));
    assert!(st.requests >= 2);

    control("pause", None).unwrap();
    let err = control("seek", Some(99.0 * 3600.0)).unwrap_err();
    assert!(err.starts_with("[cast-rejected]") && err.contains("711"), "{err}");

    // stop: renderer told to stop, the media URL no longer works
    control("stop", None).unwrap();
    assert_eq!(fake.log.lock().unwrap().actions.last().map(String::as_str), Some("Stop"));
    assert!(get(&uri).is_err(), "URL must be dead after stop");
    assert!(!status().unwrap().active);
    assert!(control("pause", None).unwrap_err().starts_with("[cast-inactive]"));

    // a type the renderer does not list: clear error, nothing sent
    *fake.sink.lock().unwrap() = "http-get:*:audio/mpeg:*".into();
    let mkv = dir.join("film.mkv");
    std::fs::write(&mkv, b"x").unwrap();
    fake.log.lock().unwrap().actions.clear();
    assert!(start(&id, &mkv, "film", 0.0).unwrap_err().starts_with("[cast-format]"));
    assert_eq!(fake.log.lock().unwrap().actions, ["GetProtocolInfo"]);
    assert!(start(&id, &dir.join("x.exe"), "x", 0.0).unwrap_err().starts_with("[cast-format]"));

    // a device that stops answering: errors within the timeout, does not hang
    *fake.sink.lock().unwrap() = "http-get:*:*:*".into();
    start(&id, &media, "Klip", 0.0).unwrap();
    let uri = fake.log.lock().unwrap().uri.clone().unwrap();
    assert_eq!(get(&uri).unwrap().status, 200);
    fake.hang.store(true, Ordering::SeqCst);
    let t = Instant::now();
    let err = status().unwrap_err();
    assert!(err.starts_with("[cast-timeout]"), "{err}");
    assert!(t.elapsed() < Duration::from_secs(8));
    shutdown();
    assert!(get(&uri).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
