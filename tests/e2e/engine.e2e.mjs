// libmpv engine (Plan 02 §2-§4): engine active, play/pause/seek, audio + subtitle track
// switching, external SRT via sub-add, chapters, audio delay, equalizer (af), screenshot file,
// frame step, bookmarks, A-B loop, volume 200 %, photo hides the video window, HEVC;
// fallback: VHO_DISABLE_MPV=1 -> HTML5 engine.
// Needs the DLL set next to vho.exe (npm run stage:mpv); skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HTML5_ENGINE, fixture, launchApp, mpvStaged } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

const MKV = fixture("engine-multitrack.mkv");
const skip = mpvStaged() ? false : "libmpv DLLs not staged next to vho.exe (npm run stage:mpv)";

test("engine: libmpv plays the multitrack MKV", { timeout: 240000, skip }, async (t) => {
  const app = await launchApp({ args: [MKV] });
  const get = (name) => app.eval(`__TAURI__.core.invoke("engine_get", { name: ${JSON.stringify(name)} })`);
  const status = () => app.eval(`__TAURI__.core.invoke("engine_status")`);
  const E = "window.__vhoEngine";
  const waitProp = (name, pred, timeoutMs = 5000) => app.waitFor(`__TAURI__.core.invoke("engine_get", { name: ${JSON.stringify(name)} })
    .then((v) => ((${pred})(v) ? { v } : false)).catch(() => false)`, { timeoutMs, message: `${name} ${pred}` });
  const seek = async (time) => {
    await app.eval(`__TAURI__.core.invoke("engine_command", { args: ["seek", ${time}, "absolute+exact"] }).then(() => true)`);
    await waitProp("time-pos", `(v) => Math.abs(v - ${time}) < 0.1`);
    // the UI's mirror (engine://property, rate limited) must have caught up too
    await app.waitFor(`Math.abs(${E}.time - ${time}) < 0.1`, { timeoutMs: 3000, message: `UI time ${time}` });
  };
  /** Clicks through the HUD "⋯" menu: more("chapters", "chapter:2"). */
  const more = async (...ids) => {
    await app.click("#btn-hud-more");
    for (const id of ids) {
      await app.waitFor(`!document.getElementById("hud-more-menu").hidden &&
        !!document.querySelector('#hud-more-menu [data-menu-id="${id}"]')`, { timeoutMs: 3000, message: `menu item ${id}` });
      await app.click(`#hud-more-menu [data-menu-id="${id}"]`);
    }
  };
  const menuLabels = () => app.eval(`[...document.querySelectorAll("#hud-more-menu [data-menu-id]")].map((b) => b.dataset.menuId)`);
  const pause = async () => {
    await app.eval(`__TAURI__.core.invoke("engine_set", { name: "pause", value: true }).then(() => true)`);
    await waitProp("pause", "(v) => v === true");
  };

  try {
    await t.test("libmpv engine is active (LGPL build, video window shown)", async () => {
      const s = await status();
      assert.equal(s.available, true, s.error);
      assert.match(s.mpvVersion, /^mpv v0\.\d+/);
      assert.match(s.ffmpegVersion, /\d/);
      await app.waitFor(`${E}.kind === "mpv" && document.documentElement.classList.contains("engine-mpv-video")`, { timeoutMs: 10000 });
      assert.equal(await app.eval(`document.documentElement.dataset.engine`), "mpv");
      assert.equal(await app.eval(`document.getElementById("btn-pip").hidden`), true); // PiP is HTML5 only
      assert.equal(await app.eval(`getComputedStyle(document.body).backgroundColor`), "rgba(0, 0, 0, 0)");
      assert.equal((await status()).visible, true);
      assert.match(await app.text("#engine-info"), /^libmpv/);
    });

    await t.test("A/B comparison does not look usable with libmpv; the reason is shown (S04)", async () => {
      assert.equal(await app.eval(`document.getElementById("btn-toggle-split-view").disabled`), true);
      assert.equal(await app.eval(`document.getElementById("split-view-reason").hidden`), false);
      assert.match(await app.text("#split-view-reason"), /libmpv/);
      await app.key("KeyB");
      assert.equal(await app.eval(`document.getElementById("split-screen-banner").style.display`), "none");
      // the libmpv sharpness note says the level only changes contrast/saturation
      assert.notEqual(await app.eval(`getComputedStyle(document.querySelector("[data-i18n='enhance.sharpMpvNote']")).display`), "none");
    });

    await t.test("minimal HUD: only frequent controls visible, the rest in the ⋯ menu", async () => {
      const visible = await app.eval(`[...document.querySelectorAll(".controls-group.right button")]
        .filter((b) => b.offsetParent !== null).map((b) => b.id)`);
      assert.deepEqual(visible, ["btn-toggle-subtitles", "btn-sub-menu", "btn-hud-more", "btn-fullscreen"]);
      assert.equal(await app.eval(`document.getElementById("btn-toggle-effects").offsetParent`), null);
      assert.equal(await app.eval(`document.getElementById("btn-toggle-audio-panel").offsetParent`), null);
      await app.waitFor(`window.__vhoEngine.tracks.audio.length === 2 && window.__vhoEngine.chapters.length === 3`, { timeoutMs: 8000 });
      await app.click("#btn-hud-more");
      await app.waitFor(`!document.getElementById("hud-more-menu").hidden`, { timeoutMs: 3000 });
      const ids = await menuLabels();
      for (const id of ["audio-tracks", "chapters", "bookmarks", "speed", "ab-loop", "aspect", "view", "snapshot",
        "video-settings", "audio-settings", "settings"]) assert.ok(ids.includes(id), `${id} in ${ids}`);
      assert.equal(ids.includes("pip"), false); // PiP: HTML5 engine only
      await app.eval(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
      await app.waitFor(`document.getElementById("hud-more-menu").hidden`, { timeoutMs: 3000 });
    });

    await t.test("plays: time advances, duration, title, play/pause button", async () => {
      await app.waitFor(`${E}.time > 0.3 && Math.abs(${E}.duration - 6) < 0.2 && !${E}.paused`, { timeoutMs: 15000 });
      assert.equal(await app.text("#current-filename"), "engine-multitrack.mkv");
      assert.equal(await app.text("#time-total"), "00:06");
      await app.click("#btn-play-pause");
      await waitProp("pause", "(v) => v === true");
      await app.waitFor(`document.getElementById("icon-play").style.display === "block"`, { timeoutMs: 3000 });
      await app.click("#btn-play-pause");
      await waitProp("pause", "(v) => v === false");
      await pause();
    });

    await t.test("seek: timeline click and arrow keys", async () => {
      await app.eval(`(() => {
        const c = document.getElementById("timeline-container"), r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2, bubbles: true }));
        return true; })()`);
      await waitProp("time-pos", "(v) => Math.abs(v - 3) < 0.15");
      await app.key("ArrowLeft");
      await waitProp("time-pos", "(v) => v < 0.1");
      await app.key("ArrowRight");
      await waitProp("time-pos", "(v) => Math.abs(v - 5) < 0.15");
    });

    await t.test("audio track menu (⋯) switches aid and language", async () => {
      assert.equal((await get("current-tracks/audio")).lang, "tur"); // alang=tur,eng
      await more("audio-tracks", "audio:2");
      await waitProp("aid", "(v) => v === 2");
      assert.equal((await get("current-tracks/audio")).lang, "eng");
      assert.match(await app.toast(), /^Ses kanalı: English 880Hz/);
    });

    await t.test("subtitle tracks: embedded ASS / SRT in the CC menu", async () => {
      await app.waitFor(`document.querySelectorAll("#sub-track-list [data-sid]").length === 3`, { timeoutMs: 5000 });
      await seek(1);
      await app.click(`#sub-track-list [data-sid="2"]`);
      await waitProp("sid", "(v) => v === 2");
      await waitProp("sub-text", `(v) => v === "English subtitle track (SRT)"`);
      assert.equal(await app.text("#sub-status-label"), "CC Açık");
      await app.click(`#sub-track-list [data-sid="1"]`);
      await waitProp("sub-text", `(v) => typeof v === "string" && v.includes("Türkçe altyazı")`);
      await app.key("KeyC"); // off
      await waitProp("sid", "(v) => v === false");
      await app.waitFor(`document.getElementById("sub-status-label").textContent === "CC Kapalı"`, { timeoutMs: 3000 });
      await app.key("KeyC"); // back on (last track)
      await waitProp("sid", "(v) => v === 1");
    });

    await t.test("external SRT is added with sub-add (path, like a native drop)", async () => {
      await app.eval(`${E}.openPaths([${JSON.stringify(fixture("sample.srt"))}]).then(() => true)`);
      const ext = await app.waitFor(`(() => { const s = ${E}.tracks.sub.find((x) => x.external); return s && s.selected && s; })()`, { timeoutMs: 5000 });
      await waitProp("sid", `(v) => v === ${ext.id}`);
      await seek(0.5);
      await waitProp("sub-text", `(v) => v === "Merhaba dünya"`);
      assert.match(await app.toast(), /^Altyazı yüklendi: sample\.srt$/);
      assert.equal(await app.text("#subtitle-text"), ""); // rendered by mpv, not the overlay
    });

    await t.test("subtitle delay (H) maps to sub-delay", async () => {
      await app.key("KeyH");
      await waitProp("sub-delay", "(v) => Math.abs(v + 0.05) < 1e-6");
      await app.key("KeyG");
      await waitProp("sub-delay", "(v) => Math.abs(v) < 1e-6");
    });

    await t.test("chapters: markers, ⋯ menu, jump", async () => {
      assert.equal(await app.eval(`document.querySelectorAll("#timeline-track .chapter-marker").length`), 2);
      assert.deepEqual((await app.eval(`${E}.chapters`)).map((c) => c.title), ["Bölüm 1", "Bölüm 2", "Bölüm 3"]);
      await more("chapters", "chapter:2");
      await waitProp("chapter", "(v) => v === 2");
      await waitProp("time-pos", "(v) => v >= 3.95 && v < 4.5");
      assert.equal(await app.toast(), "Bölüm 3 (00:04)");
    });

    await t.test("audio delay +/-50 ms (audio panel)", async () => {
      await more("audio-settings");
      assert.equal(await app.eval(`document.getElementById("audio-panel").classList.contains("show")`), true);
      await app.click("#btn-audio-plus");
      await waitProp("audio-delay", "(v) => Math.abs(v - 0.05) < 1e-6");
      assert.equal(await app.text("#val-audio-delay"), "+50 ms");
      await app.click("#btn-audio-minus");
      await app.click("#btn-audio-minus");
      await waitProp("audio-delay", "(v) => Math.abs(v + 0.05) < 1e-6");
      await app.click("#btn-audio-reset");
      await waitProp("audio-delay", "(v) => Math.abs(v) < 1e-6");
    });

    await t.test("equalizer preset + normalisation become the af chain", async () => {
      await app.eval(`(() => { const s = document.getElementById("select-eq-preset"); s.value = "bass"; s.dispatchEvent(new Event("change")); return true; })()`);
      const af = await waitProp("af", `(v) => JSON.stringify(v).includes("equalizer=f=31:t=o:w=1:g=6")`);
      assert.match(JSON.stringify(af.v), /lavfi/);
      await app.click("#check-audio-normalize");
      await waitProp("af", `(v) => JSON.stringify(v).includes("dynaudnorm")`);
      // one band by hand -> "custom"
      await app.eval(`(() => { const s = document.querySelector('.eq-slider[data-band="16000"]'); s.value = -6; s.dispatchEvent(new Event("input")); return true; })()`);
      await waitProp("af", `(v) => JSON.stringify(v).includes("equalizer=f=16000:t=o:w=1:g=-6")`);
      assert.equal(await app.eval(`document.getElementById("select-eq-preset").value`), "custom");
      // playback still runs with the filters
      await app.eval(`__TAURI__.core.invoke("engine_set", { name: "pause", value: false }).then(() => true)`);
      await seek(1);
      await waitProp("time-pos", "(v) => v > 1.3");
      await app.click("#check-audio-normalize");
      await app.eval(`(() => { const s = document.getElementById("select-eq-preset"); s.value = "flat"; s.dispatchEvent(new Event("change")); return true; })()`);
      await waitProp("af", `(v) => Array.isArray(v) && v.length === 0`);
      await app.click("#btn-close-audio-panel");
      await pause();
    });

    await t.test("volume 150 %: mpv volume stays 100, boost + limiter in af; colour controls reach mpv", async () => {
      await app.eval(`(() => { const s = document.getElementById("volume-slider"); s.value = 150; s.dispatchEvent(new Event("input")); return true; })()`);
      await waitProp("volume", "(v) => v === 100");
      await waitProp("af", `(v) => JSON.stringify(v).includes("volume=1.750") && JSON.stringify(v).includes("alimiter")`);
      assert.equal(await app.eval(`${E}.status && window.__vhoEngine.kind`), "mpv");
      await app.eval(`(() => { const s = document.getElementById("volume-slider"); s.value = 100; s.dispatchEvent(new Event("input")); return true; })()`);
      await waitProp("af", `(v) => !JSON.stringify(v).includes("alimiter")`);
      await waitProp("volume", "(v) => v === 100");
      await app.eval(`(() => { for (const [id, v] of [["slider-brightness", 120], ["slider-gamma", 10], ["slider-hue", -20]]) {
        const s = document.getElementById(id); s.value = v; s.dispatchEvent(new Event("input")); } return true; })()`);
      await waitProp("brightness", "(v) => v === 20");
      await waitProp("gamma", "(v) => v === 10");
      await waitProp("hue", "(v) => v === -20");
      await app.click("#btn-reset-filters");
      await waitProp("brightness", "(v) => v === 0");
    });

    await t.test("frame step (. and ,) pauses and moves one frame", async () => {
      await seek(2);
      await pause();
      const t0 = await get("time-pos");
      await app.key("Period", { key: "." });
      await waitProp("time-pos", `(v) => v > ${t0} + 0.03 && v < ${t0} + 0.15`);
      await app.key("Comma", { key: "," });
      await waitProp("time-pos", `(v) => Math.abs(v - ${t0}) < 0.03`);
      assert.equal(await get("pause"), true);
    });

    await t.test("screenshot (S) writes a PNG through mpv", async () => {
      await app.key("KeyS");
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent.startsWith("Ekran görüntüsü kaydedildi: ")`, { timeoutMs: 8000 });
      const dir = join(app.userData, "screenshots");
      const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
      assert.equal(files.length, 1);
      assert.match(files[0], /^engine-multitrack_mkv_00-0\d\.png$/);
      assert.ok(existsSync(join(dir, files[0])));
    });

    await t.test("bookmarks (Y): stored per file, marker on the timeline", async () => {
      await seek(1.5);
      await app.key("KeyY");
      await app.waitFor(`${E}.bookmarks.length === 1 && document.querySelectorAll("#timeline-track .bookmark-marker").length === 1`, { timeoutMs: 3000 });
      assert.equal((await app.eval(`${E}.bookmarks`))[0].time, 1.5);
      await seek(4);
      await more("bookmarks", "bookmark:0");
      await waitProp("time-pos", "(v) => Math.abs(v - 1.5) < 0.1");
    });

    await t.test("A-B loop uses mpv's ab-loop-a/b", async () => {
      await seek(1);
      await app.click("#btn-ab-loop");
      await seek(2.5);
      await app.click("#btn-ab-loop");
      await waitProp("ab-loop-a", "(v) => Math.abs(v - 1) < 0.1");
      await waitProp("ab-loop-b", "(v) => Math.abs(v - 2.5) < 0.1");
      assert.equal(await app.text("#ab-loop-label"), "A-B Döngüde");
      await app.click("#btn-ab-loop");
      await waitProp("ab-loop-b", `(v) => v === "no"`);
    });

    await t.test("rotate / flip / zoom map to video-rotate, vf, video-zoom", async () => {
      await more("view", "view:rotate");
      await waitProp("video-rotate", "(v) => v === 90");
      await more("view", "view:hflip");
      await waitProp("vf", `(v) => JSON.stringify(v).includes("hflip")`);
      await app.eval(`document.getElementById("viewport").dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })), true`);
      await waitProp("video-zoom", "(v) => Math.abs(v - 0.1) < 1e-6");
      await more("view", "view:reset");
      await waitProp("video-rotate", "(v) => v === 0");
      await waitProp("vf", `(v) => Array.isArray(v) && v.length === 0`);
    });

    await t.test("photo: libmpv window hidden, page opaque; back to video", async () => {
      await app.eval(`${E}.openPaths([${JSON.stringify(fixture("photo-a.jpg"))}]).then(() => true)`);
      await app.waitFor(`document.getElementById("image-element").naturalWidth > 0`, { timeoutMs: 8000 });
      await app.waitFor(`!document.documentElement.classList.contains("engine-mpv-video")`, { timeoutMs: 3000 });
      await sleep(200);
      assert.equal((await status()).visible, false);
      assert.notEqual(await app.eval(`getComputedStyle(document.body).backgroundColor`), "rgba(0, 0, 0, 0)");
      await app.click(`#playlist-items li[data-idx="0"]`);
      await app.waitFor(`document.documentElement.classList.contains("engine-mpv-video") && ${E}.time > 0`, { timeoutMs: 8000 });
      assert.equal((await status()).visible, true);
    });

    await t.test("HEVC plays through libmpv", async () => {
      await app.eval(`${E}.openPaths([${JSON.stringify(fixture("engine-hevc.mp4"))}]).then(() => true)`);
      await app.waitFor(`${E}.kind === "mpv" && Math.abs(${E}.duration - 2) < 0.2`, { timeoutMs: 10000 });
      const vp = await waitProp("video-params", "(v) => v && v.w === 640", 10000);
      assert.equal(vp.v.h, 360);
      assert.equal((await get("current-tracks/video")).codec, "hevc");
    });

    await t.test("audio-only file: no picture controls in the ⋯ menu", async () => {
      await app.eval(`${E}.openPaths([${JSON.stringify(fixture("engine-tone.m4a"))}]).then(() => true)`);
      await app.waitFor(`${E}.kind === "mpv" && document.documentElement.classList.contains("media-audio-only") && ${E}.time > 0.2`, { timeoutMs: 10000 });
      await app.click("#btn-hud-more");
      await app.waitFor(`!document.getElementById("hud-more-menu").hidden`, { timeoutMs: 3000 });
      const ids = await menuLabels();
      for (const id of ["aspect", "view", "snapshot", "video-settings"]) assert.equal(ids.includes(id), false, id);
      assert.ok(ids.includes("audio-settings"));
      await app.eval(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
    });

    await t.test("playlist auto-advance at the end (eof)", async () => {
      // the HEVC clip is the last item: playing the first video to its end advances to item 1 (photo)
      await app.click(`#playlist-items li[data-idx="0"]`);
      await app.waitFor(`${E}.kind === "mpv" && Math.abs(${E}.duration - 6) < 0.2`, { timeoutMs: 8000 });
      await seek(5.6);
      await app.eval(`__TAURI__.core.invoke("engine_set", { name: "pause", value: false }).then(() => true)`);
      await app.waitFor(`document.querySelector('#playlist-items li[data-idx="1"]').classList.contains("active")`, { timeoutMs: 8000 });
    });

    await t.test("no uncaught page errors", async () => {
      await sleep(200);
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});

test("engine fallback: VHO_DISABLE_MPV=1 -> HTML5 engine, opaque window", { timeout: 120000 }, async (t) => {
  const app = await launchApp({ args: [fixture("sample-h264.mp4")], env: HTML5_ENGINE });
  try {
    await t.test("HTML5 engine plays the MP4", async () => {
      const s = await app.eval(`__TAURI__.core.invoke("engine_status")`);
      assert.equal(s.available, false);
      assert.match(s.error, /VHO_DISABLE_MPV/);
      await app.waitFor(`window.__vhoEngine.kind === "html5" && document.getElementById("video-element").currentTime > 0.2`, { timeoutMs: 15000 });
      assert.equal(await app.eval(`document.documentElement.classList.contains("engine-mpv-video")`), false);
      assert.equal(await app.eval(`document.documentElement.dataset.engine`), "html5");
      assert.equal(await app.eval(`document.getElementById("btn-pip").hidden`), false);
      assert.match(await app.text("#engine-info"), /HTML5 <video> yedek motoru — libmpv yok/);
      assert.notEqual(await app.eval(`getComputedStyle(document.body).backgroundColor`), "rgba(0, 0, 0, 0)");
      assert.equal(await app.eval(`document.getElementById("btn-hud-more").offsetParent !== null`), true);
    });
    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});
