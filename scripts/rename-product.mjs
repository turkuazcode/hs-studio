// Product rename "VHO" -> "HS Studio" in ONE step (docs/release/rename-hs-studio.md).
// Run it only at the very end, after all agent branches are merged into main.
//
//   node scripts/rename-product.mjs                                   # dry run: list every change
//   node scripts/rename-product.mjs --apply --identifier com.hsstudio.app [--name "HS Studio"]
//        [--exe-name "HS Studio"]   # optional: name of the installed .exe (default: keep vho.exe)
//   node scripts/rename-product.mjs --verify                          # only the leftover check
//
// What changes: product name, window title, bundle identifier (+ the data-migration entry in
// src-tauri/src/identity.rs), file-association names, user-visible app strings (index.html,
// TR/EN dictionaries, About box, default file/folder names, HTTP user agent), README/CONTRIBUTING/
// SECURITY, notices title, SBOM product name, source-offer text, CHANGELOG entry, and the two test
// assertions that check user-visible text.
// What stays (and why) is listed in KEEP below and in the doc. Afterwards the verification step
// greps the user-visible files for a leftover "VHO" (outside "formerly VHO" mentions).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OLD_NAME = "VHO";
export const OLD_IDENTIFIER = "com.vho.app";

/** Intentionally unchanged (documentation for the dry-run output and the doc). */
export const KEEP = [
  "Environment variables VHO_* (VHO_DATA_DIR, VHO_EXE, VHO_MPV_DLL, …): developer/test switches, not user-visible; renaming them would break scripts, CI and other branches.",
  "Crate/package names (vho, vho_lib, package.json \"vho\"), the built file target/release/vho.exe and file names like vho-*.cdx.json: code identifiers; the installed exe can be renamed with --exe-name.",
  "Test identities \"VHO PackageTest\" / com.vho.app.packagetest and synthetic test data (\"VHO Test\" EXIF make, OCR sample text): not user-visible.",
  "Git history, CHANGELOG entries of earlier changes, docs/plans/*, docs/status/*, docs/adr/*: historical records (a new CHANGELOG line documents the rename).",
  "\"formerly VHO\" / \"eski adı VHO\" mentions in NOTICE, TRADEMARKS, README, notices: they name the old product on purpose.",
  "Code comments and log prefixes ([VHO] …): not shown to users; can be cleaned up later without risk.",
  "Legacy names used for migration: com.vho.app in identity.rs and the NSIS hook's previous product name \"VHO\" (package-windows.ps1).",
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "VHO" as a word, not part of VHO_* / vho.exe, not in "formerly VHO"-style mentions. */
const WORD = /(?<!formerly |formerly the working name \*\*|eski çalışma adı \*\*|eski adı |\(formerly |\(eski adı |[\w-])VHO(?![\w_])/g;

/** Every edit: { file, replace: [[from(string|RegExp), to]], json?: true (validate after) }. */
export function rules({ name, identifier, exeName }) {
  const ua = name.replace(/\s+/g, "-");
  const r = [
    {
      file: "src-tauri/tauri.conf.json", json: true,
      replace: [
        [`"productName": "${OLD_NAME}",`, `"productName": "${name}",${exeName ? `\n  "mainBinaryName": "${exeName}",` : ""}`],
        [`"identifier": "${OLD_IDENTIFIER}",`, `"identifier": "${identifier}",`],
        [`"title": "${OLD_NAME} - Video H Oynatıcısı",`, `"title": "${name}",`],
        [/"name": "VHO (Video|Audio|Image|Subtitle)"/g, `"name": "${name} $1"`],
      ],
    },
    { file: "src-tauri/Cargo.toml", replace: [[`description = "${OLD_NAME} - Video H Oynatıcısı: `, `description = "${name}: `]] },
    {
      file: "src-tauri/src/identity.rs",
      replace: [["    // RENAME-PRODUCT: migration entry (inserted by scripts/rename-product.mjs)\n",
        `    // RENAME-PRODUCT: migration entry (inserted by scripts/rename-product.mjs)\n    ("${identifier}", &["${OLD_IDENTIFIER}"]),\n`]],
    },
    { file: "src-tauri/src/actions/mod.rs", replace: [['base.join("VHO")', `base.join("${name}")`], ['"Videos\\VHO"', `"Videos\\${name}"`]] },
    { file: "src-tauri/src/engine/mod.rs", replace: [['d.join("VHO")', `d.join("${name}")`], ['"VHO".to_string()', `"${name}".to_string()`]] },
    { file: "src-tauri/src/ai/download.rs", replace: [['concat!("VHO/", env!("CARGO_PKG_VERSION"))', `concat!("${ua}/", env!("CARGO_PKG_VERSION"))`]] },
    { file: "src/index.html", replace: [[WORD, name]] },
    { file: "src/i18n/tr.json", json: true, replace: [[WORD, name]] },
    { file: "src/i18n/en.json", json: true, replace: [[WORD, name]] },
    { file: "src/ui/settings-modal.js", replace: [['el("strong", { text: "VHO" }', `el("strong", { text: "${name}" }`]] },
    { file: "src/media/photo-ai.js", replace: [['|| "VHO")', `|| "${name}")`]] },
    { file: "src/media/snapshot.js", replace: [['|| "VHO")', `|| "${name}")`]] },
    { file: "legal/NOTICES_HEADER.txt", replace: [[`${OLD_NAME} (Video H Oynatıcısı) — LİSANSLAR VE TEŞEKKÜRLER`, `${name} (formerly VHO) — LİSANSLAR VE TEŞEKKÜRLER`]] },
    { file: "legal/generate-sbom.mjs", replace: [['name: "VHO", version: appVersion', `name: "${name}", version: appVersion`], ['"VHO (Video H Oynaticisi) - ', `"${name} (formerly VHO) - `]] },
    { file: "legal/SOURCE-OFFER.txt", replace: [[`Product: ${OLD_NAME} (to be renamed HS Studio), version`, `Product: ${name} (formerly VHO), version`]] },
    {
      file: "README.md",
      replace: [
        [`${OLD_NAME} — Video H Oynatıcısı`, name],
        [`**${OLD_NAME} (Video H Oynatıcısı)**`, `**${name}** (eski adı VHO)`],
        [WORD, name],
      ],
    },
    { file: "CONTRIBUTING.md", replace: [[WORD, name]] },
    { file: "SECURITY.md", replace: [[WORD, name]] },
    {
      file: "CHANGELOG.md",
      // the rename is recorded once; after the first release it lives in that release's section
      done: (text) => text.includes(`Product name **${name}**`) || text.includes(`Product renamed to **${name}**`),
      replace: [["## [Unreleased]\n", `## [Unreleased]\n\n- Product renamed to **${name}** (formerly VHO). On first start the app copies the data of\n  the old identifier (${OLD_IDENTIFIER}) to ${identifier}; the installer removes an old per-user "VHO"\n  install first. Exports now go to the "${name}" folder (existing "VHO" folders are left as they are).\n`]],
    },
    { file: "tests/unit/i18n-coverage.test.mjs", replace: [["const NEUTRAL_TEXT = /^(VHO.*|", `const NEUTRAL_TEXT = /^(VHO.*|${esc(name)}.*|`]] },
    { file: "tests/e2e/storage.e2e.mjs", replace: [["/daha yeni bir VHO sürümüne ait/", `/daha yeni bir ${esc(name)} sürümüne ait/`]] },
  ];
  return r;
}

/** Files where a remaining user-visible "VHO" is a defect after the rename. */
export const VERIFY_FILES = [
  "src/index.html", "src/i18n/tr.json", "src/i18n/en.json", "src/ui/settings-modal.js", "README.md", "CONTRIBUTING.md",
  "SECURITY.md", "src-tauri/tauri.conf.json",
];

function apply1(text, [from, to]) {
  if (typeof from === "string") {
    const parts = text.split(from);
    return { next: parts.join(to), count: parts.length - 1 };
  }
  const count = (text.match(from) ?? []).length;
  return { next: text.replace(from, to), count };
}

/** Leftover user-visible "VHO" (line numbers) in VERIFY_FILES. */
export function verify(root = ROOT) {
  const out = [];
  for (const f of VERIFY_FILES) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (f === "src-tauri/tauri.conf.json" && !/"(productName|title|name|identifier)"/.test(line)) return;
      if (/com\.vho\.app/.test(line) && f !== "src-tauri/tauri.conf.json") return;
      WORD.lastIndex = 0;
      if (WORD.test(line)) out.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    if (f === "src-tauri/tauri.conf.json" && /"identifier": "com\.vho\.app"/.test(readFileSync(p, "utf8"))) out.push(`${f}: identifier still ${OLD_IDENTIFIER}`);
  }
  return out;
}

/**
 * Plans (dry run) or applies the rename under `root`. Returns { changes: [{file, count}], missing, errors }.
 * Idempotent: a second --apply finds nothing to change.
 */
export function run({ root = ROOT, apply = false, name = "HS Studio", identifier, exeName } = {}) {
  if (apply && !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(identifier ?? "")) {
    throw new Error("--apply needs --identifier (reverse-DNS, lower case, e.g. com.hsstudio.app); see docs/release/rename-hs-studio.md");
  }
  const changes = [];
  const missing = [];
  const errors = [];
  for (const rule of rules({ name, identifier: identifier ?? "<identifier>", exeName })) {
    const p = join(root, rule.file);
    if (!existsSync(p)) { missing.push(rule.file); continue; }
    const before = readFileSync(p, "utf8");
    if (rule.done?.(before)) continue;
    let text = before;
    let count = 0;
    for (const rep of rule.replace) {
      // already applied (idempotency): the target text is present and the source is gone
      if (typeof rep[0] === "string" && (!text.includes(rep[0]) || text.includes(rep[1]))) continue;
      const r = apply1(text, rep);
      text = r.next;
      count += r.count;
    }
    if (text === before) continue;
    if (rule.json) {
      try { JSON.parse(text); } catch (e) { errors.push(`${rule.file}: invalid JSON after rename (${e.message})`); continue; }
    }
    changes.push({ file: rule.file, count });
    if (apply) writeFileSync(p, text);
  }
  return { changes, missing, errors };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  if (args.includes("--verify")) {
    const left = verify();
    left.forEach((l) => console.log(`  leftover  ${l}`));
    console.log(left.length ? `${left.length} leftover user-visible "VHO"` : "no leftover user-visible VHO");
    process.exitCode = left.length ? 1 : 0;
    return;
  }
  const apply = args.includes("--apply");
  const name = opt("--name", "HS Studio");
  const identifier = opt("--identifier", null);
  const exeName = opt("--exe-name", null);
  const r = run({ apply, name, identifier, exeName });
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: "${OLD_NAME}" -> "${name}", identifier ${OLD_IDENTIFIER} -> ${identifier ?? "<--identifier required for --apply>"}${exeName ? `, exe "${exeName}.exe"` : ""}`);
  for (const c of r.changes) console.log(`  ${String(c.count).padStart(3)}  ${c.file}`);
  for (const m of r.missing) console.log(`  MISSING  ${m}`);
  for (const e of r.errors) console.log(`  ERROR  ${e}`);
  console.log("\nKept on purpose:");
  KEEP.forEach((k) => console.log(`  - ${k}`));
  if (apply) {
    const left = verify();
    console.log(`\nVerification: ${left.length ? `${left.length} leftover user-visible "VHO"` : "no leftover user-visible VHO"}`);
    left.forEach((l) => console.log(`  ${l}`));
    console.log("\nNext: regenerate notices + SBOM, npm test, full check, installer test (docs/release/rename-hs-studio.md).");
    if (left.length || r.errors.length) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
