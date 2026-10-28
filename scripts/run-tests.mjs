// Test layer runner (Q01). One entry point per layer, see docs/status/test-map.md:
//
//   node scripts/run-tests.mjs unit     [files | node --test flags]   npm test        (network-free, fast)
//   node scripts/run-tests.mjs e2e      [files | flags]                npm run e2e     (release binary, CDP)
//   node scripts/run-tests.mjs ai       [files | flags]                npm run test:ai (real models, cache)
//   node scripts/run-tests.mjs quality  [files | flags]                npm run test:quality (Q02, not populated)
//
// What it adds on top of `node --test`:
// - unit: preloads tests/lib/no-network.mjs (every non-loopback connection fails).
// - e2e/ai: resolves the binary once (VHO_EXE or src-tauri/target/release/vho.exe), logs its
//   path, size, build time and whether it is older than the sources, and hands the same
//   absolute path to every test file via VHO_EXE.
// - every layer: pass / fail / skip / todo / cancelled counted separately (skips are never
//   passes), skipped and failed tests listed with reasons, JSON copy in tests/.results/<layer>.json.
//   VHO_TEST_NO_SKIP=1 turns any skip into a failing exit code (release candidates / CI).
// Extra arguments: paths ending in .mjs replace the layer's default file list; everything
// else is passed to `node --test` (e.g. --test-name-pattern=...).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LAYERS = {
  unit: { dir: "tests/unit", suffix: ".test.mjs", concurrency: null, guard: true, exe: false },
  e2e: { dir: "tests/e2e", suffix: ".e2e.mjs", concurrency: 1, guard: false, exe: true },
  ai: { dir: "tests/ai", suffix: ".ai.mjs", concurrency: 1, guard: false, exe: true },
  quality: { dir: "tests/quality", suffix: ".quality.mjs", concurrency: 1, guard: false, exe: true },
};

const [layerName, ...rest] = process.argv.slice(2);
const layer = LAYERS[layerName];
if (!layer) {
  console.error(`usage: node scripts/run-tests.mjs <${Object.keys(LAYERS).join("|")}> [files] [node --test flags]`);
  process.exit(2);
}

const fileArgs = rest.filter((a) => a.endsWith(".mjs") && !a.startsWith("-"));
const flagArgs = rest.filter((a) => !fileArgs.includes(a));
const dir = join(ROOT, layer.dir);
const files = fileArgs.length
  ? fileArgs.map((f) => resolve(f))
  : existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(layer.suffix)).sort().map((f) => join(dir, f)) : [];

const line = (s = "") => console.log(s);
const rel = (p) => relative(ROOT, p) || ".";

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Newest modification time below the given paths (files only). */
function newestMtime(paths) {
  let newest = { t: 0, path: "" };
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e));
    } else if (st.mtimeMs > newest.t) {
      newest = { t: st.mtimeMs, path: p };
    }
  };
  paths.forEach((p) => walk(join(ROOT, p)));
  return newest;
}

const header = [`VHO tests — layer: ${layerName} (${files.length} file${files.length === 1 ? "" : "s"})`];
const commit = git("rev-parse", "--short", "HEAD");
if (commit) header.push(`commit: ${commit}${git("status", "--porcelain") ? " (+ uncommitted changes)" : ""}`);
header.push(`node: ${process.version} · ${process.platform}-${process.arch}`);

