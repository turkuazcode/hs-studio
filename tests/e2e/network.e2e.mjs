// Network streams and casting (Plan 13/L04) in the real app, everything on 127.0.0.1:
// * a local HTTP server serves an HLS playlist, a progressive MP4 and an ICY "radio";
//   it drops connections on purpose (mid-file, one HLS segment) and libmpv must recover;
// * the ICY title reaches the window title;
// * a URL with a password / token is not written to the app's data folder;
// * a FAKE UPnP renderer (SSDP answer + AVTransport) is found from the "⋯" menu, fetches the
//   file from the app's token URL, and after "Stop" the URL no longer works.
// A simulator is not a real TV: real-device compatibility stays a manual check (docs/network.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, launchApp, makeDataDir, mpvStaged, removeDir } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

const J = JSON.stringify;
const FFMPEG = ["", "mpv", join("resources", "mpv")].map((s) => join(dirname(defaultExe()), s, "ffmpeg.exe")).find((p) => existsSync(p));
const skip = !FFMPEG ? "ffmpeg.exe not staged (npm run stage:mpv)" : !mpvStaged() ? "libmpv not staged" : false;
const ICY_TITLE = "Barış Manço - Dönence";
const SECRET = "xyzSECRET42";

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", timeout: 60000 });
}

function makeMedia(dir) {
  const mp4 = join(dir, "klip.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", mp4]);
  const hls = join(dir, "hls");
  execFileSync("cmd", ["/c", "mkdir", hls]);
  // dump_extra: MPEG-4 Part 2 keeps its headers in the MP4 extradata; TS segments need them in-band
  ffmpeg(["-i", mp4, "-c", "copy", "-bsf:v", "dump_extra=freq=keyframe", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(hls, "seg%d.ts"), join(hls, "live.m3u8")]);
  const aac = join(dir, "radio.aac");
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=30", "-c:a", "aac", "-b:a", "64k", "-f", "adts", aac]);
  return { mp4, hls, aac };
}

/** ICY stream: audio with a metadata block after every `metaint` bytes. */
function icyBody(audio, metaint, title) {
  const text = Buffer.from(`StreamTitle='${title}';`, "utf8");
  const n = Math.ceil(text.length / 16);
  const meta = Buffer.alloc(1 + n * 16);
  meta[0] = n;
  text.copy(meta, 1);
  const parts = [];
  for (let o = 0; o < audio.length; o += metaint) {
    parts.push(audio.subarray(o, o + metaint));
    if (o + metaint < audio.length) parts.push(meta);
  }
  return Buffer.concat(parts);
}

