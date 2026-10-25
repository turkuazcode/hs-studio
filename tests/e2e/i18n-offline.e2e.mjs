// S05: language switch reaches the main UI (not only the Settings window), no request leaves
// the app at start-up (bundled font, no Google Fonts), and local files still open with the
// network switched off (CDP offline emulation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HTML5_ENGINE, fixture, launchApp } from "./lib/app.mjs";

const VIDEO = fixture("sample-h264.mp4");
const PHOTO = fixture("photo-a.jpg");

const platformReady = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
const setControl = (app, id, value) => app.eval(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) throw new Error("no control ${id}");
  el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);

/** Visible text nodes (no display:none ancestor) with Turkish-only letters, minus user content. */
const TURKISH_VISIBLE = `(() => {
  const skip = (el) => el.closest("#playlist-items, #current-filename, #licenses-text, select, option, .ps-tree, #ps-breadcrumb");
  const laidOut = (el) => { for (; el; el = el.parentElement) if (getComputedStyle(el).display === "none") return false; return true; };
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const s = n.nodeValue.trim();
    if (!s || !/[çğıöşüÇĞİÖŞÜ]/.test(s)) continue;
    const el = n.parentElement;
    if (!el || skip(el) || !laidOut(el)) continue;
    out.push(s.slice(0, 80));
  }
  for (const el of document.querySelectorAll("[title], [aria-label], [placeholder]")) {
    if (skip(el) || !laidOut(el)) continue;
    for (const a of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v && /[çğıöşüÇĞİÖŞÜ]/.test(v)) out.push("@" + a + ": " + v.slice(0, 80));
    }
  }
  return out;
})()`;

test("S05: language switch, offline start, bundled font", { timeout: 180000 }, async (t) => {
  const app = await launchApp({ args: [VIDEO], env: HTML5_ENGINE });
  try {
    await platformReady(app);
    await app.waitFor(`window.__vhoEngine.kind === "html5" && document.getElementById("video-element").currentTime > 0.2`, { timeoutMs: 15000 });

    await t.test("no request leaves the app at start-up; the UI font is the bundled Outfit", async () => {
      await app.eval(`document.fonts.ready.then(() => true)`);
      const res = await app.eval(`performance.getEntriesByType("resource").map((e) => e.name)`);
      const external = res.filter((u) => /^https?:/i.test(u) && !/^https?:\/\/(tauri|asset|ipc)\.localhost\//i.test(u));
      assert.deepEqual(external, [], "external requests");
      assert.ok(res.some((u) => u.endsWith("/assets/fonts/Outfit-wght.ttf")), "local font file loaded");
      assert.equal(await app.eval(`document.fonts.check('600 16px Outfit')`), true);
      assert.equal(await app.eval(`[...document.querySelectorAll("link[href*='googleapis'], link[href*='gstatic']")].length`), 0);
    });

    await t.test("switching to English translates the main UI, panels and menus (no Turkish left)", async () => {
      await app.click("#btn-app-menu");
      await app.click(`#app-menu [data-menu-id="settings"]`);
      await setControl(app, "setting-general-language", "en");
      await app.waitFor(`document.documentElement.lang === "en" && document.getElementById("settings-title").textContent === "Settings"`, { timeoutMs: 5000, message: "English" });
      await app.key("Escape");
      await app.waitFor(`!document.getElementById("settings-modal").classList.contains("active")`, { timeoutMs: 3000, message: "settings closed" });
      assert.equal(await app.text(`#btn-toggle-ai-restore [data-i18n="enhance.button"]`), "Enhance");
      assert.equal(await app.eval(`document.getElementById("btn-play-pause").title`), "Play / Pause (Space)");
      assert.equal(await app.text("#sub-status-label"), "CC");
      // open the enhance panel and the playlist: their texts must be English too
      await app.click("#btn-toggle-ai-restore");
      await app.key("KeyL");
      const left = await app.eval(TURKISH_VISIBLE);
      assert.deepEqual(left, [], "untranslated visible texts");
      assert.match(await app.text("#playlist-total-text"), /^1 items$/);
      await app.click("#btn-close-ai-restore");
      await app.key("KeyL");
    });

    await t.test("back to Turkish", async () => {
      await app.click("#btn-app-menu");
      await app.click(`#app-menu [data-menu-id="settings"]`);
      await setControl(app, "setting-general-language", "tr");
      await app.waitFor(`document.documentElement.lang === "tr" && document.getElementById("settings-title").textContent === "Ayarlar"`, { timeoutMs: 5000, message: "Turkish" });
      await app.key("Escape");
      assert.equal(await app.text(`#btn-toggle-ai-restore [data-i18n="enhance.button"]`), "İyileştir");
      assert.match(await app.text("#playlist-total-text"), /^1 Medya$/);
    });

    await t.test("network off: a local photo still opens, the map says it is offline", async () => {
      await app.cdp.send("Network.enable");
      await app.cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      try {
        assert.equal(await app.eval(`navigator.onLine`), false);
        await app.eval(`window.__vhoEngine.openPaths(${JSON.stringify([PHOTO])}).then(() => true)`);
        await app.waitFor(`(() => { const i = document.getElementById("image-element"); return i.complete && i.naturalWidth === 640; })()`,
          { timeoutMs: 10000, message: "photo shown offline" });
      } finally {
        await app.cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      }
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
    });
  } finally {
    await app.close();
  }
});