const env = { ...process.env };
let exeInfo = null;
if (layer.exe) {
  const { defaultExe, mpvStaged } = await import(pathToFileURL(join(ROOT, "tests/e2e/lib/app.mjs")).href);
  const exe = resolve(defaultExe());
  env.VHO_EXE = exe; // every test file launches exactly this binary
  if (existsSync(exe)) {
    const st = statSync(exe);
    const src = newestMtime(["src", "src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
    exeInfo = { path: exe, bytes: st.size, built: st.mtime.toISOString(), stale: src.t > st.mtimeMs ? rel(src.path) : null };
    header.push(`binary: ${exe}`);
    header.push(`        ${(st.size / 1048576).toFixed(1)} MB, built ${st.mtime.toISOString()}, libmpv ${mpvStaged(exe) ? "staged" : "NOT staged (HTML5 engine only)"}`);
    if (exeInfo.stale) header.push(`WARNING: binary is older than ${exeInfo.stale} — rebuild (npm run build:release) to test the current sources`);
  } else {
    exeInfo = { path: exe, missing: true };
    header.push(`binary: ${exe} (NOT FOUND — build it first: npm run build:release, or set VHO_EXE)`);
  }
  const lo = env.VHO_E2E_PORT_MIN || "9500", hi = env.VHO_E2E_PORT_MAX || "9599";
  header.push(`CDP ports: ${lo}-${hi}`);
}
if (layer.guard) header.push("network: blocked for non-loopback hosts (tests/lib/no-network.mjs)");
line("=".repeat(78));
header.forEach((h) => line(h));
line("=".repeat(78));

// A missing binary fails every test at launch; stop here instead of running (and possibly hanging)
if (exeInfo?.missing) {
  line(`FAILED: no app binary at ${exeInfo.path} — nothing was run. Run \`npm ci\` and \`npm run build:release\` first, or set VHO_EXE.`);
  process.exit(2);
}

if (!files.length) {
  line(`No ${layer.suffix} files in ${layer.dir}: this layer is NOT YET POPULATED (0 tests run, nothing passed).`);
  if (layerName === "quality") line("Planned by Q02 (docs/plans/14-kalite-ve-acik-kaynak-yayin.md); see docs/status/test-map.md.");
  process.exit(0);
}

const resultsDir = join(ROOT, "tests", ".results");
mkdirSync(resultsDir, { recursive: true });
const summaryFile = join(resultsDir, `${layerName}.json`);

const nodeArgs = [];
if (layer.guard) nodeArgs.push("--import", pathToFileURL(join(ROOT, "tests/lib/no-network.mjs")).href);
// --test-force-exit: a test that leaves a handle open (a server after a failed launch) must not keep
// the run alive after all tests finished
nodeArgs.push("--test", "--test-force-exit");
if (layer.concurrency) nodeArgs.push(`--test-concurrency=${layer.concurrency}`);
nodeArgs.push(
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  `--test-reporter=${pathToFileURL(join(ROOT, "tests/lib/summary-reporter.mjs")).href}`, `--test-reporter-destination=${summaryFile}`,
  ...flagArgs, ...files,
);

const started = Date.now();
const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, env, stdio: "inherit" });
const forward = (sig) => () => child.kill(sig); // stop only our own child
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
const code = await new Promise((res) => child.once("exit", (c, sig) => res(c ?? (sig ? 1 : 0))));

let s = null;
try {
  s = JSON.parse(readFileSync(summaryFile, "utf8"));
} catch {
  // reporter did not finish (e.g. the runner crashed before any event)
}
line();
line("=".repeat(78));
line(`SUMMARY ${layerName}: ${s ? `pass ${s.pass} · fail ${s.fail} · skip ${s.skip} · todo ${s.todo} · cancelled ${s.cancelled}` : "no summary"} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (exeInfo) line(`binary tested: ${exeInfo.path}${exeInfo.missing ? " (missing)" : `, built ${exeInfo.built}`}${exeInfo.stale ? " (OLDER THAN SOURCES)" : ""}`);
if (s?.skipped.length) {
  line("skipped (not counted as passed):");
  for (const t of s.skipped) line(`  - ${t.file} › ${t.name}${t.reason ? ` — ${t.reason}` : ""}`);
}
if (s?.failed.length) {
  line("failed / cancelled:");
  for (const t of s.failed) line(`  - ${t.file} › ${t.name}${t.error ? ` — ${t.error}` : ""}`);
}
line("=".repeat(78));

if (s) {
  // keep the binary information next to the counts for CI artifacts
  const { writeFileSync } = await import("node:fs");
  writeFileSync(summaryFile, JSON.stringify({ layer: layerName, commit, exe: exeInfo, exitCode: code, ...s }, null, 2));
}
let exit = code;
if (exit === 0 && s && process.env.VHO_TEST_NO_SKIP === "1" && s.skip + s.todo > 0) {
  line(`VHO_TEST_NO_SKIP=1: ${s.skip + s.todo} skipped/todo test(s) -> failing`);
  exit = 1;
}
process.exit(exit);
