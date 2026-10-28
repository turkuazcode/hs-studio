// Photo studio: open JPEG + PNG, info card, zoom, rotate, navigation (wrapping), slideshow,
// snapshot, AI toggle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, fixture } from "./lib/app.mjs";

const IMG = `document.getElementById("image-element")`;

test("photo: two photos from the command line", { timeout: 120000 }, async (t) => {
  const app = await launchApp({ args: [fixture("photo-a.jpg"), fixture("photo-b.png")] });
  const display = (id) => app.eval(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`);
  const shown = (width, title, counter) => app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === ${width} &&
    document.getElementById("current-filename").textContent === ${JSON.stringify(title)} &&
    document.getElementById("photo-counter-badge").textContent === ${JSON.stringify(counter)}`, { timeoutMs: 8000, message: `${title} shown` });
  const transform = () => app.eval(`${IMG}.style.transform`);

  try {
    await t.test("first photo, info card data, photo UI instead of video UI", async () => {
      await shown(640, "photo-a.jpg", "1 / 2");
      assert.equal(await app.text("#playlist-count-badge"), "2");
      // local files show their size (was "Ağ Akışı" before the fix)
      assert.match(await app.text(`#playlist-items li[data-idx="0"] .item-meta`), /^0.0 MB$/);
      assert.equal(await app.eval(`document.getElementById("playlist-drawer").classList.contains("open")`), true);
      assert.equal(await display("image-container"), "flex");
      assert.equal(await display("photo-hud"), "flex");
      assert.equal(await display("video-element"), "none");
      assert.equal(await display("controls-hud"), "none");
      assert.equal(await app.text("#info-res"), "640 × 480");
      assert.equal(await app.text("#info-format"), "JPG");
      assert.equal(await app.text("#info-ratio"), "4:3");
      assert.match(await app.text("#info-size"), /^\d+ KB$/);
    });

    await t.test("zoom: button, keys, reset", async () => {
      await app.click("#btn-photo-zoom-in");
      assert.equal(await app.text("#photo-zoom-level"), "125%");
      await app.key("Equal");
      assert.equal(await app.text("#photo-zoom-level"), "156%");
      await app.key("Minus");
      assert.equal(await app.text("#photo-zoom-level"), "125%");
      await app.key("Digit0");
      assert.equal(await app.text("#photo-zoom-level"), "Sığdır");
      assert.match(await transform(), /scale\(1\) rotate\(0deg\)/);
    });

    await t.test("rotate right / left (R, Shift+R)", async () => {
      await app.key("KeyR");
      assert.match(await transform(), /rotate\(90deg\)/);
      assert.equal(await app.toast(), "Sağa Döndürüldü (90°)");
      await app.key("KeyR", { shiftKey: true });
      assert.match(await transform(), /rotate\(0deg\)/);
      assert.equal(await app.toast(), "Sola Döndürüldü (0°)");
    });

    await t.test("info card toggle (I)", async () => {
      await app.key("KeyI");
      assert.equal(await app.eval(`document.getElementById("photo-info-card").style.display`), "flex");
      await app.key("KeyI");
      assert.equal(await app.eval(`document.getElementById("photo-info-card").style.display`), "none");
    });

    await t.test("navigation with wrapping (arrow keys, buttons)", async () => {
      await app.key("ArrowRight");
      await shown(400, "photo-b.png", "2 / 2");
      assert.equal(await app.text("#info-format"), "PNG");
      assert.equal(await app.text("#info-res"), "400 × 300");
      await app.key("ArrowRight"); // wraps to the first
      await shown(640, "photo-a.jpg", "1 / 2");
      await app.key("ArrowLeft"); // wraps to the last
      await shown(400, "photo-b.png", "2 / 2");
      await app.click("#btn-photo-prev");
      await shown(640, "photo-a.jpg", "1 / 2");
      assert.equal(await app.eval(`document.querySelector('#playlist-items li[data-idx="0"]').classList.contains("active")`), true);
    });

    await t.test("slideshow advances by itself (Space)", async () => {
      await app.key("Space");
      assert.equal(await app.toast(), "Slayt Gösterisi Başlatıldı (3.5 sn)");
      assert.equal(await app.eval(`document.getElementById("icon-slideshow-pause").style.display`), "inline-block");
      await shown(400, "photo-b.png", "2 / 2"); // 3.5 s interval
      await app.key("Space");
      assert.equal(await app.toast(), "Slayt Gösterisi Duraklatıldı");
    });

    await t.test("snapshot of a rotated photo (S)", async () => {
      await app.key("KeyR");
      await app.key("KeyS");
      const d = await app.waitFor(`window.__downloads.length && window.__downloads[0]`, { timeoutMs: 5000 });
      assert.equal(d.name, "photo-b_png_enhanced.png");
      assert.equal(d.type, "image/png");
      assert.ok(d.size > 1000, `png size ${d.size}`);
      await app.key("Digit0");
    });

    await t.test("picture filter toggle in photo mode (A), photo layout of the enhance panel (S04), playlist drawer (L)", async () => {
      const laidOut = (sel) => app.eval(`(() => { let el = document.querySelector(${JSON.stringify(sel)}); for (; el; el = el.parentElement) if (getComputedStyle(el).display === "none") return false; return true; })()`);
      assert.equal(await app.eval(`document.documentElement.dataset.media`), "image");
      const drawerOpen = await app.eval(`document.getElementById("playlist-drawer").classList.contains("open")`);
      await app.click("#btn-toggle-ai-restore"); // (opening the panel closes the playlist drawer)
      assert.equal(await laidOut("#photo-enhance"), true, "model-free photo enhance shown for photos");
      assert.equal(await app.eval(`document.getElementById("btn-deep-enhance")`), null, "legacy neural enhancer out of scope (core/scope.js)");
      assert.equal(await laidOut("#check-ai-voice-clarity"), false, "sound filters hidden for photos");
      assert.equal(await laidOut("#video-restore-note"), false);
      await app.click("#btn-close-ai-restore");
      if (drawerOpen) await app.eval(`document.getElementById("playlist-drawer").classList.add("open"), true`);
      await app.key("KeyA");
      assert.match(await app.text("#ai-master-status"), /^(Açık|On)/);
      await app.key("KeyA");
      assert.match(await app.text("#ai-master-status"), /^(Kapalı \(orijinal\)|Off \(original\))$/);
      await app.key("KeyL");
      assert.equal(await app.eval(`document.getElementById("playlist-drawer").classList.contains("open")`), false);
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});
