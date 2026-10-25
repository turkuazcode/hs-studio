// Engine facade contract (with fake engines) and the pure engine helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_METHODS, EQ_BANDS, isAudioOnlyMedia, EQ_PRESETS, LAVFI_LIMITER, addBookmark, aspectProps, audioFilterChain, chapterAt,
  createEngineFacade, cssViewTransform, engineKindFor, flipFilter, languageName, nextZoom, normalizeChapters,
  normalizeTracks, pictureProps, removeBookmark, subMarginFor, trackLabel,
} from "../../src/media/engine/engine.js";
import { bandLabel, formatAudioDelay } from "../../src/media/audio-fx.js";
import { wantFastProfile } from "../../src/media/engine-settings.js";

/** Minimal engine implementing the whole contract; records calls. */
function fakeEngine(kind) {
  const calls = [];
  let emit = () => {};
  const e = {
    kind, caps: { pip: kind === "html5" }, calls, time: 0, duration: 10, paused: true, ended: false,
    volume: 100, rate: 1, previewSrc: "",
    fire: (ev, p) => emit(ev, p),
  };
  for (const m of ENGINE_METHODS) e[m] = (...args) => { calls.push([m, ...args]); return Promise.resolve(); };
  e.attach = (fn) => { emit = fn; };
  e.tracks = () => ({ audio: [], sub: [], video: [] });
  e.chapters = () => [];
  return e;
}

test("facade: rejects an engine that misses part of the contract", () => {
  const bad = fakeEngine("mpv");
  delete bad.setLoop;
  assert.throws(() => createEngineFacade({ html5: fakeEngine("html5"), mpv: bad }), /setLoop/);
  assert.throws(() => createEngineFacade({ mpv: fakeEngine("mpv") }), /html5/);
});

test("facade: picks libmpv for paths/URLs, HTML5 for browser files, forwards calls", async () => {
  const html5 = fakeEngine("html5"), mpv = fakeEngine("mpv");
  const f = createEngineFacade({ html5, mpv });
  assert.equal(f.kind, "html5");
  assert.equal(f.mpvAvailable, true);
  await f.load({ path: "C:\\a.mkv" });
  assert.equal(f.kind, "mpv");
  assert.deepEqual(html5.calls.map((c) => c[0]), ["deactivate"]);
  assert.deepEqual(mpv.calls.map((c) => c[0]), ["activate", "load"]);
  f.seek(3); f.setVolume(150); f.selectTrack("audio", 2);
  assert.deepEqual(mpv.calls.slice(2), [["seek", 3], ["setVolume", 150], ["selectTrack", "audio", 2]]);
  await f.load({ file: {} });
  assert.equal(f.kind, "html5");
  assert.equal(f.caps.pip, true);
});

test("facade: without libmpv everything stays on HTML5", async () => {
  const html5 = fakeEngine("html5");
  const f = createEngineFacade({ html5, mpv: null });
  await f.load({ path: "C:\\a.mkv" });
  assert.equal(f.kind, "html5");
  assert.equal(f.mpvAvailable, false);
});

test("facade: only the active engine's events reach the UI; unsubscribe works", async () => {
  const html5 = fakeEngine("html5"), mpv = fakeEngine("mpv");
  const f = createEngineFacade({ html5, mpv });
  const seen = [];
  const off = f.on("time", (t) => seen.push(t));
  html5.fire("time", 1);
  mpv.fire("time", 2); // inactive
  await f.load({ url: "https://x/y.mp4" });
  html5.fire("time", 3); // inactive now
  mpv.fire("time", 4);
  off();
  mpv.fire("time", 5);
  assert.deepEqual(seen, [1, 4]);
});

test("facade: a throwing handler does not stop the others", () => {
  const f = createEngineFacade({ html5: fakeEngine("html5") });
  const seen = [];
  const err = console.error;
  console.error = () => {};
  try {
    f.on("ended", () => { throw new Error("boom"); });
    f.on("ended", () => seen.push("ok"));
    f.impl.fire("ended");
  } finally {
    console.error = err;
  }
  assert.deepEqual(seen, ["ok"]);
});

test("engineKindFor", () => {
  assert.equal(engineKindFor({ path: "a" }, true), "mpv");
  assert.equal(engineKindFor({ url: "http://a" }, true), "mpv");
  assert.equal(engineKindFor({ file: {} }, true), "html5");
  assert.equal(engineKindFor({ path: "a" }, false), "html5");
});

test("normalizeTracks / trackLabel / languageName", () => {
  const t = normalizeTracks([
    { id: 1, type: "video", codec: "h264", selected: true },
    { id: 1, type: "audio", lang: "tur", title: "Türkçe 440Hz", codec: "aac", selected: true },
    { id: 2, type: "audio", lang: "eng", codec: "aac" },
    { id: 1, type: "sub", lang: "tur", codec: "ass" },
    { id: 3, type: "sub", external: true, title: "x.srt", codec: "subrip" },
    { id: 9, type: "other" },
  ]);
  assert.equal(t.video.length, 1);
  assert.deepEqual(t.audio.map((a) => [a.id, a.lang, a.selected]), [[1, "tur", true], [2, "eng", false]]);
  assert.equal(t.audio[0].label, "Türkçe 440Hz (tur, AAC)");
  assert.equal(t.audio[1].label, "English (AAC)");
  assert.equal(t.sub[0].label, "Türkçe (ASS)");
  assert.equal(t.sub[1].label, "x.srt (SUBRIP, harici)");
  assert.equal(trackLabel({ id: 4 }), "Kanal 4");
  assert.equal(languageName("xyz"), "XYZ");
  assert.equal(languageName(""), "");
  assert.deepEqual(normalizeTracks(null), { audio: [], sub: [], video: [] });
});

