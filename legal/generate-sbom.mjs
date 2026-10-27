// Generates the VHO SBOM (CycloneDX 1.6 JSON) and checks every entry against the license policy
// (docs/plans/00-YOL-HARITASI.md). One file covers:
//   - Rust crates compiled into VHO.exe   (cargo metadata for the target + Cargo.lock checksums)
//   - npm packages                        (package-lock.json; all are dev/build tools, not shipped)
//   - native binaries next to VHO.exe     (legal/inventory/native-windows-x64.json; Windows x64 only)
//   - AI downloads (runtime + weights)    (src-tauri/src/ai/manifest.rs + legal/inventory/models.json)
//   - fonts, icons, vendored JS, ported code, bundled C libraries, test fixtures
//                                         (legal/inventory/assets.json; repo files hashed here)
//
//   node legal/generate-sbom.mjs                       # -> legal/sbom/vho-<version>-<target>.cdx.json
//   node legal/generate-sbom.mjs --target x86_64-unknown-linux-gnu
//   node legal/generate-sbom.mjs --out <file> --timestamp 2026-10-25T00:00:00Z
//   node legal/generate-sbom.mjs --native-dist <dist> [--native-bin <prefix\bin>] [--update-native]
//       compares (or, with --update-native, rewrites) the native inventory's sha256/bytes against
//       a libmpv build (third_party/mpv/_build/dist; ffmpeg.exe/ffprobe.exe from --native-bin or
//       <dist>\..\prefix\bin). Run it on the exact DLL set of a release.
//
// No network: cargo metadata runs with --offline --locked (needs the crates already fetched, e.g.
// after one `cargo build`). Output is deterministic for a given commit: the timestamp defaults to the
// HEAD commit date and the serial number is derived from the content.
// Exit code 1 if any component is rejected by the policy; "review" items are listed, not fatal.
// The project's own license is read from src-tauri/Cargo.toml (`license`), the single place to
// change together with LICENSE if the project license changes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ----------------------------------------------------------------------------- license policy
/** Accepted everywhere (docs/plans/00-YOL-HARITASI.md + public-domain equivalents). */
export const ACCEPTED = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "BSL-1.0", "MPL-2.0",
  "Unicode-3.0", "Unicode-DFS-2016", "CC0-1.0", "CC-BY-4.0", "Unlicense", "blessing",
]);
/** Permissive but not named in the policy list: allowed, listed for the owner to acknowledge. */
export const REVIEW = new Set([
  "0BSD", "CDLA-Permissive-2.0", "FTL", "libpng-2.0", "bzip2-1.0.6", "IJG", "ZPL-2.1", "HPND",
  "HPND-sell-variant", "MPL-1.1", "OFL-1.1",
]);
const LGPL = /^LGPL-(2\.0|2\.1|3\.0)(-only|-or-later|\+)?$/;
const REJECT = /^(A?GPL-|SSPL|BUSL|CC-BY-NC|CC-BY-.*-NC|CC-BY-NC-SA|Commons-Clause|Elastic|Proprietary|LicenseRef-.*(NonCommercial|NC))/i;
const EXCEPTIONS_OK = new Set(["LLVM-exception", "PCRE2-exception", "GCC-exception-3.1", "Classpath-exception-2.0"]);
const RANK = { ok: 0, review: 1, reject: 2 };

/** Normalizes Cargo-style license strings ("MIT/Apache-2.0") into SPDX expressions. */
export function normalizeExpression(s) {
  return String(s).trim().replace(/\s*\/\s*/g, " OR ");
}

/**
 * Policy status of an SPDX expression: "ok" | "review" | "reject".
 * ctx.linking: "static" (compiled into VHO.exe) | "dynamic" (separate DLL, replaceable) | "process"
 * (separate executable) | "download" (fetched at runtime) | "none" (not shipped).
 * ctx.category: "font" allows OFL-1.1. OR picks the best alternative, AND the worst term.
 */
