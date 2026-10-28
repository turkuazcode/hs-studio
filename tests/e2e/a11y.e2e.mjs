// Usability and accessibility (Plan 14 Q03), automated part:
// - axe-core WCAG 2.1 A/AA audit of every main screen, panel and dialog, in Turkish and
//   English, dark / light / high-contrast theme (contrast, names, roles, labels, ARIA)
// - keyboard only: Tab reaches the controls with a visible focus ring and an accessible
//   name; dialogs take focus, keep Tab inside, close with Escape and give focus back
// - reduced motion, 200 % scale (main actions stay visible), long texts do not overflow
// - Windows UI Automation (what Narrator / NVDA read): the window exposes named buttons
// Human checks that cannot be automated (real screen reader session, 5-user task test) are
// listed in docs/status/test-map.md as pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fixture, launchApp } from "./lib/app.mjs";
import { FOCUSED, audit, describeViolations, press, tab } from "./lib/a11y.mjs";

const J = JSON.stringify;
const platformReady = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
const isActive = (app, id) => app.eval(`document.getElementById(${J(id)})?.classList.contains("active") ?? false`);
const setLanguage = async (app, lang) => {
  await app.eval(`(() => { const el = document.getElementById("setting-general-language"); el.value = ${J(lang)};
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await app.waitFor(`document.documentElement.lang === ${J(lang)}`, { timeoutMs: 5000, message: `lang ${lang}` });
};
const setTheme = (app, theme) => app.eval(`(() => { const el = document.getElementById("setting-appearance-theme");
  if (!el) return false; el.value = ${J(theme)}; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);

async function expectClean(app, where, opts) {
  // a dialog fading in/out is half transparent: contrast is only meaningful once it settled
  await app.waitFor(`document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)`,
    { timeoutMs: 5000, message: "transitions finished" });
  const v = await audit(app, opts);
  assert.deepEqual(v.map((x) => x.id), [], `${where}:\n  ${describeViolations(v)}`);
}

async function openSettings(app) {
  await app.click("#btn-app-menu");
  await app.click(`#app-menu [data-menu-id="settings"]`);
  await app.waitFor(`document.getElementById("settings-modal")?.classList.contains("active")`, { message: "settings open" });
}

test("a11y: axe audit of every screen (TR/EN, dark/light/contrast)", { timeout: 240000 }, async (t) => {
  const app = await launchApp({ args: [fixture("sample-h264.mp4")] });
  try {
    await platformReady(app);
    await app.waitFor(`window.__vhoEngine.time > 0.2`, { timeoutMs: 15000, message: "playing" });

    for (const lang of ["tr", "en"]) {
      await t.test(`video screen + HUD menu (${lang})`, async () => {
        if (lang === "en") { await openSettings(app); await setLanguage(app, "en"); await press(app, "Escape"); }
        await expectClean(app, `video ${lang}`);
        await app.click("#btn-hud-more");
        await expectClean(app, `HUD more menu ${lang}`);
        await press(app, "Escape");
        await app.click("#ma-more");
        await expectClean(app, `titlebar more menu ${lang}`);
        await press(app, "Escape");
      });
      await t.test(`settings window, every tab (${lang})`, async () => {
        await openSettings(app);
        const tabs = await app.eval(`[...document.querySelectorAll("#settings-modal [role=tab]")].map((b) => b.id)`);
        for (const id of tabs) {
          await app.click(`#${id}`);
          await expectClean(app, `settings ${id} ${lang}`, { selector: "#settings-modal" });
        }
        await press(app, "Escape");
      });
      await t.test(`dialogs and panels (${lang})`, async () => {
        await app.key("Slash", { key: "?", shiftKey: true });
        await expectClean(app, `shortcut help ${lang}`, { selector: "#shortcut-help" });
        await press(app, "Escape");
        // the sleep timer is in the titlebar "⋯" menu of a video (approved layout 2026-10-28)
        await app.click("#ma-more");
        await app.click(`#media-actions-menu [data-menu-id="sleepTimer"]`);
        await expectClean(app, `sleep timer ${lang}`, { selector: "#sleep-timer-modal" });
        await press(app, "Escape");
        for (const [open, close, id] of [["#btn-toggle-playlist", "#btn-close-playlist", "playlist"], ["#btn-toggle-ai-restore", "#btn-close-ai-restore", "filters"]]) {
          await app.click(open);
          await expectClean(app, `${id} panel ${lang}`);
          await app.click(close);
        }
      });
    }

    for (const theme of ["light", "contrast"]) {
      await t.test(`video screen + settings in the ${theme} theme`, async () => {
        await openSettings(app);
        assert.ok(await setTheme(app, theme), "theme select");
        await app.waitFor(`document.documentElement.dataset.theme === ${J(theme)}`, { timeoutMs: 3000, message: theme });
        await expectClean(app, `settings ${theme}`, { selector: "#settings-modal" });
        await press(app, "Escape");
        await expectClean(app, `video ${theme}`);
        await openSettings(app);
        await setTheme(app, "dark");
        await press(app, "Escape");
      });
    }
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }

  for (const [label, args] of [["start screen", []], ["photo viewer", [fixture("photo-a.jpg")]]]) {
    await t.test(label, async () => {
      const a = await launchApp({ args });
      try {
        await platformReady(a);
        await expectClean(a, label);
        if (!args.length) {
          await a.click("#btn-open-url");
          await expectClean(a, "URL dialog", { selector: "#url-modal" });
          await press(a, "Escape");
          await a.click("#btn-open-studio");
          await a.waitFor(`document.querySelectorAll("#ps-tree .ps-tree-node").length > 0`, { message: "studio" });
          await expectClean(a, "photo studio");
        }
      } finally {
        await a.close();
      }
    });
  }
});

test("a11y: keyboard only — focus ring, names, dialogs keep and return focus", { timeout: 120000 }, async (t) => {
  const app = await launchApp();
  try {
    await platformReady(app);

    await t.test("Tab walks the start screen: every stop visible, ringed and named", async () => {
      await app.eval(`document.activeElement?.blur?.(), true`);
      const seen = [];
      for (let i = 0; i < 30; i++) {
        await tab(app);
        const f = await app.eval(FOCUSED);
        if (!f) continue;
        seen.push(f);
        assert.ok(f.visible && f.inViewport, `focus on an invisible element: ${J(f)}`);
        assert.ok(f.ring, `no visible focus indicator: ${J(f)}`);
        assert.ok(f.name, `focused element without a name: ${J(f)}`);
      }
      const ids = new Set(seen.map((f) => f.id));
      for (const id of ["btn-browse-file", "btn-open-url", "btn-open-studio", "btn-app-menu", "btn-open-library", "btn-titlebar-settings"]) {
        assert.ok(ids.has(id), `Tab never reaches #${id}`);
      }
    });

    for (const [opener, dialog, how] of [
      ["btn-open-url", "url-modal", "click"],
      ["btn-titlebar-settings", "settings-modal", "click"],
      ["btn-app-menu", "settings-modal", "menu"],
      // a video's titlebar "⋯" → Uyku zamanlayıcı… (the video is opened first, below)
      ["ma-more", "sleep-timer-modal", "more"],
    ]) {
      await t.test(`${dialog} (${opener}): Enter opens, focus inside, Tab trapped, Escape closes, focus returns`, async () => {
        if (how === "more") {
          await app.eval(`window.__vhoEngine.openPaths([${J(fixture("sample-h264.mp4"))}]), true`);
          await app.waitFor(`document.documentElement.dataset.mediaMode === "video" && !document.getElementById("media-actions").hidden`, { timeoutMs: 15000, message: "video open" });
        }
        await app.eval(`document.getElementById(${J(opener)}).focus(), true`);
        await press(app, "Enter");
        if (how === "menu" || how === "more") {
          const [menuId, item] = how === "menu" ? ["app-menu", "settings"] : ["media-actions-menu", "sleepTimer"];
          await app.waitFor(`!document.getElementById(${J(menuId)}).hidden`, { message: "menu open" });
          await app.eval(`document.querySelector(${J(`#${menuId} [data-menu-id="${item}"]`)}).focus(), true`);
          await press(app, "Enter");
        }
        await app.waitFor(`document.getElementById(${J(dialog)}).classList.contains("active")`, { message: `${dialog} open` });
        await app.waitFor(`document.getElementById(${J(dialog)}).contains(document.activeElement)`, { timeoutMs: 2000, message: "focus moved into the dialog" });
        assert.equal(await app.eval(`document.getElementById(${J(dialog)}).closest("[role=dialog]") !== null || !!document.querySelector(${J(`#${dialog} [role=dialog]`)})`), true, "dialog role");
        for (let i = 0; i < 25; i++) {
          await tab(app, { shift: i % 3 === 2 });
          assert.equal(await app.eval(`document.getElementById(${J(dialog)}).contains(document.activeElement)`), true, `Tab ${i} left the dialog: ${J(await app.eval(FOCUSED))}`);
        }
        await press(app, "Escape");
        await app.waitFor(`!document.getElementById(${J(dialog)}).classList.contains("active")`, { message: `${dialog} closed` });
        const back = how === "menu" ? "btn-app-menu" : opener; // "more": the ⋯ button itself
        await app.waitFor(`document.activeElement?.id === ${J(back)}`, { timeoutMs: 2000, message: `focus back on #${back}` });
      });
    }
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});

test("a11y: reduced motion, 200 % scale, long texts, UI Automation names", { timeout: 120000 }, async (t) => {
  const app = await launchApp({ args: [fixture("sample-h264.mp4")] });
  try {
    await platformReady(app);
    await app.waitFor(`window.__vhoEngine.time > 0.2`, { timeoutMs: 15000, message: "playing" });

    await t.test("prefers-reduced-motion: transitions and animations are switched off", async () => {
      const dur = () => app.eval(`(() => { const els = [...document.querySelectorAll("button, .modal-card, .hud-btn")].slice(0, 40);
        return Math.max(...els.map((e) => parseFloat(getComputedStyle(e).transitionDuration) || 0)); })()`);
      // the baseline must not depend on the machine: Windows with animations off (the GitHub
      // runner) already reports "reduce"
      await app.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      assert.ok((await dur()) > 0.05, "the normal UI animates (otherwise this check proves nothing)");
      await app.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      assert.ok((await dur()) <= 0.0001, `transition still ${await dur()} s with reduced motion`);
      await app.cdp.send("Emulation.setEmulatedMedia", { features: [] });
    });

    await t.test("200 % scale: the main actions stay visible and inside the window", async () => {
      const { w, h } = await app.eval(`({ w: innerWidth, h: innerHeight })`);
      await app.cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(w / 2), height: Math.round(h / 2), deviceScaleFactor: 2, mobile: false });
      try {
        await app.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        const res = await app.eval(`["btn-play-pause", "btn-hud-more", "btn-fullscreen", "btn-app-menu", "btn-close"].map((id) => {
          const el = document.getElementById(id); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          return { id, ok: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, r: [r.left, r.top, r.right, r.bottom].map(Math.round) };
        })`);
        for (const r of res) assert.ok(r.ok, `#${r.id} not usable at 200 %: ${J(r)} (viewport ${Math.round(w / 2)}x${Math.round(h / 2)})`);
      } finally {
        await app.cdp.send("Emulation.clearDeviceMetricsOverride");
      }
    });

    await t.test("long texts (TR and EN): no clipped button or tab label in Settings", async () => {
      for (const lang of ["en", "tr"]) {
        await openSettings(app);
        await setLanguage(app, lang);
        const tabs = await app.eval(`[...document.querySelectorAll("#settings-modal [role=tab]")].map((b) => b.id)`);
        for (const id of tabs) {
          await app.click(`#${id}`);
          const clipped = await app.eval(`[...document.querySelectorAll("#settings-modal button, #settings-modal [role=tab], #settings-modal label")]
            .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== "visible")
            .map((e) => (e.id || e.className) + ": " + e.textContent.trim().slice(0, 40))`);
          assert.deepEqual(clipped, [], `clipped text in ${id} (${lang})`);
        }
        await press(app, "Escape");
      }
    });

    await t.test("Windows UI Automation exposes the named controls (what a screen reader reads)", { skip: process.platform !== "win32" && "Windows only" }, async () => {
      const expected = await app.eval(`["btn-play-pause", "btn-app-menu", "btn-fullscreen"].map((id) => {
        const el = document.getElementById(id); return el.getAttribute("aria-label") || el.textContent.trim(); })`);
      const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8 # Turkish names (ü, ş...) intact
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${app.proc.pid})
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output "NOWINDOW"; exit 0 }
$btn = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
# WebView2 builds its accessibility tree only after the first UIA client asks: retry briefly
for ($i = 0; $i -lt 10; $i++) {
  $names = @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btn) | ForEach-Object { $_.Current.Name })
  if ($names.Count -gt 3) { break }
  Start-Sleep -Milliseconds 700
}
$names -join [char]10`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 60000, windowsHide: true });
      const all = r.stdout.replace(/\s+$/, "").split(/\r?\n/).map((s) => s.trim());
      const names = all.filter(Boolean);
      assert.notEqual(names[0], "NOWINDOW", "app window not found through UI Automation");
      t.diagnostic(`${names.length} buttons exposed through UI Automation`);
      for (const n of expected) assert.ok(names.includes(n), `UIA has no button named "${n}" (got ${names.slice(0, 30).join(" | ")})`);
      // unnamed buttons are reported, not gating: axe's button-name rule gates the DOM side
      t.diagnostic(`${all.length - names.length} unnamed UIA buttons`);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});