test("normalizeChapters / chapterAt", () => {
  const c = normalizeChapters([{ time: 4, title: "C" }, { time: 0 }, { time: 2, title: "B" }]);
  assert.deepEqual(c.map((x) => x.time), [0, 2, 4]);
  assert.equal(c[0].title, "Bölüm 2"); // index from mpv order, title default
  assert.equal(chapterAt(c, 2.5), 2);
  assert.equal(chapterAt(normalizeChapters([{ time: 1 }]), 0.5), -1);
});

test("audioFilterChain: equalizer bands, normalisation, restoration switches", () => {
  assert.equal(audioFilterChain({}), "");
  assert.equal(audioFilterChain({ eq: EQ_PRESETS.flat.gains }), "");
  const bass = audioFilterChain({ eq: EQ_PRESETS.bass.gains });
  assert.match(bass, /^lavfi=\[equalizer=f=31:t=o:w=1:g=6,equalizer=f=62:t=o:w=1:g=5,/);
  assert.equal(bass.split("equalizer").length - 1, 4);
  assert.equal(audioFilterChain({ eq: [-20] }), "lavfi=[equalizer=f=31:t=o:w=1:g=-12]"); // clamped, cut only: no limiter
  assert.equal(audioFilterChain({ eq: [20] }), `lavfi=[equalizer=f=31:t=o:w=1:g=12,${LAVFI_LIMITER}]`); // boost -> limiter
  assert.match(audioFilterChain({ normalize: true }), /dynaudnorm/);
  const r = audioFilterChain({ restore: { denoise: true, voice: true, compressor: true } });
  assert.match(r, /highpass=f=90,lowpass=f=7500,equalizer=f=2400.*acompressor/);
  assert.equal(EQ_BANDS.length, 10);
  for (const p of Object.values(EQ_PRESETS)) assert.equal(p.gains.length, 10);
});

test("pictureProps / aspectProps / view helpers", () => {
  assert.deepEqual(pictureProps({ brightness: 120, contrast: 100, saturate: 250, gamma: 5, hue: -200 }),
    { brightness: 20, contrast: 0, saturation: 100, gamma: 5, hue: -100 });
  assert.equal(pictureProps({ contrast: 100, contrastBoost: 8 }).contrast, 8);
  assert.deepEqual(aspectProps("contain"), { "video-aspect-override": "no", keepaspect: true });
  assert.deepEqual(aspectProps("4-3"), { "video-aspect-override": "4:3", keepaspect: true });
  assert.equal(aspectProps("fill").keepaspect, false);
  assert.equal(flipFilter({ hflip: true, vflip: true }), "hflip,vflip");
  assert.equal(flipFilter({}), "");
  assert.equal(nextZoom(0, -100), 0.1);
  assert.equal(nextZoom(0, 100), 0);
  assert.equal(nextZoom(3, -1), 3);
  assert.equal(cssViewTransform({}), "none");
  assert.equal(cssViewTransform({ rotate: 90, hflip: true, zoom: 1 }), "scale(2.000) rotate(90deg) scale(-1, 1)");
});

test("subMarginFor keeps subtitles above the visible HUD", () => {
  assert.equal(subMarginFor(false, 100, 720), 22);
  assert.equal(subMarginFor(true, 100, 720), 122);
  assert.equal(subMarginFor(true, 100, 1440), 72);
});

test("bookmarks: sorted, no near duplicates, removable", () => {
  let b = addBookmark([], 12.34);
  b = addBookmark(b, 3);
  b = addBookmark(b, 12.5); // within 0.5 s of 12.3
  assert.deepEqual(b.map((x) => x.time), [3, 12.3]);
  assert.deepEqual(removeBookmark(b, 0).map((x) => x.time), [12.3]);
});

test("audio panel labels", () => {
  assert.equal(formatAudioDelay(50), "+50 ms");
  assert.equal(formatAudioDelay(-100), "-100 ms");
  assert.equal(formatAudioDelay(0), "0 ms");
  assert.equal(bandLabel(1000), "1k");
  assert.equal(bandLabel(62), "62");
});

test("profile=fast follows the GPU in auto mode", () => {
  assert.equal(wantFastProfile("auto", { integrated: true }), true);
  assert.equal(wantFastProfile("auto", { integrated: false }), false);
  assert.equal(wantFastProfile("auto", undefined), false);
  assert.equal(wantFastProfile("on", { integrated: false }), true);
  assert.equal(wantFastProfile("off", { integrated: true }), false);
});

test("audio-only layout: by name or no real video track", () => {
  assert.equal(isAudioOnlyMedia("song.mp3", null), true);
  assert.equal(isAudioOnlyMedia("clip.mkv", null), false);
  const t = (video) => ({ audio: [{ id: 1 }], sub: [], video });
  assert.equal(isAudioOnlyMedia("x.mka", t([])), true);
  assert.equal(isAudioOnlyMedia("x.m4a", t([{ codec: "mjpeg" }])), true); // cover art
  assert.equal(isAudioOnlyMedia("x.mkv", t([{ codec: "h264" }])), false);
});
