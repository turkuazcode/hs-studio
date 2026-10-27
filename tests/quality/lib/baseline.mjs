// Committed quality baseline (docs/benchmarks/quality-baseline.json) and regression checks.
// A run is compared metric by metric with the tolerances below; VHO_QUALITY_UPDATE_BASELINE=1
// rewrites the section from the current run (review the diff: it changes the reference numbers).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./dataset.mjs";

export const BASELINE_PATH = join(REPO_ROOT, "docs", "benchmarks", "quality-baseline.json");
export const RESULTS_DIR = join(REPO_ROOT, "tests", ".results", "quality");
export const UPDATE = process.env.VHO_QUALITY_UPDATE_BASELINE === "1";

/**
 * Allowed drift per metric. Deterministic CPU paths (ffmpeg, WASM) reproduce exactly; WebGPU
 * differs by at most a few 8-bit levels (measured in the Q01 smoke test), which moves PSNR by
 * well under 0.3 dB on these sizes.
 */
export const TOLERANCE = {
  psnr: 0.3, ssim: 0.005, gmsd: 0.005, sharpnessRatio: 0.05,
  sharpness: 0.05, noise: 0.05, colorfulness: 0.05, // relative for no-reference metrics
  temporalError: 0.05, temporalChange: 0.05, psnrMin: 0.3, ssimMin: 0.005,
};
const RELATIVE = new Set(["sharpness", "noise", "colorfulness", "sharpnessRatio", "temporalError", "temporalChange"]);

export function loadBaseline() {
  return existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
}

/** Differences of `current` (nested { key: { metric: number } }) to the stored section. */
export function compareSection(stored, current) {
  const problems = [];
  if (!stored) return ["no committed baseline for this section (run with VHO_QUALITY_UPDATE_BASELINE=1 and review)"];
  for (const [key, metrics] of Object.entries(current)) {
    const base = stored[key];
    if (!base) { problems.push(`${key}: not in the baseline`); continue; }
    for (const [m, v] of Object.entries(metrics)) {
      if (typeof v !== "number" || !(m in TOLERANCE) || typeof base[m] !== "number") continue;
      const tol = RELATIVE.has(m) ? TOLERANCE[m] * Math.max(Math.abs(base[m]), 1e-6) : TOLERANCE[m];
      if (Math.abs(v - base[m]) > tol) problems.push(`${key} ${m}: ${v.toFixed(4)} vs baseline ${base[m].toFixed(4)} (±${tol.toFixed(4)})`);
    }
  }
  for (const key of Object.keys(stored)) if (!(key in current)) problems.push(`${key}: in the baseline but not measured`);
  return problems;
}

export function saveSection(name, section, meta) {
  const all = loadBaseline();
  all[name] = { meta, metrics: section };
  mkdirSync(join(REPO_ROOT, "docs", "benchmarks"), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(all, null, 1) + "\n");
}

export function writeResult(name, data) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

export const round = (v, d = 4) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : v);
export const roundAll = (o, d = 4) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v, d)]));
