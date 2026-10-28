// Q04 through the real IPC of the release binary:
// - the mpv bridge refuses process / script / file / IPC-server commands and pseudo protocols,
//   while the commands the player uses keep working
// - a tiny image claiming a huge size (decompression bomb) is refused at once
// - Settings > General > Cache shows the sizes and clears one kind, keeping a file in use
// - path grants: write / delete / rename / tag / export commands only touch paths the user chose
//   (here: a file handed over on the command line); everything else is refused when the user
//   says no (VHO_GRANT_PROMPT=deny answers the native question)
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";

const J = JSON.stringify;
const invokeErr = (app, cmd, args) =>
  app.eval(`__TAURI__.core.invoke(${J(cmd)}, ${J(args)}).then(() => "OK", (e) => String(e))`);

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}
function pngClaiming(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0))]);
}

test("security: IPC hardening (mpv bridge, decompression bomb, cache clearing)", { timeout: 120000 }, async (t) => {
  const dataDir = await makeDataDir();
  const app = await launchApp({ args: [fixture("sample-h264.mp4")], dataDir });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
    const mpv = await app.eval(`__TAURI__.core.invoke("engine_status").then((s) => !!s.available)`);

    await t.test("mpv bridge: dangerous commands and properties are refused", { skip: !mpv && "libmpv not staged" }, async () => {
      await app.waitFor(`window.__vhoEngine.time > 0.2`, { timeoutMs: 15000, message: "playing" });
      for (const args of [["run", "cmd.exe", "/c", "exit"], ["subprocess", ["cmd.exe"]], ["load-script", "x.lua"], ["screenshot-to-file", join(dataDir, "x.png")], ["quit"]]) {
        assert.match(await invokeErr(app, "engine_command", { args }), /^\[engine-denied\]/, J(args));
      }
      for (const [name, value] of [["input-ipc-server", "\\\\.\\pipe\\vho-e2e"], ["scripts", "x.lua"], ["af", "lavfi=[amovie=x.wav]"], ["vf", "lavfi=[movie=x.png]"]]) {
        assert.match(await invokeErr(app, "engine_set", { name, value }), /^\[engine-denied\]/, name);
      }
      for (const path of ["lavfi://sine", "av://lavfi:sine", "memory://x", "file:///C:/Windows/win.ini"]) {
        assert.match(await invokeErr(app, "engine_load", { path, start: null }), /^\[engine-denied\]/, path);
      }
      assert.equal(existsSync(join(dataDir, "x.png")), false);
      // what the player uses still works
      assert.equal(await invokeErr(app, "engine_command", { args: ["seek", 0.5, "absolute+exact"] }), "OK");
      assert.equal(await invokeErr(app, "engine_set", { name: "af", value: "lavfi=[volume=1.500,alimiter=limit=0.944:attack=5:release=50:level=0]" }), "OK");
      assert.equal(await invokeErr(app, "engine_set", { name: "af", value: "" }), "OK");
      assert.equal(await app.eval(`__TAURI__.core.invoke("engine_get", { name: "pause" }).then((v) => typeof v)`), "boolean");
    });

    await t.test("decompression bomb: refused before any large allocation", async () => {
      const p = join(dataDir, "bomb.png");
      await writeFile(p, pngClaiming(20000, 20000));
      const t0 = Date.now();
      // (photo_decode hands browser-native PNGs to the webview untouched; Chromium has its own limits)
      assert.match(await invokeErr(app, "photo_thumb", { path: p, size: 256 }), /^\[unsupported\]/);
      assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    });

    await t.test("cache: sizes per kind, clearing keeps a file in use", async () => {
      const tc = join(dataDir, "cache", "transcode");
      await mkdir(tc, { recursive: true });
      await writeFile(join(tc, "aaaa.mp4"), Buffer.alloc(300000));
      await writeFile(join(tc, "bbbb.mp4"), Buffer.alloc(200000));
      const usage = await app.eval(`__TAURI__.core.invoke("cache_usage")`);
      assert.deepEqual(usage.map((u) => u.kind), ["photo", "video", "transcode"]);
      assert.ok(usage.find((u) => u.kind === "transcode").bytes >= 500000);
      const held = await open(join(tc, "aaaa.mp4"), "r"); // like the player streaming it
      try {
        const r = await app.eval(`__TAURI__.core.invoke("cache_clear", { kind: "transcode" })`);
        assert.equal(r.removed, 1);
        assert.ok(r.skipped >= 1);
        assert.ok(existsSync(join(tc, "aaaa.mp4")) && !existsSync(join(tc, "bbbb.mp4")));
      } finally {
        await held.close();
      }
      assert.match(await invokeErr(app, "cache_clear", { kind: "../ai" }), /^\[unsupported\]/);
      // Settings > General shows one row and one Clear button per kind
      await app.click("#btn-app-menu");
      await app.click(`#app-menu [data-menu-id="settings"]`);
      await app.waitFor(`document.querySelectorAll(".vho-cache-row").length === 3`, { timeoutMs: 5000, message: "cache rows" });
      assert.equal(await app.eval(`document.querySelectorAll(".vho-cache-row button[aria-describedby]").length`), 3);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
    await removeDir(dataDir);
  }
});

test("security: path grants (Q04) for write / delete / rename / tag / export commands", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vho-grants-"));
  const mine = join(root, "chosen"), other = join(root, "other");
  await mkdir(mine);
  await mkdir(other);
  await copyFile(fixture("photo-a.jpg"), join(mine, "opened.jpg"));
  await copyFile(fixture("photo-a.jpg"), join(mine, "sibling.jpg"));
  await copyFile(fixture("sample-h264.mp4"), join(mine, "clip.mp4"));
  await copyFile(fixture("photo-a.jpg"), join(other, "victim.jpg"));
  await copyFile(fixture("engine-tone.m4a"), join(other, "victim.m4a"));
  // a junction inside the chosen folder that leads to the other one
  execFileSync("cmd", ["/c", "mklink", "/J", join(mine, "link"), other], { stdio: "ignore" });
  const dataDir = await makeDataDir();
  const env = { VHO_GRANT_PROMPT: "deny" };
  let app = await launchApp({ args: [join(mine, "opened.jpg")], dataDir, env });
  const jobErr = (job) => app.eval(`__TAURI__.core.invoke("jobs_submit", { job: ${J(job)} }).then(() => "OK", (e) => e.code ?? String(e))`);
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
    const victim = join(other, "victim.jpg");

    await t.test("outside the chosen folder: every write command is refused, nothing changes", async () => {
      const refused = /^\[path-not-granted\]/;
      assert.match(await invokeErr(app, "file_trash", { path: victim }), refused);
      assert.match(await invokeErr(app, "file_rename", { path: victim, newName: "renamed.jpg" }), refused);
      assert.match(await invokeErr(app, "tags_write", { path: join(other, "victim.m4a"), tags: { title: "x" } }), refused);
      assert.match(await invokeErr(app, "replaygain_analyze", { path: join(other, "victim.m4a"), write: true }), refused);
      assert.match(await invokeErr(app, "tags_save_cover", { path: join(other, "victim.m4a"), output: join(other, "cover.jpg") }), refused);
      assert.match(await invokeErr(app, "media_job", { job: { input: join(mine, "clip.mp4"), outputDir: other, kind: "cut", start: 0, end: 0.5 } }), refused);
      assert.match(await invokeErr(app, "media_job", { job: { input: join(mine, "clip.mp4"), output: join(other, "out.mp4"), kind: "cut", start: 0, end: 0.5 } }), refused);
      assert.match(await invokeErr(app, "photo_batch", { job: { files: [join(mine, "opened.jpg")], ops: [], output: { format: "png", dir: other } } }), refused);
      assert.match(await invokeErr(app, "photo_batch", { job: { files: [victim], ops: [], output: { format: "png", dir: mine, removeSource: true } } }), refused);
      assert.match(await invokeErr(app, "library_playlist_export", { path: join(other, "list.m3u8"), items: [] }), refused);
      assert.match(await invokeErr(app, "library_add_folder", { path: other }), refused);
      assert.equal(await jobErr({ kind: "export", request: { input: join(mine, "clip.mp4"), outputDir: other, kind: "cut", start: 0, end: 0.5 } }), "pathNotGranted");
      assert.equal(await jobErr({ kind: "photo-batch", request: { files: [join(mine, "opened.jpg")], ops: [], output: { format: "png", dir: other } } }), "pathNotGranted");
      for (const f of ["victim.jpg", "victim.m4a"]) assert.ok(existsSync(join(other, f)), f);
      for (const f of ["renamed.jpg", "cover.jpg", "out.mp4", "list.m3u8", "victim.png"]) assert.ok(!existsSync(join(other, f)), f);
    });

    await t.test("escapes: junction, '..', relative and short paths do not leave the grant", async () => {
      const refused = /^\[path-not-granted\]/;
      assert.match(await invokeErr(app, "file_rename", { path: join(mine, "link", "victim.jpg"), newName: "x.jpg" }), refused);
      assert.match(await invokeErr(app, "file_trash", { path: join(mine, "..", "other", "victim.jpg") }), refused);
      assert.match(await invokeErr(app, "photo_batch", { job: { files: [join(mine, "opened.jpg")], ops: [], output: { format: "png", dir: join(mine, "link") } } }), refused);
      assert.match(await invokeErr(app, "file_rename", { path: "other\\victim.jpg", newName: "x.jpg" }), refused);
      assert.ok(existsSync(victim));
    });

    await t.test("the chosen file and its folder: normal actions keep working", async () => {
      const renamed = await app.eval(`__TAURI__.core.invoke("file_rename", { path: ${J(join(mine, "sibling.jpg"))}, newName: "sibling 2.jpg" })`);
      assert.equal(renamed, join(mine, "sibling 2.jpg"));
      const s = await app.eval(`__TAURI__.core.invoke("photo_batch", { job: { files: [${J(join(mine, "opened.jpg"))}], ops: [], output: { format: "png" } } })`);
      assert.equal(s.results[0].ok, true, J(s.results[0]));
      assert.ok(existsSync(join(mine, "opened.png")));
      assert.equal(await invokeErr(app, "library_playlist_export", { path: join(mine, "list.m3u8"), items: [{ path: join(mine, "clip.mp4"), title: "clip" }] }), "OK");
    });
    assert.deepEqual(await app.errors(), []);
    await app.close();

    // grants from the user's own actions survive a restart (backend-owned grants.json)
    app = await launchApp({ dataDir, env });
    await t.test("after a restart: the earlier chosen folder is still granted, the other one not", async () => {
      await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
      assert.equal(await invokeErr(app, "file_rename", { path: join(mine, "sibling 2.jpg"), newName: "sibling 3.jpg" }), "OK");
      assert.match(await invokeErr(app, "file_rename", { path: victim, newName: "renamed.jpg" }), /^\[path-not-granted\]/);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
    await removeDir(dataDir);
    try { execFileSync("cmd", ["/c", "rmdir", join(mine, "link")], { stdio: "ignore" }); } catch { /* already gone */ }
    await removeDir(root);
  }
});
