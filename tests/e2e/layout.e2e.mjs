// Per-media layout (approved mockup 2026-10-28, ui/mode-layout.js, styles/layout-modes.css):
// each mode shows at most two titlebar buttons plus "⋯", the empty screen has no player bar,
// no button label wraps to a second line, and the controls of a bottom bar share one centre line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, launchApp } from "./lib/app.mjs";

const J = JSON.stringify;

/** Ids of the laid-out titlebar buttons besides the logo menu, the photo arrows and the window controls. */
const TITLEBAR_BUTTONS = `[...document.querySelectorAll(".titlebar button")]
  .filter((b) => !b.closest(".titlebar-controls, .macos-traffic-lights, .titlebar-photo-nav") && b.id !== "btn-app-menu")
  .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden")
  .map((b) => b.id)`;

/** Buttons (in the given containers) whose label text runs over more than one line. */
const wrapped = (selector) => `[...document.querySelectorAll(${J(selector)})].flatMap((root) => [...root.querySelectorAll("button")])
  .filter((b) => b.getClientRects().length)
  .filter((b) => {
    const tops = new Set();
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const rect of r.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top / 4));
    }
    return tops.size > 1;
  })
  .map((b) => b.id || b.className)`;

/** Vertical centres of the laid-out controls of a bar: { id: centreY }. */
const centres = (selectors) => `Object.fromEntries(${J(selectors)}
  .map((s) => [s, document.querySelector(s)])
  .filter(([, el]) => el && el.getClientRects().length)
  .map(([s, el]) => { const r = el.getBoundingClientRect(); return [s, Math.round((r.top + r.height / 2) * 10) / 10]; }))`;

function assertOneLine(c, where) {
  const ys = Object.values(c);
  assert.ok(ys.length >= 3, `${where}: controls found ${J(c)}`);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 1, `${where}: controls not on one centre line ${J(c)}`);
}

const ready = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });

