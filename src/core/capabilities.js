// ==========================================================================
// Capability matrix (Plan 10 / P01): ONE source the UI asks "can this control
// work here?" Entries share the platform contract:
//   { id, available, implementation, verified, reasonCode }
//     available       usable right now on this machine / with the current engine
//     implementation  what does the work ("libmpv", "webgl2", "wic", "onnx-webgpu", ...) or null
//     verified        a real-device test exists for this OS/arch (docs/platform-support.md);
//                     a build flag or a runtime probe alone never sets it
//     reasonCode      why it is unavailable / limited ("engine-mpv", "no-webgl2", "not-ready", ...)
//     support         per-OS claim: "supported-tested" | "supported-untested" | "unsupported" (P04)
// Backend entries come from the Rust `platform_capabilities` command (engine, photo codecs,
// OS actions); the front end adds what only the WebView knows (WebGL2/WebGPU, active engine).
// ==========================================================================

/** Builds one entry (missing fields get safe defaults). */
export function cap(id, available, implementation = null, { verified = false, reasonCode = null, support = null } = {}) {
  return {
    id, available: !!available, implementation, verified: !!verified, reasonCode: available ? reasonCode : (reasonCode ?? "unavailable"),
    // P04 per-OS claim (backend entries: SUPPORT table in capabilities.rs)
    support: support ?? (verified ? "supported-tested" : "supported-untested"),
  };
}

/**
 * Front-end capabilities from WebView facts and the engine playing the current item.
 *   engineKind: "mpv" | "html5"; webgl2/webgpu: booleans; platform: backend platform info
 *   ({ os, arch, verifiedPlatform }) or null in a plain browser.
 * Pure (unit tested); `verified` is true only on a platform with real-device test evidence.
 */
export function frontendCapabilities({ engineKind = "html5", webgl2 = false, webgpu = false, wasm = true, platform = null } = {}) {
  const verified = !!platform?.verifiedPlatform;
  const gpuFilter = engineKind !== "mpv" && webgl2;
  const gpuReason = engineKind === "mpv" ? "engine-mpv" : "no-webgl2";
  const aiBackend = webgpu ? "onnx-webgpu" : wasm ? "onnx-wasm" : null;
  return [
    // Live picture filter: WebGL2 shader on the <video>/<img> element; libmpv draws its own
    // frames (no WebGL access), so only colour properties apply there.
    cap("video.gpuFilter", gpuFilter, gpuFilter ? "webgl2" : null, { verified, reasonCode: gpuFilter ? null : gpuReason }),
    cap("video.colorFilter", true, engineKind === "mpv" ? "libmpv" : "css", { verified }),
    // A/B split view = the WebGL2 shader drawing half of the frame
    cap("video.compare", gpuFilter, gpuFilter ? "webgl2" : null, { verified, reasonCode: gpuFilter ? null : gpuReason }),
    // Neural video restoration: not ready until Plan 12's V06 gate passes
    cap("video.aiRestore", false, null, { reasonCode: "not-ready", support: "unsupported" }),
    // Neural photo enhancement (ONNX Runtime Web); model download needed on first use
    cap("photo.aiEnhance", !!aiBackend && !!platform, aiBackend, {
      verified, reasonCode: !platform ? "no-backend" : aiBackend ? "model-download-on-first-use" : "no-ai-backend", support: "supported-untested",
    }),
    // Plan 07 smart editing (A06): object removal and colorize like the enhancement; background
    // removal is experimental (BiRefNet does not fit ORT Web on the 1 GB iGPU test machine)
    ...["photo.aiInpaint", "photo.aiColorize"].map((id) => cap(id, !!aiBackend && !!platform, aiBackend, {
      verified, reasonCode: !platform ? "no-backend" : aiBackend ? "model-download-on-first-use" : "no-ai-backend", support: "supported-untested",
    })),
    cap("photo.aiBackground", !!aiBackend && !!platform, aiBackend, {
      verified: false, reasonCode: !platform ? "no-backend" : aiBackend ? "experimental-memory" : "no-ai-backend", support: "supported-untested",
    }),
    // Booster above 100 % always ends in a limiter (HTML5: DynamicsCompressor, libmpv: lavfi alimiter)
    cap("audio.boostLimiter", true, engineKind === "mpv" ? "lavfi-alimiter" : "webaudio-compressor", { verified }),
  ];
}

/** Backend + front-end lists -> Map(id -> entry); a front-end entry overrides a backend one. */
export function mergeCapabilities(...lists) {
  const out = new Map();
  for (const list of lists) for (const e of Array.isArray(list) ? list : []) if (e?.id) out.set(e.id, e);
  return out;
}

function detectWebgl2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * app-level view: app.capabilities.get("video.compare") -> entry (evaluated with the engine
 * of the current item, so it follows engine switches). backend = result of
 * `platform_capabilities` ({ platform, entries }) or null; webgl2/webgpu: boolean or getter.
 */
export function createCapabilities({ engineKind = () => "html5", backend = null, webgl2 = detectWebgl2(), webgpu = !!globalThis.navigator?.gpu } = {}) {
  let platform = backend?.platform ?? null;
  let backendEntries = backend?.entries ?? [];
  const val = (v) => (typeof v === "function" ? v() : v);
  const current = () => mergeCapabilities(backendEntries, frontendCapabilities({
    engineKind: engineKind(), webgl2: !!val(webgl2), webgpu: !!val(webgpu), platform,
  }));
  return {
    get: (id) => current().get(id) ?? cap(id, false, null, { reasonCode: "unknown" }),
    isAvailable: (id) => !!current().get(id)?.available,
    all: () => [...current().values()],
    get platform() { return platform; },
    /** Backend answer arrived (platform_capabilities is loaded after boot, off the start path). */
    setBackend(report) {
      platform = report?.platform ?? null;
      backendEntries = report?.entries ?? [];
    },
  };
}
