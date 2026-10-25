// npm run bench:media — performance measurements and budgets (Plan 14 Q02).
//
//   node scripts/bench-media.mjs [--runs=3] [--only=startup,first-frame,grid,playback,ai] [--check] [--update-budgets]
//
// Every measurement launches the release binary (same resolution as the test runner: VHO_EXE or
// src-tauri/target/release/vho.exe) with an isolated data dir, exactly like the E2E layer. The
// whole process tree (vho.exe + WebView2 + ffmpeg children) is sampled by
// tests/quality/lib/proc-sampler.ps1 — a small main exe alone proves nothing about weight.
//
//   startup      spawn -> first app document complete (fresh WebView2 profile = cold profile)
//   first-frame  __vhoEngine.openPaths -> first decoded frame, libmpv and HTML5, 1080p H.264
//   grid         5,000-file folder: first grid paint (app-measured), scan, first-screen thumbnails
//   playback     10 s of 1080p H.264 with AI off: CPU seconds of the tree, peak RAM, dropped frames
//   ai           photo-x4 on a 128x128 photo: cold (session/shader creation) and warm run per
//                backend (WebGPU and WASM), peak RAM and GPU memory of the tree
//
// Output: tests/.results/bench/bench-<date>.json (+ .md). --check compares the medians with
// tests/quality/budgets.json and exits 1 when one is over budget. --update-budgets writes new
// budgets = measured median x margin (review the diff; budgets are not goals, they catch
// regressions on the reference machine named in the file).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTML5_ENGINE, defaultExe, launchApp, mpvStaged } from "../tests/e2e/lib/app.mjs";
import { makeBulkFolder } from "../tests/e2e/lib/photo-fixtures.mjs";
import { decodePng } from "../tests/ai/lib/image.mjs";
import { launchAiApp } from "../tests/quality/lib/ai-app.mjs";
import { FFMPEG, ffmpeg, requireTools } from "../tests/quality/lib/ffmpeg.mjs";
import { prepareSet } from "../tests/quality/lib/dataset.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const RUNS = Number(args.runs ?? 3);
const ONLY = new Set(String(args.only ?? "startup,first-frame,grid,playback,ai").split(","));
const BUDGETS = join(ROOT, "tests", "quality", "budgets.json");
const OUT_DIR = join(ROOT, "tests", ".results", "bench");
const WORK = join(ROOT, "tests", ".cache", "bench");
const J = JSON.stringify;
const log = (...a) => console.log("[bench]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
function sampler(pid) {
  const tag = `${pid}-${Date.now()}`;
  const stop = join(tmpdir(), `vho-bench-stop-${tag}`), out = join(tmpdir(), `vho-bench-out-${tag}.json`);
  const ps = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "tests/quality/lib/proc-sampler.ps1"),
    "-RootPid", String(pid), "-StopFile", stop, "-OutFile", out], { stdio: "ignore", windowsHide: true });
  const exited = new Promise((r) => ps.once("exit", r));
  return {
    async stop() {
      writeFileSync(stop, "");
      await Promise.race([exited, sleep(30000)]);
      rmSync(stop, { force: true });
      try {
        const r = JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, ""));
        rmSync(out, { force: true });
        return r;
      } catch { return null; }
    },
  };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const stats = (a) => ({ median: median(a), min: Math.min(...a), max: Math.max(...a), runs: a.map((v) => Math.round(v * 10) / 10) });
const MB = (b) => Math.round((b / 1048576) * 10) / 10;

async function gpuName() {
  return new Promise((res) => {
    const ps = spawn("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '; '"], { windowsHide: true });
    let s = ""; ps.stdout.on("data", (d) => (s += d)); ps.once("exit", () => res(s.trim()));
  });
}

async function makeVideo() {
  mkdirSync(WORK, { recursive: true });
  const p = join(WORK, "testsrc2-1080p30-h264-12s.mp4");
  if (!existsSync(p)) {
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=12", "-f", "lavfi", "-i", "sine=f=440:d=12",
      "-c:v", "h264_mf", "-b:v", "8M", "-pix_fmt", "nv12", "-c:a", "aac", "-shortest", p]);
  }
  return p;
}

// ---------------------------------------------------------------- measurements
async function benchStartup() {
  const loaded = [], cdp = [];
  for (let i = 0; i < RUNS; i++) {
    const app = await launchApp();
    loaded.push(app.timings.loadedMs);
    cdp.push(app.timings.cdpMs);
    await app.close();
    await sleep(1000);
  }
  return { "startup.firstDocumentMs": stats(loaded), "startup.cdpReachableMs": stats(cdp) };
}

/** Time from openPaths to the first decoded frame (polled in the page every few ms). */
async function firstFrame(app, video, engine) {
  return app.eval(`(async () => {
    const t0 = performance.now();
    window.__vhoEngine.openPaths([${J(video)}]);
    const v = document.getElementById("video-element");
    for (;;) {
      if (${J(engine)} === "mpv") {
        const n = await __TAURI__.core.invoke("engine_get", { name: "estimated-frame-number" }).catch(() => null);
        if (typeof n === "number" && n >= 0 && (await __TAURI__.core.invoke("engine_get", { name: "time-pos" }).catch(() => null)) !== null) break;
      } else if ((v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0) break;
      if (performance.now() - t0 > 20000) throw new Error("no first frame in 20 s");
      await new Promise((r) => setTimeout(r, 5));
    }
    return performance.now() - t0;
  })()`, { timeoutMs: 30000 });
}

