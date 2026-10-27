// Q02 video quality baseline + structural fixtures (npm run test:quality).
//
// Clips (tests/quality/manifest.json): 3 s, reference 320x176 lossless (FFV1), input 80x44
// MPEG-2 (compressed, some with low-light noise). Profiles at equal output size (x4):
//   lanczos           standard scaling
//   nlmeans-lanczos   conventional clean-up (LGPL nlmeans) + scaling
//   candidate:<name>  any file tests/.cache/quality/candidates/<name>/<clip>.mkv (320x176) —
//                     the hook for V02 model experiments; evaluated with the same metrics.
// Metrics: mean/min PSNR, mean/min SSIM (every 5th frame), temporal error |Δout − Δref| and
// output temporal change. Structural fixtures prove what V01/V03 must detect: field order,
// VFR timestamps, A/V sync (flash vs beep within one frame).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, prepareSet } from "./lib/dataset.mjs";
import { ffmpeg, probe, readFrames } from "./lib/ffmpeg.mjs";
import { videoMetrics } from "./lib/metrics.mjs";
import { compareSection, loadBaseline, roundAll, saveSection, UPDATE, writeResult, RESULTS_DIR } from "./lib/baseline.mjs";

const OUT = join(CACHE, "out", "video");
const CANDIDATES = join(CACHE, "candidates");
const log = (...a) => console.log("[quality-video]", ...a);
const PROFILES = {
  "lanczos": "scale=320:176:flags=lanczos+accurate_rnd",
  "nlmeans-lanczos": "nlmeans=s=2.5:p=5:r=9,scale=320:176:flags=lanczos+accurate_rnd",
};

let set;
const results = [];

before(async () => {
  set = await prepareSet();
  mkdirSync(OUT, { recursive: true });
});

test("video profiles: equal size, metrics per clip", { timeout: 1800000 }, async () => {
  assert.deepEqual(set.problems, [], set.problems.join("\n"));
  assert.ok(set.manifest.clips.length >= 6, "Plan 14 Q02 asks for at least 6 clips");
  const candidates = existsSync(CANDIDATES) ? readdirSync(CANDIDATES) : [];
  for (const c of set.manifest.clips) {
    const dir = set.dir(c.id);
    const ref = await readFrames(join(dir, "ref.mkv"));
    assert.equal(ref.frames.length, 75, `${c.id}: reference frame count`);
    const outputs = Object.entries(PROFILES).map(([name, vf]) => ({ name, path: join(OUT, `${name}--${c.id}.mkv`), vf }));
    for (const name of candidates) {
      const p = join(CANDIDATES, name, `${c.id}.mkv`);
      if (existsSync(p)) outputs.push({ name: `candidate:${name}`, path: p });
    }
    for (const o of outputs) {
      const t0 = Date.now();
      if (o.vf) await ffmpeg(["-i", join(dir, "input.mkv"), "-vf", `${o.vf},format=bgr0`, "-c:v", "ffv1", o.path]);
      const ms = Date.now() - t0;
      const out = await readFrames(o.path);
      assert.equal(out.width, ref.width, `${c.id}/${o.name}: width`);
      assert.equal(out.height, ref.height, `${c.id}/${o.name}: height`);
      assert.equal(out.frames.length, ref.frames.length, `${c.id}/${o.name}: frame count`);
      const m = videoMetrics(out, ref);
      results.push({ id: c.id, profile: o.name, categories: c.categories, split: c.split, ms, metrics: m });
      log(`${c.id} ${o.name} ${ms} ms: ${JSON.stringify(roundAll(m, 3))}`);
    }
  }
});

test("structural: interlaced fixture is top-field-first, 25 fps, 50 frames", async () => {
  const p = (await probe(join(set.dir("s01-interlaced-tff"), "interlaced-tff.mpg"), ["-count_frames"])).streams[0];
  assert.equal(p.field_order, "tt");
  assert.equal(p.r_frame_rate, "25/1");
  assert.equal(Number(p.nb_read_frames), 50);
});

test("structural: VFR fixture keeps irregular timestamps (no silent CFR)", async () => {
  const v = await readFrames(join(set.dir("s02-vfr"), "vfr.mkv"));
  assert.equal(v.frames.length, 80);
  const d = v.pts.slice(1).map((t, i) => Math.round((t - v.pts[i]) * 1000));
  const distinct = [...new Set(d)].sort((a, b) => a - b);
  assert.ok(distinct.length >= 2 && distinct.at(-1) >= 60, `frame durations ${distinct.join(",")} ms`);
  assert.ok(Math.abs(v.pts.at(-1) - (89 / 30)) < 0.05, `last pts ${v.pts.at(-1)}`);
});

test("structural: A/V sync fixture — flash and beep within one frame", async () => {
  const file = join(set.dir("s03-av-sync"), "av-sync.mkv");
  const v = await readFrames(file);
  const flashes = [];
  v.frames.forEach((f, i) => {
    let s = 0;
    for (let k = 0; k < f.length; k += 16) s += f[k];
    const bright = s / (f.length / 16) > 128;
    if (bright && !(i > 0 && flashes.at(-1)?.i === i - 1)) flashes.push({ i, t: v.pts[i] });
  });
  const pcm = await ffmpeg(["-i", file, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "48000", "-"]);
  const beeps = [];
  let silentRun = 48000;
  for (let i = 0; i < pcm.length / 2; i++) {
    const loud = Math.abs(pcm.readInt16LE(i * 2)) > 3000;
    if (loud && silentRun > 2400) beeps.push(i / 48000);
    silentRun = loud ? 0 : silentRun + 1;
  }
  assert.equal(flashes.length, 3, `flashes ${JSON.stringify(flashes)}`);
  assert.equal(beeps.length, 3, `beeps ${beeps}`);
  flashes.forEach((f, k) => assert.ok(Math.abs(f.t - beeps[k]) < 0.04, `offset ${((f.t - beeps[k]) * 1000).toFixed(1)} ms at ${k}`));
});

test("video metrics within tolerance of the committed baseline", (t) => {
  if (!results.length) return t.skip("no results (previous test failed)");
  const section = Object.fromEntries(results.filter((r) => !r.profile.startsWith("candidate:")).map((r) => [`${r.id}|${r.profile}`, roundAll(r.metrics)]));
  const meta = { date: new Date().toISOString().slice(0, 10), ffmpeg: set.version, profiles: Object.keys(PROFILES) };
  writeResult("video", { meta, results: results.map((r) => ({ ...r, metrics: roundAll(r.metrics) })) });
  const lines = ["# Video quality run " + meta.date, "", "| clip | profile | ms | PSNR | PSNR min | SSIM | temporal error | temporal change |", "|---|---|---|---|---|---|---|---|",
    ...results.map((r) => { const m = roundAll(r.metrics, 3); return `| ${r.id} | ${r.profile} | ${r.ms} | ${m.psnr} | ${m.psnrMin} | ${m.ssim} | ${m.temporalError} | ${m.temporalChange} |`; })];
  writeFileSync(join(RESULTS_DIR, "video-report.md"), lines.join("\n") + "\n");
  if (UPDATE) {
    saveSection("video", section, meta);
    t.diagnostic("baseline section 'video' rewritten");
    return;
  }
  const problems = compareSection(loadBaseline().video?.metrics, section);
  assert.deepEqual(problems, [], problems.join("\n"));
});