export function evaluateLicense(expression, ctx = {}) {
  const tokens = normalizeExpression(expression).replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let i = 0;
  const term = (id, exc) => {
    if (ctx.linking === "none") return "ok"; // not distributed: listed for completeness only
    if (exc) {
      if (!EXCEPTIONS_OK.has(exc)) return "review";
      if (/^GPL-/.test(id) && exc === "GCC-exception-3.1") return "review"; // allowed runtime exception, owner acknowledges
      return term(id);
    }
    if (ACCEPTED.has(id)) return "ok";
    if (id === "OFL-1.1") return ctx.category === "font" ? "ok" : "reject";
    if (LGPL.test(id)) return ctx.linking === "dynamic" || ctx.linking === "process" ? "ok" : "reject";
    if (REJECT.test(id)) return "reject";
    if (REVIEW.has(id) || /^LicenseRef-/.test(id)) return "review";
    return "review";
  };
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);
  function primary() {
    const t = tokens[i++];
    if (t === "(") {
      const v = orExpr();
      i++; // ")"
      return v;
    }
    if (tokens[i] === "WITH") {
      i++;
      return term(t, tokens[i++]);
    }
    return term(t);
  }
  function andExpr() {
    let v = primary();
    while (tokens[i] === "AND") { i++; v = worst(v, primary()); }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (tokens[i] === "OR") { i++; v = best(v, andExpr()); }
    return v;
  }
  if (!tokens.length) return "review";
  return orExpr();
}

// ----------------------------------------------------------------------------- sources
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
/** Repository text files are hashed with LF line endings so the hash does not depend on the
 *  checkout's core.autocrlf setting; binary files (containing NUL) are hashed as-is. */
const sha256RepoFile = (p) => {
  const b = readFileSync(p);
  const data = b.includes(0) ? b : Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return createHash("sha256").update(data).digest("hex");
};

