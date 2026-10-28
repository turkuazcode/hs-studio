// Test isolation of the harness itself: a test instance (VHO_DATA_DIR) gets its own identifier
// `<app identifier>.test<hash>`; Tauri creates %APPDATA% / %LOCALAPPDATA% folders under it. The
// harness removes exactly those folders after close (never the user's app folder), and the
// app's caches (thumbnails, frame grabs, transcodes) stay inside VHO_DATA_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, identityDirs, launchApp, makeDataDir, removeDir, testIdentity } from "./lib/app.mjs";
import { TEST_ID } from "../lib/test-identity.mjs";

test("test isolation: identity folders removed after close, caches inside VHO_DATA_DIR", { timeout: 120000 }, async (t) => {
  const dataDir = await makeDataDir();
  const id = testIdentity(dataDir);
  assert.match(id, /^com\.turkuazcode\.hsstudio\.test[0-9a-f]{16}$/);
  assert.ok(TEST_ID.test(id), "clean-test-artifacts recognises it");
  const app = await launchApp({ dataDir, args: [fixture("photo-a.jpg")] });
  try {
    // open the photo studio on the fixtures folder: thumbnails are written to the cache root
    await app.click("#btn-app-menu");
    await app.click(`#app-menu [data-menu-id="photo-studio"]`);
    await app.waitFor(`document.querySelectorAll("#ps-tree .ps-tree-node").length > 0`, { message: "folder tree" });
    await app.eval(`(() => { document.getElementById("ps-path-edit").click();
      const i = document.getElementById("ps-path"); i.value = ${JSON.stringify(join(fixture("photo-a.jpg"), ".."))}; i.form.requestSubmit(); return true; })()`);
    await app.waitFor(`[...document.querySelectorAll("#ps-grid .ps-cell img")].some((i) => i.src.includes("asset"))`, { timeoutMs: 30000, message: "a thumbnail" });
    assert.ok(existsSync(join(dataDir, "cache", "photo")), "photo cache lives in VHO_DATA_DIR/cache");
    t.diagnostic(`identity ${id}; folders while running: ${identityDirs(dataDir).join(", ") || "none"}`);
  } finally {
    await app.close();
  }
  assert.deepEqual(identityDirs(dataDir), [], "identity folders left behind");
  await removeDir(dataDir);
});
