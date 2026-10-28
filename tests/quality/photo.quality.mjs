// Q02 photo restoration quality (npm run test:quality). See docs/status/test-map.md and
// docs/benchmarks/README.md for the protocol.
//
// Every sample of tests/quality/manifest.json is processed at EQUAL output resolution (x4 of
// the input, = reference size) by each profile:
//   lanczos        standard scaling of the original (baseline, ffmpeg)
//   vho-x4         the app's current photo AI (photo-x4 DAT-2 via upscaleImage, WebGPU -> WASM)
//   vho-x4-faces   vho-x4 + GFPGAN face restoration ("creative"; face samples only)
//   classic-x4     the default photo enhance since A05 (model-free classical chain, src-tauri/src/photo/
//                  enhance.rs) with the product's default settings at scale 4, run as the app's own
//                  "photo-enhance" queue job; also records job time, output file size and the app
//                  process' peak working set (audit D08). The product offers 1x / 2x / 4x.
// VHO_QUALITY_PROFILES=lanczos,classic-x4 limits the profiles (e.g. to skip the neural models).
//
// Metrics: controlled/synthetic -> full reference (PSNR, SSIM, GMSD, sharpness ratio) for the
// whole image and every face/text region; real-old -> no reference (sharpness, noise σ,
// colourfulness). Red flags (recorded, never averaged away): a face/text region whose SSIM
// drops by more than 0.05 or whose GMSD rises by more than 0.05 against the lanczos baseline
// (possible identity / text change), lost alpha, and colour added to a greyscale photo. Failing samples stay in the report.
//
// Gates: set integrity (set-lock.json), finite and correctly sized outputs, every metric within
// tolerance of docs/benchmarks/quality-baseline.json, no new red flag.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng, decodePng } from "../ai/lib/image.mjs";
import { CACHE, prepareSet } from "./lib/dataset.mjs";
import { ffmpeg } from "./lib/ffmpeg.mjs";
import { fullReference, noReference } from "./lib/metrics.mjs";
import { compareSection, loadBaseline, roundAll, saveSection, UPDATE, writeResult, RESULTS_DIR } from "./lib/baseline.mjs";
import { launchAiApp } from "./lib/ai-app.mjs";
import { launchApp } from "../e2e/lib/app.mjs";
import { sleep } from "../e2e/lib/cdp.mjs";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const ALL_PROFILES = ["lanczos", "classic-x4", "vho-x4", "vho-x4-faces"];
const PROFILES = (process.env.VHO_QUALITY_PROFILES?.split(",").map((s) => s.trim()).filter(Boolean)) ?? ALL_PROFILES;
const OUT = join(CACHE, "out", "photo");
const log = (...a) => console.log("[quality-photo]", ...a);

let set, ai = null, aiReport = null, classicApp = null;
const classicRuns = new Map(); // photo id -> { out, ms, bytes, peakMiB }
const results = []; // { id, profile, origin, metrics, rois, flags, ms, backend }
let complete = false; // every sample/profile ran: only then is the baseline compared or rewritten

before(async () => {
  set = await prepareSet();
  mkdirSync(OUT, { recursive: true });
  // the classical chain first, in its own app instance that is closed before the neural models
  // run (two WebView2 instances with WebGPU busy in one stalled the other's page)
  if (PROFILES.includes("classic-x4")) {
    classicApp = await launchApp();
    try {
      await classicApp.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000 });
      for (const p of set.manifest.photos) classicRuns.set(p.id, await classic(join(set.dir(p.id), "input.png")));
    } finally {
      await classicApp.close();
      classicApp = null;
    }
  }
  if (PROFILES.some((p) => p.startsWith("vho"))) {
    ai = await launchAiApp();
    const ids = ["ort-web", "photo-x4", ...(PROFILES.includes("vho-x4-faces") ? ["face-restore"] : [])];
    aiReport = await ai.ensureComponents(ids);
    log("AI components:", JSON.stringify(aiReport));
  }
});

after(async () => {
  await ai?.app.close();
});