/** Parses the AI manifest (src-tauri/src/ai/manifest.rs): components with their pinned files. */
export function parseAiManifest(src = readFileSync(join(ROOT, "src-tauri/src/ai/manifest.rs"), "utf8")) {
  const consts = Object.fromEntries([...src.matchAll(/const (\w+): &str = "([^"]+)";/g)].map((m) => [m[1], m[2]]));
  const body = src.slice(src.indexOf("pub fn builtin"));
  const blocks = body.split(/Component \{/).slice(1);
  return blocks.map((b) => {
    const field = (name) => (b.match(new RegExp(`\\b${name}: "([^"]*)"`)) || [])[1];
    const calls = (b.match(/\bfile\(/g) || []).length;
    const files = [...b.matchAll(/\bfile\(\s*(?:&format!\("([^"]+)"\)|"([^"]+)")\s*,\s*"([^"]+)"\s*,\s*"([0-9a-f]{64})"\s*,\s*([\d_]+)\s*\)/g)].map((m) => ({
      url: (m[1] || m[2]).replace(/\{(\w+)\}/g, (_, k) => consts[k] ?? `{${k}}`),
      name: m[3],
      sha256: m[4],
      bytes: Number(m[5].replace(/_/g, "")),
    }));
    if (files.length !== calls) throw new Error(`manifest.rs: could not parse every file() of ${field("id")} (${files.length}/${calls})`);
    return { id: field("id"), version: field("version"), title: field("title"), author: field("author"), license: field("license"), source: field("source"), files };
  });
}

function cargoLockChecksums() {
  const lock = readFileSync(join(ROOT, "src-tauri/Cargo.lock"), "utf8");
  const map = new Map();
  for (const block of lock.split("[[package]]").slice(1)) {
    const g = (k) => (block.match(new RegExp(`^${k} = "([^"]+)"`, "m")) || [])[1];
    if (g("checksum")) map.set(`${g("name")}@${g("version")}`, g("checksum"));
  }
  return map;
}

function rustComponents(target) {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--manifest-path", join(ROOT, "src-tauri/Cargo.toml"), "--filter-platform", target], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] }));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root;
  // scope: "normal" = linked into VHO.exe, "build" = build script / proc-macro only. Dev-deps skipped.
  const scope = new Map();
  const queue = [[root, "normal"]];
  while (queue.length) {
    const [id, sc] = queue.shift();
    const prev = scope.get(id);
    if (prev === "normal" || prev === sc) continue;
    scope.set(id, sc);
    for (const d of nodes.get(id).deps) {
      const kinds = d.dep_kinds.map((k) => k.kind);
      if (kinds.every((k) => k === "dev")) continue;
      queue.push([d.pkg, sc === "build" || !kinds.includes(null) ? "build" : "normal"]);
    }
  }
  const sums = cargoLockChecksums();
  const ref = (p) => `pkg:cargo/${p.name}@${p.version}`;
  const components = [];
  const dependencies = [];
  for (const [id, sc] of scope) {
    const p = pkgs.get(id);
    if (id === root) continue;
    const expr = p.license ? normalizeExpression(p.license) : `LicenseRef-file-${p.name}`;
    const status = evaluateLicense(expr, { linking: sc === "normal" ? "static" : "none" });
    const c = {
      type: "library", "bom-ref": ref(p), name: p.name, version: p.version, purl: ref(p),
      scope: sc === "normal" ? "required" : "excluded",
      licenses: [{ expression: expr }],
      properties: [{ name: "vho:origin", value: "cargo" }, { name: "vho:linking", value: sc === "normal" ? "static (compiled into VHO.exe)" : "build-time only" }, { name: "vho:policy", value: status }],
    };
    const sum = sums.get(`${p.name}@${p.version}`);
    if (sum) c.hashes = [{ alg: "SHA-256", content: sum }];
    if (p.repository) c.externalReferences = [{ type: "vcs", url: p.repository }];
    if (p.description) c.description = p.description.replace(/\s+/g, " ").trim();
    components.push(c);
  }
  for (const [id] of scope) {
    const n = nodes.get(id);
    const from = id === root ? "vho" : ref(pkgs.get(id));
    const to = n.deps.filter((d) => scope.has(d.pkg) && !d.dep_kinds.every((k) => k.kind === "dev")).map((d) => ref(pkgs.get(d.pkg)));
    dependencies.push({ ref: from, dependsOn: [...new Set(to)].sort() });
  }
  const rootPkg = pkgs.get(root);
  return { components, dependencies, rootPkg };
}

function npmComponents() {
  const lock = readJson("package-lock.json");
  const out = [];
  for (const [key, v] of Object.entries(lock.packages)) {
    if (!key) continue;
    const name = key.replace(/^.*node_modules\//, "");
    const purl = `pkg:npm/${name.startsWith("@") ? "%40" + name.slice(1) : name}@${v.version}`;
    const expr = v.license ? normalizeExpression(v.license) : `LicenseRef-npm-${name.replace(/[^A-Za-z0-9.-]/g, "-")}`;
    const shipped = !v.dev && !v.devOptional;
    const c = {
      type: "library", "bom-ref": purl, name, version: v.version, purl,
      scope: shipped ? "required" : "excluded",
      licenses: [{ expression: expr }],
      properties: [{ name: "vho:origin", value: "npm" }, { name: "vho:linking", value: shipped ? "bundled" : "dev/build tool, not shipped" }, { name: "vho:policy", value: evaluateLicense(expr, { linking: shipped ? "static" : "none" }) }],
    };
    if (v.integrity?.startsWith("sha512-")) c.hashes = [{ alg: "SHA-512", content: Buffer.from(v.integrity.slice(7), "base64").toString("hex") }];
    if (v.resolved) c.externalReferences = [{ type: "distribution", url: v.resolved }];
    if (v.os) c.properties.push({ name: "vho:npm-os", value: v.os.join(",") });
    out.push(c);
  }
  return out;
}

function nativeComponents(native) {
  const out = [];
  for (const comp of native.components) {
    const linking = comp.policy === "lgpl-separate-process" ? "process" : "dynamic";
    const concluded = comp.concluded || comp.license;
    const status = evaluateLicense(concluded, { linking });
    const refs = [{ type: "website", url: comp.upstream }];
    if (comp.origin === "built-from-source") {
      const s = native.sources[comp.build];
      refs.push({ type: "vcs", url: `${s.repository}#${s.commit}`, comment: `tag ${s.tag}, no local patches` });
      refs.push({ type: "build-meta", url: native.build.recipe, comment: `${comp.build === "mpv" ? "meson " + s.meson.join(" ") : "configure " + s.configure.join(" ")}` });
    } else {
      refs.push({ type: "source-distribution", url: `https://repo.msys2.org/mingw/sources/${comp.msys2.pkgbase}-${comp.msys2.version}.src.tar.zst`, comment: "expected MSYS2 source package (not verified online); archive with the release" });
      refs.push({ type: "build-meta", url: `https://github.com/msys2/MINGW-packages/tree/master/${comp.msys2.pkgbase}`, comment: `MSYS2 recipe; pin the commit matching ${comp.msys2.version}` });
    }
    for (const f of comp.files) {
      out.push({
        type: f.name.endsWith(".exe") ? "application" : "library",
        "bom-ref": `native:${native.platform}:${f.name}`,
        name: f.name, version: comp.version, group: comp.name,
        scope: "required",
        hashes: [{ alg: "SHA-256", content: f.sha256 }],
        licenses: [{ expression: comp.license }],
        externalReferences: refs,
        properties: [
          { name: "vho:origin", value: comp.origin },
          { name: "vho:linking", value: linking === "process" ? "separate process" : "separate DLL loaded at runtime (replaceable)" },
          { name: "vho:license-concluded", value: concluded },
          { name: "vho:policy", value: status },
          ...(comp.acknowledged ? [{ name: "vho:acknowledged", value: comp.acknowledged }] : []),
          { name: "vho:bytes", value: String(f.bytes) },
          ...(comp.msys2 ? [{ name: "vho:msys2-package", value: `${comp.msys2.package} ${comp.msys2.version}` }] : []),
        ],
      });
    }
  }
  return out;
}

function modelComponents(manifest, inventory) {
  const out = [];
  for (const m of manifest) {
    const inv = inventory.components.find((c) => c.component === m.id);
    if (!inv) throw new Error(`legal/inventory/models.json: no entry for manifest component ${m.id}`);
    for (const f of m.files) {
      const fi = inv.files[f.name];
      if (!fi) throw new Error(`legal/inventory/models.json: ${m.id} has no entry for ${f.name}`);
      const license = fi.weightLicense || inv.weightLicense || inv.codeLicense;
      const isModel = /\.onnx$/i.test(f.name);
      out.push({
        type: isModel ? "machine-learning-model" : f.name.endsWith(".wasm") || f.name.endsWith(".mjs") ? "library" : "file",
        "bom-ref": `ai:${m.id}:${m.version}:${f.name}`,
        name: f.name, version: m.version, group: fi.name || inv.name,
        author: fi.weightAuthor || inv.weightAuthor || inv.author,
        scope: "optional",
        hashes: [{ alg: "SHA-256", content: f.sha256 }],
        licenses: [{ expression: license }],
        externalReferences: [{ type: "distribution", url: f.url }, { type: "website", url: m.source }],
        properties: [
          { name: "vho:origin", value: "ai-manifest" },
          { name: "vho:delivery", value: "downloaded on first use after user confirmation; never bundled" },
          { name: "vho:kind", value: inv.kind },
          { name: "vho:bytes", value: String(f.bytes) },
          { name: "vho:policy", value: inv.policy === "review" ? "review" : evaluateLicense(license, { linking: "download" }) },
          ...(inv.acknowledged ? [{ name: "vho:acknowledged", value: inv.acknowledged }] : []),
          ...(fi.trainingData || inv.trainingData ? [{ name: "vho:training-data", value: fi.trainingData || inv.trainingData }] : []),
          ...(inv.architecture ? [{ name: "vho:architecture", value: `${inv.architecture.name} (${inv.architecture.codeLicense}, ${inv.architecture.source})` }] : []),
        ],
      });
    }
  }
  return out;
}

function assetComponents(assets) {
  return assets.items.map((a) => {
    const linking = a.shipped ? "static" : "none";
    const c = {
      type: a.category === "vendored-js" || a.category === "c-library-in-crate" ? "library" : "file",
      "bom-ref": `asset:${a.id}`, name: a.name, scope: a.shipped ? "required" : "excluded",
      licenses: [{ expression: a.license }],
      properties: [
        { name: "vho:origin", value: "repository" },
        { name: "vho:category", value: a.category },
        { name: "vho:policy", value: a.policy === "review" ? "review" : evaluateLicense(a.license, { linking, category: a.category }) },
        ...(a.acknowledged ? [{ name: "vho:acknowledged", value: a.acknowledged }] : []),
        ...(a.paths.length ? [{ name: "vho:paths", value: a.paths.join(", ") }] : []),
      ],
    };
    if (a.version) c.version = a.version;
    if (a.purl) c.purl = a.purl;
    if (a.author) c.author = a.author;
    if (a.upstream) c.externalReferences = [{ type: "website", url: a.upstream }];
    if (a.paths.length && a.hashPaths !== false) {
      // one hash per file is not expressible on one component: hash the concatenation of
      // "<sha256>  <path>\n" lines (like sha256sum output), list per-file hashes as properties
      const lines = a.paths.map((p) => `${sha256RepoFile(join(ROOT, p))}  ${p}`);
      c.hashes = [{ alg: "SHA-256", content: createHash("sha256").update(lines.join("\n") + "\n").digest("hex") }];
      lines.forEach((l) => c.properties.push({ name: "vho:file-sha256", value: l }));
    }
    return c;
  });
}

// ----------------------------------------------------------------------------- native refresh
function checkNative(native, dist, bin, update) {
  const binDir = bin || join(dist, "..", "prefix", "bin");
  let mismatches = 0;
  for (const comp of native.components) {
    for (const f of comp.files) {
      const p = join(f.name.endsWith(".exe") ? binDir : dist, f.name);
      if (!existsSync(p)) { console.log(`  MISSING  ${p}`); mismatches++; continue; }
      const sha = sha256File(p);
      const bytes = statSync(p).size;
      if (sha !== f.sha256 || bytes !== f.bytes) {
        console.log(`  ${update ? "UPDATED " : "DIFFERS "} ${f.name}`);
        mismatches++;
        if (update) Object.assign(f, { sha256: sha, bytes });
      }
    }
  }
  const listed = new Set(native.components.flatMap((c) => c.files.map((f) => f.name.toLowerCase())));
  const extra = execFileSync("powershell", ["-NoProfile", "-Command", `Get-ChildItem -LiteralPath '${dist}' -Filter *.dll -File | ForEach-Object Name`], { encoding: "utf8" })
    .split(/\r?\n/).filter((n) => n && !listed.has(n.toLowerCase()));
  for (const n of extra) console.log(`  NOT IN INVENTORY  ${n} (add it with its license before shipping)`);
  if (update && mismatches) writeFileSync(join(ROOT, "legal/inventory/native-windows-x64.json"), JSON.stringify(native, null, 2) + "\n");
  console.log(`native: ${mismatches} difference(s), ${extra.length} unlisted DLL(s)${update && mismatches ? " — inventory rewritten" : ""}`);
  return mismatches + extra.length;
}

// ----------------------------------------------------------------------------- main
function uuidFrom(hex) {
  const h = hex.slice(0, 32).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const target = opt("--target", "x86_64-pc-windows-msvc");
  const native = readJson("legal/inventory/native-windows-x64.json");

  const nativeDist = opt("--native-dist", null);
  if (nativeDist) {
    const bad = checkNative(native, resolve(nativeDist), opt("--native-bin", null) && resolve(opt("--native-bin")), args.includes("--update-native"));
    if (bad && !args.includes("--update-native")) process.exitCode = 1;
  }

  const appVersion = readJson("src-tauri/tauri.conf.json").version;
  const rust = rustComponents(target);
  const projectLicense = rust.rootPkg.license || "NOASSERTION";
  const windowsX64 = target === "x86_64-pc-windows-msvc";
  const components = [
    ...rust.components,
    ...npmComponents(),
    ...(windowsX64 ? nativeComponents(native) : []),
    ...modelComponents(parseAiManifest(), readJson("legal/inventory/models.json")),
    ...assetComponents(readJson("legal/inventory/assets.json")),
  ];
  const rootDeps = rust.dependencies.find((d) => d.ref === "vho");
  rootDeps.dependsOn = [...rootDeps.dependsOn, ...components.filter((c) => !c["bom-ref"].startsWith("pkg:")).map((c) => c["bom-ref"])];

  let timestamp = opt("--timestamp", null);
  if (!timestamp) {
    try { timestamp = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { timestamp = new Date().toISOString(); }
  }
  let commit = "";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}

  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: "",
    version: 1,
    metadata: {
      timestamp: new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z"),
      tools: { components: [{ type: "application", name: "vho legal/generate-sbom.mjs", description: "cargo metadata + package-lock.json + legal/inventory/*.json + AI manifest" }] },
      component: {
        type: "application", "bom-ref": "vho", name: "VHO", version: appVersion,
        description: "VHO (Video H Oynaticisi) - video, photo and music desktop app (Tauri 2)",
        licenses: [{ expression: projectLicense }],
        authors: (rust.rootPkg.authors || []).map((a) => ({ name: a })),
      },
      properties: [
        { name: "vho:target", value: target },
        { name: "vho:source-commit", value: commit || "unknown" },
        { name: "vho:native-binaries", value: windowsX64 ? "included (legal/inventory/native-windows-x64.json)" : "not inventoried for this target" },
        { name: "vho:policy", value: "docs/plans/00-YOL-HARITASI.md; vho:policy per component = ok | review | reject; vho:acknowledged = owner decision on a review item" },
      ],
    },
    components,
    dependencies: rust.dependencies.sort((a, b) => a.ref.localeCompare(b.ref)),
  };
  const body = JSON.stringify(bom);
  bom.serialNumber = `urn:uuid:${uuidFrom(createHash("sha256").update(body).digest("hex"))}`;

  const out = resolve(opt("--out", join(ROOT, "legal", "sbom", `vho-${appVersion}-${target}.cdx.json`)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(bom, null, 1) + "\n");

  const policyOf = (c) => c.properties.find((p) => p.name === "vho:policy")?.value;
  const by = (k) => components.filter((c) => policyOf(c) === k);
  const count = (pred) => components.filter(pred).length;
  console.log(`SBOM ${out}`);
  console.log(`  target ${target} · project license ${projectLicense}`);
  console.log(`  rust ${rust.components.length} (${count((c) => c.purl?.startsWith("pkg:cargo") && c.scope === "required")} linked, rest build-time) · npm ${count((c) => c.purl?.startsWith("pkg:npm/") && !c["bom-ref"].startsWith("asset:"))} · native ${count((c) => c["bom-ref"].startsWith("native:"))} · ai ${count((c) => c["bom-ref"].startsWith("ai:"))} · assets ${count((c) => c["bom-ref"].startsWith("asset:"))}`);
  const acked = (c) => c.properties.some((p) => p.name === "vho:acknowledged");
  const open = by("review").filter((c) => !acked(c));
  console.log(`  policy: ok ${by("ok").length} · review ${by("review").length} (acknowledged ${by("review").length - open.length}, open ${open.length}) · reject ${by("reject").length}`);
  for (const c of by("review")) console.log(`    ${acked(c) ? "review/ack" : "REVIEW/OPEN"}  ${c.group ? c.group + " / " : ""}${c.name}${c.version ? "@" + c.version : ""}  ${c.licenses[0].expression}`);
  for (const c of by("reject")) console.log(`    REJECT  ${c.name}${c.version ? "@" + c.version : ""}  ${c.licenses[0].expression}`);
  if (by("reject").length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
