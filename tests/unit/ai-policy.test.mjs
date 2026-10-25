// AI resource policy (Plan 11/A03): error classes, backend/tile fallback (smaller tiles only for
// memory errors, no CPU retry of a broken model), memory budget without silent shrinking,
// measured ETA, one heavy job at a time, the probe model's protobuf, the AI job request.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OUTPUT_PIXELS, classifyAiError, createSlot, deviceKey, errorCodeForClass, estimateBytes, etaSeconds, memoryBudget,
  nextAttempt, planInput,
} from "../../src/media/ai-policy.js";
import { PROBE_SHAPE, probeData, probeModel } from "../../src/media/onnx-tiny.js";
import { enhanceFraction, photoEnhanceRequest } from "../../src/media/ai-jobs.js";

test("ai policy: error classes", () => {
  const c = (m) => classifyAiError(new Error(m));
  assert.equal(c("Failed to allocate GPU buffer: out of memory"), "memory");
  assert.equal(c("Failed to load model: RangeError: Array buffer allocation failed"), "memory");
  assert.equal(c("WebAssembly: memory access out of bounds"), "memory");
  assert.equal(c("GPUDevice was lost: device lost"), "device");
  assert.equal(c("AI worker crashed: "), "device");
  assert.equal(c("Failed to load model: no available backend found. ERR: [webgpu] backend not found."), "backend");
  assert.equal(c("Failed to load model: failed to parse protobuf"), "model");
  assert.equal(c("Failed to load model: Can't create a session"), "model");
  assert.equal(c("Got invalid dimensions for input: x for the following indices"), "input");
  assert.equal(c("something odd"), "other");
  assert.equal(classifyAiError(new DOMException("x", "AbortError")), "cancelled");
  assert.equal(errorCodeForClass("memory"), "memory");
  assert.equal(errorCodeForClass("model"), "modelFailed");
  assert.equal(errorCodeForClass("other"), "failed");
});

test("ai policy: fallback order (tiles only for memory, no CPU retry of a broken model)", () => {
  const steps = { webgpu: [128, 96, 64, 48], wasm: [128, 96, 64] };
  let st = { order: ["webgpu", "wasm"], b: 0, ti: 0, steps, deviceRetries: 0 };
  // memory: 128 -> 96 -> 64 -> 48 on the GPU, then the CPU at its first tile
  const seen = [];
  while (st) {
    seen.push(`${st.order[st.b]}/${steps[st.order[st.b]][st.ti]}`);
    st = nextAttempt(st, "memory");
  }
  assert.deepEqual(seen, ["webgpu/128", "webgpu/96", "webgpu/64", "webgpu/48", "wasm/128", "wasm/96", "wasm/64"]);
  // the CPU starts at the tile that worked last time on this device
  const s0 = { order: ["webgpu", "wasm"], b: 0, ti: 3, steps, deviceRetries: 0 };
  assert.deepEqual(nextAttempt(s0, "memory", (b) => (b === "wasm" ? 2 : 0)), { ...s0, b: 1, ti: 2 });
  // device lost / worker crash: the same attempt once more, then the next backend
  const d1 = nextAttempt(s0, "device");
  assert.deepEqual([d1.b, d1.ti, d1.deviceRetries], [0, 3, 1]);
  assert.deepEqual([nextAttempt(d1, "device").b, nextAttempt(d1, "device").deviceRetries], [1, 0]);
  // backend / unknown error: next backend; nothing left after the CPU
  assert.equal(nextAttempt(s0, "backend").b, 1);
  assert.equal(nextAttempt({ ...s0, b: 1 }, "other"), null);
  // model / input / cancelled: stop (not re-run on the CPU)
  for (const cls of ["model", "input", "cancelled"]) assert.equal(nextAttempt(s0, cls), null, cls);
});

test("ai policy: memory budget, planned input, no silent shrinking", () => {
  assert.equal(memoryBudget(8), 2048 * 1048576);
  assert.equal(memoryBudget(0.5), 512 * 1048576, "floor");
  assert.equal(memoryBudget(undefined), 1024 * 1048576, "unknown device memory = 4 GB");
  const small = planInput(640, 480, 4, { budget: memoryBudget(8) });
  assert.deepEqual([small.width, small.height, small.outWidth, small.outHeight, small.downscaled], [640, 480, 2560, 1920, false]);
  const big = planInput(6000, 4000, 4, { budget: memoryBudget(8) });
  assert.equal(big.downscaled, true);
  assert.ok(big.outWidth * big.outHeight <= MAX_OUTPUT_PIXELS);
  assert.ok(big.bytes <= big.budget, "fits the budget");
  assert.ok(Math.abs(big.width / big.height - 1.5) < 0.01, "aspect kept");
  // a small device budget shrinks further than the pixel cap
  const tight = planInput(6000, 4000, 4, { budget: memoryBudget(2) });
  assert.ok(tight.width < big.width && tight.bytes <= tight.budget);
  assert.equal(estimateBytes(10, 10, 4), 10 * 10 * 8 + 1600 * 16);
});

