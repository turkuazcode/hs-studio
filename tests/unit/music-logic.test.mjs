// L03 music rules: queue order (shuffle / repeat), ReplayGain factor, device removal, LRC
// line after seek / speed change.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceRemoved, mpvReplayGainOptions, nextIndex, nowPlayingText, parseGain, replayGainFactor, seededRandom, shuffleOrder, upNext,
} from "../../src/music/music-logic.js";
import { lineIndexAt, parseLrc } from "../../src/media/lyrics.js";

test("shuffle order: permutation starting with the current track, reproducible with a seed", () => {
  const a = shuffleOrder(10, 3, seededRandom(42));
  assert.equal(a[0], 3);
  assert.deepEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(shuffleOrder(10, 3, seededRandom(42)), a);
  assert.notDeepEqual(shuffleOrder(10, 3, seededRandom(7)), a);
  assert.deepEqual(shuffleOrder(0, 0), []);
});

test("next / previous with repeat off / all / one and shuffle", () => {
  // repeat off: the end stops auto-advance, a manual "next" at the end does nothing
  assert.equal(nextIndex(1, 1, 3, { auto: true }), 2);
  assert.equal(nextIndex(2, 1, 3, { auto: true }), -1);
  assert.equal(nextIndex(2, 1, 3), -1);
  assert.equal(nextIndex(0, -1, 3), 0);
  // repeat all wraps both ways
  assert.equal(nextIndex(2, 1, 3, { repeat: "all", auto: true }), 0);
  assert.equal(nextIndex(0, -1, 3, { repeat: "all" }), 2);
  // repeat one replays at the natural end; a manual "next" still moves on
  assert.equal(nextIndex(1, 1, 3, { repeat: "one", auto: true }), 1);
  assert.equal(nextIndex(1, 1, 3, { repeat: "one" }), 2);
  // shuffle follows the order
  const order = [2, 0, 3, 1];
  assert.equal(nextIndex(2, 1, 4, { order, auto: true }), 0);
  assert.equal(nextIndex(3, 1, 4, { order, auto: true }), 1);
  assert.equal(nextIndex(1, 1, 4, { order, auto: true }), -1);
  assert.equal(nextIndex(1, 1, 4, { order, repeat: "all", auto: true }), 2);
  assert.equal(nextIndex(0, 0, 0), -1);
  assert.deepEqual(upNext(0, 4, { order, repeat: "off" }), [3, 1]);
  assert.deepEqual(upNext(1, 3, { repeat: "all" }), [2, 0]);
});

test("ReplayGain: track / album, preamp, clipping prevention by the sample peak", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  const tags = { trackGain: -6, trackPeak: 0.9, albumGain: -8, albumPeak: 0.95 };
  close(replayGainFactor({ ...tags, mode: "off" }), 1);
  close(replayGainFactor({ ...tags, mode: "track" }), 10 ** (-6 / 20));
  close(replayGainFactor({ ...tags, mode: "album" }), 10 ** (-8 / 20));
  close(replayGainFactor({ ...tags, mode: "album", albumGain: null }), 10 ** (-6 / 20)); // album falls back to track
  close(replayGainFactor({ ...tags, mode: "track", preampDb: 3 }), 10 ** (-3 / 20));
  // +6 dB on a 0.9 peak would clip: limited to 1 / peak; without prevention it is not
  close(replayGainFactor({ mode: "track", trackGain: 6, trackPeak: 0.9 }), 1 / 0.9);
  close(replayGainFactor({ mode: "track", trackGain: 6, trackPeak: 0.9, preventClip: false }), 10 ** (6 / 20));
  close(replayGainFactor({ mode: "track" }), 1); // untagged file: unchanged
  assert.equal(parseGain("-6.20 dB"), -6.2);
  assert.equal(parseGain("+1,5 dB"), 1.5);
  assert.equal(parseGain("0.988"), 0.988);
  assert.equal(parseGain(""), null);
  assert.equal(parseGain("loud"), null);
  assert.deepEqual(mpvReplayGainOptions({ mode: "album", preampDb: 2, preventClip: true }), { replaygain: "album", "replaygain-preamp": 2, "replaygain-clip": "yes" });
  assert.equal(mpvReplayGainOptions({ mode: "off" }).replaygain, "no");
});

test("output device removal and now-playing text", () => {
  const a = [{ name: "auto" }, { name: "wasapi/{spk}" }, { name: "wasapi/{hp}" }];
  assert.equal(deviceRemoved(a, [{ name: "auto" }, { name: "wasapi/{spk}" }]), true);
  assert.equal(deviceRemoved(a, [...a, { name: "wasapi/{usb}" }]), false);
  assert.equal(deviceRemoved(["default", "x"], ["default", "x"]), false);
  assert.equal(deviceRemoved(null, a), false);
  assert.deepEqual(nowPlayingText({ name: "01 Parça.flac" }, { title: "Gül Pembe", artist: "", albumArtist: "Barış Manço", album: "A" }), { title: "Gül Pembe", artist: "Barış Manço", album: "A" });
  assert.deepEqual(nowPlayingText({ name: "01 Parça.flac" }), { title: "01 Parça", artist: "", album: "" });
});

test("LRC line follows the playback time after a seek and at another speed", () => {
  const { lines } = parseLrc("[00:01.00]bir\n[00:05.00]iki\n[00:09.50]üç\n");
  // the line is a function of the media time only: a seek jumps, a speed change only
  // changes how fast the time advances (media time = wall time x speed)
  assert.equal(lineIndexAt(lines, 0.5), -1);
  assert.equal(lineIndexAt(lines, 6.0), 1); // seek forward to 6 s
  assert.equal(lineIndexAt(lines, 2.0), 0); // seek back
  const speed = 1.5, wall = 6; // 6 s at 1.5x = 9 s of media
  assert.equal(lineIndexAt(lines, wall * speed), 1);
  assert.equal(lineIndexAt(lines, 7 * speed), 2);
});
