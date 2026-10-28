// A05 faithful photo enhance in the real app: the panel opens with the recommended settings,
// "Reset to defaults" works, Apply runs the queued "photo-enhance" job (Rust, no model) and
// shows a separate result file; Save copies it next to the photo; the original never changes.
// Sources are copies in a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fixture, launchApp } from "./lib/app.mjs";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const IMG = `document.getElementById("image-element")`;

test("photo enhance: recommended settings, reset, queued job, separate result, save copy", { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-enhance-"));
  const photo = join(dir, "eski foto.jpg");
  copyFileSync(fixture("photo-a.jpg"), photo);
  const before = sha(photo);
  const app = await launchApp({ args: [photo] });
  const laidOut = (sel) => app.eval(`(() => { let el = document.querySelector(${JSON.stringify(sel)}); for (; el; el = el.parentElement) if (getComputedStyle(el).display === "none") return false; return true; })()`);
  try {
    await app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 640`, { timeoutMs: 10000, message: "photo shown" });

    await t.test("panel: photo section with the recommended settings; video filters hidden", async () => {
      await app.click("#btn-toggle-ai-restore");
      assert.equal(await laidOut("#photo-enhance"), true);
      assert.equal(await laidOut("#check-ai-master"), false, "video filter switch hidden for photos");
      // the legacy neural enhancer is out of the Windows alpha scope (core/scope.js)
      assert.equal(await app.eval(`document.getElementById("btn-deep-enhance") === null && !document.querySelector(".deep-enhance-box")`), true, "no legacy AI section");
      assert.equal(await app.eval(`document.getElementById("pe-sharp").value`), "40");
      assert.equal(await app.eval(`document.getElementById("pe-shadow").value`), "33");
      assert.equal(await app.eval(`document.getElementById("pe-scale").value`), "2");
      assert.equal(await app.eval(`document.getElementById("pe-grain").checked`), false);
      assert.match(await app.text("#pe-val-sharp"), /^(Orta|Medium)$/);
    });

    await t.test("reset to defaults after a change", async () => {
      await app.eval(`(() => { const s = document.getElementById("pe-sharp"); s.value = "90"; s.dispatchEvent(new Event("input")); return true; })()`);
      assert.match(await app.text("#pe-val-sharp"), /^(Güçlü|Strong)$/);
      await app.click("#btn-pe-reset");
      assert.equal(await app.eval(`document.getElementById("pe-sharp").value`), "40");
    });

    await t.test("apply: queued job, separate 2x result shown, original unchanged", async () => {
      await app.click("#btn-pe-apply");
      await app.waitFor(`!document.getElementById("pe-result").hidden`, { timeoutMs: 60000, message: "result ready" });
      await app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 1280 && ${IMG}.naturalHeight === 960`, { timeoutMs: 10000, message: "2x result shown" });
      assert.equal(sha(photo), before, "original unchanged");
      await app.click("#btn-pe-compare");
      await app.waitFor(`${IMG}.complete && ${IMG}.naturalWidth === 640`, { timeoutMs: 10000, message: "original shown again" });
      await app.click("#btn-pe-compare");
    });

    await t.test("save: a copy next to the photo, never overwriting", async () => {
      await app.click("#btn-pe-save");
      const saved = await app.waitFor(`document.getElementById("btn-pe-save").dataset.saved || ""`, { timeoutMs: 10000, message: "saved" });
      assert.equal(dirname(saved).toLowerCase(), dir.toLowerCase());
      assert.match(basename(saved), /^eski foto_enhanced(\s\(\d+\))?\.jpg$/);
      assert.ok(existsSync(saved));
      assert.equal(sha(photo), before, "original unchanged");
    });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
