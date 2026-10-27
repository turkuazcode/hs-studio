// Capability matrix (P01) as used by the S04 naming/visibility rules, and the booster limiter chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cap, createCapabilities, frontendCapabilities, mergeCapabilities } from "../../src/core/capabilities.js";
import { LAVFI_LIMITER, audioFilterChain } from "../../src/media/engine/engine.js";
import { LIMITER_CEILING, LIMITER_PARAMS, softClipCurve, volumeToGain } from "../../src/media/audio-engine.js";

const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e]));

test("capability entries carry the platform contract fields", () => {
  for (const e of frontendCapabilities({ engineKind: "html5", webgl2: true })) {
    assert.deepEqual(Object.keys(e).sort(), ["available", "id", "implementation", "reasonCode", "support", "verified"]);
    assert.ok(["supported-tested", "supported-untested", "unsupported"].includes(e.support), e.id);
  }
  assert.equal(cap("x", false).reasonCode, "unavailable");
  assert.equal(cap("x", true).reasonCode, null);
});

test("A/B comparison and the GPU filter: only with HTML5 + WebGL2", () => {
  const html5 = byId(frontendCapabilities({ engineKind: "html5", webgl2: true }));
  assert.equal(html5["video.compare"].available, true);
  assert.equal(html5["video.compare"].implementation, "webgl2");
  const mpv = byId(frontendCapabilities({ engineKind: "mpv", webgl2: true }));
  assert.equal(mpv["video.compare"].available, false);
  assert.equal(mpv["video.compare"].reasonCode, "engine-mpv");
  assert.equal(mpv["video.gpuFilter"].reasonCode, "engine-mpv");
  assert.equal(mpv["video.colorFilter"].implementation, "libmpv");
  const noGl = byId(frontendCapabilities({ engineKind: "html5", webgl2: false }));
  assert.equal(noGl["video.compare"].reasonCode, "no-webgl2");
  assert.equal(noGl["video.colorFilter"].implementation, "css");
});

test("video restoration is never offered as ready; photo AI needs the desktop backend", () => {
  for (const engineKind of ["mpv", "html5"]) {
    const c = byId(frontendCapabilities({ engineKind, webgl2: true, webgpu: true, platform: { verifiedPlatform: true } }));
    assert.equal(c["video.aiRestore"].available, false);
    assert.equal(c["video.aiRestore"].reasonCode, "not-ready");
    assert.equal(c["video.aiRestore"].support, "unsupported");
  }
  const browser = byId(frontendCapabilities({ webgpu: true }));
  assert.equal(browser["photo.aiEnhance"].available, false);
  assert.equal(browser["photo.aiEnhance"].reasonCode, "no-backend");
  const desk = byId(frontendCapabilities({ webgpu: false, platform: { verifiedPlatform: false } }));
  assert.equal(desk["photo.aiEnhance"].implementation, "onnx-wasm");
  assert.equal(desk["photo.aiEnhance"].verified, false);
  assert.equal(desk["photo.aiEnhance"].reasonCode, "model-download-on-first-use");
});

test("verified is set only on a platform with real-device evidence", () => {
  const unverified = frontendCapabilities({ engineKind: "html5", webgl2: true, platform: { verifiedPlatform: false } });
  assert.ok(unverified.every((e) => e.verified === false));
  const verified = byId(frontendCapabilities({ engineKind: "html5", webgl2: true, platform: { verifiedPlatform: true } }));
  assert.equal(verified["video.compare"].verified, true);
  assert.equal(verified["video.aiRestore"].verified, false);
});

test("createCapabilities follows the current engine; front end overrides backend", () => {
  let kind = "html5";
  const caps = createCapabilities({
    engineKind: () => kind, webgl2: () => true, webgpu: false,
    backend: { platform: { os: "windows", verifiedPlatform: true }, entries: [cap("video.compare", false), cap("engine.libmpv", true, "libmpv")] },
  });
  assert.equal(caps.isAvailable("video.compare"), true);
  assert.equal(caps.isAvailable("engine.libmpv"), true);
  kind = "mpv";
  assert.equal(caps.get("video.compare").reasonCode, "engine-mpv");
  assert.equal(caps.get("nope").reasonCode, "unknown");
  assert.equal(mergeCapabilities([cap("a", true)], null, [cap("a", false)]).get("a").available, false);
});

test("booster: libmpv chain ends in a limiter whenever a stage can raise the level", () => {
  assert.equal(audioFilterChain({ boost: 1 }), "");
  const b = audioFilterChain({ boost: volumeToGain(200) });
  assert.equal(b, `lavfi=[volume=2.500,${LAVFI_LIMITER}]`);
  assert.match(LAVFI_LIMITER, /^alimiter=limit=0\.891:.*level=0$/);
  // the limiter is the very last stage, after EQ / compressor / normaliser
  const all = audioFilterChain({ eq: [3], normalize: true, restore: { voice: true, compressor: true }, boost: 1.75 });
  assert.ok(all.endsWith(`volume=1.750,${LAVFI_LIMITER}]`), all);
  assert.equal(all.split("alimiter").length - 1, 1);
  // voice band alone (+5.5 dB) also gets the limiter; cuts only do not
  assert.ok(audioFilterChain({ restore: { voice: true } }).includes("alimiter"));
  assert.ok(!audioFilterChain({ restore: { denoise: true, compressor: true } }).includes("alimiter"));
  assert.deepEqual(LIMITER_PARAMS, { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
});

test("booster: HTML5 soft-clip safety stage never reaches full scale, is transparent below the knee", () => {
  const c = softClipCurve(2049);
  const n = c.length;
  let max = 0;
  for (const v of c) max = Math.max(max, Math.abs(v));
  assert.ok(max < LIMITER_CEILING && max > 0.9, `max ${max}`);
  // curve index for a signal x (after the 0.5 pre-gain): i = (x/2 + 1) / 2 * (n - 1)
  const at = (x) => c[Math.round(((x / 2 + 1) / 2) * (n - 1))];
  for (const x of [0, 0.25, 0.5, -0.7]) assert.ok(Math.abs(at(x) - x) < 0.003, `identity at ${x}: ${at(x)}`);
  for (let i = 1; i < n; i++) assert.ok(c[i] >= c[i - 1], "monotonic");
});