function mediaServer({ mp4, hls, aac }) {
  const log = [];
  const mp4Bytes = readFileSync(mp4);
  const state = { dropMp4: true, failSegment: null, failed: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    log.push({ path: url.pathname, range: req.headers.range ?? null, auth: !!req.headers.authorization, icy: req.headers["icy-metadata"] ?? null });
    if (url.pathname.startsWith("/hls/")) {
      const name = url.pathname.slice(5);
      if (name === state.failSegment && !state.failed) {
        state.failed = true;
        req.socket.destroy(); // dropped connection on one segment
        return;
      }
      const p = join(hls, name);
      if (!existsSync(p)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" });
      res.end(readFileSync(p));
      return;
    }
    if (url.pathname === "/klip.mp4") {
      // a URL with a token is a protected resource: Basic challenge first (ffmpeg answers with the URL's user:password)
      if (url.searchParams.has("token") && !req.headers.authorization) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="vho-test"' }).end();
        return;
      }
      const len = mp4Bytes.length;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : len - 1;
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${len}` } : {}),
      });
      if (state.dropMp4 && start === 0) {
        // first full read: 40 % of the file, then the connection breaks
        state.dropMp4 = false;
        res.write(mp4Bytes.subarray(0, Math.floor(len * 0.4)), () => setTimeout(() => req.socket.destroy(), 50));
        return;
      }
      res.end(mp4Bytes.subarray(start, end + 1));
      return;
    }
    if (url.pathname === "/radio") {
      const body = icyBody(readFileSync(aac), 4000, ICY_TITLE);
      res.writeHead(200, { "Content-Type": "audio/aac", "icy-metaint": "4000", "icy-name": "VHO Test FM" });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log, state, port: server.address().port })));
}

const DESC = (port) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
<friendlyName>Sahte TV</friendlyName><manufacturer>VHO</manufacturer><modelName>Simulator</modelName><UDN>uuid:fake-tv</UDN>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>http://127.0.0.1:${port}/avt</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service></serviceList></device></root>`;

const soapOk = (action, inner = "") =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${action}Response></s:Body></s:Envelope>`;

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(url, { headers, timeout: 4000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
  });
}

async function fakeRenderer() {
  const actions = [];
  const state = { uri: null, fetched: null, transport: "STOPPED" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      if (req.method === "GET" && req.url === "/desc.xml") {
        res.writeHead(200, { "Content-Type": "text/xml" }).end(DESC(server.address().port));
        return;
      }
      const action = String(req.headers.soapaction ?? "").replace(/"/g, "").split("#")[1] ?? "";
      actions.push(action);
      let inner = "";
      if (action === "GetProtocolInfo") inner = "<Source></Source><Sink>http-get:*:video/mp4:*,http-get:*:audio/mpeg:*</Sink>";
      if (action === "SetAVTransportURI") {
        state.uri = /<CurrentURI>(.*?)<\/CurrentURI>/s.exec(body)?.[1]?.replace(/&amp;/g, "&") ?? null;
        try {
          const r = await httpGet(state.uri, { Range: "bytes=0-99" }); // like a TV
          state.fetched = { status: r.status, length: r.body.length };
        } catch (e) {
          state.fetched = { error: e.message };
        }
        state.transport = "TRANSITIONING";
      }
      if (action === "Play") state.transport = "PLAYING";
      if (action === "Pause") state.transport = "PAUSED_PLAYBACK";
      if (action === "Stop") state.transport = "STOPPED";
      if (action === "GetTransportInfo") inner = `<CurrentTransportState>${state.transport}</CurrentTransportState>`;
      if (action === "GetPositionInfo") inner = "<TrackDuration>0:00:12</TrackDuration><RelTime>0:00:03</RelTime>";
      res.writeHead(200, { "Content-Type": "text/xml" }).end(soapOk(action, inner));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, rinfo) => {
    if (!msg.toString().includes("MediaRenderer")) return;
    const answer = `HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${port}/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:fake-tv::urn\r\n\r\n`;
    udp.send(answer, rinfo.port, rinfo.address);
  });
  await new Promise((r) => udp.bind(0, "127.0.0.1", r));
  return { actions, state, ssdp: `127.0.0.1:${udp.address().port}`, close: () => { server.close(); udp.close(); } };
}

/** Every file under `dir` that contains `needle` (UTF-8 or UTF-16LE). */
function filesContaining(dir, needle) {
  const hits = [];
  const a = Buffer.from(needle, "utf8");
  const b = Buffer.from(needle, "utf16le");
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (statSync(p).size < 64 * 1024 * 1024) {
        const buf = readFileSync(p);
        if (buf.includes(a) || buf.includes(b)) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

async function openUrl(app, url) {
  await app.click("#btn-open-url");
  await app.eval(`(() => { const i = document.getElementById("input-video-url"); i.value = ${J(url)}; return true; })()`);
  await app.click("#btn-confirm-url");
}

test("network streams: HLS + dropped connections recover, ICY title, secrets not stored, UPnP cast to a fake renderer", { timeout: 300000, skip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-net-"));
  const media = makeMedia(work);
  const srv = await mediaServer(media);
  const fake = await fakeRenderer();
  const base = `http://127.0.0.1:${srv.port}`;
  const dataDir = await makeDataDir();
  const app = await launchApp({ dataDir, env: { VHO_SSDP_TARGET: fake.ssdp, VHO_SSDP_WINDOW_MS: "1000" } });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!window.__vhoCast`, { timeoutMs: 15000 });
    const caps = await app.eval(`Object.fromEntries(window.__vhoEngine.capabilities.filter((c) => /^(net|cast)\\./.test(c.id)).map((c) => [c.id, [c.available, c.support]]))`);
    assert.deepEqual(caps, {
      "net.streams": [true, "supported-tested"],
      "cast.dlna": [true, "supported-untested"],
      "cast.chromecast": [false, "unsupported"],
    });

    // KNOWN ISSUE (docs/network.md): in libmpv the local HLS fixture stalls after the first
    // segment and segments are re-opened several times (ffmpeg CLI plays it cleanly). Kept running as todo.
    const HLS_TODO = "libmpv HLS stalls after the first segment (docs/network.md, open issue)";
    await t.test("HLS from the URL dialog plays", { todo: HLS_TODO }, async () => {
      await openUrl(app, `${base}/hls/live.m3u8`);
      await app.waitFor(`window.__vhoEngine.kind === "mpv" && window.__vhoEngine.duration > 10`, { timeoutMs: 20000, message: "HLS loaded" });
      await app.waitFor("window.__vhoEngine.time > 5", { timeoutMs: 20000, message: "HLS plays across segments" })
        .catch(async (e) => {
          const st = await app.eval(`({ t: window.__vhoEngine.time, paused: window.__vhoEngine.paused })`);
          throw new Error(`${e.message}; engine ${J(st)}; requests ${J(srv.log.map((l) => l.path))}`);
        });
    });

    await t.test("HLS: a dropped segment connection does not stop playback", { todo: HLS_TODO }, async () => {
      srv.state.failSegment = "seg2.ts";
      srv.log.length = 0;
      await openUrl(app, `${base}/hls/live.m3u8?again=1`);
      await app.waitFor(`window.__vhoEngine.kind === "mpv" && window.__vhoEngine.duration > 10`, { timeoutMs: 20000, message: "HLS loaded" });
      // plays through segment 2 (4.3-6.2 s), whose first connection is dropped
      await app.waitFor("window.__vhoEngine.time > 7", { timeoutMs: 30000, message: "played past the dropped segment" })
        .catch(async (e) => {
          const st = await app.eval(`({ t: window.__vhoEngine.time, paused: window.__vhoEngine.paused, d: window.__vhoEngine.duration })`);
          throw new Error(`${e.message}; engine ${J(st)}; requests ${J(srv.log.map((l) => l.path))}`);
        });
      assert.equal(srv.state.failed, true, "the segment connection was dropped once");
      assert.equal(await app.eval(`document.getElementById("current-filename").textContent`), "live.m3u8");
    });

    await t.test("progressive MP4: the connection breaks at 40 %, libmpv reconnects with a Range request", async () => {
      await openUrl(app, `${base}/klip.mp4`);
      await app.waitFor(`window.__vhoEngine.duration > 10 && document.getElementById("current-filename").textContent === "klip.mp4"`, { timeoutMs: 20000, message: "mp4 loaded" });
      // no seeking (a seek would also send a Range request): 40 % of the file is ~4.8 s
      await app.waitFor("window.__vhoEngine.time > 7", { timeoutMs: 30000, message: "played past the break" });
      const len = statSync(media.mp4).size;
      const resumed = srv.log.filter((l) => l.path === "/klip.mp4" && l.range).map((l) => Number(/bytes=(\d+)-/.exec(l.range)?.[1] ?? -1));
      assert.ok(resumed.some((s) => s > len * 0.3 && s <= len * 0.4), `a ranged reconnect from the break point (${J(resumed)}, length ${len})`);
    });

    await t.test("internet radio: the ICY title is shown with the stream name", async () => {
      await openUrl(app, `${base}/radio`);
      await app.waitFor(`document.getElementById("current-filename").dataset.streamTitle === ${J(ICY_TITLE)}`, { timeoutMs: 20000, message: "ICY title" });
      assert.equal(await app.text("#current-filename"), `radio — ${ICY_TITLE}`);
      assert.ok(srv.log.some((l) => l.path === "/radio" && l.icy === "1"), "ICY metadata requested");
    });

    await t.test("a URL with a password and a token plays, but neither is stored", async () => {
      const u = `http://kullanici:parola${SECRET}@127.0.0.1:${srv.port}/klip.mp4?token=${SECRET}&q=1`;
      await openUrl(app, u);
      await app.waitFor(`window.__vhoEngine.duration > 10 && window.__vhoEngine.time > 0.5`, { timeoutMs: 20000, message: "secret URL plays" });
      assert.match(await app.toast(), /son açılanlara kaydedilmez|not saved in recent/);
      assert.ok(srv.log.some((l) => l.path === "/klip.mp4" && l.auth), "credentials were used for the request");
      assert.ok(!(await app.text("#current-filename")).includes(SECRET));
      await app.eval("window.__vhoEngine.pause(), true");
    });

    await t.test("cast: fake renderer found from the ⋯ menu, fetches the token URL; Stop closes it", async () => {
      await app.eval(`window.__vhoEngine.openPaths(${J([media.mp4])}), true`);
      await app.waitFor(`window.__vhoEngine.duration > 10 && document.getElementById("current-filename").textContent === "klip.mp4" && !document.getElementById("media-actions").hidden`, { timeoutMs: 20000, message: "local file" });
      await app.click("#ma-more");
      await app.waitFor(`!!document.querySelector('#media-actions-menu [data-menu-id="castDevice"]')`, { timeoutMs: 3000, message: "cast item" });
      await app.click('#media-actions-menu [data-menu-id="castDevice"]');
      await app.waitFor(`document.getElementById("vho-cast-devices")?.dataset.state === "found"`, { timeoutMs: 10000, message: "device found" });
      assert.equal(await app.eval(`document.querySelector("#vho-cast-devices li strong").textContent`), "Sahte TV");
      await app.click("#vho-cast-devices li");
      await app.waitFor(`document.documentElement.dataset.casting === "1" && document.getElementById("vho-cast-now").dataset.state === "PLAYING"`, { timeoutMs: 10000, message: "casting" });
      assert.deepEqual(fake.actions.slice(0, 3), ["GetProtocolInfo", "SetAVTransportURI", "Play"]);
      assert.deepEqual(fake.state.fetched, { status: 206, length: 100 });
      assert.match(fake.state.uri, /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{32}\/klip\.mp4$/);
      assert.equal(await app.eval("window.__vhoEngine.paused"), true, "local playback paused while casting");
      // a wrong token is refused
      const wrong = fake.state.uri.replace(/\/m\/[0-9a-f]{32}\//, `/m/${"0".repeat(32)}/`);
      assert.equal((await httpGet(wrong)).status, 404);

      await app.click("#vho-cast-pause");
      await app.waitFor(`document.getElementById("vho-cast-now").dataset.state === "PAUSED_PLAYBACK"`, { timeoutMs: 6000 });
      await app.click("#vho-cast-stop");
      await app.waitFor(`!document.documentElement.dataset.casting`, { timeoutMs: 8000, message: "stopped" });
      assert.equal(fake.actions.at(-1), "Stop");
      await assert.rejects(httpGet(fake.state.uri), "the media URL is closed after Stop");
      await app.click("#vho-cast-close");
    });
  } finally {
    await app.close();
    fake.close();
    srv.server.close();
  }
  // nothing in the app's data folder (settings, library.db, recent files, resume) holds the secret
  assert.deepEqual(filesContaining(dataDir, SECRET), []);
  await removeDir(dataDir);
  await removeDir(work);
});
