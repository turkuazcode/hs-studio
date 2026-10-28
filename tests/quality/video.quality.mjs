// Q02 video quality baseline + structural fixtures (npm run test:quality).
//
// Clips (tests/quality/manifest.json): 3 s, reference 320x176 lossless (FFV1), input 80x44
// MPEG-2 (compressed, some with low-light noise). Profiles at equal output size (x4):
//   lanczos           standard scaling
//   nlmeans-lanczos   conventional clean-up (LGPL nlmeans) + scaling
//   faithful-light    the model-free video enhance of V03 with the dialog's default choices,
//   faithful-medium   and with "medium": the filter chain comes from the app itself
//                     (video_enhance_plan), only the scale target is set to 320x176 and the
//                     colour conversion step is left out (the reference is untagged; it would
//                     measure the colour tagging, not the clean-up). Audit D08.
//   candidate:<name>  any file tests/.cache/quality/candidates/<name>/<clip>.mkv (320x176) —
//                     the hook for V02 model experiments; evaluated with the same metrics.
// Every ffmpeg run also records its peak memory (-benchmark maxrss). For the faithful profiles
// the product-size output (x2, the product encoder h264_mf quality 65 where available) is
// encoded once more to record the real output size against the input size.
// Metrics: mean/min PSNR, mean/min SSIM (every 5th frame), temporal error |Δout − Δref| and
// output temporal change. Structural fixtures prove what V01/V03 must detect: field order,
// VFR timestamps, A/V sync (flash vs beep within one frame).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE, prepareSet } from "./lib/dataset.mjs";
import { FFMPEG, ffmpeg, probe, readFrames, run } from "./lib/ffmpeg.mjs";
import { statSync } from "node:fs";
import { launchApp } from "../e2e/lib/app.mjs";
import { videoMetrics } from "./lib/metrics.mjs";
import { compareSection, loadBaseline, roundAll, saveSection, UPDATE, writeResult, RESULTS_DIR } from "./lib/baseline.mjs";

const OUT = join(CACHE, "out", "video");
const CANDIDATES = join(CACHE, "candidates");
const log = (...a) => console.log("[quality-video]", ...a);
const PROFILES = {
  "lanczos": "scale=320:176:flags=lanczos+accurate_rnd",
  "nlmeans-lanczos": "nlmeans=s=2.5:p=5:r=9,scale=320:176:flags=lanczos+accurate_rnd",
};

const FAITHFUL = process.env.VHO_QUALITY_FAITHFUL !== "0";
let set;
const results = [];
let complete = false; // every sample/profile ran: only then is the baseline compared or rewritten
const chains = {}; // clip id -> { light, medium, product }

/** The app's V03 chain for one clip, made comparable: target 320x176, no colour conversion. */
export function measurableChain(filter, size = "320:176") {
  return filter.split(",").filter((f) => !/^(colorspace|format)=/.test(f)).map((f) => f.replace(/^scale=\d+:\d+:/, `scale=${size}:`)).join(",");
}

/** ffmpeg with -benchmark: { maxrssKiB } (peak memory of the run). */
async function benchRun(args) {
  const out = await new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(FFMPEG, ["-hide_banner", "-v", "info", "-nostats", "-nostdin", "-y", "-benchmark", ...args],
      { encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr).slice(-1500))) : resolve(stderr))));
  });
  const m = /maxrss=(\d+)KiB/.exec(out);
  return { maxrssKiB: m ? Number(m[1]) : null };
}

