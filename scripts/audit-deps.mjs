// Q04: known vulnerabilities in the Rust crates (Cargo.lock) and npm packages (package-lock.json),
// looked up in the OSV database (https://osv.dev, which includes the RustSec and GitHub advisories).
// Only package names and versions are sent; no source, paths or user data. Needs network, so it
// is not part of `npm test`. Every finding must be reviewed (reachable? fixed version?) and
// recorded in docs/security/q04-review.md; there is no silent allowlist.
//
//   npm run audit:deps            # table; exit 1 when anything is found
//   npm run audit:deps -- --json  # machine-readable list
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OSV = "https://api.osv.dev/v1";

function cratesFromLock() {
  const text = readFileSync(join(ROOT, "src-tauri/Cargo.lock"), "utf8");
  const out = [];
  for (const block of text.split(/\r?\n\[\[package\]\]\r?\n/).slice(1)) {
    const get = (k) => block.match(new RegExp(`^${k} = "([^"]+)"`, "m"))?.[1];
    if (get("source")?.startsWith("registry+")) out.push({ ecosystem: "crates.io", name: get("name"), version: get("version") });
  }
  return out;
}

function npmFromLock() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([path, p]) => path && p.version && !p.link)
    .map(([path, p]) => ({ ecosystem: "npm", name: path.slice(path.lastIndexOf("node_modules/") + 13), version: p.version, dev: !!p.dev }));
}

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

const pkgs = [...cratesFromLock(), ...npmFromLock()];
const findings = [];
for (let i = 0; i < pkgs.length; i += 500) {
  const chunk = pkgs.slice(i, i + 500);
  const res = await post(`${OSV}/querybatch`, { queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) });
  res.results.forEach((r, j) => { for (const v of r.vulns ?? []) findings.push({ ...chunk[j], id: v.id }); });
}
for (const f of findings) {
  const r = await fetch(`${OSV}/vulns/${f.id}`);
  const v = r.ok ? await r.json() : {};
  f.summary = v.summary ?? v.details?.split("\n")[0] ?? "";
  f.aliases = v.aliases ?? [];
  f.withdrawn = !!v.withdrawn;
  // RustSec: unmaintained / unsound / notice
  f.informational = v.database_specific?.informational ?? (v.affected ?? []).map((a) => a.database_specific?.informational).find(Boolean) ?? null;
  f.fixed = (v.affected ?? []).flatMap((a) => (a.ranges ?? []).flatMap((rg) => rg.events.filter((e) => e.fixed).map((e) => e.fixed)));
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ checked: pkgs.length, findings }, null, 2));
} else {
  console.log(`OSV: ${pkgs.length} packages checked (${pkgs.filter((p) => p.ecosystem === "crates.io").length} crates, ${pkgs.filter((p) => p.ecosystem === "npm").length} npm)`);
  for (const f of findings) {
    const kind = f.withdrawn ? "withdrawn" : f.informational ?? "vulnerability";
    console.log(`  ${f.ecosystem} ${f.name}@${f.version}${f.dev ? " (dev)" : ""}  ${f.id} [${kind}]  fixed: ${f.fixed.join(", ") || "-"}\n      ${f.summary}`);
  }
  console.log(findings.length ? `${findings.length} finding(s): review each in docs/security/q04-review.md` : "no known vulnerabilities");
}
process.exit(findings.length ? 1 : 0);