async function benchFirstFrame(video) {
  const out = {};
  const engines = [["html5", HTML5_ENGINE], ...(mpvStaged() ? [["mpv", {}]] : [])];
  for (const [name, env] of engines) {
    const ms = [];
    for (let i = 0; i < RUNS; i++) {
      const app = await launchApp({ env });
      await sleep(500);
      ms.push(await firstFrame(app, video, name));
      await app.close();
      await sleep(1000);
    }
    out[`firstFrame.${name}.1080pH264Ms`] = stats(ms);
  }
  return out;
}

async function benchGrid() {
  const dir = join(tmpdir(), `vho-bench-grid-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  makeBulkFolder(dir, 5000);
  const paint = [], scan = [], thumbs = [], ram = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      const app = await launchApp();
      const s = sampler(app.proc.pid);
      await app.click("#btn-photo-studio");
      await app.waitFor(`document.querySelectorAll("#ps-tree .ps-tree-node").length > 0`, { message: "folder tree" });
      const t0 = Date.now();
      await app.eval(`(() => { document.getElementById("ps-path-edit").click();
        const i = document.getElementById("ps-path"); i.value = ${J(dir)}; i.form.requestSubmit(); return true; })()`);
      await app.waitFor(`document.getElementById("ps-grid").dataset.loading === "0" && document.getElementById("ps-grid").dataset.total === "5000"`, { timeoutMs: 60000, intervalMs: 20 });
      await app.waitFor(`(() => { const imgs = [...document.querySelectorAll("#ps-grid .ps-cell img")];
        return imgs.length > 0 && imgs.every((i) => i.src.includes("asset") || i.closest(".ps-cell").getBoundingClientRect().top > innerHeight); })()`,
      { timeoutMs: 60000, intervalMs: 20, message: "first screen thumbnails" });
      thumbs.push(Date.now() - t0);
      paint.push(Number(await app.eval(`document.getElementById("ps-grid").dataset.firstPaintMs`)));
      scan.push(Number(await app.eval(`document.getElementById("ps-grid").dataset.scanMs`)));
      const r = await s.stop();
      if (r) ram.push(MB(r.peakWorkingSetBytes));
      await app.close();
      await sleep(1000);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { "grid5000.firstPaintMs": stats(paint), "grid5000.scanMs": stats(scan), "grid5000.firstScreenThumbsColdMs": stats(thumbs), "grid5000.peakTreeRamMB": stats(ram) };
}

async function benchPlayback(video) {
  const out = {};
  const engines = [["html5", HTML5_ENGINE], ...(mpvStaged() ? [["mpv", {}]] : [])];
  for (const [name, env] of engines) {
    const cpu = [], ram = [], drops = [];
    for (let i = 0; i < RUNS; i++) {
      const app = await launchApp({ env });
      await sleep(500);
      await firstFrame(app, video, name);
      await sleep(500);
      const s = sampler(app.proc.pid);
      const t0 = Date.now();
      await sleep(10000);
      const r = await s.stop();
      const secs = (Date.now() - t0) / 1000;
      const dropped = name === "mpv"
        ? Number(await app.eval(`__TAURI__.core.invoke("engine_get", { name: "frame-drop-count" }).catch(() => 0)`)) +
          Number(await app.eval(`__TAURI__.core.invoke("engine_get", { name: "decoder-frame-drop-count" }).catch(() => 0)`))
        : Number(await app.eval(`document.getElementById("video-element").getVideoPlaybackQuality().droppedVideoFrames`));
      if (r) { cpu.push((r.cpuSeconds / Math.max(secs, 1)) * 100); ram.push(MB(r.peakWorkingSetBytes)); }
      drops.push(dropped || 0);
      await app.close();
      await sleep(1000);
    }
    out[`playback.${name}.1080pH264.cpuPercentOfOneCore`] = stats(cpu);
    out[`playback.${name}.1080pH264.peakTreeRamMB`] = stats(ram);
    out[`playback.${name}.1080pH264.droppedFrames`] = stats(drops);
  }
  return out;
}

async function benchAi() {
  const set = await prepareSet();
  const input = decodePng(readFileSync(join(set.dir("r01-lincoln-1863"), "input.png"))); // 128x128 public-domain scan
  const out = {};
  for (const backend of ["webgpu", "wasm"]) {
    const cold = [], warm = [], ram = [], gpuDed = [], gpuShared = [];
    let used = null;
    for (let i = 0; i < RUNS; i++) {
      const ai = await launchAiApp();
      await ai.ensureComponents(["ort-web", "photo-x4"]);
      if (backend === "wasm") await ai.app.eval(`localStorage.setItem("vho.ai.backend", "wasm"), true`);
      else await ai.app.eval(`localStorage.removeItem("vho.ai.backend"), true`);
      const s = sampler(ai.app.proc.pid);
      const a = await ai.upscale(input);
      const b = await ai.upscale(input);
      const r = await s.stop();
      used = a.backend;
      cold.push(a.upMs); warm.push(b.upMs);
      if (r) { ram.push(MB(r.peakWorkingSetBytes)); gpuDed.push(MB(r.peakGpuDedicatedBytes)); gpuShared.push(MB(r.peakGpuSharedBytes)); }
      await ai.app.eval(`localStorage.removeItem("vho.ai.backend"), true`);
      await ai.app.close();
      await sleep(1000);
    }
    if (used !== backend) { log(`ai: ${backend} requested, ran on ${used} (no adapter?) — recorded under ${used}`); }
    const k = `ai.photoX4.128px.${used}`;
    out[`${k}.coldMs`] = stats(cold);
    out[`${k}.warmMs`] = stats(warm);
    out[`${k}.peakTreeRamMB`] = stats(ram);
    out[`${k}.peakGpuDedicatedMB`] = stats(gpuDed);
    out[`${k}.peakGpuSharedMB`] = stats(gpuShared);
  }
  return out;
}

// ---------------------------------------------------------------- main
requireTools();
const exe = resolve(defaultExe());
if (!existsSync(exe)) { console.error(`${exe} not found: npm run build:release`); process.exit(2); }
const env = {
  date: new Date().toISOString(), exe, os: `Windows ${release()}`, cpu: cpus()[0]?.model?.trim(), threads: cpus().length,
  ramGB: Math.round(totalmem() / 1073741824), gpu: await gpuName(), runs: RUNS, mpvStaged: mpvStaged(), ffmpeg: FFMPEG,
};
log(`binary: ${exe}`);
log(`machine: ${env.cpu} (${env.threads} threads), ${env.ramGB} GB RAM, GPU ${env.gpu}; ${RUNS} runs each`);
const video = await makeVideo();
const measured = {};
const steps = { startup: benchStartup, "first-frame": () => benchFirstFrame(video), grid: benchGrid, playback: () => benchPlayback(video), ai: benchAi };
for (const [name, fn] of Object.entries(steps)) {
  if (!ONLY.has(name)) continue;
  const t0 = Date.now();
  log(`${name}…`);
  Object.assign(measured, await fn());
  log(`${name} done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
for (const [k, v] of Object.entries(measured)) log(`${k}: median ${v.median?.toFixed?.(1) ?? v.median} (min ${v.min?.toFixed?.(1)}, max ${v.max?.toFixed?.(1)})`);

mkdirSync(OUT_DIR, { recursive: true });
const stamp = env.date.slice(0, 19).replace(/[:T]/g, "-");
writeFileSync(join(OUT_DIR, `bench-${stamp}.json`), J({ env, measured }, null, 2));

const budgets = existsSync(BUDGETS) ? JSON.parse(readFileSync(BUDGETS, "utf8")) : null;
if (args["update-budgets"]) {
  const MARGIN = 1.5; // generous: these catch regressions, they are not targets
  const b = budgets ?? { about: "", machine: {}, budgets: {} };
  b.about = "Performance budgets on the reference machine (Plan 14 Q02). Value = measured median x 1.5 (rounded up), so only a clear regression fails `npm run bench:media -- --check`. Plan 04/Q02 targets are listed separately under `targets`.";
  b.machine = { cpu: env.cpu, threads: env.threads, ramGB: env.ramGB, gpu: env.gpu, os: env.os, measured: env.date.slice(0, 10) };
  for (const [k, v] of Object.entries(measured)) {
    if (/droppedFrames|peakGpu/.test(k)) { b.budgets[k] = { max: Math.max(5, Math.ceil(v.max * MARGIN)), measuredMedian: v.median }; continue; }
    b.budgets[k] = { max: Math.ceil(v.median * MARGIN), measuredMedian: Math.round(v.median * 10) / 10 };
  }
  b.targets = { "grid5000.firstPaintMs": 2000, "uiFeedbackP95Ms": 200 };
  writeFileSync(BUDGETS, J(b, null, 2) + "\n");
  log(`budgets written: ${BUDGETS}`);
}
let over = [];
if (budgets && args.check) {
  for (const [k, v] of Object.entries(measured)) {
    const b = budgets.budgets[k];
    if (b && v.median > b.max) over.push(`${k}: median ${v.median.toFixed(1)} > budget ${b.max}`);
  }
  if (budgets.machine?.cpu && budgets.machine.cpu !== env.cpu) log(`NOTE: budgets were measured on ${budgets.machine.cpu}; this machine is ${env.cpu} — comparison is indicative only`);
}
console.log("=".repeat(78));
console.log(`bench:media: ${Object.keys(measured).length} measurements, ${RUNS} runs each; results tests/.results/bench/bench-${stamp}.json`);
if (args.check) console.log(over.length ? `OVER BUDGET:\n  ${over.join("\n  ")}` : "all medians within budget");
console.log("=".repeat(78));
process.exit(over.length ? 1 : 0);