test("layout: empty screen — Kütüphane + Ayarlar, one main action, no player bar", { timeout: 60000 }, async () => {
  const app = await launchApp();
  try {
    await ready(app);
    assert.equal(await app.eval(`document.documentElement.dataset.mediaMode`), "none");
    assert.deepEqual(await app.eval(TITLEBAR_BUTTONS), ["btn-open-library", "btn-titlebar-settings"]);
    assert.equal(await app.eval(`getComputedStyle(document.getElementById("controls-hud")).display`), "none", "no player bar");
    assert.equal(await app.eval(`getComputedStyle(document.getElementById("current-filename")).display`), "none", "no media-specific text");
    assert.equal(await app.eval(`document.querySelectorAll(".drop-card .btn-primary").length`), 1, "one main action");
    assert.deepEqual(await app.eval(`[...document.querySelectorAll(".drop-links .btn-link")].map((b) => b.id)`), ["btn-open-url", "btn-open-studio"]);
    assert.deepEqual(await app.eval(wrapped(".titlebar, .drop-card")), []);
    assert.equal(await app.eval(`[...document.querySelectorAll(".app-edition-tag")].length`), 0, "no repeated STUDIO tag");
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});

test("layout: video — Liste + ⋯, HUD on one line, CC▾ one control, Filtreler", { timeout: 90000 }, async () => {
  const app = await launchApp({ args: [fixture("sample-h264.mp4")] });
  try {
    await ready(app);
    await app.waitFor(`document.documentElement.dataset.mediaMode === "video" && !document.getElementById("media-actions").hidden`, { timeoutMs: 15000, message: "video" });
    assert.deepEqual(await app.eval(TITLEBAR_BUTTONS), ["btn-toggle-playlist", "ma-more"]);
    // the filters button sits in the HUD, labelled "Filtreler" in video
    assert.equal(await app.eval(`document.getElementById("btn-toggle-ai-restore").closest(".controls-group.right") !== null`), true);
    assert.equal(await app.eval(`(() => { const b = document.getElementById("btn-toggle-ai-restore");
      return [...b.querySelectorAll("span")].filter((s) => s.getClientRects().length).map((s) => s.textContent.trim()).join(" "); })()`), "Filtreler");
    // CC: the text only (no second CC icon), the caret is part of the same control
    assert.equal(await app.eval(`document.querySelectorAll("#btn-toggle-subtitles svg").length`), 0);
    assert.equal((await app.text("#btn-toggle-subtitles")).trim(), "CC");
    assert.equal(await app.eval(`document.getElementById("btn-sub-menu").parentElement === document.getElementById("btn-toggle-subtitles").parentElement`), true);
    await app.eval(`window.__vhoHud?.poke?.(), document.getElementById("controls-hud").classList.remove("hidden"), true`);
    const c = await app.eval(centres(["#btn-play-pause", "#btn-skip-backward", "#btn-skip-forward", ".volume-container", ".time-display",
      ".cc-split", "#btn-hud-more", "#btn-toggle-ai-restore", "#btn-fullscreen"]));
    assertOneLine(c, "video HUD");
    const heights = await app.eval(`["#btn-play-pause", "#btn-skip-backward", ".cc-split", "#btn-hud-more", "#btn-toggle-ai-restore", "#btn-fullscreen"]
      .map((s) => Math.round(document.querySelector(s).getBoundingClientRect().height))`);
    assert.deepEqual(heights, heights.map(() => 40), `40 px controls ${J(heights)}`);
    assert.deepEqual(await app.eval(wrapped(".titlebar, .controls-hud")), []);
    // the rarely used titlebar buttons are gone from the bar (reached through "⋯")
    for (const id of ["btn-search-subtitles", "btn-sleep-timer", "btn-open-library"]) {
      assert.equal(await app.eval(`document.getElementById(${J(id)}).getClientRects().length`), 0, `${id} not in the titlebar`);
    }
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});

test("layout: photo — Düzenle + ⋯, ‹ n / N › next to the name, İyileştir in the bottom bar", { timeout: 60000 }, async () => {
  const app = await launchApp({ args: [fixture("photo-a.jpg"), fixture("photo-b.png")] });
  try {
    await ready(app);
    await app.waitFor(`document.documentElement.dataset.mediaMode === "photo" && !document.getElementById("media-actions").hidden`, { timeoutMs: 15000, message: "photo" });
    assert.deepEqual(await app.eval(TITLEBAR_BUTTONS), ["ma-editPhoto", "ma-more"]);
    assert.equal(await app.eval(`document.querySelector(".titlebar-photo-nav").getClientRects().length > 0`), true);
    assert.equal(await app.text("#photo-counter-badge"), "1 / 2");
    await app.click("#btn-photo-next");
    await app.waitFor(`document.getElementById("photo-counter-badge").textContent === "2 / 2"`, { timeoutMs: 5000, message: "next from the titlebar" });
    assert.equal(await app.eval(`document.getElementById("btn-toggle-ai-restore").closest(".photo-hud") !== null`), true);
    assert.equal(await app.eval(`document.getElementById("btn-photo-info").getClientRects().length`), 0, "info is in ⋯");
    assertOneLine(await app.eval(centres(["#btn-photo-slideshow", "#btn-photo-zoom-out", "#btn-photo-zoom-reset", "#btn-photo-zoom-in",
      "#btn-photo-rotate-left", "#btn-photo-rotate-right", "#btn-toggle-ai-restore"])), "photo bar");
    assert.deepEqual(await app.eval(wrapped(".titlebar, .photo-hud")), []);
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});

test("layout: music — Sıradakiler + ⋯, shuffle/prev/play/next/repeat, readable title", { timeout: 60000 }, async () => {
  const app = await launchApp({ args: [fixture("engine-tone.m4a")] });
  try {
    await ready(app);
    await app.waitFor(`document.documentElement.dataset.mediaMode === "music" && !document.getElementById("music-mode").hidden`, { timeoutMs: 15000, message: "music" });
    assert.deepEqual(await app.eval(TITLEBAR_BUTTONS), ["btn-music-queue", "ma-more"]);
    for (const id of ["btn-skip-backward", "btn-skip-forward", "btn-fullscreen", "btn-toggle-subtitles"]) {
      assert.equal(await app.eval(`document.getElementById(${J(id)}).getClientRects().length`), 0, `${id} hidden for music`);
    }
    await app.eval(`document.getElementById("controls-hud").classList.remove("hidden"), true`);
    const order = await app.eval(`[...document.querySelectorAll(".controls-group.left > *")].filter((e) => e.getClientRects().length).map((e) => e.id || e.className)`);
    assert.deepEqual(order.slice(0, 5), ["music-shuffle", "music-prev", "btn-play-pause", "music-next", "music-repeat"]);
    assertOneLine(await app.eval(centres(["#music-shuffle", "#music-prev", "#btn-play-pause", "#music-next", "#music-repeat", ".volume-container"])), "music HUD");
    // the title is readable on the music view's own ground (WCAG 4.5:1)
    const ratio = await app.eval(`(() => {
      const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const a = lum(rgb(getComputedStyle(document.getElementById("music-title")).color));
      const b = lum(rgb(getComputedStyle(document.getElementById("music-mode")).backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    })()`);
    assert.ok(ratio >= 4.5, `music title contrast ${ratio.toFixed(2)}:1`);
    // the up-next panel toggles from the titlebar
    await app.click("#btn-music-queue");
    assert.equal(await app.eval(`document.querySelector(".music-queue").getClientRects().length`), 0);
    assert.equal(await app.eval(`document.getElementById("btn-music-queue").getAttribute("aria-pressed")`), "false");
    await app.click("#btn-music-queue");
    assert.deepEqual(await app.eval(wrapped(".titlebar, .controls-hud")), []);
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});
