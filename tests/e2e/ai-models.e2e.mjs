// AI component manager (A01) end to end: Settings > AI models with `test-*` components served
// by a local HTTP fixture server (VHO_AI_TEST_MANIFEST, honoured only with VHO_DATA_DIR).
// No real model is downloaded; the built-in components are only listed and never fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

// CRC-32 (zip entries)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Minimal zip writer: [{ name, data, deflate }] */
function makeZip(items) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const it of items) {
    const payload = it.deflate ? deflateRawSync(it.data) : it.data;
    const name = Buffer.from(it.name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(it.deflate ? 8 : 0, 8);
    head.writeUInt32LE(crc32(it.data), 14); head.writeUInt32LE(payload.length, 18); head.writeUInt32LE(it.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, payload);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(it.deflate ? 8 : 0, 10);
    c.writeUInt32LE(crc32(it.data), 16); c.writeUInt32LE(payload.length, 20); c.writeUInt32LE(it.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + payload.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Fixture server: ETag + Range/If-Range, optional throttling / one cut response / outage. */
function startServer(files) {
  const log = [];
  const slow = new Set();
  const cutOnce = new Set();
  const server = createServer((req, res) => {
    const path = req.url;
    log.push({ path, range: req.headers.range ?? null });
    const body = files.get(path);
    if (!body) { res.writeHead(404, { "Content-Length": 0 }); res.end(); return; }
    const etag = `"${sha(body).slice(0, 16)}"`;
    let start = 0;
    const headers = { ETag: etag, "Accept-Ranges": "bytes", Connection: "close" };
    let status = 200;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
      start = Math.min(Number(m[1]), body.length);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }
    const part = body.subarray(start);
    headers["Content-Length"] = part.length;
    res.writeHead(status, headers);
    if (cutOnce.delete(path)) {
      res.write(part.subarray(0, part.length >> 1), () => req.socket.destroy());
      return;
    }
    if (!slow.has(path)) { res.end(part); return; }
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      const chunk = part.subarray(i, i + 32 * 1024);
      i += chunk.length;
      if (!chunk.length) { clearInterval(timer); res.end(); return; }
      res.write(chunk);
    }, 30);
    res.on("close", () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    log, slow, cutOnce,
    requests: (p) => log.filter((l) => l.path === p),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

const component = (id, downloads, extra = {}) => ({
  id, version: "v1", task: "test", title: `Test ${id}`, author: "VHO E2E", license: "CC0-1.0", source: "local",
  downloads, ...extra,
});
const fileDl = (base, path, name, data) => ({ url: base + path, sha256: sha(data), bytes: data.length, name });

test("ai models: settings list, download, verify/repair, remove, zip, cancel, errors", { timeout: 240000 }, async (t) => {
  const model = randomBytes(1_500_000);
  const slowData = randomBytes(8_000_000);
  const cutData = randomBytes(2_000_000);
  const good = randomBytes(300_000);
  const evil = Buffer.from(good); evil[77] ^= 0xff;
  const net = randomBytes(200_000);
  const weights = randomBytes(700_000);
  const pack = makeZip([
    { name: "pack/net.onnx", data: net, deflate: true },
    { name: "pack/net.data", data: weights, deflate: false },
    { name: "../evil.txt", data: Buffer.from("never written"), deflate: false },
  ]);
  const files = new Map([
    ["/model.bin", model], ["/slow.bin", slowData], ["/cut.bin", cutData], ["/bad.bin", evil], ["/pack.zip", pack],
  ]);
  const srv = await startServer(files);
  srv.slow.add("/slow.bin");
  srv.cutOnce.add("/cut.bin");

  const manifest = [
    component("test-model", [fileDl(srv.base, "/model.bin", "model.bin", model)]),
    component("test-slow", [fileDl(srv.base, "/slow.bin", "slow.bin", slowData)]),
    component("test-cut", [fileDl(srv.base, "/cut.bin", "cut.bin", cutData)]),
    component("test-bad", [{ ...fileDl(srv.base, "/bad.bin", "bad.bin", good) }]),
    component("test-pack", [{
      url: `${srv.base}/pack.zip`, sha256: sha(pack), bytes: pack.length,
      extract: [
        { entry: "pack/net.onnx", name: "net.onnx", sha256: sha(net), bytes: net.length },
        { entry: "pack/net.data", name: "net.data", sha256: sha(weights), bytes: weights.length },
      ],
    }], { externalData: [{ model: "net.onnx", data: "net.data" }] }),
  ];
  const manifestDir = await mkdtemp(join(tmpdir(), "vho-e2e-aimanifest-"));
  const manifestPath = join(manifestDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const dataDir = await makeDataDir();
  const compDir = (id) => join(dataDir, "ai", id, "v1");
  const parts = (id) => (existsSync(compDir(id)) ? readdirSync(compDir(id)).filter((f) => f.includes(".part")) : []);

  const app = await launchApp({
    args: [fixture("photo-a.jpg")],
    dataDir,
    env: { VHO_AI_TEST_MANIFEST: manifestPath, VHO_AI_TEST_BACKOFF_MS: "50", VHO_AI_TEST_STALL_MS: "4000" },
  });
  const row = (id) => `#ai-model-list [data-component="${id}"]`;
  const rowState = (id) => app.eval(`document.querySelector(${JSON.stringify(row(id))})?.dataset.state ?? null`);
  const waitState = (id, state, timeoutMs = 30000) => app.waitFor(
    `document.querySelector(${JSON.stringify(row(id))})?.dataset.state === ${JSON.stringify(state)}`, { timeoutMs, message: `${id} ${state}` });
  const press = (id, action) => app.click(`${row(id)} [data-action="${action}"]`);
  const rowError = (id) => app.eval(`document.querySelector(${JSON.stringify(`${row(id)} .vho-ai-model-error`)})?.dataset.code ?? ""`);
  const backendState = (id) => app.eval(`__TAURI__.core.invoke("ai_status", { id: ${JSON.stringify(id)} }).then((s) => s.state)`);
  const waitBackend = async (id, state) => {
    for (let i = 0; i < 100; i++) {
      if ((await backendState(id)) === state) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`${id} never reached ${state}`);
  };

  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });

    await t.test("first use of photo AI asks with size, author and license (no download on 'no')", async () => {
      await app.waitFor(`document.getElementById("image-element").naturalWidth === 640`, { timeoutMs: 10000, message: "photo shown" });
      await app.click("#btn-deep-enhance");
      const msg = await app.waitFor(`window.__confirms.length && window.__confirms.at(-1)`, { timeoutMs: 8000, message: "consent dialog" });
      for (const s of ["ONNX Runtime Web", "Microsoft, MIT", "Philip Hofmann, CC-BY-4.0", "Tencent ARC", "MB", "Ayarlar > AI modelleri"]) {
        assert.ok(msg.includes(s), `consent mentions ${s}: ${msg}`);
      }
      assert.equal(await backendState("photo-x4"), "missing", "declined: nothing downloaded");
      assert.ok(!existsSync(join(dataDir, "ai", "photo-x4", "rwp4-95e9cd5", "4xRealWebPhoto_v4_fp32_opset17.onnx")));
    });

    await t.test("settings tab lists every component with license, author and size before download", async () => {
      await app.click("#btn-app-menu");
      await app.click(`#app-menu [data-menu-id="settings"]`);
      await app.click("#settings-tab-components");
      assert.equal(await app.text("#settings-tab-components"), "AI modelleri");
      await app.waitFor(`document.getElementById("ai-model-list")?.dataset.loaded === "1"`, { timeoutMs: 8000, message: "list loaded" });
      const ids = await app.eval(`[...document.querySelectorAll("#ai-model-list [data-component]")].map((r) => r.dataset.component)`);
      assert.deepEqual(ids, ["ort-web", "photo-x4", "face-restore", "test-model", "test-slow", "test-cut", "test-bad", "test-pack"]);
      const photo = await app.text(row("photo-x4"));
      for (const s of ["4xRealWebPhoto v4 (DAT-2)", "Philip Hofmann", "CC-BY-4.0", "46.5 MB", "İndirilmedi"]) assert.ok(photo.includes(s), `${s} in ${photo}`);
      assert.equal(await rowState("test-model"), "missing");
      assert.deepEqual(await app.eval(`[...document.querySelectorAll(${JSON.stringify(`${row("test-model")} [data-action]`)})].map((b) => b.dataset.action)`), ["install"]);
    });

    await t.test("download -> verified, final name only after the hash, no part files", async () => {
      await press("test-model", "install");
      await waitState("test-model", "ready");
      assert.equal(sha(readFileSync(join(compDir("test-model"), "model.bin"))), sha(model));
      assert.deepEqual(parts("test-model"), []);
      assert.equal(srv.requests("/model.bin").length, 1);
    });

    await t.test("same-size damage on disk: verify finds it, repair downloads only that file", async () => {
      const p = join(compDir("test-model"), "model.bin");
      const damaged = Buffer.from(model); damaged[1000] ^= 1;
      writeFileSync(p, damaged);
      await press("test-model", "verify");
      await waitState("test-model", "corrupt");
      assert.ok((await app.text(row("test-model"))).includes("model.bin"), "damaged file named");
      await press("test-model", "repair");
      await waitState("test-model", "ready");
      assert.equal(sha(readFileSync(p)), sha(model));
      assert.equal(srv.requests("/model.bin").length, 2);
    });

    await t.test("remove deletes the component folder (after confirmation)", async () => {
      await app.eval(`window.__realConfirmStub = window.confirm; window.confirm = (m) => { __confirms.push(String(m)); return true; }`);
      try {
        await press("test-model", "remove");
        await waitState("test-model", "missing");
      } finally {
        await app.eval(`window.confirm = window.__realConfirmStub`);
      }
      assert.ok(!existsSync(join(dataDir, "ai", "test-model")));
    });

    await t.test("zip: listed entries extracted and hashed, archive deleted, traversal entry ignored", async () => {
      await press("test-pack", "install");
      await waitState("test-pack", "ready");
      assert.deepEqual(readdirSync(compDir("test-pack")).sort(), ["net.data", "net.onnx"]);
      assert.equal(sha(readFileSync(join(compDir("test-pack"), "net.data"))), sha(weights));
      assert.ok(!existsSync(join(dataDir, "ai", "evil.txt")) && !existsSync(join(dataDir, "evil.txt")) && !existsSync(join(dataDir, "ai", "test-pack", "evil.txt")));
    });

    await t.test("cancel reaches the download: no part file, nothing installed", async () => {
      await press("test-slow", "install");
      await app.waitFor(`!document.querySelector(${JSON.stringify(`${row("test-slow")} .vho-ai-model-progress`)}).hidden`, { timeoutMs: 15000, message: "progress shown" });
      await press("test-slow", "cancel");
      await app.waitFor(`document.querySelector(${JSON.stringify(`${row("test-slow")} .vho-ai-model-error`)})?.dataset.code === "cancelled"`, { timeoutMs: 10000, message: "cancelled shown" });
      await waitBackend("test-slow", "missing");
      assert.deepEqual(parts("test-slow"), []);
      assert.ok(!existsSync(join(compDir("test-slow"), "slow.bin")));
    });

    await t.test("wrong hash is a coded checksum error, never installed, not retried", async () => {
      await press("test-bad", "install");
      await app.waitFor(`document.querySelector(${JSON.stringify(`${row("test-bad")} .vho-ai-model-error`)})?.dataset.code === "checksum"`, { timeoutMs: 15000, message: "checksum error" });
      assert.equal(await rowError("test-bad"), "checksum");
      assert.ok((await app.text(`${row("test-bad")} .vho-ai-model-error`)).includes("SHA-256"));
      assert.equal(await rowState("test-bad"), "missing");
      assert.equal(srv.requests("/bad.bin").length, 1);
      assert.deepEqual(parts("test-bad"), []);
    });

    await t.test("interrupted connection is resumed with Range", async () => {
      await press("test-cut", "install");
      await waitState("test-cut", "ready");
      const reqs = srv.requests("/cut.bin");
      assert.equal(reqs.length, 2);
      assert.match(reqs[1].range ?? "", /^bytes=\d+-$/);
      assert.equal(sha(readFileSync(join(compDir("test-cut"), "cut.bin"))), sha(cutData));
    });

    await t.test("English texts", async () => {
      await app.eval(`(() => { const el = document.getElementById("setting-general-language"); el.value = "en"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await app.waitFor(`document.getElementById("settings-tab-components").textContent === "AI models"`, { timeoutMs: 5000, message: "English tab" });
      await app.click("#settings-tab-components");
      await app.waitFor(`document.querySelector(${JSON.stringify(row("test-cut"))})?.textContent.includes("Ready (verified)")`, { timeoutMs: 8000, message: "English state" });
      await app.eval(`(() => { const el = document.getElementById("setting-general-language"); el.value = "tr"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    });

    assert.deepEqual(await app.errors(), []);
    assert.deepEqual(await app.blockedCalls(), []);
    // the built-in models were never requested from the internet: only the fixture server served files
    assert.ok(srv.log.every((l) => files.has(l.path)));
  } finally {
    await app.close();
    await srv.close();
    await removeDir(dataDir);
    await removeDir(manifestDir);
  }
});
