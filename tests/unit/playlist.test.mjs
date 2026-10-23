import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapIndex, hasNextItem, itemMetaText } from "../../src/ui/playlist.js";
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

test("itemMetaText: size for browser files, stream label otherwise", () => {
  assert.equal(itemMetaText({ file: { size: 3 * 1048576 } }), "3.0 MB");
  assert.equal(itemMetaText({ path: "C:\\a.mp4", size: 10 }), "Ağ Akışı");
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
