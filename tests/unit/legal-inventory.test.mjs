// R01: the license inventories, the committed SBOM and the notices stay in sync with what VHO
// ships. Pure file checks (no cargo, no network); regenerate with `npm run sbom` when they fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLicense, normalizeExpression, parseAiManifest } from "../../legal/generate-sbom.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));
const sha256 = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

const native = json("legal/inventory/native-windows-x64.json");
const models = json("legal/inventory/models.json");
const assets = json("legal/inventory/assets.json");
const manifest = parseAiManifest();
const version = json("src-tauri/tauri.conf.json").version;
const SBOM_PATH = `legal/sbom/vho-${version}-x86_64-pc-windows-msvc.cdx.json`;
const notices = read("legal/NOTICES_HEADER.txt");

test("license policy evaluator follows docs/plans/00 (OR = best, AND = worst, LGPL only dynamic)", () => {
  assert.equal(normalizeExpression("MIT/Apache-2.0"), "MIT OR Apache-2.0");
  assert.equal(evaluateLicense("MIT OR Apache-2.0", { linking: "static" }), "ok");
  assert.equal(evaluateLicense("(MIT OR Apache-2.0) AND Unicode-3.0", { linking: "static" }), "ok");
  assert.equal(evaluateLicense("GPL-3.0-only", { linking: "static" }), "reject");
  assert.equal(evaluateLicense("AGPL-3.0-or-later", { linking: "dynamic" }), "reject");
  assert.equal(evaluateLicense("GPL-2.0-or-later OR MIT", { linking: "static" }), "ok");
  assert.equal(evaluateLicense("LGPL-2.1-or-later", { linking: "static" }), "reject");
  assert.equal(evaluateLicense("LGPL-2.1-or-later", { linking: "dynamic" }), "ok");
  assert.equal(evaluateLicense("LGPL-2.1-or-later", { linking: "process" }), "ok");
  assert.equal(evaluateLicense("CC-BY-NC-SA-4.0", { linking: "download" }), "reject");
  assert.equal(evaluateLicense("OFL-1.1", { linking: "static" }), "reject");
  assert.equal(evaluateLicense("OFL-1.1", { linking: "static", category: "font" }), "ok");
  assert.equal(evaluateLicense("GPL-3.0-or-later WITH GCC-exception-3.1", { linking: "dynamic" }), "review");
  assert.equal(evaluateLicense("Apache-2.0 WITH LLVM-exception", { linking: "static" }), "ok");
});

test("every AI manifest file has a license/provenance entry in models.json, and nothing extra", () => {
  assert.ok(manifest.length >= 3, "manifest.rs parsed");
  for (const c of manifest) {
    const inv = models.components.find((m) => m.component === c.id);
    assert.ok(inv, `models.json: missing component ${c.id}`);
    assert.deepEqual(Object.keys(inv.files).sort(), c.files.map((f) => f.name).sort(), `models.json files of ${c.id}`);
    for (const name of Object.keys(inv.files)) {
      const fi = inv.files[name];
      assert.ok(fi.weightLicense || inv.weightLicense || inv.codeLicense, `${c.id}/${name}: license`);
    }
    if (inv.kind === "model-weights") {
      for (const fi of Object.values(inv.files)) assert.ok(fi.trainingData || inv.trainingData, `${c.id}: training-data note (open item if unknown)`);
    }
  }
  assert.equal(models.components.length, manifest.length);
});

