// ==========================================================================
// AI resource policy (Plan 11/A03) — pure functions, unit tested:
//   classifyAiError   which failures may be retried, and how
//   nextAttempt       backend / tile fallback: smaller tiles ONLY for memory errors; a
//                     model / input error is never re-run on the CPU
//   planInput         memory budget from output size + copies; a too large job is not
//                     shrunk silently: the caller shows the target size and asks
//   etaSeconds        remaining time from the measured rate (no guess without a sample)
//   createSlot        one heavy AI job at a time (FIFO)
// ==========================================================================

/** Error classes: memory | device | backend | model | input | cancelled | other. */
export function classifyAiError(err) {
  if (err?.name === "AbortError") return "cancelled";
  const m = String(err?.message ?? err ?? "");
  if (/out of memory|\boom\b|failed to allocate|allocation fail|could not allocate|buffer size|exceeds (the )?max|maxBufferSize|maxStorageBufferBindingSize|memory access out of bounds|Array buffer allocation failed|insufficient memory|bad_alloc/i.test(m)) return "memory";
  if (/device (was )?lost|device is lost|GPUDevice.*(lost|destroyed)|context lost|worker crashed|ai worker crashed/i.test(m)) return "device";
  if (/no available backend|backend not found|webgpu is not supported|webgpu.*not available|requestAdapter|failed to get gpu adapter|navigator\.gpu/i.test(m)) return "backend";
  if (/invalid (input|dims|dimension|shape)|input.*(dims?|shape).*(mismatch|invalid|expected)|got invalid dimensions|input tensor/i.test(m)) return "input";
  if (/protobuf|invalid model|failed to load model|load model|can't create a session|cannot create.*session|unsupported (op|operator)|opset|not implemented|model.*(corrupt|damaged)|external data/i.test(m)) return "model";
  return "other";
}

/** Job error code (backend `jobs` codes) for a final failure class. */
export const errorCodeForClass = (cls) =>
  ({ memory: "memory", model: "modelFailed", input: "unsupported", cancelled: "cancelled" })[cls] ?? "failed";

/**
 * Fallback after a failed attempt. state: { order, b, ti, steps: { backend: [tile...] },
 * deviceRetries }. Returns the next state, or null when nothing should be retried.
 *  memory  -> smaller tile on the same backend, then the next backend (its first tile)
 *  device  -> the same attempt once more with a fresh worker, then the next backend
 *  backend / other -> the next backend
 *  model / input / cancelled -> stop (a broken model or a wrong input fails on the CPU too)
 */
export function nextAttempt(state, cls, startTile = () => 0) {
  const nextBackend = () => {
    const b = state.b + 1;
    if (b >= state.order.length) return null;
    return { ...state, b, ti: startTile(state.order[b]), deviceRetries: 0 };
  };
  switch (cls) {
    case "memory": {
      const steps = state.steps[state.order[state.b]] ?? [];
      return state.ti + 1 < steps.length ? { ...state, ti: state.ti + 1, deviceRetries: 0 } : nextBackend();
    }
    case "device":
      return state.deviceRetries < 1 ? { ...state, deviceRetries: state.deviceRetries + 1 } : nextBackend();
    case "backend":
    case "other":
      return nextBackend();
    default:
      return null;
  }
}

/** Default AI memory budget: a quarter of the device memory (navigator.deviceMemory, GB). */
export function memoryBudget(deviceMemoryGB) {
  const gb = Number(deviceMemoryGB) > 0 ? Number(deviceMemoryGB) : 4;
  return Math.max(512, Math.min(4096, gb * 1024 * 0.25)) * 1024 * 1024;
}

/**
 * Bytes the page holds for one job (not the GPU): the source (+ one copy per attempt), the
 * output buffer, the result ImageData shown in the viewer, the face pass copy and the upload.
 */
export const BYTES_PER_INPUT_PX = 8;
export const BYTES_PER_OUTPUT_PX = 16;
export const MAX_OUTPUT_PIXELS = 40e6;

export function estimateBytes(width, height, scale) {
  return width * height * BYTES_PER_INPUT_PX + width * height * scale * scale * BYTES_PER_OUTPUT_PX;
}

/**
 * Input size for an x`scale` model within the budget. Returns the size that will be used and
 * whether it is smaller than the photo (`downscaled`): the UI shows `outWidth x outHeight`
 * and asks before running a reduced job.
 */
export function planInput(width, height, scale, { budget = memoryBudget(), maxOutputPixels = MAX_OUTPUT_PIXELS } = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const perPx = BYTES_PER_INPUT_PX + scale * scale * BYTES_PER_OUTPUT_PX;
  const maxIn = Math.min(maxOutputPixels / (scale * scale), budget / perPx);
  const k = Math.min(1, Math.sqrt(maxIn / (w * h)));
  const iw = Math.max(1, Math.floor(w * k));
  const ih = Math.max(1, Math.floor(h * k));
  return {
    width: iw, height: ih, outWidth: iw * scale, outHeight: ih * scale,
    downscaled: iw < w || ih < h, bytes: estimateBytes(iw, ih, scale), budget,
  };
}

/**
 * Remaining seconds from what was measured: the run's own progress (after 5 %), else a rate
 * measured earlier on this device (input pixels per second); null when nothing was measured.
 */
export function etaSeconds({ fraction = 0, elapsed = 0, pixels = 0, rate = null } = {}) {
  if (fraction >= 0.05 && elapsed > 0) return Math.max(0, Math.round((elapsed * (1 - fraction)) / fraction));
  if (rate > 0 && pixels > 0) return Math.round((pixels * (1 - fraction)) / rate);
  return null;
}

/** Stable key of a GPU adapter for per-device memory (tile size that worked). */
export function deviceKey(info) {
  const parts = [info?.vendor, info?.architecture, info?.device, info?.description].map((s) => String(s ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join("/").slice(0, 120) : "unknown";
}

/** FIFO slot: `const release = await slot.acquire()`; one holder at a time. */
export function createSlot() {
  let tail = Promise.resolve();
  let waiting = 0;
  return {
    acquire() {
      let release;
      const mine = new Promise((r) => { release = r; });
      const ready = tail.then(() => release);
      tail = tail.then(() => mine);
      waiting++;
      return ready.then((r) => {
        waiting--;
        let done = false;
        return () => { if (!done) { done = true; r(); } };
      });
    },
    get waiting() { return waiting; },
  };
}
