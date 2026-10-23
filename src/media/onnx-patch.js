// ==========================================================================
// Minimal protobuf walker for ONNX ModelProto + the output dim-name patch.
// Used by ai-worker.js; kept free of worker globals so it can be unit tested.
// ==========================================================================

export function readVarint(b, i) {
  let v = 0, shift = 0, byte;
  do {
    byte = b[i++];
    v += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [v, i];
}

/** Yields { field, start, end } for the length-delimited fields of a message in b[start, end). */
export function* lenFields(b, start, end) {
  let i = start;
  while (i < end) {
    let key;
    [key, i] = readVarint(b, i);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) [, i] = readVarint(b, i);
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      let len;
      [len, i] = readVarint(b, i);
      yield { field, start: i, end: i + len };
      i += len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

const child = (b, msg, field) => [...lenFields(b, msg.start, msg.end)].filter((f) => f.field === field);

/**
 * Some exported upscalers declare the output as [batch, 3, "height", "width"], reusing the
 * input's symbolic names although the output is N× larger. The CPU backend ignores this,
 * but the WebGPU backend plans buffers from it and fails ("Shape mismatch attempting to
 * re-use buffer"). Renames the output's spatial dim names in place (same byte length, so
 * the file layout is unchanged). Only metadata changes; weights and computation do not.
 */
export function fixOutputDimNames(bytes) {
  const b = new Uint8Array(bytes);
  let patched = 0;
  for (const graph of child(b, { start: 0, end: b.length }, 7)) {           // ModelProto.graph
    for (const out of child(b, graph, 12)) {                                // GraphProto.output
      for (const type of child(b, out, 2))                                  // ValueInfoProto.type
        for (const tensor of child(b, type, 1))                             // TypeProto.tensor_type
          for (const shape of child(b, tensor, 2))                          // Tensor.shape
            child(b, shape, 1).slice(2).forEach((dim) => {                  // dims H, W
              for (const p of child(b, dim, 2)) {                           // Dimension.dim_param
                b[p.start] = 0x6f; // first letter -> "o": "height" -> "oeight"
                patched++;
              }
            });
    }
  }
  return { bytes: b, patched };
}