test("ai policy: ETA only from measurements", () => {
  assert.equal(etaSeconds({ fraction: 0.01, elapsed: 3 }), null, "too early, no rate");
  assert.equal(etaSeconds({ fraction: 0.25, elapsed: 10 }), 30);
  assert.equal(etaSeconds({ fraction: 0, pixels: 1000, rate: 100 }), 10);
  assert.equal(etaSeconds({}), null);
  assert.equal(deviceKey({ vendor: "amd", architecture: "rdna-2" }), "amd/rdna-2");
  assert.equal(deviceKey(null), "unknown");
});

test("ai policy: one heavy AI job at a time (FIFO slot)", async () => {
  const slot = createSlot();
  const log = [];
  const job = async (name, ms) => {
    const release = await slot.acquire();
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${name}`);
    release();
    release(); // double release is harmless
  };
  await Promise.all([job("a", 20), job("b", 1), job("c", 1)]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(slot.waiting, 0);
});

/** Minimal protobuf reader: [field, wire, value] triples (varints as numbers, bytes as Uint8Array). */
function readProto(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return Number(v);
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const k = varint();
    const field = k >> 3;
    const wire = k & 7;
    if (wire === 0) out.push([field, wire, varint()]);
    else if (wire === 2) {
      const len = varint();
      out.push([field, wire, buf.subarray(i, i + len)]);
      i += len;
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}
const str = (u8) => new TextDecoder().decode(u8);

test("probe model: valid ModelProto y = Add(x, x), opset 13, float [1,3,8,8]", () => {
  const m = readProto(probeModel());
  assert.deepEqual(m.find(([f]) => f === 1).slice(2), [8], "ir_version 8");
  const opset = readProto(m.find(([f]) => f === 8)[2]);
  assert.equal(opset.find(([f]) => f === 2)[2], 13);
  const graph = readProto(m.find(([f]) => f === 7)[2]);
  const node = readProto(graph.find(([f]) => f === 1)[2]);
  assert.deepEqual(node.filter(([f]) => f === 1).map(([, , v]) => str(v)), ["x", "x"]);
  assert.equal(str(node.find(([f]) => f === 2)[2]), "y");
  assert.equal(str(node.find(([f]) => f === 4)[2]), "Add");
  for (const [field, name] of [[11, "x"], [12, "y"]]) {
    const vi = readProto(graph.find(([f]) => f === field)[2]);
    assert.equal(str(vi.find(([f]) => f === 1)[2]), name);
    const tensor = readProto(readProto(vi.find(([f]) => f === 2)[2])[0][2]);
    assert.equal(tensor.find(([f]) => f === 1)[2], 1, "FLOAT");
    const dims = readProto(tensor.find(([f]) => f === 2)[2]).map(([, , d]) => readProto(d)[0][2]);
    assert.deepEqual(dims, PROBE_SHAPE);
  }
  const { input, expected } = probeData();
  assert.equal(input.length, 192);
  assert.ok(expected.every((v, i) => v === input[i] * 2));
  assert.ok(new Set(input).size > 50, "varied input");
});

test("AI photo job request and progress mapping", () => {
  assert.deepEqual(photoEnhanceRequest({ path: "C:\\a.jpg", faces: true, inputWidth: 10, inputHeight: 8 }), {
    input: "C:\\a.jpg", components: ["ort-web", "photo-x4", "face-restore"], model: "photo-x4", faces: true, inputWidth: 10, inputHeight: 8,
  });
  assert.deepEqual(photoEnhanceRequest({ path: "a.png", inputWidth: 1, inputHeight: 1 }).components, ["ort-web", "photo-x4"]);
  assert.equal(enhanceFraction("download", 0.5, false), 0);
  assert.equal(enhanceFraction("run", 0.5, false), 0.5);
  assert.equal(enhanceFraction("run", 1, true), 0.8);
  assert.ok(Math.abs(enhanceFraction("faces", 0.5, true) - 0.9) < 1e-9);
});
