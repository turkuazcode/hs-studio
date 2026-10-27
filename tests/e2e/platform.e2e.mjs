// Platform layer: settings window (tabs, language switch), persistence across restarts,
// recent files, shortcut help / editor, context menu, single instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";
import { waitLibraryDb } from "./lib/db.mjs";
import { sleep } from "./lib/cdp.mjs";

const VIDEO = fixture("sample-h264.mp4");
const PHOTO = fixture("photo-a.jpg");

/** Parsed store file of the isolated data folder (or null). */
function readStore(dataDir, file) {
  const p = join(dataDir, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

async function waitStore(dataDir, file, pred, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = readStore(dataDir, file);
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`${file}: timed out waiting for ${what}; last=${JSON.stringify(last)?.slice(0, 400)}`);
}

const platformReady = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
const isActive = (app, id) => app.eval(`document.getElementById(${JSON.stringify(id)})?.classList.contains("active") ?? false`);

/** Changes a settings control the way a user would (value + input/change events). */
const setControl = (app, id, value) => app.eval(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) throw new Error("no control ${id}");
  if (el.type === "checkbox") el.checked = ${JSON.stringify(value)}; else el.value = ${JSON.stringify(String(value))};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);

test("platform: settings window, language switch, help, menus", { timeout: 120000 }, async (t) => {
  const app = await launchApp();
  try {
    await platformReady(app);

    await t.test("defaults: PC sleep off, settings file written to the isolated folder", async () => {
      assert.equal(await app.eval(`document.getElementById("check-pc-sleep").checked`), false);
      const store = await waitStore(app.dataDir, "settings.json", (s) => s.settings?.version === 1, "defaults");
      assert.equal(store.settings.values["sleep.pcSleep"], false);
      assert.equal(await app.eval(`document.getElementById("snapshot-toast").getAttribute("aria-live")`), "polite");
    });

    await t.test("titlebar menu opens the settings window with all tabs", async () => {
      await app.click("#btn-app-menu");
      assert.equal(await app.eval(`!document.getElementById("app-menu").hidden`), true);
      await app.click(`#app-menu [data-menu-id="settings"]`);
      assert.equal(await isActive(app, "settings-modal"), true);
      const tabs = await app.eval(`[...document.querySelectorAll("#settings-modal [role=tab]")].map((b) => b.textContent)`);
      assert.deepEqual(tabs, ["Genel", "Oynatma", "Altyazı", "Ses", "Fotoğraf", "Kütüphane", "Görünüm", "Kısayollar", "AI modelleri", "Gelişmiş", "Hakkında / Lisanslar"]);
      assert.equal(await app.text("#settings-title"), "Ayarlar");
      assert.equal(await app.eval(`!!document.getElementById("setting-btn-default-apps")`), true, "default apps button (Windows)");
    });

    await t.test("language switch updates the settings window without reload", async () => {
      await app.eval(`window.__noReload = true`);
      await setControl(app, "setting-general-language", "en");
      await app.waitFor(`document.getElementById("settings-title").textContent === "Settings"`, { timeoutMs: 5000, message: "English title" });
      assert.equal(await app.text("#settings-tab-general"), "General");
      assert.equal(await app.text(`#btn-app-menu span`), "Menu");
      assert.equal(await app.eval(`document.documentElement.lang`), "en");
      await setControl(app, "setting-general-language", "tr");
      await app.waitFor(`document.getElementById("settings-title").textContent === "Ayarlar"`, { timeoutMs: 5000, message: "Turkish title" });
      assert.equal(await app.text("#settings-tab-shortcuts"), "Kısayollar");
      assert.equal(await app.eval(`window.__noReload`), true, "no page reload");
    });

    await t.test("shortcut editor refuses a conflicting key, accepts a free one", async () => {
      await app.click("#settings-tab-shortcuts");
      await app.click(`#settings-panel-shortcuts [data-action="snapshot"] .vho-shortcut-change`);
      await app.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true, cancelable: true })), true`);
      assert.match(await app.text(".vho-shortcut-status"), /F zaten "Tam ekran" için kullanılıyor/);
      await app.click(`#settings-panel-shortcuts [data-action="snapshot"] .vho-shortcut-change`);
      await app.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", key: "k", bubbles: true, cancelable: true })), true`);
      assert.equal(await app.text(".vho-shortcut-status"), "Kısayol kaydedildi");
      assert.equal(await app.text(`#settings-panel-shortcuts [data-action="snapshot"] kbd`), "K");
      await waitStore(app.dataDir, "settings.json", (s) => s.settings?.values?.["shortcuts.bindings"]?.snapshot?.[0] === "KeyK", "binding");
      await app.click("#btn-shortcuts-reset-all");
      assert.equal(await app.text(`#settings-panel-shortcuts [data-action="snapshot"] kbd`), "S");
    });

    await t.test("Escape closes the settings window", async () => {
      await app.key("Escape");
      assert.equal(await isActive(app, "settings-modal"), false);
    });

    await t.test("? opens the shortcut help, Escape closes it", async () => {
      await app.key("Slash", { key: "?", shiftKey: true });
      assert.equal(await isActive(app, "shortcut-help"), true);
      const text = await app.text("#shortcut-help");
      assert.match(text, /Oynat \/ duraklat/);
      assert.match(text, /Boşluk/);
      await app.key("Escape");
      assert.equal(await isActive(app, "shortcut-help"), false);
      await app.key("F1");
      assert.equal(await isActive(app, "shortcut-help"), true);
      await app.key("F1");
      assert.equal(await isActive(app, "shortcut-help"), false);
    });

    await t.test("right click opens the context menu; items run actions", async () => {
      await app.eval(`document.getElementById("viewport").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })), true`);
      assert.equal(await app.eval(`!document.getElementById("context-menu").hidden`), true);
      const items = await app.eval(`[...document.querySelectorAll("#context-menu [role=menuitem]")].map((b) => b.dataset.menuId)`);
      for (const id of ["play-pause", "fullscreen", "open-file", "settings", "shortcuts"]) assert.ok(items.includes(id), id);
      await app.click(`#context-menu [data-menu-id="shortcuts"]`);
      assert.equal(await app.eval(`document.getElementById("context-menu").hidden`), true);
      assert.equal(await isActive(app, "shortcut-help"), true);
      await app.key("Escape");
    });

    await t.test("Ctrl+, opens settings; theme switch applies data-theme", async () => {
      await app.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", { code: "Comma", key: ",", ctrlKey: true, bubbles: true, cancelable: true })), true`);
      assert.equal(await isActive(app, "settings-modal"), true);
      await app.click("#settings-tab-appearance");
      await setControl(app, "setting-appearance-theme", "contrast");
      assert.equal(await app.eval(`document.documentElement.dataset.theme`), "contrast");
      await setControl(app, "setting-appearance-theme", "dark");
      assert.equal(await app.eval(`document.documentElement.hasAttribute("data-theme")`), false);
      await app.key("Escape");
    });

    await t.test("no uncaught errors; the guard blocked nothing", async () => {
      assert.deepEqual(await app.errors(), []);
      assert.deepEqual(await app.blockedCalls(), []);
    });
  } finally {
    await app.close();
  }
});

