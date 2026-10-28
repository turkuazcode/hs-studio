// Network streams / casting helpers (Plan 13/L04): allowed schemes, secrets never shown or
// stored, ICY title, cast error / state mapping, firewall hint.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  castErrorKey, castLooksBlocked, castStateKey, hasSecret, parseStreamUrl, redactUrl, streamTitle,
} from "../../src/media/net-logic.js";
import { entryFromItem } from "../../src/ui/recent-files.js";
import { resumeKey } from "../../src/media/video-player.js";

test("net: only http(s) stream URLs are accepted", () => {
  assert.ok(parseStreamUrl("http://192.168.1.10:8080/live.m3u8"));
  assert.ok(parseStreamUrl(" https://radio.example.org/stream "));
  for (const bad of ["file:///C:/x.mkv", "javascript:alert(1)", "rtmp://x/y", "smb://nas/film.mkv", "http://a b/c", "", "C:\\x.mkv", "http://"]) {
    assert.equal(parseStreamUrl(bad), null, bad);
  }
});

test("net: passwords and tokens are redacted and flagged", () => {
  const u = "https://ali:gizli@cdn.example.com/a/b.m3u8?token=abc&quality=hd&X-Amz-Signature=zz#t=3";
  assert.equal(hasSecret(u), true);
  const r = redactUrl(u);
  assert.equal(r, "https://***@cdn.example.com/a/b.m3u8?token=***&quality=hd&X-Amz-Signature=***#t=3");
  assert.ok(!r.includes("gizli") && !r.includes("abc") && !r.includes("zz"));
  assert.equal(hasSecret("http://nas.local/film.mp4?start=10"), false);
  assert.equal(redactUrl("http://nas.local/film.mp4?start=10"), "http://nas.local/film.mp4?start=10");
  assert.equal(hasSecret("http://h/x?api_key=1"), true);
});

test("net: a URL with a secret is not kept in recent files and its resume key has no secret", () => {
  const secret = { url: "http://u:p@h/live.m3u8?token=t1", name: "live.m3u8" };
  assert.equal(entryFromItem(secret), null);
  assert.ok(!resumeKey(secret).includes("t1") && !resumeKey(secret).includes("u:p"));
  const plain = { url: "http://h/film.mp4", name: "film.mp4" };
  assert.equal(entryFromItem(plain).url, "http://h/film.mp4");
  assert.equal(resumeKey(plain), "vho_url_http://h/film.mp4");
});

test("net: radio title, cast error / state mapping, firewall hint", () => {
  assert.equal(streamTitle("radyo", "Barış Manço - Dönence"), "radyo — Barış Manço - Dönence");
  assert.equal(streamTitle("radyo", "  "), "radyo");
  assert.equal(castErrorKey("cast-format"), "cast.error.format");
  assert.equal(castErrorKey("cast-timeout"), "cast.error.unreachable");
  assert.equal(castErrorKey("nope"), null);
  assert.equal(castStateKey("PLAYING"), "cast.state.playing");
  assert.equal(castStateKey("WEIRD"), "cast.state.loading");
  assert.equal(castLooksBlocked({ active: true, requests: 0, state: "TRANSITIONING" }, 12000), true);
  assert.equal(castLooksBlocked({ active: true, requests: 0, state: "TRANSITIONING" }, 3000), false);
  assert.equal(castLooksBlocked({ active: true, requests: 2, state: "STOPPED" }, 60000), false);
});
