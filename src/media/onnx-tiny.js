// ==========================================================================
// A tiny ONNX model built in memory (Plan 11/A03 backend probe): y = x + x for a float32
// [1, 3, 8, 8] input. Running it on an execution provider proves the backend can create a
// session and run a kernel on this device — the GPU name or reported memory is not evidence.
// Hand-written protobuf (ModelProto / GraphProto / NodeProto / ValueInfoProto), no library.
// ==========================================================================

export const PROBE_SHAPE = [1, 3, 8, 8];

const enc = new TextEncoder();

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}

const key = (field, wire) => varint((field << 3) | wire);
const vField = (field, n) => [...key(field, 0), ...varint(n)];
function lField(field, bytes) {
  const b = bytes instanceof Uint8Array ? [...bytes] : bytes;
  return [...key(field, 2), ...varint(b.length), ...b];
}
const sField = (field, s) => lField(field, enc.encode(s));

function valueInfo(name, shape) {
  const dims = shape.flatMap((d) => lField(1, vField(1, d)));          // Dimension.dim_value
  const tensor = [...vField(1, 1), ...lField(2, dims)];                // elem_type FLOAT, shape
  return [...sField(1, name), ...lField(2, lField(1, tensor))];         // name, TypeProto.tensor_type
}

/** Serialized ModelProto of `y = Add(x, x)` (opset 13). */
export function probeModel(shape = PROBE_SHAPE) {
  const node = [...sField(1, "x"), ...sField(1, "x"), ...sField(2, "y"), ...sField(3, "add"), ...sField(4, "Add")];
  const graph = [...lField(1, node), ...sField(2, "vho-probe"), ...lField(11, valueInfo("x", shape)), ...lField(12, valueInfo("y", shape))];
  const opset = [...sField(1, ""), ...vField(2, 13)];
  const model = [...vField(1, 8), ...sField(2, "vho"), ...lField(7, graph), ...lField(8, opset)];
  return new Uint8Array(model);
}

/** Deterministic probe input and the expected output (x + x). */
export function probeData(shape = PROBE_SHAPE) {
  const n = shape.reduce((a, b) => a * b, 1);
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = ((i * 37) % 101) / 100 - 0.5;
  return { input, expected: input.map((v) => v + v) };
}
