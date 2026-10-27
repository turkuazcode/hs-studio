// Launches the release app for quality/bench runs with the real AI components, sharing the
// model cache of the real-AI smoke test (tests/.cache/ai-smoke, see tests/ai/photo-x4.ai.mjs),
// so a model is downloaded at most once for all layers. Never the user's own AI cache.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, launchApp, removeDir } from "../../e2e/lib/app.mjs";

export const AI_CACHE_ROOT = process.env.VHO_TEST_AI_CACHE || join(REPO_ROOT, "tests", ".cache", "ai-smoke");
export const AI_DATA_DIR = join(AI_CACHE_ROOT, "vho-data");

const J = JSON.stringify;

export async function launchAiApp(opts = {}) {
  mkdirSync(AI_DATA_DIR, { recursive: true });
  for (const e of readdirSync(AI_DATA_DIR)) if (e.toLowerCase() !== "ai") await removeDir(join(AI_DATA_DIR, e));
  const app = await launchApp({ dataDir: AI_DATA_DIR, ...opts });
  const invoke = (cmd, args = {}, timeoutMs = 15000) => app.eval(`__TAURI__.core.invoke(${J(cmd)}, ${J(args)})`, { timeoutMs });

  /** Installs (once) and hash-verifies components; returns { id: { downloadedBytes, ms } }. */
  async function ensureComponents(ids, { offline = process.env.VHO_AI_OFFLINE === "1" } = {}) {
    const report = {};
    for (const st of await invoke("ai_status_all", { ids })) {
      let cur = st.installed ? await invoke("ai_verify", { id: st.id }, 600000) : st;
      report[st.id] = { downloadedBytes: 0, ms: 0 };
      if (cur.state !== "ready") {
        if (offline) throw new Error(`${st.id}: not in the AI test cache and VHO_AI_OFFLINE=1`);
        const t0 = Date.now();
        try {
          await invoke("ai_install", { id: st.id, requestId: `quality-${st.id}` }, 1800000);
        } catch (e) {
          throw new Error(`INFRA: download of ${st.id} failed: ${e.message}`);
        }
        report[st.id] = { downloadedBytes: st.downloadBytes, ms: Date.now() - t0 };
        cur = await invoke("ai_verify", { id: st.id }, 600000);
      }
      if (cur.state !== "ready") throw new Error(`${st.id} not verified (${cur.state})`);
      report[st.id].version = cur.version;
    }
    return report;
  }

  /** RGBA bytes -> base64 helper on both sides. */
  const toB64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  const PAGE_HELPERS = `
    const __fromB64 = (s) => { const b = atob(s); const u = new Uint8ClampedArray(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
    const __toB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const __eng = await import(new URL("/media/ai-engine.js", location.href).href);`;

  /** photo-x4 through the app API (upscaleImage), optionally followed by face restoration. */
  async function upscale(img, { faces = false, keepWorker = true } = {}) {
    const r = await app.eval(`(async () => { ${PAGE_HELPERS}
      const src = new ImageData(__fromB64(${J(toB64(img.data))}), ${img.width}, ${img.height});
      const t0 = performance.now();
      const up = await __eng.upscaleImage("photo-x4", src);
      const upMs = performance.now() - t0;
      let out = up.imageData, faceStats = null, faceMs = 0;
      if (${faces}) {
        const t1 = performance.now();
        const fr = await __eng.restoreFacesInImage(up.imageData, { strength: 1, srcScale: up.imageData.width / src.width }, { original: src });
        faceMs = performance.now() - t1;
        out = fr.imageData; faceStats = fr.stats;
      }
      ${keepWorker ? "" : "__eng.releaseAi();"}
      return { width: out.width, height: out.height, data: __toB64(new Uint8Array(out.data.buffer)), backend: up.backend, tile: up.tile,
        stats: up.stats, upMs, faceMs, faceStats };
    })()`, { timeoutMs: 1800000 });
    return { ...r, data: new Uint8Array(Buffer.from(r.data, "base64")) };
  }

  return { app, invoke, ensureComponents, upscale, release: () => app.eval(`(async () => { ${PAGE_HELPERS} __eng.releaseAi(); return true; })()`) };
}
