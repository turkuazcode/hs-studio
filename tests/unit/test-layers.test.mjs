// Q01: the unit layer stays network-free and fast, and the real-AI smoke fixtures are intact.
// Runs under the network guard preloaded by scripts/run-tests.mjs (npm test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { request } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRgb, decodePng, encodePng, makeFixture } from "../ai/lib/image.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The URLs the app downloads its AI components from (src-tauri/src/ai/manifest.rs)
const MANIFEST = readFileSync(join(ROOT, "src-tauri/src/ai/manifest.rs"), "utf8");
const MODEL_URL = "https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2/resolve/95e9cd50553951c27d86bafbdc1bc27ca8e750d2/4xRealWebPhoto_v4_fp32_opset17.onnx";

test("unit layer runs under the network guard (npm test)", () => {
  assert.ok(globalThis.__vhoNetworkGuard, "tests/lib/no-network.mjs is not preloaded: run the unit layer with npm test");
});

test("a real model download cannot start in the unit layer (fetch, https, raw socket)", async () => {
  assert.ok(MANIFEST.includes("4xRealWebPhoto_v4_fp32_opset17.onnx") && MANIFEST.includes("huggingface.co/Phips/4xRealWebPhoto_v4_dat2"),
    "manifest changed: update MODEL_URL");
  const before = globalThis.__vhoNetworkGuard.blocked.length;
  await assert.rejects(fetch(MODEL_URL, { signal: AbortSignal.timeout(5000) }), (e) =>
    (e.cause ?? e).code === "ERR_VHO_NETWORK_BLOCKED");
  await assert.rejects(new Promise((res, rej) => {
    const req = request("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs", res);
    req.on("error", rej);
    req.end();
  }), { code: "ERR_VHO_NETWORK_BLOCKED" });
  const { connect } = await import("node:net");
  await assert.rejects(new Promise((res, rej) => connect(443, "93.184.215.14").on("connect", res).on("error", rej)),
    { code: "ERR_VHO_NETWORK_BLOCKED" });
  assert.equal(globalThis.__vhoNetworkGuard.blocked.length, before + 3);
});

test("loopback stays available for local fixture servers", async () => {
  const { createServer } = await import("node:http");
  const srv = createServer((_, res) => res.end("ok"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text();
    assert.equal(body, "ok");
  } finally {
    srv.close();
  }
});

test("no unit test launches the app or the real-model layer", () => {
  const self = fileURLToPath(import.meta.url).split(/[\\/]/).pop();
  for (const f of readdirSync(join(ROOT, "tests/unit")).filter((n) => n.endsWith(".mjs") && n !== self)) {
    const src = readFileSync(join(ROOT, "tests/unit", f), "utf8");
    assert.ok(!/launchApp|e2e\/lib\/app\.mjs|ai_install|\.ai\.mjs/.test(src), `${f} reaches into the app / AI layer`);
  }
});

test("AI smoke fixture: committed PNG equals the generated synthetic image; PNG round trip", () => {
  const committed = decodePng(readFileSync(join(ROOT, "tests/ai/fixtures/smoke-44x28.png")));
  const gen = makeFixture();
  assert.equal(committed.width, 44);
  assert.equal(committed.height, 28);
  assert.deepEqual(Buffer.from(committed.data), Buffer.from(gen.data));
  const again = decodePng(encodePng(gen));
  assert.deepEqual(Buffer.from(again.data), Buffer.from(gen.data));
  const alphas = new Set();
  for (let i = 3; i < gen.data.length; i += 4) alphas.add(gen.data[i]);
  assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 128, 255]);
});

test("AI smoke reference: x4 size of the fixture; compareRgb measures differences", () => {
  const ref = decodePng(readFileSync(join(ROOT, "tests/ai/fixtures/photo-x4-ref.png")));
  assert.equal(ref.width, 44 * 4);
  assert.equal(ref.height, 28 * 4);
  const same = compareRgb(ref, ref);
  assert.equal(same.maxAbs, 0);
  const shifted = { ...ref, data: ref.data.map((v, i) => (i % 4 === 3 ? v : Math.min(255, v + 2))) };
  const d = compareRgb(ref, shifted);
  assert.ok(d.meanAbs > 1.5 && d.meanAbs <= 2 && d.maxAbs === 2 && d.p999 === 2);
});

test("E2E harness derives the same test identity as platform.rs (vector shared with the Rust test)", async () => {
  const { testIdentity } = await import("../e2e/lib/app.mjs");
  // src-tauri/src/platform.rs tests::test_identifier_matches_the_e2e_harness: same hash, the
  // prefix is the app identifier from tauri.conf.json
  const expected = "com.turkuazcode.hsstudio.test784bc84e15c2ff8b";
  assert.equal(testIdentity(String.raw`C:\Users\Test\AppData\Local\Temp\vho-e2e-ABC\vho-data`), expected);
  // case-insensitive like the Rust side (to_lowercase before hashing)
  assert.equal(testIdentity(String.raw`C:\USERS\TEST\APPDATA\LOCAL\TEMP\VHO-E2E-ABC\VHO-DATA`), expected);
});

test("clean-test-artifacts only matches exact test identities, never the user's app folder", async () => {
  const { TEST_ID, PACKAGE_TEST_ID } = await import("../lib/test-identity.mjs");
  const match = (n) => TEST_ID.test(n) || PACKAGE_TEST_ID.test(n);
  assert.ok(match("com.vho.app.test784bc84e15c2ff8b"));
  assert.ok(match("com.turkuazcode.hsstudio.test784bc84e15c2ff8b"));
  assert.ok(match("com.vho.app.packagetest"));
  assert.ok(match("com.hsstudio.app.packagetest"));
  for (const n of ["com.turkuazcode.hsstudio", "com.turkuazcode.hsstudio.test", "com.turkuazcode.hsstudio.packagetest",
    "com.turkuazcode.hsstudio.test784bc84e15c2ff8b.migrating-12", "com.vho.app", "com.vho.app.test", "com.vho.app.test784bc84e15c2ff8", "com.vho.app.test784BC84E15C2FF8B",
    "com.vho.app.test784bc84e15c2ff8b.bak", "com.vho.mpvspike", "x.com.vho.app.test784bc84e15c2ff8b", "com.vho.app.testing"]) {
    assert.ok(!match(n), n);
  }
});
