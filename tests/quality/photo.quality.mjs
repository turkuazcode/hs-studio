// Q02 photo restoration quality (npm run test:quality). See docs/status/test-map.md and
// docs/benchmarks/README.md for the protocol.
//
// Every sample of tests/quality/manifest.json is processed at EQUAL output resolution (x4 of
// the input, = reference size) by each profile:
//   lanczos        standard scaling of the original (baseline, ffmpeg)
//   vho-x4         the app's current photo AI (photo-x4 DAT-2 via upscaleImage, WebGPU -> WASM)
//   vho-x4-faces   vho-x4 + GFPGAN face restoration ("creative"; face samples only)
// VHO_QUALITY_PROFILES=lanczos,vho-x4 limits the profiles (e.g. to skip the 170 MB face model).
//
// Metrics: controlled/synthetic -> full reference (PSNR, SSIM, GMSD, sharpness ratio) for the
// whole image and every face/text region; real-old -> no reference (sharpness, noise σ,
// colourfulness). Red flags (recorded, never averaged away): a face/text region whose SSIM
// drops by more than 0.05 or whose GMSD rises by more than 0.05 against the lanczos baseline
// (possible identity / text change), and lost alpha. Failing samples stay in the report.
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

const ALL_PROFILES = ["lanczos", "vho-x4", "vho-x4-faces"];
const PROFILES = (process.env.VHO_QUALITY_PROFILES?.split(",").map((s) => s.trim()).filter(Boolean)) ?? ALL_PROFILES;
const OUT = join(CACHE, "out", "photo");
const log = (...a) => console.log("[quality-photo]", ...a);

let set, ai = null, aiReport = null;
const results = []; // { id, profile, origin, metrics, rois, flags, ms, backend }

before(async () => {
  set = await prepareSet();
  mkdirSync(OUT, { recursive: true });
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
  t.diagnostic(`${results.length} sample/profile results; red flags: ${results.filter((r) => r.flags.length).map((r) => `${r.id}/${r.profile}: ${r.flags.join("+")}`).join("; ") || "none"}`);
});

test("photo metrics within tolerance of the committed baseline; no new red flag", (t) => {
  if (!results.length) return t.skip("no results (previous test failed)");
  const section = {};
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
  const stored = loadBaseline().photo?.metrics;
  // ROI metrics share the tolerance of their base metric
  const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, x]) => [m.replace(/^roi\d+\./, ""), x]))]));
  const problems = stored ? compareSection(flat(stored), flat(section)) : compareSection(null, section);
  for (const [k, v] of Object.entries(section)) {
    const old = stored?.[k]?.flags ?? "";
    for (const f of v.flags.split(",").filter(Boolean)) if (!old.split(",").includes(f)) problems.push(`${k}: new red flag ${f}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

function markdown({ meta, results: rs }) {
  const lines = [`# Photo quality run ${meta.date}`, "", `ffmpeg: ${meta.ffmpeg} · backends: ${meta.backends.join(", ")} · profiles: ${meta.profiles.join(", ")}`, "",
    "| sample | origin | profile | backend | ms | PSNR | SSIM | GMSD | ROI SSIM | flags |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rs) {
    const m = r.metrics;
    lines.push(`| ${r.id} | ${r.origin} | ${r.profile} | ${r.backend} | ${r.ms} | ${m.psnr ?? "—"} | ${m.ssim ?? "—"} | ${m.gmsd ?? "—"} | ${r.rois.map((x) => x.ssim ?? "—").join(" / ") || "—"} | ${r.flags.join(", ")} |`);
  }
  return lines.join("\n") + "\n";
}
