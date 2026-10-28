// Removes app folders left behind by test instances of VHO. DRY RUN by default.
//
//   node scripts/clean-test-artifacts.mjs            list what would be removed
//   node scripts/clean-test-artifacts.mjs --apply    remove it
//   options: --min-age-hours=2
//
// Only these exact names directly under %APPDATA% and %LOCALAPPDATA% are candidates:
//   com.turkuazcode.hsstudio.test<16 hex> / com.vho.app.test<16 hex> (before the rename)
//                                  test identity of a VHO_DATA_DIR run (platform.rs test_identifier)
//   com.vho.app.packagetest<...> / com.hsstudio.app.packagetest<...>
//                                  package-test identity — only when no installed app with that
//                                  identifier is registered (Uninstall keys, HKCU + HKLM)
// Never the real app folders (com.turkuazcode.hsstudio, com.vho.app) or anything else
// (tests/lib/test-identity.mjs). A folder is skipped when it changed within the
// minimum age (default 2 h: a test may be running) or when it is in use (renaming it fails on
// Windows while a process holds a handle inside it).
import { execFileSync } from "node:child_process";
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_TEST_ID, TEST_ID } from "../tests/lib/test-identity.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? true]; }));
const APPLY = !!args.apply;
const MIN_AGE_MS = Number(args["min-age-hours"] ?? 2) * 3600e3;

const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);

function registered(identifier) {
  for (const hive of ["HKCU", "HKLM"]) {
    try {
      const out = execFileSync("reg", ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", identifier],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      if (/End of search: [1-9]/.test(out) || out.includes(identifier)) return true;
    } catch {
      // reg exits 1 when nothing matched
    }
  }
  return false;
}

/** Size and newest modification time below a folder (no symlink following). */
function scan(dir) {
  let bytes = 0, newest = statSync(dir).mtimeMs, files = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isSymbolicLink()) continue;
      const st = statSync(q);
      newest = Math.max(newest, st.mtimeMs);
      if (e.isDirectory()) walk(q);
      else { bytes += st.size; files++; }
    }
  };
  try { walk(dir); } catch { /* unreadable entry: counted as far as possible */ }
  return { bytes, newest, files };
}

const found = [], skipped = [];
for (const root of roots) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const name = e.name;
    const isTest = TEST_ID.test(name);
    const isPackageTest = PACKAGE_TEST_ID.test(name);
    if (!isTest && !isPackageTest) continue;
    const dir = join(root, name);
    if (isPackageTest && registered(name)) { skipped.push({ dir, why: "package-test identity is registered as installed" }); continue; }
    const s = scan(dir);
    if (Date.now() - s.newest < MIN_AGE_MS) { skipped.push({ dir, why: `changed ${Math.round((Date.now() - s.newest) / 60000)} min ago` }); continue; }
    found.push({ dir, ...s });
  }
}

let removed = 0, freed = 0;
const failed = [];
for (const f of found) {
  if (!APPLY) continue;
  // in-use check: a folder with an open handle inside cannot be renamed on Windows
  const probe = `${f.dir}.vho-clean-${process.pid}`;
  try {
    renameSync(f.dir, probe);
  } catch (e) {
    failed.push({ dir: f.dir, why: `in use (${e.code})` });
    continue;
  }
  try {
    rmSync(probe, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    removed++;
    freed += f.bytes;
  } catch (e) {
    failed.push({ dir: probe, why: e.code });
  }
}

const MB = (b) => (b / 1048576).toFixed(1);
const total = found.reduce((s, f) => s + f.bytes, 0);
console.log(`test identity folders older than ${MIN_AGE_MS / 3600e3} h: ${found.length} (${MB(total)} MB, ${found.reduce((s, f) => s + f.files, 0)} files)`);
console.log(`skipped: ${skipped.length}${skipped.length ? "\n  " + skipped.slice(0, 10).map((s) => `${s.dir}: ${s.why}`).join("\n  ") : ""}`);
if (APPLY) {
  console.log(`removed: ${removed} folders, ${MB(freed)} MB freed; failed: ${failed.length}`);
  for (const f of failed.slice(0, 20)) console.log(`  ${f.dir}: ${f.why}`);
} else {
  for (const f of found.slice(0, 10)) console.log(`  would remove ${f.dir} (${MB(f.bytes)} MB)`);
  if (found.length > 10) console.log(`  … and ${found.length - 10} more`);
  console.log("dry run: nothing removed (add --apply)");
}
process.exit(failed.length ? 1 : 0);
