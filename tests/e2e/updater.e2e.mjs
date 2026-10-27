// Signed self-update (R02 updater card) end to end against the release exe.
// A THROWAWAY minisign key pair is generated at test time in a temp folder (never committed) with
// the project's own Tauri CLI; update manifests and artifacts come from a loopback server.
// The app accepts the test endpoint/key only in an isolated instance (VHO_DATA_DIR) and only for
// http://127.0.0.1 (src-tauri/src/updater.rs). VHO_UPDATER_DRY_RUN=1: a valid update is downloaded
// and verified but the installer is not started (the installer path is covered by the P05 test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";

const TAURI_CLI = join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const PASSWORD = "throwaway-test-key";
const WIN_TARGETS = ["windows-x86_64", "windows-x86_64-nsis"];

function tauri(args) {
  return execFileSync(process.execPath, [TAURI_CLI, ...args], { encoding: "utf8", env: { ...process.env, CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
}

/** Throwaway key pair + a signed fake artifact for `version`. */
function makeKeys(dir, name) {
  const key = join(dir, `${name}.key`);
  tauri(["signer", "generate", "--ci", "-p", PASSWORD, "-w", key]);
  return { key, pub: readFileSync(`${key}.pub`, "utf8").trim() };
}
function signArtifact(dir, key, file, bytes, version) {
  const path = join(dir, file);
  writeFileSync(path, bytes);
  tauri(["signer", "sign", "-f", key, "-p", PASSWORD, "--app-version", version, path]);
  return readFileSync(`${path}.sig`, "utf8").trim();
}

/** Loopback server: /latest.json (current manifest) and /files/<name>. Logs requests. */
function startServer() {
  const files = new Map();
  const log = [];
  let manifest = null;
  const server = createServer((req, res) => {
    log.push(req.url);
    if (req.url.startsWith("/latest.json")) {
      if (!manifest) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manifest));
      return;
    }
    const f = files.get(decodeURIComponent(req.url.replace(/^\/files\//, "")));
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": f.length });
    res.end(f);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      base, log, files,
      setManifest(m) { manifest = m; },
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

const release = (base, version, file, signature) => ({
  version, notes: `Test release ${version}`, pub_date: "2026-10-27T00:00:00Z",
  platforms: Object.fromEntries(WIN_TARGETS.map((t) => [t, { url: `${base}/files/${file}`, signature }])),
});

const check = (app) => app.eval(`__TAURI__.core.invoke("updater_check")`);
const install = (app) => app.eval(`__TAURI__.core.invoke("updater_install").then((r) => ({ ok: r }), (e) => ({ err: String(e) }))`, { timeoutMs: 30000 });

test("updater: signed updates, rejection of bad ones, quiet offline, default off", { timeout: 300000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("updater artifacts are tested on Windows (NSIS)"); return; }
  const dir = await mkdtemp(join(tmpdir(), "vho-updater-keys-"));
  const server = await startServer();
  const dataDir = await makeDataDir();
  let app;
  try {
    const good = makeKeys(dir, "good");
    const other = makeKeys(dir, "other");
    const payload = Buffer.from("fake NSIS installer payload " + "x".repeat(4096));
    const sigGood = signArtifact(dir, good.key, "good-9.9.9.exe", payload, "9.9.9");
    const sigOther = signArtifact(dir, other.key, "other-9.9.9.exe", payload, "9.9.9");
    const sigOld = signArtifact(dir, good.key, "good-0.0.9.exe", payload, "0.0.9");
    server.files.set("good.exe", payload);
    server.files.set("corrupt.exe", Buffer.concat([payload.subarray(0, 100), Buffer.from("tampered"), payload.subarray(108)]));

    // Toggle on in the isolated settings, so the startup check also runs
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ settings: { version: 1, values: { "general.checkUpdates": true } } }));
    server.setManifest(release(server.base, "9.9.9", "good.exe", sigGood));
    app = await launchApp({
      dataDir,
      env: {
        VHO_UPDATER_TEST_ENDPOINT: `${server.base}/latest.json?current={{current_version}}&target={{target}}&arch={{arch}}`,
        VHO_UPDATER_TEST_PUBKEY: good.pub,
        VHO_UPDATER_DRY_RUN: "1",
      },
    });

    await t.test("toggle on: the startup check finds the release and shows one quiet toast", async () => {
      await app.waitFor(`!!document.querySelector("#snapshot-toast span")?.textContent?.includes("9.9.9")`, { timeoutMs: 20000, message: "update toast" });
      assert.ok(server.log.some((u) => u.startsWith("/latest.json")), "manifest requested");
      assert.ok(server.log.some((u) => /target=windows/.test(u) && /arch=x86_64/.test(u)), `target/arch in URL: ${server.log}`);
    });

    await t.test("valid signed update: downloaded and verified", async () => {
      const r = await check(app);
      assert.equal(r.status, "available");
      assert.equal(r.version, "9.9.9");
      assert.equal(r.currentVersion, "0.1.0");
      assert.deepEqual(await install(app), { ok: "verified" });
    });

    await t.test("signature of another key: rejected", async () => {
      server.setManifest(release(server.base, "9.9.9", "good.exe", sigOther));
      assert.equal((await check(app)).status, "available");
      const r = await install(app);
      assert.match(r.err ?? "", /^signature:/, JSON.stringify(r));
    });

    await t.test("corrupt download: rejected", async () => {
      server.setManifest(release(server.base, "9.9.9", "corrupt.exe", sigGood));
      assert.equal((await check(app)).status, "available");
      const r = await install(app);
      assert.match(r.err ?? "", /^signature:/, JSON.stringify(r));
    });

    await t.test("old genuine artifact announced as a newer version: rejected (signed version)", async () => {
      server.setManifest(release(server.base, "9.9.9", "good.exe", sigOld));
      assert.equal((await check(app)).status, "available");
      const r = await install(app);
      assert.match(r.err ?? "", /^signature:/, JSON.stringify(r));
    });

    await t.test("downgrade / same version: not offered", async () => {
      server.setManifest(release(server.base, "0.0.9", "good.exe", sigOld));
      assert.equal((await check(app)).status, "none");
      server.setManifest(release(server.base, "0.1.0", "good.exe", sigGood));
      assert.equal((await check(app)).status, "none");
      const r = await install(app);
      assert.match(r.err ?? "", /^none:/, "nothing pending after a 'none' check");
    });

    await t.test("Settings > General: status row shows the result", async () => {
      server.setManifest(release(server.base, "9.9.9", "good.exe", sigGood));
      await app.click("#btn-app-menu");
      await app.click(`#app-menu [data-menu-id="settings"]`);
      assert.equal(await app.eval(`document.getElementById("setting-general-checkUpdates").checked`), true, "toggle reflects the stored value");
      await app.waitFor(`!!document.querySelector("#update-check-now")`, { timeoutMs: 5000, message: "settings: update row" });
      await app.click("#update-check-now");
      await app.waitFor(`document.querySelector("#update-status")?.dataset.status === "available"`, { timeoutMs: 15000, message: "status available" });
      assert.match(await app.text("#update-status"), /9\.9\.9/);
      assert.equal(await app.eval(`document.querySelector("#update-install").hidden`), false);
    });

    await t.test("offline: quiet result, no error toast, no console errors", async () => {
      await server.close();
      const before = await app.eval(`document.querySelector("#snapshot-toast span")?.textContent ?? ""`);
      const r = await check(app);
      assert.equal(r.status, "offline");
      await app.click("#update-check-now");
      await app.waitFor(`document.querySelector("#update-status")?.dataset.status === "offline"`, { timeoutMs: 30000, message: "status offline" });
      assert.equal(await app.eval(`document.querySelector("#snapshot-toast span")?.textContent ?? ""`), before, "no new toast");
      assert.deepEqual((await app.errors()).filter((e) => /updat/i.test(JSON.stringify(e))), []);
    });
  } finally {
    await app?.close();
    await server.close().catch(() => {});
    await removeDir(dataDir);
    await removeDir(dir); // throwaway keys never leave the temp folder
  }
});

test("updater: default off and not configured without the test endpoint", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows"); return; }
  const app = await launchApp();
  try {
    const r = await app.eval(`__TAURI__.core.invoke("updater_check")`);
    assert.equal(r.status, "not-configured", "no endpoint/pubkey in tauri.conf.json until the repository exists");
    await app.click("#btn-app-menu");
    await app.click(`#app-menu [data-menu-id="settings"]`);
    assert.equal(await app.eval(`document.getElementById("setting-general-checkUpdates").checked`), false, "off by default");
    await app.click("#update-check-now");
    await app.waitFor(`document.querySelector("#update-status")?.dataset.status === "not-configured"`, { timeoutMs: 10000, message: "not configured" });
  } finally {
    await app.close();
  }
});
