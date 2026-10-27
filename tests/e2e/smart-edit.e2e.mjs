// A06: "✨ Akıllı" tools of the photo editor without real models (those run in tests/ai/smart-edit.ai.mjs):
// availability rules (colorize only for black-and-white photos, pending edits first), brush mask
// panel, first-use download consent (declined: no job), background options, an AI result as an
// undoable base image with the applied steps shown, Save turning into a copy next to the original
// (original unchanged, transparency kept), and a reset when another photo opens.
// Test files are generated in the temp directory and deleted afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./lib/app.mjs";
import { decodePng, encodePng } from "../ai/lib/image.mjs";

const J = JSON.stringify;
const ROOT = join(tmpdir(), `vho-smart-e2e-${process.pid}`);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function png(path, w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  writeFileSync(path, encodePng({ width: w, height: h, data }));
}

test("smart tools in the photo editor", { timeout: 180000 }, async (t) => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const color = join(ROOT, "color.png");
  const gray = join(ROOT, "gray.png");
  const result = join(ROOT, "color_removed.png");
  png(color, 320, 240, (x, y) => [x % 256, y, 255 - (x % 256), 255]);
  png(gray, 320, 240, (x, y) => { const v = (x + y) % 256; return [v, v, v, 255]; });
  // an AI result with a transparent left quarter (like a cut-out)
  png(result, 320, 240, (x, y) => [x % 256, y, 128, x < 80 ? 0 : 255]);
  const colorSha = sha(color);
  const app = await launchApp();

  const ed = (k) => app.eval(`document.getElementById("ps-editor").dataset[${J(k)}]`);
  const smart = (sel) => `#ps-editor .ps-smart ${sel}`;
  const hidden = (sel) => app.eval(`document.querySelector(${J(sel)}).hidden`);
  const disabled = (sel) => app.eval(`document.querySelector(${J(sel)}).disabled`);
  const openEditor = async (path, name) => {
    await app.eval(`(() => { __vhoStudio.show(); __vhoStudio.editor.open({ path: ${J(path)}, name: ${J(name)}, ext: "png", browserNative: true }); return true; })()`);
    await app.waitFor(`document.getElementById("ps-editor").dataset.ready === "1"`, { timeoutMs: 15000, message: `editor ready (${name})` });
  };

  try {
    await t.test("availability: colour photo has remove + background, no colorize; pending edits disable the tools", async () => {
      await openEditor(color, "color.png");
      assert.equal(await hidden(smart('[data-act="smart-color"]')), true, "colorize hidden for a colour photo");
      assert.equal(await disabled(smart('[data-act="smart-remove"]')), false);
      assert.equal(await disabled(smart('[data-act="smart-bg"]')), false);
      assert.equal(await hidden(smart(".ps-smart-applied")), true);
      await app.click(`#ps-editor [data-act="rotr"]`);
      assert.equal(await disabled(smart('[data-act="smart-remove"]')), true, "pending rotate disables the tools");
      assert.equal(await hidden(smart(".ps-smart-hint")), false);
      await app.click(`#ps-editor [data-act="undo"]`);
      assert.equal(await disabled(smart('[data-act="smart-remove"]')), false);
      assert.equal(await hidden(smart(".ps-smart-hint")), true);
    });

    await t.test("object removal panel: brush mask, eraser/clear, cancel", async () => {
      await app.click(smart('[data-act="smart-remove"]'));
      assert.equal(await hidden(smart('[data-panel="remove"]')), false);
      assert.equal(await hidden("#ps-editor .ps-mask-canvas"), false, "mask overlay over the preview");
      assert.equal(await disabled(smart('[data-act="remove-apply"]')), true, "nothing painted yet");
      await app.eval(`__vhoStudio.editor.smart.addStroke({ points: [[0.5, 0.5], [0.6, 0.5]], radius: 0.05 }), true`);
      assert.equal(await disabled(smart('[data-act="remove-apply"]')), false);
      await app.click(smart('[data-act="brush-clear"]'));
      assert.equal(await disabled(smart('[data-act="remove-apply"]')), true);
      await app.click(smart('[data-panel="remove"] [data-act="smart-close"]'));
      assert.equal(await hidden("#ps-editor .ps-mask-canvas"), true);
    });

    await t.test("first use: the download consent names model, size, license; declining submits no job", async () => {
      const before = (await app.eval(`window.__confirms.length`));
      await app.click(smart('[data-act="smart-remove"]'));
      await app.eval(`__vhoStudio.editor.smart.addStroke({ points: [[0.5, 0.5]], radius: 0.05 }), true`);
      await app.click(smart('[data-act="remove-apply"]'));
      await app.waitFor(`window.__confirms.length > ${before}`, { timeoutMs: 15000, message: "consent asked" });
      const msg = await app.eval(`window.__confirms[window.__confirms.length - 1]`);
      assert.match(msg, /LaMa/);
      assert.match(msg, /Apache-2\.0/);
      assert.match(msg, /\d+(\.\d+)?\s*MB/);
      const jobs = await app.eval(`__TAURI__.core.invoke("jobs_list")`);
      assert.ok(!jobs.some((j) => j.kind.startsWith("ai-")), J(jobs.map((j) => j.kind)));
      assert.equal(await app.eval(`__vhoStudio.editor.smart.busy`), false);
      await app.click(smart('[data-panel="remove"] [data-act="smart-close"]'));
    });

    await t.test("background panel: colour picker only for a custom colour, blur amount only for blur", async () => {
      await app.click(smart('[data-act="smart-bg"]'));
      assert.equal(await hidden(smart('[data-panel="bg"]')), false);
      await app.click(smart('[data-bg="color"]'));
      assert.equal(await hidden(smart(".ps-smart-color")), false);
      assert.equal(await hidden(smart(".ps-smart-blur")), true);
      await app.click(smart('[data-bg="blur"]'));
      assert.equal(await hidden(smart(".ps-smart-color")), true);
      assert.equal(await hidden(smart(".ps-smart-blur")), false);
      await app.click(smart('[data-panel="bg"] [data-act="smart-close"]'));
    });

    await t.test("an AI result becomes the undoable base image; the applied step is shown", async () => {
      await app.eval(`__vhoStudio.editor.smart.applyResult(${J(result)}, "inpaint"), true`);
      await app.waitFor(`document.getElementById("ps-editor").dataset.base === ${J(result)} && document.getElementById("ps-editor").dataset.ready === "1"`,
        { timeoutMs: 15000, message: "result loaded" });
      assert.equal(await app.eval(`document.querySelector(${J(smart(""))}).dataset.steps`), "inpaint");
      assert.equal(await hidden(smart(".ps-smart-applied")), false);
      assert.ok((await app.eval(`document.querySelector(${J(smart(".ps-smart-applied"))}).textContent`)).length > 3);
      await app.click(`#ps-editor [data-act="undo"]`);
      await app.waitFor(`document.getElementById("ps-editor").dataset.base === "" && document.getElementById("ps-editor").dataset.ready === "1"`,
        { timeoutMs: 15000, message: "undo back to the original" });
      assert.equal(await hidden(smart(".ps-smart-applied")), true);
      await app.click(`#ps-editor [data-act="redo"]`);
      await app.waitFor(`document.getElementById("ps-editor").dataset.base === ${J(result)} && document.getElementById("ps-editor").dataset.ready === "1"`,
        { timeoutMs: 15000, message: "redo" });
    });

    await t.test("Save with an AI result writes a copy next to the original (no overwrite, alpha kept)", async () => {
      const confirms = await app.eval(`window.__confirms.length`);
      await app.click(`#ps-editor [data-act="save"]`);
      const r = JSON.parse(await app.waitFor(`document.getElementById("ps-editor").dataset.lastResult`, { timeoutMs: 15000, message: "saved" }));
      assert.ok(r.ok, J(r));
      assert.equal(await app.eval(`window.__confirms.length`), confirms, "no overwrite confirmation: it is a copy");
      assert.match(r.output, /^.*[\\/]color_.+\.png$/);
      assert.notEqual(r.output, color);
      assert.notEqual(r.output, result);
      assert.equal(sha(color), colorSha, "original unchanged");
      const out = decodePng(readFileSync(r.output));
      assert.deepEqual([out.width, out.height], [320, 240]);
      assert.equal(out.data[(10 * 320 + 10) * 4 + 3], 0, "transparent area kept");
      assert.equal(out.data[(10 * 320 + 200) * 4 + 3], 255);
    });

    await t.test("another photo: steps and mask reset; colorize offered for a black-and-white photo", async () => {
      await openEditor(gray, "gray.png");
      assert.equal(await ed("base"), "");
      assert.equal(await hidden(smart(".ps-smart-applied")), true);
      assert.equal(await hidden(smart('[data-act="smart-color"]')), false, "colorize shown for a grey photo");
      await app.click(`#ps-editor [data-act="close"]`);
      assert.equal(await app.eval(`document.getElementById("ps-editor").hidden`), true);
    });

    await t.test("no uncaught page errors", async () => {
      assert.deepEqual(await app.errors(), []);
      assert.deepEqual(await app.blockedCalls(), []);
    });
  } finally {
    await app.close();
    rmSync(ROOT, { recursive: true, force: true });
  }
});
