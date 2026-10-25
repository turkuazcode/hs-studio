import "./i18n-setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, extOf, isImageFile, isAudioOnlyName, isRemoteUrl, DIALOG_FILTERS, itemSize, nameFromUrl,
  isValidMediaUrl, isHlsUrl, VIDEO_EXT, IMAGE_EXT, SUB_EXT,
} from "../../src/media/classify.js";

test("extOf: lower-case extension, query/hash ignored", () => {
  assert.equal(extOf("Film.MKV"), "mkv");
  assert.equal(extOf("a.b.c.Mp4"), "mp4");
  assert.equal(extOf("https://x.org/v/clip.webm?token=1.2#t=3"), "webm");
  assert.equal(extOf("noext"), "noext");
  assert.equal(extOf(), "");
});

test("classify: by extension", () => {
  assert.equal(classify({ name: "a.mp4" }), "video");
  assert.equal(classify({ name: "a.WMV" }), "video");
  assert.equal(classify({ name: "song.mp3" }), "video"); // audio plays in the video element
  assert.equal(classify({ name: "photo.JPG" }), "image");
  assert.equal(classify({ name: "x.webp" }), "image");
  assert.equal(classify({ name: "sub.srt" }), "sub");
  assert.equal(classify({ name: "styled.ass" }), "sub");
  assert.equal(classify({ name: "sub.VTT" }), "sub");
  assert.equal(classify({ name: "doc.pdf" }), "unknown");
  assert.equal(classify({ name: "archive.zip", type: "application/zip" }), "unknown");
});

test("classify: MIME type fallback, subtitles win over MIME", () => {
  assert.equal(classify({ name: "blob", type: "image/heic" }), "image");
  assert.equal(classify({ name: "stream", type: "video/x-matroska" }), "video");
  assert.equal(classify({ name: "voice", type: "audio/ogg" }), "video");
  assert.equal(classify({ name: "x.srt", type: "video/mp4" }), "sub");
  assert.equal(classify({ name: "x.png", type: "video/mp4" }), "image");
});

test("isImageFile / isAudioOnlyName", () => {
  assert.ok(isImageFile("https://x.org/a.png?x=1"));
  assert.ok(!isImageFile("https://x.org/a.mp4"));
  assert.ok(isAudioOnlyName("a.FLAC"));
  assert.ok(!isAudioOnlyName("a.wma")); // wma is not a Chromium audio format
  assert.ok(!isAudioOnlyName("a.mp4"));
});

test("isRemoteUrl: other-origin http(s) only", () => {
  const origin = "http://tauri.localhost";
  assert.ok(isRemoteUrl("https://cdn.example.com/v.mp4", origin));
  assert.ok(isRemoteUrl("HTTP://cdn.example.com/v.mp4", origin));
  assert.ok(!isRemoteUrl("http://tauri.localhost/x.mp4", origin));
  assert.ok(!isRemoteUrl("blob:http://tauri.localhost/123", origin));
  assert.ok(isRemoteUrl("http://asset.localhost/C%3A/a.mp4", origin)); // CORS-enabled, but still another origin
});

test("dialog filters contain every supported extension", () => {
  const exts = DIALOG_FILTERS[0].extensions;
  for (const e of [...VIDEO_EXT, ...IMAGE_EXT, ...SUB_EXT]) assert.ok(exts.includes(e), e);
  assert.deepEqual(DIALOG_FILTERS[1].extensions, ["*"]);
});

test("itemSize: File size, backend size, unknown", () => {
  assert.equal(itemSize({ file: { size: 10 } }), 10);
  assert.equal(itemSize({ size: 20 }), 20);
  assert.equal(itemSize({ url: "x" }), 0);
});

test("URL helpers", () => {
  assert.equal(nameFromUrl("https://x.org/videos/G%C3%BCzel%20Film.mp4?a=1"), "Güzel Film.mp4");
  assert.equal(nameFromUrl("https://x.org/"), "Ağ Akışı");
  assert.equal(nameFromUrl("not a url"), "Ağ Akışı");
  assert.equal(nameFromUrl("https://x.org/%E0%A4%A"), "Ağ Akışı"); // malformed escape
  assert.ok(isValidMediaUrl("https://x.org/a.mp4"));
  assert.ok(!isValidMediaUrl("ftp://x.org/a.mp4"));
  assert.ok(!isValidMediaUrl("https://x.org/a b.mp4"));
  assert.ok(isHlsUrl("https://x.org/live.m3u8"));
  assert.ok(isHlsUrl("https://x.org/live.M3U8?token=1"));
  assert.ok(!isHlsUrl("https://x.org/live.m3u8x"));
});