before(async () => {
  set = await prepareSet();
  mkdirSync(OUT, { recursive: true });
  if (!FAITHFUL) return;
  const app = await launchApp();
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000 });
    const J = JSON.stringify;
    // the clips are generated progressive; answering the field-order question keeps idet's
    // verdict on 80x44 pictures out of the measurement
    const plan = (path, options) => app.eval(`__TAURI__.core.invoke("video_enhance_plan", ${J({ path, options, fieldOrder: "progressive" })})`, { timeoutMs: 60000 });
    for (const c of set.manifest.clips) {
      const input = join(set.dir(c.id), "input.mkv");
      const light = await plan(input, { denoise: "light", sharpen: "light", upscale: true });
      const medium = await plan(input, { denoise: "medium", sharpen: "medium", upscale: true });
      for (const r of [light, medium]) assert.notEqual(r.assessment.status, "blocked", `${c.id}: ${r.assessment.blockers}`);
      chains[c.id] = { light: measurableChain(light.filter), medium: measurableChain(medium.filter), product: light.filter, productSize: [light.recipe.scale.width, light.recipe.scale.height] };
    }
  } finally {
    await app.close();
  }
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
    if (chains[c.id]) {
      for (const level of ["light", "medium"]) outputs.push({ name: `faithful-${level}`, path: join(OUT, `faithful-${level}--${c.id}.mkv`), vf: chains[c.id][level] });
    }
    for (const name of candidates) {
      const p = join(CANDIDATES, name, `${c.id}.mkv`);
      if (existsSync(p)) outputs.push({ name: `candidate:${name}`, path: p });
    }
    for (const o of outputs) {
      const t0 = Date.now();
      const bench = o.vf ? await benchRun(["-i", join(dir, "input.mkv"), "-vf", `${o.vf},format=bgr0`, "-c:v", "ffv1", o.path]) : {};
      const ms = Date.now() - t0;
      // the faithful chain as the product writes it (x2, product encoder): real output size
      let product = null;
      if (o.name === "faithful-light") {
        const p = join(OUT, `product--${c.id}.mkv`);
        const enc = await benchRun(["-i", join(dir, "input.mkv"), "-vf", chains[c.id].product, "-c:v", "h264_mf", "-rate_control", "quality", "-quality", "65", p])
          .catch(() => benchRun(["-i", join(dir, "input.mkv"), "-vf", chains[c.id].product, "-c:v", "mpeg4", "-q:v", "3", p]).then((r) => ({ ...r, fallback: "mpeg4" })));
        product = { size: chains[c.id].productSize, bytes: statSync(p).size, inputBytes: statSync(join(dir, "input.mkv")).size, encoder: enc.fallback ?? "h264_mf q65", maxrssKiB: enc.maxrssKiB };
      }
      const out = await readFrames(o.path);
      assert.equal(out.width, ref.width, `${c.id}/${o.name}: width`);
      assert.equal(out.height, ref.height, `${c.id}/${o.name}: height`);
      assert.equal(out.frames.length, ref.frames.length, `${c.id}/${o.name}: frame count`);
      const m = videoMetrics(out, ref);
      results.push({ id: c.id, profile: o.name, categories: c.categories, split: c.split, ms, maxrssKiB: bench.maxrssKiB ?? null, chain: o.vf ?? null, product, metrics: m });
      log(`${c.id} ${o.name} ${ms} ms: ${JSON.stringify(roundAll(m, 3))}`);
    }
  }
  complete = true;
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
  if (!complete) return t.skip("the profile run did not finish: the baseline is neither compared nor rewritten");
  const section = Object.fromEntries(results.filter((r) => !r.profile.startsWith("candidate:")).map((r) => [`${r.id}|${r.profile}`, roundAll(r.metrics)]));
  const meta = { date: new Date().toISOString().slice(0, 10), ffmpeg: set.version, profiles: [...new Set(results.map((r) => r.profile).filter((p) => !p.startsWith("candidate:")))] };
  writeResult("video", { meta, results: results.map((r) => ({ ...r, metrics: roundAll(r.metrics) })) });
  const lines = ["# Video quality run " + meta.date, "", "| clip | profile | ms | peak MiB | PSNR | PSNR min | SSIM | temporal error | temporal change |", "|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => { const m = roundAll(r.metrics, 3); return `| ${r.id} | ${r.profile} | ${r.ms} | ${r.maxrssKiB ? (r.maxrssKiB / 1024).toFixed(0) : "—"} | ${m.psnr} | ${m.psnrMin} | ${m.ssim} | ${m.temporalError} | ${m.temporalChange} |`; }),
    "", "Product-size output of faithful-light (x2, product encoder):", "", "| clip | size | encoder | output bytes | input bytes | ratio |", "|---|---|---|---|---|---|",
    ...results.filter((r) => r.product).map((r) => `| ${r.id} | ${r.product.size.join("x")} | ${r.product.encoder} | ${r.product.bytes} | ${r.product.inputBytes} | ${(r.product.bytes / r.product.inputBytes).toFixed(2)} |`),
    "", "Chains (faithful profiles):", "", ...[...new Map(results.filter((r) => r.profile.startsWith("faithful")).map((r) => [r.profile, r.chain])).entries()].map(([k, v]) => `- ${k}: \`${v}\``)];
  writeFileSync(join(RESULTS_DIR, "video-report.md"), lines.join("\n") + "\n");
  if (UPDATE) {
    saveSection("video", section, meta);
    t.diagnostic("baseline section 'video' rewritten");
    return;
  }
  const problems = compareSection(loadBaseline().video?.metrics, section);
  assert.deepEqual(problems, [], problems.join("\n"));
});