test("platform: settings persist across a restart", { timeout: 120000 }, async (t) => {
  const dataDir = await makeDataDir();
  try {
    const first = await launchApp({ dataDir });
    try {
      await platformReady(first);
      await first.eval(`(() => { const s = document.getElementById("volume-slider"); s.value = 60; s.dispatchEvent(new Event("input")); return true; })()`);
      await first.click(`#aspect-menu .dropdown-item[data-aspect="4-3"]`);
      await first.click(`#speed-menu .dropdown-item[data-speed="1.5"]`);
      await first.eval(`(() => { const s = document.getElementById("slider-brightness"); s.value = 130; s.dispatchEvent(new Event("input")); return true; })()`);
      await first.click("#btn-app-menu");
      await first.click(`#app-menu [data-menu-id="settings"]`);
      await setControl(first, "setting-appearance-theme", "light");
      await setControl(first, "setting-general-language", "en");
      await setControl(first, "setting-subtitle-fontScale", 150);
      await waitStore(dataDir, "settings.json", (s) => {
        const v = s.settings?.values ?? {};
        return v["playback.volume"] === 60 && v["playback.aspect"] === "4-3" && v["playback.speed"] === 1.5 &&
          v["filters.brightness"] === 130 && v["appearance.theme"] === "light" && v["general.language"] === "en" &&
          v["subtitle.fontScale"] === 150;
      }, "changed values");
    } finally {
      await first.close();
    }

    const second = await launchApp({ dataDir });
    try {
      await platformReady(second);
      await t.test("values restored into the UI", async () => {
        const s = await second.eval(`({
          volume: document.getElementById("volume-badge").textContent,
          aspect: document.getElementById("aspect-label").textContent,
          speed: document.getElementById("speed-label").textContent,
          brightness: document.getElementById("slider-brightness").value,
          theme: document.documentElement.dataset.theme,
          lang: document.documentElement.lang,
          menu: document.querySelector("#btn-app-menu span").textContent,
          subScale: document.documentElement.style.getPropertyValue("--sub-scale"),
          pcSleep: document.getElementById("check-pc-sleep").checked,
        })`);
        assert.deepEqual(s, { volume: "60%", aspect: "4:3", speed: "1.5x", brightness: "130", theme: "light", lang: "en", menu: "Menu", subScale: "1.5", pcSleep: false });
      });
      await t.test("settings window shows the stored values", async () => {
        await second.click("#btn-app-menu");
        await second.click(`#app-menu [data-menu-id="settings"]`);
        assert.equal(await second.eval(`document.getElementById("setting-appearance-theme").value`), "light");
        assert.equal(await second.eval(`document.getElementById("setting-playback-volume").value`), "60");
        assert.equal(await second.text("#settings-title"), "Settings");
      });
      assert.deepEqual(await second.errors(), []);
    } finally {
      await second.close();
    }
  } finally {
    await removeDir(dataDir);
  }
});

