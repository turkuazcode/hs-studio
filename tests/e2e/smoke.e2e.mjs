// Startup, empty screen, licenses window, module worker, shortcuts without media.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp } from "./lib/app.mjs";

test("smoke: app starts, empty screen, licenses", { timeout: 120000 }, async (t) => {
  const app = await launchApp();
  try {
    await t.test("boots without uncaught errors", async () => {
      assert.deepEqual(await app.errors(), []);
      assert.equal(await app.eval("typeof __TAURI__.core.invoke"), "function");
    });

    await t.test("empty screen: drop zone, placeholder title, no media", async () => {
      const s = await app.eval(`({
        drop: document.getElementById("drop-zone").classList.contains("visible"),
        title: document.getElementById("current-filename").textContent,
        videoSrc: document.getElementById("video-element").getAttribute("src"),
        imageShown: getComputedStyle(document.getElementById("image-container")).display !== "none",
        count: document.getElementById("playlist-count-badge").textContent,
        cc: document.getElementById("sub-status-label").textContent,
        volume: document.getElementById("volume-badge").textContent,
      })`);
      assert.deepEqual(s, { drop: true, title: "Video Bekleniyor", videoSrc: null, imageShown: false, count: "0", cc: "CC", volume: "100%" });
    });

    await t.test("shortcuts without media do not throw", async () => {
      for (const code of ["Space", "ArrowLeft", "ArrowRight", "KeyC", "KeyG", "KeyL", "KeyL", "KeyB"]) await app.key(code);
      // C with no subtitles opens the subtitle search modal
      assert.equal(await app.eval(`document.getElementById("subtitle-search-modal").classList.contains("active")`), true);
      await app.click("#btn-close-sub-modal");
      assert.equal(await app.eval(`document.getElementById("val-sub-delay").textContent`), "-50 ms");
      assert.deepEqual(await app.errors(), []);
    });

    await t.test("licenses window shows the third-party notices", async () => {
      await app.click("#btn-open-licenses");
      // Placeholder text first, then the fetched notices
      const len = await app.waitFor(`document.getElementById("licenses-modal").classList.contains("active") &&
        document.getElementById("licenses-text").textContent.length > 1000 &&
        document.getElementById("licenses-text").textContent.length`, { timeoutMs: 5000 });
      assert.ok(len > 10000, `notices length ${len}`);
      assert.match(await app.text("#licenses-text"), /onnxruntime|ONNX Runtime/i);
      await app.click("#btn-close-licenses");
      assert.equal(await app.eval(`document.getElementById("licenses-modal").classList.contains("active")`), false);
    });

    await t.test("AI worker module (and its imports) loads", async () => {
      const r = await app.eval(`new Promise((resolve) => {
        const w = new Worker("media/ai-worker.js", { type: "module" });
        const done = (v) => { w.terminate(); resolve(v); };
        w.onerror = (e) => done("error: " + (e.message || "module load failed"));
        w.postMessage({ type: "noop" }); // ignored by the worker
        setTimeout(() => done("ok"), 1500);
      })`, { timeoutMs: 5000 });
      assert.equal(r, "ok");
    });

    await t.test("URL modal validates input (invalid scheme, HLS)", async () => {
      await app.click("#btn-open-url");
      assert.equal(await app.eval(`document.getElementById("url-modal").classList.contains("active")`), true);
      await app.eval(`document.getElementById("input-video-url").value = "ftp://example.com/a.mp4", true`);
      await app.click("#btn-confirm-url");
      assert.equal(await app.toast(), "Geçerli bir http(s) URL girin");
      const hls = await app.eval(`document.getElementById("video-element").canPlayType("application/vnd.apple.mpegurl")`);
      if (!hls) {
        await app.eval(`document.getElementById("input-video-url").value = "https://example.com/live.m3u8", true`);
        await app.click("#btn-confirm-url");
        assert.equal(await app.toast(), "⚠️ HLS (.m3u8) akışları bu sürümde desteklenmiyor");
      }
      assert.equal(await app.text("#playlist-count-badge"), "0");
      await app.click("#btn-cancel-url");
      assert.equal(await app.eval(`document.getElementById("url-modal").classList.contains("active")`), false);
    });

    await t.test("panels toggle; compatibility mode asks first and keeps the setting on 'no'", async () => {
      await app.click("#btn-toggle-effects");
      assert.equal(await app.eval(`document.getElementById("effects-panel").classList.contains("show")`), true);
      const before = await app.eval(`document.getElementById("check-compat-mode").checked`);
      await app.click("#check-compat-mode"); // confirm() is stubbed to answer "no"
      assert.equal(await app.eval(`window.__confirms.length`), 1);
      assert.match(await app.eval(`window.__confirms[0]`), /Uyumluluk Modu/);
      assert.equal(await app.eval(`document.getElementById("check-compat-mode").checked`), before);
      await app.click("#btn-close-effects");
      assert.equal(await app.eval(`document.getElementById("effects-panel").classList.contains("show")`), false);
      await app.click("#btn-toggle-ai-restore");
      assert.equal(await app.eval(`document.getElementById("ai-restore-panel").classList.contains("show")`), true);
      await app.click("#btn-close-ai-restore");
      assert.equal(await app.eval(`document.getElementById("ai-restore-panel").classList.contains("show")`), false);
      await app.click("#btn-toggle-playlist");
      assert.equal(await app.eval(`document.getElementById("playlist-drawer").classList.contains("open")`), true);
      await app.click("#btn-close-playlist");
      assert.equal(await app.eval(`document.getElementById("playlist-drawer").classList.contains("open")`), false);
    });

    await t.test("fullscreen: F enters, Escape leaves (window API)", async () => {
      const isFs = `__TAURI__.window.getCurrentWindow().isFullscreen()`;
      await app.key("KeyF");
      await app.waitFor(isFs, { timeoutMs: 5000 });
      assert.equal(await app.eval(`document.documentElement.classList.contains("is-fullscreen")`), true);
      assert.equal(await app.eval(`document.getElementById("icon-fs-exit").style.display`), "block");
      await app.key("Escape");
      await app.waitFor(`${isFs}.then((fs) => !fs)`, { timeoutMs: 5000 });
      assert.equal(await app.eval(`document.documentElement.classList.contains("is-fullscreen")`), false);
    });

    await t.test("sleep timer modal opens and closes", async () => {
      await app.click("#btn-sleep-timer");
      assert.equal(await app.eval(`document.getElementById("sleep-timer-modal").classList.contains("active")`), true);
      await app.click("#btn-cancel-sleep-timer");
      assert.equal(await app.eval(`document.getElementById("sleep-timer-modal").classList.contains("active")`), false);
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});
