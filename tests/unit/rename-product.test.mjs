// Product rename rehearsal (docs/release/rename-hs-studio.md): scripts/rename-product.mjs is run
// on a TEMPORARY COPY of the affected files, never on the repository itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rules, run, verify, VERIFY_FILES } from "../../scripts/rename-product.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ID = "com.hsstudio.app";
const files = [...new Set([...rules({ name: "HS Studio", identifier: ID }).map((r) => r.file), ...VERIFY_FILES])];
const hashAll = (root) => Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")]));

function copyRepoSubset() {
  const dir = mkdtempSync(join(tmpdir(), "vho-rename-"));
  for (const f of files) cpSync(join(ROOT, f), join(dir, f), { recursive: false });
  return dir;
}

test("dry run on the real repository plans changes and writes nothing", () => {
  const before = hashAll(ROOT);
  const r = run({ apply: false });
  assert.ok(r.changes.length >= 15, `planned changes: ${r.changes.length}`);
  assert.deepEqual(r.missing, [], "every file of the rename table exists");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(hashAll(ROOT), before, "dry run must not modify files");
  assert.ok(verify(ROOT).length > 0, "before the rename the verification reports VHO (sanity)");
});

test("--apply needs a valid reverse-DNS identifier", () => {
  assert.throws(() => run({ root: copyRepoSubset(), apply: true }), /--identifier/);
  assert.throws(() => run({ root: copyRepoSubset(), apply: true, identifier: "HS Studio" }), /--identifier/);
});

test("apply on a temporary copy: identity, strings, migration entry; verification clean; idempotent", () => {
  const dir = copyRepoSubset();
  try {
    const r = run({ root: dir, apply: true, identifier: ID });
    assert.deepEqual(r.errors, []);
    const conf = JSON.parse(readFileSync(join(dir, "src-tauri/tauri.conf.json"), "utf8"));
    assert.equal(conf.productName, "HS Studio");
    assert.equal(conf.identifier, ID);
    assert.equal(conf.app.windows[0].title, "HS Studio");
    assert.deepEqual(conf.bundle.fileAssociations.map((a) => a.name), ["HS Studio Video", "HS Studio Audio", "HS Studio Image", "HS Studio Subtitle"]);
    assert.match(readFileSync(join(dir, "src-tauri/src/identity.rs"), "utf8"), /\("com\.hsstudio\.app", &\["com\.vho\.app"\]\),/);
    for (const lang of ["tr", "en"]) {
      const text = readFileSync(join(dir, `src/i18n/${lang}.json`), "utf8");
      JSON.parse(text);
      assert.doesNotMatch(text, /\bVHO\b/, `${lang}.json has no VHO left`);
      assert.match(text, /HS Studio/);
    }
    assert.match(readFileSync(join(dir, "src/i18n/tr.json"), "utf8"), /HS Studio'yu seçin/, "Turkish suffix kept");
    assert.match(readFileSync(join(dir, "src-tauri/src/ai/download.rs"), "utf8"), /concat!\("HS-Studio\/"/);
    assert.match(readFileSync(join(dir, "legal/NOTICES_HEADER.txt"), "utf8"), /^HS Studio \(formerly VHO\) — LİSANSLAR/);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    assert.match(readme, /VHO_|vho\.exe|eski/, "code identifiers and former-name mentions stay");
    assert.match(readFileSync(join(dir, "CONTRIBUTING.md"), "utf8"), /VHO_TEST_NO_SKIP/, "env vars are not renamed");
    assert.match(readFileSync(join(dir, "CHANGELOG.md"), "utf8"), /Product renamed to \*\*HS Studio\*\* \(formerly VHO\)/);
    assert.deepEqual(verify(dir), [], "no leftover user-visible VHO");

    const again = run({ root: dir, apply: true, identifier: ID });
    assert.deepEqual(again.changes, [], "second run changes nothing");
    assert.equal((readFileSync(join(dir, "CHANGELOG.md"), "utf8").match(/Product renamed/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional exe name is written as mainBinaryName", () => {
  const dir = copyRepoSubset();
  try {
    run({ root: dir, apply: true, identifier: ID, exeName: "HS Studio" });
    assert.equal(JSON.parse(readFileSync(join(dir, "src-tauri/tauri.conf.json"), "utf8")).mainBinaryName, "HS Studio");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
