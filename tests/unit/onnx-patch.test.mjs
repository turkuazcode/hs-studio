// fixOutputDimNames against a small hand-built ONNX ModelProto fragment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixOutputDimNames, readVarint, lenFields } from "../../src/media/onnx-patch.js";

// ---- tiny protobuf encoder (just what ModelProto needs) ----
const varint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const key = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, payload) => [...key(field, 2), ...varint(payload.length), ...payload];
const strField = (field, s) => bytesField(field, [...new TextEncoder().encode(s)]);
const intField = (field, v) => [...key(field, 0), ...varint(v)];

/** Dimension: dim_value (1) or dim_param (2) */
const dim = (d) => bytesField(1, typeof d === "number" ? intField(1, d) : strField(2, d));
/** ValueInfoProto { name, type { tensor_type { elem_type = FLOAT, shape } } } */
const valueInfo = (name, dims) => [
  ...strField(1, name),
  ...bytesField(2, bytesField(1, [...intField(1, 1), ...bytesField(2, dims.flatMap(dim))])),
];

function model({ inputDims, outputDims, docString = "" }) {
  const graph = [
    ...strField(2, "graph"),
    ...bytesField(11, valueInfo("input", inputDims)),
    ...bytesField(12, valueInfo("output", outputDims)),
  ];
  return Uint8Array.from([
    ...intField(1, 8),                                 // ir_version
    ...(docString ? strField(6, docString) : []),      // doc_string
    ...bytesField(7, graph),                           // graph
    ...bytesField(8, [...strField(1, ""), ...intField(2, 17)]), // opset_import
  ]);
}

const text = (bytes) => new TextDecoder().decode(bytes);

test("varint reader handles multi-byte values", () => {
  assert.deepEqual(readVarint(Uint8Array.from(varint(300)), 0), [300, 2]);
  assert.deepEqual(readVarint(Uint8Array.from(varint(2 ** 40)), 0), [2 ** 40, 6]);
});

test("renames only the output's spatial dim params, same byte length", () => {
  const input = model({ inputDims: ["batch", 3, "height", "width"], outputDims: ["batch", 3, "height", "width"] });
  const { bytes, patched } = fixOutputDimNames(input.buffer.slice(0));
  assert.equal(patched, 2);
  assert.equal(bytes.length, input.length);
  const s = text(bytes);
  assert.ok(s.includes("oeight") && s.includes("oidth"));
  // input dims untouched: "height"/"width" still present exactly once (input), "batch" twice
  assert.equal(s.split("height").length - 1, 1);
  assert.equal(s.split("width").length - 1, 1);
  assert.equal(s.split("batch").length - 1, 2);
  let diff = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== input[i]) diff++;
  assert.equal(diff, 2); // one byte per renamed dim
});

test("numeric output dims are left alone", () => {
  const input = model({ inputDims: [1, 3, "h", "w"], outputDims: [1, 3, 512, 512] });
  const { bytes, patched } = fixOutputDimNames(input);
  assert.equal(patched, 0);
  assert.deepEqual([...bytes], [...input]);
});

test("does not modify the caller's buffer (works on a copy)", () => {
  const input = model({ inputDims: ["b", 3, "height", "width"], outputDims: ["b", 3, "height", "width"] });
  const before = [...input];
  fixOutputDimNames(input);
  assert.deepEqual([...input], before);
});

test("walks past long fields (multi-byte length varints)", () => {
  const input = model({ inputDims: ["b", 3, "height", "width"], outputDims: ["b", 3, "height", "width"], docString: "x".repeat(400) });
  const { patched } = fixOutputDimNames(input);
  assert.equal(patched, 2);
});

test("lenFields skips fixed64/fixed32 fields and rejects group wire types", () => {
  const msg = Uint8Array.from([...key(1, 1), 1, 2, 3, 4, 5, 6, 7, 8, ...key(2, 5), 1, 2, 3, 4, ...strField(3, "ok")]);
  const fields = [...lenFields(msg, 0, msg.length)];
  assert.deepEqual(fields.map((f) => f.field), [3]);
  assert.throws(() => [...lenFields(Uint8Array.from(key(1, 3)), 0, 1)], /wire type 3/);
});