/** Peak working set (MiB) of the app's main process so far (where the Rust job runs). */
function peakWorkingSetMiB(pid) {
  try {
    const v = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PeakWorkingSet64`], { encoding: "utf8" });
    return Math.round(Number(v.trim()) / 1048576);
  } catch {
    return null;
  }
}

/** The A05 chain through the app's queue: default settings at scale 4 (= the lanczos size). */
async function classic(inputPath) {
  const J = JSON.stringify;
  const inv = (cmd, args, timeoutMs = 60000) => classicApp.eval(`__TAURI__.core.invoke(${J(cmd)}, ${J(args)})`, { timeoutMs });
  const t0 = Date.now();
  const { id } = await inv("jobs_submit", { job: { kind: "photo-enhance", request: { input: inputPath, params: { scale: 4 }, output: { format: "png", suffix: "_classic" } } } });
  let d;
  for (;;) {
    d = await inv("jobs_get", { id });
    if (["completed", "failed", "cancelled", "interrupted"].includes(d.job.state)) break;
    await sleep(50);
  }
  const ms = Date.now() - t0;
  const item = d.items[0];
  if (d.job.state !== "completed") throw new Error(`photo-enhance ${d.job.state}: ${item?.errorCode ?? ""} ${item?.errorDetail ?? ""}`);
  const output = item.outputPath ?? item.output_path;
  return { out: readPng(output), ms, bytes: statSync(output).size, peakMiB: peakWorkingSetMiB(classicApp.proc.pid) };
}

const readPng = (p) => decodePng(readFileSync(p));

async function lanczos(input, s) {
  const p = join(OUT, "_tmp.png");
  writeFileSync(p, encodePng(input));
  const out = join(OUT, "_tmp_out.png");
  await ffmpeg(["-i", p, "-vf", `scale=iw*${s}:ih*${s}:flags=lanczos+accurate_rnd,format=rgba`, "-frames:v", "1", out]);
  return readPng(out);
}

function alphaPreserved(input, out) {
  // nearest-neighbour expectation of the input alpha at the output size
  const s = out.width / input.width;
  let bad = 0, transparent = 0;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const a = input.data[(Math.floor(y / s) * input.width + Math.floor(x / s)) * 4 + 3];
      if (a < 255) transparent++;
      if (Math.abs(out.data[(y * out.width + x) * 4 + 3] - a) > 32) bad++;
    }
  }
  return transparent === 0 ? null : bad / transparent < 0.1;
}

test("quality set: sources verified, samples identical to set-lock.json", () => {
  assert.deepEqual(set.problems, [], set.problems.join("\n"));
  const counts = { photo: set.manifest.photos.length, clip: set.manifest.clips.length };
  log(`set: ${counts.photo} photos, ${counts.clip} clips, ${set.manifest.structural.length} structural fixtures; ${set.version}`);
  assert.ok(counts.photo >= 12, "Plan 14 Q02 asks for at least 12 photos");
  for (const p of set.manifest.photos) {
    if (p.source) assert.ok(set.manifest.sources[p.source].license.startsWith("Public domain"), `${p.id}: licence`);
  }
});

test("photo profiles: every sample, equal output size, finite output", { timeout: 3600000 }, async (t) => {
  for (const p of set.manifest.photos) {
    const dir = set.dir(p.id);
    const input = readPng(join(dir, "input.png"));
    const ref = p.origin === "real-old" ? null : readPng(join(dir, "ref.png"));
    const hasFace = (p.roi ?? []).some((r) => r.kind === "face");
    for (const profile of PROFILES) {
      if (profile === "vho-x4-faces" && !hasFace) continue;
      let out, ms, backend = "cpu-ffmpeg", extra = {};
      const t0 = Date.now();
      if (profile === "lanczos") {
        out = await lanczos(input, 4);
        ms = Date.now() - t0;
      } else if (profile === "classic-x4") {
        const r = classicRuns.get(p.id);
        out = r.out;
        ms = r.ms;
        backend = "cpu-rust";
        extra = { bytes: r.bytes, peakWorkingSetMiB: r.peakMiB };
      } else {
        const r = await ai.upscale(input, { faces: profile === "vho-x4-faces" });
        out = { width: r.width, height: r.height, data: r.data };
        ms = Math.round(r.upMs + r.faceMs);
        backend = r.backend;
        extra = { tile: r.tile, faceStats: r.faceStats, raw: r.stats };
        assert.equal(r.stats?.nonFinite ?? 0, 0, `${p.id}/${profile}: NaN/Inf in the model output`);
      }
      assert.equal(out.width, input.width * 4, `${p.id}/${profile}: width`);
      assert.equal(out.height, input.height * 4, `${p.id}/${profile}: height`);
      writeFileSync(join(OUT, `${profile}--${p.id}.png`), encodePng(out));
      const entry = { id: p.id, profile, origin: p.origin, split: p.split, categories: p.categories, backend, ms, ...extra, flags: [] };
      if (ref) {
        entry.metrics = fullReference(out, ref);
        entry.rois = (p.roi ?? []).map((r) => ({ kind: r.kind, ...fullReference(out, ref, r) }));
      } else {
        entry.metrics = noReference(out);
        entry.rois = (p.roi ?? []).map((r) => ({ kind: r.kind, ...noReference(out, r) }));
        entry.inputMetrics = noReference(input);
      }
      const alpha = alphaPreserved(input, out);
      if (alpha === false) entry.flags.push("alpha-lost");
      // A greyscale photo must stay greyscale (colourfulness of a neutral image is ~0)
      const inColor = noReference(input).colorfulness;
      const outColor = noReference(out).colorfulness;
      entry.colorfulness = { input: inColor, output: outColor };
      if (inColor < 1 && outColor > 2) entry.flags.push("color-cast-on-greyscale");
      results.push(entry);
      log(`${p.id} ${profile} (${backend}) ${ms} ms: ${JSON.stringify(roundAll(entry.metrics, 3))}`);
    }
  }
  // Red flags against the standard scaling of the same sample
  for (const e of results) {
    if (e.profile === "lanczos" || !e.rois?.length || e.origin === "real-old") continue;
    const base = results.find((b) => b.id === e.id && b.profile === "lanczos");
    if (!base) continue;
    e.rois.forEach((r, i) => {
      const b = base.rois[i];
      if (r.ssim < b.ssim - 0.05 || r.gmsd > b.gmsd + 0.05) e.flags.push(`${r.kind}-fidelity-drop`);
    });
  }
  complete = true;
  t.diagnostic(`${results.length} sample/profile results; red flags: ${results.filter((r) => r.flags.length).map((r) => `${r.id}/${r.profile}: ${r.flags.join("+")}`).join("; ") || "none"}`);
});

// Profiles of the legacy neural photo enhancer: out of the Windows alpha scope (src/core/scope.js),
// compared in a test of their own so their result stays on record without hiding the others'.
const LEGACY = new Set(["vho-x4", "vho-x4-faces"]);
let section = null;

/** Baseline problems of the section keys whose profile passes `keep`. */
function baselineProblems(keep) {
  const pick = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keep(k.split("|")[1])));
  const current = pick(section);
  const stored = loadBaseline().photo?.metrics;
  // ROI metrics share the tolerance of their base metric
  const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, x]) => [m.replace(/^roi\d+\./, ""), x]))]));
  const problems = stored ? compareSection(flat(pick(stored)), flat(current)) : compareSection(null, current);
  for (const [k, v] of Object.entries(current)) {
    const old = stored?.[k]?.flags ?? "";
    for (const f of v.flags.split(",").filter(Boolean)) if (!old.split(",").includes(f)) problems.push(`${k}: new red flag ${f}`);
  }
  return problems;
}

test("photo metrics within tolerance of the committed baseline; no new red flag", (t) => {
  if (!complete) return t.skip("the profile run did not finish: the baseline is neither compared nor rewritten");
  section = {};
  for (const r of results) {
    section[`${r.id}|${r.profile}`] = { ...roundAll(r.metrics), ...Object.fromEntries(r.rois.flatMap((x, i) =>
      Object.entries(x).filter(([k]) => k !== "kind").map(([k, v]) => [`roi${i}.${k}`, Number(v.toFixed(4))]))), flags: r.flags.join(",") };
  }
  const meta = { date: new Date().toISOString().slice(0, 10), ffmpeg: set.version, profiles: PROFILES,
    backends: [...new Set(results.map((r) => r.backend))], models: aiReport };
  const report = { meta, results: results.map((r) => ({ ...r, metrics: roundAll(r.metrics), rois: r.rois.map((x) => roundAll(x)) })) };
  writeResult("photo", report);
  writeFileSync(join(RESULTS_DIR, "photo-report.md"), markdown(report));
  if (UPDATE) {
    saveSection("photo", section, meta);
    t.diagnostic("baseline section 'photo' rewritten");
    return;
  }
  const problems = baselineProblems((profile) => !LEGACY.has(profile));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("legacy experimental photo AI (vho-x4, vho-x4-faces; out of the Windows alpha) within tolerance of the baseline", (t) => {
  if (!complete || UPDATE) return t.skip(UPDATE ? "baseline update run" : "the profile run did not finish");
  if (![...LEGACY].some((p) => PROFILES.includes(p))) return t.skip("legacy profiles not selected (VHO_QUALITY_PROFILES)");
  const problems = baselineProblems((profile) => LEGACY.has(profile));
  assert.deepEqual(problems, [], problems.join("\n"));
});

function markdown({ meta, results: rs }) {
  const lines = [`# Photo quality run ${meta.date}`, "", `ffmpeg: ${meta.ffmpeg} · backends: ${meta.backends.join(", ")} · profiles: ${meta.profiles.join(", ")}`, "",
    "| sample | origin | profile | backend | ms | bytes | peak MiB | PSNR | SSIM | GMSD | sharpness | ROI SSIM | flags |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rs) {
    const m = r.metrics;
    lines.push(`| ${r.id} | ${r.origin} | ${r.profile} | ${r.backend} | ${r.ms} | ${r.bytes ?? "—"} | ${r.peakWorkingSetMiB ?? "—"} | ${m.psnr ?? "—"} | ${m.ssim ?? "—"} | ${m.gmsd ?? "—"} | ${m.sharpnessRatio ?? m.sharpness ?? "—"} | ${r.rois.map((x) => x.ssim ?? "—").join(" / ") || "—"} | ${r.flags.join(", ")} |`);
  }
  return lines.join("\n") + "\n";
}
