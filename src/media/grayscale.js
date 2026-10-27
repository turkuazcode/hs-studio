// ==========================================================================
// Grayscale integrity (Plan 11/A04): an RGB model can invent colour on a black-and-white
// photo (Q02 baseline: colourfulness 0 -> 2-10 on old scans). When the input is grayscale,
// the result is put back to grayscale (luma of the model output, R = G = B), so the AI
// output never adds a colour the photo did not have. Pure, unit tested.
// ==========================================================================

/**
 * True when (almost) every visible pixel has R ≈ G ≈ B: max channel spread <= `tol` for at
 * least `frac` of the pixels (JPEG chroma noise on scans is tolerated). Fully transparent
 * pixels are ignored; an image without visible pixels is not called grayscale.
 */
export function isGrayscale(data, { tol = 6, frac = 0.995 } = {}) {
  let visible = 0;
  let gray = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    visible++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= tol) gray++;
  }
  return visible > 0 && gray >= visible * frac;
}

/** In place: R = G = B = Rec.601 luma of each pixel (alpha untouched). */
export function toGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  return data;
}

/** Applies the rule: `output` (ImageData-like data) becomes gray when `input` was gray. */
export function keepGrayscale(input, output) {
  if (!isGrayscale(input)) return false;
  toGrayscale(output);
  return true;
}
