import "./i18n-setup.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapIndex, wrapIndexWhere, photoPosition, hasNextItem, itemMetaText } from "../../src/ui/playlist.js";
import { isMusicName } from "../../src/media/classify.js";
import { partitionEntries, toPlaylistItem } from "../../src/media/loader.js";

test("wrapIndex: forward / backward inside the list", () => {
  assert.equal(wrapIndex(0, 1, 3), 1);
  assert.equal(wrapIndex(2, -1, 3), 1);
});

test("wrapIndex: wraps at both ends", () => {
  assert.equal(wrapIndex(2, 1, 3), 0);
  assert.equal(wrapIndex(0, -1, 3), 2);
  assert.equal(wrapIndex(-1, -1, 3), 2); // nothing selected yet, going back
  assert.equal(wrapIndex(-1, 1, 3), 0);  // nothing selected yet, going forward
});

test("wrapIndex: single item and empty list", () => {
  assert.equal(wrapIndex(0, 1, 1), 0);
  assert.equal(wrapIndex(0, -1, 1), 0);
  assert.equal(wrapIndex(0, 1, 0), -1);
});

test("hasNextItem: auto-advance only before the last item", () => {
  assert.ok(hasNextItem(0, 2));
  assert.ok(!hasNextItem(1, 2));
  assert.ok(!hasNextItem(-1, 2));
  assert.ok(!hasNextItem(0, 0));
  assert.ok(!hasNextItem(0, 1));
});

test("itemMetaText: size for browser and local files, stream label for URLs", () => {
  assert.equal(itemMetaText({ file: { size: 3 * 1048576 } }), "3.0 MB");
  assert.equal(itemMetaText({ path: "C:\\a.mp4", size: 5 * 1048576 }), "5.0 MB"); // was "Ağ Akışı" (bug)
  assert.equal(itemMetaText({ url: "https://x/a.mp4" }), "Ağ Akışı");
});

test("partitionEntries: media, subtitles and rejected count", () => {
  const entries = [{ name: "a.mp4" }, { name: "b.jpg" }, { name: "c.srt" }, { name: "d.exe" }, { name: "e.vtt" }];
  const { media, subs, rejected } = partitionEntries(entries);
  assert.deepEqual(media.map((e) => e.name), ["a.mp4", "b.jpg"]);
  assert.deepEqual(subs.map((e) => e.name), ["c.srt", "e.vtt"]);
  assert.equal(rejected, 1);
});

test("toPlaylistItem: backend entries keep path and size", () => {
  assert.deepEqual(toPlaylistItem({ path: "C:\\v\\a.mp4", name: "a.mp4", size: 5 }, false),
    { path: "C:\\v\\a.mp4", name: "a.mp4", size: 5, isImage: false });
  assert.deepEqual(toPlaylistItem({ path: "/p/b.PNG", name: "b.PNG", size: 1 }, false),
    { path: "/p/b.PNG", name: "b.PNG", size: 1, isImage: true });
  const file = { name: "c.webp", size: 7 };
  assert.deepEqual(toPlaylistItem(file, true), { file, name: "c.webp", isImage: true });
});

// mixed list: video, photo, music, photo
const MIXED = [{ name: "a.mp4", isImage: false }, { name: "b.jpg", isImage: true }, { name: "c.mp3", isImage: false }, { name: "d.png", isImage: true }];
const isPhoto = (i) => i.isImage;

test("wrapIndexWhere: photo navigation skips videos and music, wrapping", () => {
  assert.equal(wrapIndexWhere(1, 1, MIXED, isPhoto), 3);
  assert.equal(wrapIndexWhere(3, 1, MIXED, isPhoto), 1);
  assert.equal(wrapIndexWhere(1, -1, MIXED, isPhoto), 3);
  assert.equal(wrapIndexWhere(0, 1, [MIXED[1]], isPhoto), 0); // the only photo: stays
  assert.equal(wrapIndexWhere(0, 1, [MIXED[0]], isPhoto), -1);
  assert.equal(wrapIndexWhere(-1, 1, [], isPhoto), -1);
});

test("photoPosition: the titlebar counter counts photos only", () => {
  assert.deepEqual(photoPosition(MIXED, 3), { n: 2, total: 2 });
  assert.deepEqual(photoPosition(MIXED, 1), { n: 1, total: 2 });
  assert.deepEqual(photoPosition(MIXED, 0), { n: 0, total: 2 });
  assert.deepEqual(photoPosition([], -1), { n: 0, total: 0 });
});

test("isMusicName: audio files (wma too) get the music badge, videos / photos do not", () => {
  assert.equal(isMusicName({ name: "01 Parça.MP3" }), true);
  assert.equal(isMusicName({ path: "C:\\m\\x.wma" }), true);
  assert.equal(isMusicName({ name: "a.mp4" }), false);
  assert.equal(isMusicName({ name: "b.jpg" }), false);
});
