// H.264/AAC playback, pause, seek, volume booster, A-B loop, subtitles (UTF-8 / Windows-1254 /
// VTT), speed & aspect menus, colour filters, AI restoration toggle, snapshot, playlist advance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, fixture } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

const MP4 = fixture("sample-h264.mp4");
const V = `document.getElementById("video-element")`;

test("video: H.264 clip + SRT opened from the command line", { timeout: 180000 }, async (t) => {
  const app = await launchApp({ args: [MP4, fixture("sample.srt")] });
  const has = (sel, cls) => app.eval(`document.querySelector(${JSON.stringify(sel)}).classList.contains(${JSON.stringify(cls)})`);
  const seek = async (time) => {
    await app.eval(`${V}.currentTime = ${time}, true`);
    await app.waitFor(`!${V}.seeking && Math.abs(${V}.currentTime - ${time}) < 0.05`, { timeoutMs: 5000 });
  };
  const subtitle = () => app.text("#subtitle-text");
  const timelineClick = (fraction) => app.eval(`(() => {
    const c = document.getElementById("timeline-container"), r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent("click", { clientX: r.left + r.width * ${fraction}, clientY: r.top + r.height / 2, bubbles: true }));
    return true;
  })()`);
  const pause = async () => {
    if (!(await app.eval(`${V}.paused`))) await app.click("#btn-play-pause");
    await app.waitFor(`${V}.paused`, { timeoutMs: 3000 });
  };

  try {
    await t.test("decodes and plays (frames, size, duration, title)", async () => {
      const s = await app.waitFor(`(() => { const v = ${V}, q = v.getVideoPlaybackQuality();
        return v.videoWidth > 0 && q.totalVideoFrames > 5 && v.currentTime > 0.2 &&
          { w: v.videoWidth, h: v.videoHeight, frames: q.totalVideoFrames, src: v.currentSrc }; })()`, { timeoutMs: 15000 });
      assert.equal(s.w, 320);
      assert.equal(s.h, 240);
      assert.match(s.src, /^http:\/\/asset\.localhost\//);
      assert.equal(await app.text("#current-filename"), "sample-h264.mp4");
      assert.equal(await app.text("#time-total"), "00:03");
      assert.equal(await has("#drop-zone", "visible"), false);
      await pause();
      assert.equal(await app.eval(`document.getElementById("icon-play").style.display`), "block");
      assert.equal(await app.eval(`document.body.classList.contains("is-playing")`), false);
    });

    await t.test("subtitle from the command line (asset protocol, UTF-8 SRT)", async () => {
      assert.equal(await app.text("#sub-status-label"), "CC Açık");
      await seek(0.5);
      assert.equal(await subtitle(), "Merhaba dünya");
      await seek(1.5);
      assert.equal(await subtitle(), "Çalışkan öğrenci şiir okudu");
      await seek(2.5);
      assert.equal(await subtitle(), "Işık ve gölge\nİkinci satır");
      await seek(0.95);
      assert.equal(await subtitle(), "");
    });

    await t.test("subtitle delay (H / G keys)", async () => {
      await seek(0.15);
      assert.equal(await subtitle(), "");
      await app.key("KeyH");
      assert.equal(await app.text("#val-sub-delay"), "+50 ms");
      assert.equal(await subtitle(), "Merhaba dünya"); // 0.15 s + 50 ms falls into the first cue
      await app.key("KeyG");
      assert.equal(await app.text("#val-sub-delay"), "0 ms");
      assert.equal(await subtitle(), "");
    });

    await t.test("Windows-1254 SRT and BOM VTT via drag & drop", async () => {
      assert.equal(await app.dropFiles([fixture("sample-1254.srt")]), 1);
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent === "Altyazı yüklendi (2 satır)"`, { timeoutMs: 5000 });
      await seek(1.5);
      assert.equal(await subtitle(), "İşçi ÇÖĞÜŞ ığüşöç");

      await app.dropFiles([fixture("sample.vtt")]);
      await app.waitFor(`document.querySelector("#snapshot-toast span").textContent === "Altyazı yüklendi (3 satır)"`, { timeoutMs: 5000 });
      await seek(2.5);
      assert.equal(await subtitle(), "Şimdi ölçü");

      await app.key("KeyC");
      assert.equal(await app.text("#sub-status-label"), "CC Kapalı");
      assert.equal(await subtitle(), "");
      await app.key("KeyC");
      assert.equal(await app.text("#sub-status-label"), "CC Açık");
    });

    await t.test("seeking: timeline click, skip buttons, arrow keys (clamped)", async () => {
      await timelineClick(0.5);
      await app.waitFor(`!${V}.seeking`, { timeoutMs: 3000 });
      const mid = await app.eval(`${V}.currentTime / ${V}.duration`);
      assert.ok(Math.abs(mid - 0.5) < 0.03, `timeline seek at ${mid}`);
      await app.click("#btn-skip-backward");
      assert.equal(await app.eval(`${V}.currentTime`), 0);
      await app.click("#btn-skip-forward");
      assert.equal(await app.eval(`${V}.currentTime === ${V}.duration`), true);
      await app.key("ArrowLeft", { shiftKey: true });
      assert.equal(await app.eval(`${V}.currentTime`), 0);
      await app.key("ArrowRight");
      assert.equal(await app.eval(`${V}.currentTime === ${V}.duration`), true);
      await app.key("ArrowLeft");
      assert.equal(await app.eval(`${V}.currentTime`), 0);
    });

    await t.test("volume booster to 150 %, arrow keys, mute", async () => {
      await app.eval(`(() => { const s = document.getElementById("volume-slider"); s.value = 150; s.dispatchEvent(new Event("input")); return true; })()`);
      assert.equal(await app.text("#volume-badge"), "150%");
      assert.equal(await has(".volume-container", "boosted"), true);
      assert.equal(await app.eval(`${V}.volume`), 1);
      assert.equal(await app.eval(`document.getElementById("icon-volume-boost").style.display`), "block");
      await app.key("ArrowUp");
      assert.equal(await app.text("#volume-badge"), "155%");
      await app.key("KeyM");
      assert.equal(await app.text("#volume-badge"), "0%");
      assert.equal(await app.eval(`${V}.volume`), 0);
      await app.key("KeyM");
      assert.equal(await app.text("#volume-badge"), "155%");
      await app.key("ArrowDown");
      assert.equal(await app.text("#volume-badge"), "150%");
    });

    await t.test("A-B loop keeps playback between the markers", async () => {
      await app.click("#btn-skip-backward");
      await app.click("#btn-play-pause");
      await app.waitFor(`${V}.currentTime >= 0.5`, { timeoutMs: 5000 });
      await app.click("#btn-ab-loop");
      const a = await app.eval(`${V}.currentTime`);
      assert.match(await app.text("#ab-loop-label"), /^A: 00:00 -> B\?$/);
      await app.waitFor(`${V}.currentTime >= ${a} + 0.8`, { timeoutMs: 5000 });
      await app.click("#btn-ab-loop"); // sets B and jumps back to A
      const b = await app.eval(`parseFloat(document.getElementById("ab-marker-b").style.left) / 100 * ${V}.duration`);
      assert.ok(b >= a + 0.8, `B ${b} after A ${a}`);
      assert.equal(await app.text("#ab-loop-label"), "A-B Döngüde");
      assert.equal(await app.eval(`document.getElementById("ab-range").style.display`), "block");
      // Watch for 2.5 s inside the page: time must wrap back to A and never run far past B
      const r = await app.eval(`new Promise((resolve) => {
        const v = ${V}; let max = 0, wraps = 0, last = v.currentTime;
        const id = setInterval(() => { const t = v.currentTime; max = Math.max(max, t); if (t < last - 0.3) wraps++; last = t; }, 40);
        setTimeout(() => { clearInterval(id); resolve({ max, wraps, ended: v.ended }); }, 2500);
      })`, { timeoutMs: 6000 });
      assert.ok(r.wraps >= 1, `looped ${r.wraps} times`);
      assert.ok(r.max < b + 0.4, `max ${r.max} vs B ${b}`);
      assert.equal(r.ended, false);
      await app.click("#btn-ab-loop");
      assert.equal(await app.text("#ab-loop-label"), "A-B Döngü");
      assert.equal(await app.eval(`document.getElementById("ab-range").style.display`), "none");
      await pause();
    });

    await t.test("speed and aspect ratio menus", async () => {
      await app.click("#btn-speed");
      assert.equal(await has("#speed-menu", "show"), true);
      await app.click(`#speed-menu [data-speed="1.5"]`);
      assert.equal(await app.eval(`${V}.playbackRate`), 1.5);
      assert.equal(await app.text("#speed-label"), "1.5x");
      assert.equal(await has("#speed-menu", "show"), false);
      await app.click("#btn-aspect-ratio");
      await app.click(`#aspect-menu [data-aspect="4-3"]`);
      assert.equal(await has("#video-element", "aspect-4-3"), true);
      assert.equal(await app.text("#aspect-label"), "4:3");
      await app.click(`#aspect-menu [data-aspect="contain"]`);
      assert.equal(await has("#video-element", "aspect-4-3"), false);
      assert.equal(await app.text("#aspect-label"), "Orijinal");
    });

    await t.test("colour filters and reset", async () => {
      await app.eval(`(() => { const s = document.getElementById("slider-brightness"); s.value = 120; s.dispatchEvent(new Event("input")); return true; })()`);
      assert.equal(await app.text("#val-brightness"), "120%");
      assert.equal(await app.eval(`${V}.style.filter`), "brightness(120%) contrast(100%) saturate(100%)");
      await app.click("#btn-reset-filters");
      assert.equal(await app.eval(`${V}.style.filter`), "brightness(100%) contrast(100%) saturate(100%)");
    });

    await t.test("AI restoration (A) and A/B split view (B)", async () => {
      await app.key("KeyA");
      assert.match(await app.text("#ai-master-status"), /^Aktif/);
      assert.equal(await app.eval(`document.getElementById("ai-restore-badge").style.display`), "inline-block");
      const gpu = await app.eval(`document.getElementById("ai-master-status").textContent.includes("GPU")`);
      if (gpu) {
        assert.equal(await has("#video-element", "enhancer-source-hidden"), true);
        await app.key("KeyB");
        assert.equal(await app.eval(`document.getElementById("split-screen-banner").style.display`), "flex");
        assert.equal(await app.text("#split-view-status"), "Açık");
      } else {
        assert.match(await app.eval(`${V}.style.filter`), /contrast\(120%\)/);
      }
      await app.key("KeyA"); // off: also closes the split view
      assert.equal(await app.text("#ai-master-status"), "Kapalı (Orijinal)");
      assert.equal(await app.eval(`document.getElementById("split-screen-banner").style.display`), "none");
      assert.equal(await has("#video-element", "enhancer-source-hidden"), false);
    });

    await t.test("snapshot (S) saves a PNG of the current frame", async () => {
      await seek(1.2);
      await app.key("KeyS");
      const d = await app.waitFor(`window.__downloads.length && window.__downloads[0].size > 0 && window.__downloads[0]`, { timeoutMs: 5000 });
      assert.equal(d.name, "sample-h264_mp4_00-01.png");
      assert.equal(d.type, "image/png");
      assert.ok(d.size > 1000, `png size ${d.size}`);
    });

    await t.test("playlist: second item, click to play, auto-advance at the end", async () => {
      await app.dropFiles([MP4]); // HTML drop: browser File + ObjectURL path, plays immediately
      await app.waitFor(`document.getElementById("playlist-count-badge").textContent === "2" &&
        ${V}.currentSrc.startsWith("blob:") && ${V}.videoWidth === 320`, { timeoutMs: 10000 });
      await app.click(`#playlist-items li[data-idx="0"]`);
      await app.waitFor(`${V}.currentSrc.startsWith("http://asset.localhost/") && ${V}.readyState >= 2`, { timeoutMs: 10000 });
      assert.equal(await has(`#playlist-items li[data-idx="0"]`, "active"), true);
      await app.eval(`${V}.currentTime = ${V}.duration - 0.3, ${V}.play(), true`);
      await app.waitFor(`${V}.currentSrc.startsWith("blob:") &&
        document.querySelector('#playlist-items li[data-idx="1"]').classList.contains("active")`, { timeoutMs: 10000 });
      await pause();
    });

    await t.test("sleep timer 'when the video ends': fade, pause, overlay, wake up", async () => {
      await app.click("#btn-sleep-timer");
      await app.click(`.btn-sleep-preset[data-minutes="video-end"]`);
      assert.equal(await app.text("#sleep-badge"), "Bitince");
      assert.equal(await app.eval(`document.getElementById("sleep-timer-modal").classList.contains("active")`), false);
      await app.eval(`${V}.currentTime = ${V}.duration - 0.3, ${V}.play(), true`);
      // ended -> ~3 s fade -> pause + overlay (instead of advancing the playlist)
      await app.waitFor(`document.getElementById("sleep-overlay").classList.contains("active")`, { timeoutMs: 10000 });
      assert.equal(await app.eval(`${V}.paused`), true);
      assert.equal(await app.eval(`document.getElementById("sleep-badge").style.display`), "none");
      await app.click("#btn-wake-up");
      assert.equal(await app.eval(`document.getElementById("sleep-overlay").classList.contains("active")`), false);
      await app.waitFor(`!${V}.paused`, { timeoutMs: 5000 }); // playback resumes
      assert.equal(await app.text("#volume-badge"), "150%"); // user's own level restored
      await pause();
    });

    await t.test("no uncaught page errors", async () => {
      await sleep(200);
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});