test("platform: recent files", { timeout: 120000 }, async (t) => {
  const dataDir = await makeDataDir();
  try {
    const app = await launchApp({ args: [VIDEO, PHOTO], dataDir });
    try {
      await platformReady(app);
      await t.test("opened video is recorded with duration and a thumbnail", async () => {
        await app.waitFor(`window.__vhoEngine.time > 1`, { timeoutMs: 15000, message: "video playing" }); // either engine
        // recent list lives in library.db (Plan 13/L01); no library.json is written any more
        const lib = await waitLibraryDb(dataDir, (l) => l.recent[0]?.thumb?.startsWith("data:image/jpeg"), "video thumb");
        const v = lib.recent[0];
        assert.equal(v.name, "sample-h264.mp4");
        assert.equal(v.type, "video");
        assert.ok(v.duration > 2 && v.duration < 4, `duration ${v.duration}`);
        assert.equal(v.path, VIDEO);
      });
      await t.test("photo is recorded too (most recent first)", async () => {
        await app.eval(`document.querySelectorAll("#playlist-items li")[1].click(), true`);
        await app.waitFor(`document.getElementById("current-filename").textContent === "photo-a.jpg"`, { timeoutMs: 10000 });
        const lib = await waitLibraryDb(dataDir, (l) => l.recent.length === 2, "two entries");
        assert.deepEqual(lib.recent.map((e) => [e.name, e.type]), [["photo-a.jpg", "image"], ["sample-h264.mp4", "video"]]);
        assert.equal(existsSync(join(dataDir, "library.json")), false);
      });
      await t.test("grid and titlebar menu list the entries; remove and clear", async () => {
        assert.equal(await app.eval(`document.querySelectorAll("#recent-files .vho-recent-item").length`), 2);
        await app.click("#btn-app-menu");
        const names = await app.eval(`[...document.querySelectorAll('#app-menu [data-menu-id="recent-item"]')].map((b) => b.textContent)`);
        assert.deepEqual(names, ["photo-a.jpg", "sample-h264.mp4"]);
        await app.key("Escape");
        await app.click(`#recent-files .vho-recent-item[data-id=${JSON.stringify(PHOTO)}] .vho-recent-remove`);
        assert.equal(await app.eval(`document.querySelectorAll("#recent-files .vho-recent-item").length`), 1);
        assert.match(await app.toast(), /photo-a\.jpg listeden kaldırıldı/);
        await app.click("#btn-recent-clear");
        assert.equal(await app.eval(`document.getElementById("recent-files").hidden`), true);
        await waitLibraryDb(dataDir, (l) => l.recent.length === 0, "cleared");
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
  }
});

test("platform: second launch with a file opens it in the running window", { timeout: 120000 }, async () => {
  const app = await launchApp();
  try {
    await platformReady(app);
    assert.equal(await app.text("#current-filename"), "Video Bekleniyor");
    // Same data folder => same single-instance lock as the first test instance only
    const second = spawn(app.exe, [VIDEO], { env: app.env, stdio: "ignore" });
    const code = await new Promise((res, rej) => {
      const timer = setTimeout(() => { second.kill(); rej(new Error("second instance did not exit")); }, 20000);
      second.once("exit", (c) => { clearTimeout(timer); res(c); });
    });
    assert.equal(code, 0, "second instance exits after forwarding");
    await app.waitFor(`document.getElementById("current-filename").textContent === "sample-h264.mp4"`, { timeoutMs: 15000, message: "file opened in the first window" });
    await app.waitFor(`window.__vhoEngine.time > 0.2 && (window.__vhoEngine.kind === "mpv" || document.getElementById("video-element").videoWidth > 0)`, { timeoutMs: 15000, message: "video decoded" }); // either engine
    const pages = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
    assert.equal(pages.filter((p) => p.type === "page").length, 1, "still one window");
    assert.equal(await app.text("#playlist-count-badge"), "1");
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});
