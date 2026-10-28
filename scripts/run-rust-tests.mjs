// Rust layer runner (D01): `cargo test --release --lib --locked` with the same JSON summary as the
// other layers (tests/.results/rust.json), so scripts/release-gate.mjs can read it.
//
//   node scripts/run-rust-tests.mjs                 npm run test:rust
//   node scripts/run-rust-tests.mjs --offline       extra cargo flags are passed through
//   node scripts/run-rust-tests.mjs restoration     a name filter: recorded as a partial run (full: false)
//   node scripts/run-rust-tests.mjs -- --skip=x     libtest options too: --skip / --exact / --ignored make it partial
// "full" needs libtest's own count: every "test result" line with 0 filtered out.
//
// `#[ignore]` tests are counted as skips (never as passes) and listed by name; the gate decides
// which of them are declared manual tools. The cargo exit code is kept.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Whole layer: no filter / skip option, cargo got as far as a result line, libtest filtered nothing out. */
export const isFullRun = (s, filters) => filters.length === 0 && s.resultLines > 0 && s.filteredOut === 0;

/** Counts and names from `cargo test` output (libtest's plain format). */
export function parseCargoTest(text) {
  const s = { pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0, skipped: [], failed: [], todos: [], resultLines: 0, filteredOut: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored(?:, (.*))?)$/);
    if (m) {
      if (m[2] === "ok") s.pass++;
      else if (m[2] === "FAILED") { s.fail++; s.failed.push({ name: m[1], file: "rust" }); }
      else { s.skip++; s.skipped.push({ name: m[1], file: "rust", reason: m[3] ?? "#[ignore]" }); }
      continue;
    }
    if (/^test result: /.test(line)) {
      s.resultLines++;
      s.filteredOut += Number(/(\d+) filtered out/.exec(line)?.[1] ?? 0);
    }
  }
  return s;
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function main() {
  const extra = process.argv.slice(2);
  // cargo arguments before `--`, libtest arguments after it
  const sep = extra.indexOf("--");
  const cargoArgs = sep < 0 ? extra : extra.slice(0, sep);
  const testArgs = sep < 0 ? [] : extra.slice(sep + 1);
  const filters = [
    ...cargoArgs.filter((a) => !a.startsWith("-")),
    ...testArgs.filter((a, i) => !a.startsWith("-") && !/^--(skip|test-threads|format|color|logfile|report-time)$/.test(testArgs[i - 1] ?? "")),
    ...testArgs.filter((a, i) => /^--(skip|exact|ignored)(=|$)/.test(a) || testArgs[i - 1] === "--skip"),
  ];
  const args = ["test", "--release", "--lib", "--locked", "--manifest-path", "src-tauri/Cargo.toml", ...extra];
  const commit = git("rev-parse", "--short", "HEAD");
  const dirty = commit ? git("status", "--porcelain", "--untracked-files=no") !== "" : null;
  console.log(`VHO tests — layer: rust · commit ${commit}${dirty ? " (+ uncommitted changes)" : ""} · cargo ${args.join(" ")}`);
  const started = Date.now();
  const child = spawn("cargo", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
  const code = await new Promise((res) => child.once("exit", (c, sig) => res(c ?? (sig ? 1 : 0))));
  const s = parseCargoTest(out);
  const { resultLines, filteredOut, ...counts } = s;
  mkdirSync(join(ROOT, "tests", ".results"), { recursive: true });
  writeFileSync(join(ROOT, "tests", ".results", "rust.json"), JSON.stringify({
    layer: "rust", commit, commitFull: git("rev-parse", "HEAD") || null, dirty, platform: `${process.platform}-${process.arch}`,
    // no test-result line: cargo stopped before running (compile error)
    full: isFullRun(s, filters), files: ["src-tauri (cargo test --lib)"], filters, filteredOut,
    finished: new Date().toISOString(), exe: null, exitCode: code, ...counts,
  }, null, 2));
  console.log(`\nSUMMARY rust: pass ${s.pass} · fail ${s.fail} · ignored ${s.skip} (not counted as passed) · ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const t of s.skipped) console.log(`  ignored: ${t.name}`);
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