test("native inventory: every shipped DLL/exe has version, license, hash and a source recipe", () => {
  const names = native.components.flatMap((c) => c.files.map((f) => f.name));
  assert.equal(new Set(names).size, names.length, "no duplicate files");
  assert.equal(names.filter((n) => n.endsWith(".dll")).length, 38, "38 DLLs of third_party/mpv/build-windows.md");
  assert.ok(names.includes("ffmpeg.exe") && names.includes("ffprobe.exe"));
  const sizes = read("third_party/mpv/evidence/windows/dist-sizes.tsv").trim().split(/\r?\n/).map((l) => l.split("\t")[1]);
  assert.deepEqual([...sizes].sort(), names.filter((n) => n.endsWith(".dll")).sort(), "same DLL set as the build evidence");
  for (const c of native.components) {
    assert.ok(c.version && c.license && c.policy && c.upstream, `${c.id}: metadata`);
    if (c.origin === "built-from-source") assert.match(native.sources[c.build].commit, /^[0-9a-f]{40}$/);
    else assert.ok(c.msys2?.pkgbase && c.msys2.version, `${c.id}: MSYS2 package + version`);
    for (const f of c.files) assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.name}: sha256`);
    if (/lgpl/.test(c.policy)) assert.match(c.concluded || c.license, /LGPL/, `${c.id}: LGPL policy only for LGPL`);
  }
});

test("Linux native inventory (P03): LGPL flags, same file set and hashes as the build evidence", () => {
  const linux = json("legal/inventory/native-linux-x64.json");
  assert.ok(!linux.sources.ffmpeg.configure.some((f) => /--enable-(gpl|version3|nonfree)/.test(f)), "no GPL/nonfree FFmpeg");
  assert.ok(linux.sources.mpv.meson.includes("-Dgpl=false"));
  assert.match(read("third_party/mpv/evidence/linux/mpv-options.txt"), /gpl = False/);
  assert.doesNotMatch(read("third_party/mpv/evidence/linux/ffmpeg-buildconf.txt"), /--enable-(gpl|version3|nonfree)/);
  assert.doesNotMatch(read("third_party/mpv/evidence/linux/mpv-vo.txt"), /^\s+(x11|xv)\s/m, "GPL-gated X11 VOs absent");
  const evidence = Object.fromEntries(read("third_party/mpv/evidence/linux/dist-sha256.txt").trim().split(/\r?\n/).map((l) => l.split(/\s+/).reverse()));
  assert.deepEqual(linux.files.map((f) => f.name).sort(), Object.keys(evidence).sort(), "same file set as the build evidence");
  for (const f of linux.files) {
    assert.equal(f.sha256, evidence[f.name], `${f.name}: sha256`);
    assert.equal(f.license, "LGPL-2.1-or-later");
  }
  for (const s of Object.values(linux.sources)) assert.match(s.commit, /^[0-9a-f]{40}$/);
});

test("every native DLL and AI file is named in the notices (legal/NOTICES_HEADER.txt)", () => {
  for (const c of native.components) for (const f of c.files) assert.ok(notices.includes(f.name), `${f.name} missing from notices`);
  for (const c of manifest) for (const f of c.files) {
    if (["LICENSE", "ThirdPartyNotices.txt"].includes(f.name)) continue;
    if (f.name.endsWith(".mjs") || f.name.endsWith(".wasm")) continue; // runtime listed as ONNX Runtime Web 1.30.0
    assert.ok(notices.includes(f.name) || notices.includes(f.name.replace(/\.onnx$/, "")), `${f.name} missing from notices`);
  }
  assert.ok(notices.includes("ONNX Runtime Web 1.30.0"));
});

test("project license: Apache-2.0 everywhere, NOTICE shown at the top of the in-app notices", () => {
  assert.match(read("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
  assert.match(read("src-tauri/Cargo.toml"), /^license = "Apache-2\.0"$/m);
  assert.equal(json("package.json").license, "Apache-2.0");
  const notice = read("NOTICE").replace(/\r\n/g, "\n").trim();
  for (const f of ["legal/NOTICES_HEADER.txt", "src/legal/THIRD_PARTY_NOTICES.txt"]) {
    const head = read(f).replace(/\r\n/g, "\n").slice(0, 3000);
    assert.ok(head.includes(notice), `${f} starts with the NOTICE file (Apache-2.0 4(d))`);
  }
  assert.ok(!existsSync(join(ROOT, "CLA.md")), "no CLA: inbound = outbound Apache-2.0 + DCO");
});

test("asset inventory: paths exist, hashes of pinned upstream files match, shipped src/ assets are covered", () => {
  for (const a of assets.items) {
    for (const p of a.paths) assert.ok(existsSync(join(ROOT, p)), `${a.id}: ${p} exists`);
    for (const [p, h] of Object.entries(a.upstreamSha256 || {})) assert.equal(sha256(p), h, `${p} is the pinned upstream file`);
    assert.ok(a.license && a.policy, `${a.id}: license + policy`);
  }
  const covered = new Set(assets.items.flatMap((a) => a.paths));
  const binaryAssets = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map((f) => `${dir}/${String(f).replace(/\\/g, "/")}`)
    .filter((f) => /\.(png|jpe?g|gif|svg|ico|icns|webp|ttf|otf|woff2?)$/i.test(f));
  for (const f of [...binaryAssets("src"), ...binaryAssets("src-tauri/icons")]) assert.ok(covered.has(f), `${f} is shipped but not in legal/inventory/assets.json`);
});

test("committed SBOM matches the inventories (regenerate with npm run sbom)", () => {
  const bom = json(SBOM_PATH);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.metadata.component.version, version);
  const byRef = new Map(bom.components.map((c) => [c["bom-ref"], c]));
  assert.equal(byRef.size, bom.components.length, "unique bom-refs");
  for (const d of bom.dependencies) {
    for (const r of d.dependsOn) assert.ok(byRef.has(r), `dependency target ${r}`);
  }
  for (const c of native.components) for (const f of c.files) {
    const s = byRef.get(`native:${native.platform}:${f.name}`);
    assert.ok(s, `SBOM has ${f.name}`);
    assert.equal(s.hashes[0].content, f.sha256, `SBOM hash of ${f.name}`);
  }
  for (const c of manifest) for (const f of c.files) {
    const s = byRef.get(`ai:${c.id}:${c.version}:${f.name}`);
    assert.ok(s, `SBOM has ${c.id}/${f.name}`);
    assert.equal(s.hashes[0].content, f.sha256);
  }
  for (const a of assets.items) assert.ok(byRef.has(`asset:${a.id}`), `SBOM has asset ${a.id}`);
  const rejected = bom.components.filter((c) => c.properties?.some((p) => p.name === "vho:policy" && p.value === "reject"));
  assert.deepEqual(rejected.map((c) => c.name), [], "no component rejected by the license policy");
  // every "review" item carries an owner acknowledgement, except the ones still open by decision
  const STILL_OPEN = ["asset:app-icons"]; // logo authorship/rights: owner + lawyer (legal/INVENTORY.md)
  const openReview = bom.components.filter((c) => c.properties?.some((p) => p.name === "vho:policy" && p.value === "review")
    && !c.properties.some((p) => p.name === "vho:acknowledged")).map((c) => c["bom-ref"]);
  assert.deepEqual(openReview.sort(), STILL_OPEN, "new review item: decide it and record 'acknowledged' in legal/inventory");
  // Rust deps in the SBOM are exactly the locked versions
  const lock = read("src-tauri/Cargo.lock");
  for (const c of bom.components.filter((x) => x.purl?.startsWith("pkg:cargo/")).slice(0, 400)) {
    assert.ok(lock.includes(`name = "${c.name}"\nversion = "${c.version}"`) || lock.includes(`name = "${c.name}"\r\nversion = "${c.version}"`), `${c.name}@${c.version} in Cargo.lock (run npm run sbom after dependency changes)`);
  }
});
