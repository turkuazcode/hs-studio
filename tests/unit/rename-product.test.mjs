// Product rename (docs/release/rename-hs-studio.md). The rename was applied on 2026-10-28 with
// `--identifier com.turkuazcode.hsstudio --exe-name "HS Studio"`; these tests check that the
// repository stays renamed and that the script is idempotent. The rehearsal on the pre-rename
// files is in the git history of this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rules, run, verify, VERIFY_FILES } from "../../scripts/rename-product.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ID = "com.turkuazcode.hsstudio";
const EXE = "HS Studio";
const files = [...new Set([...rules({ name: "HS Studio", identifier: ID }).map((r) => r.file), ...VERIFY_FILES])];
const hashAll = (root) => Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(join(root, f))).digest("hex")]));

function copyRepoSubset() {
  const dir = mkdtempSync(join(tmpdir(), "vho-rename-"));
  for (const f of files) cpSync(join(ROOT, f), join(dir, f), { recursive: false });
  return dir;
}

test("the repository is renamed: identity, exe name, migration entry, no user-visible VHO", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(conf.productName, "HS Studio");
  assert.equal(conf.identifier, ID);
  assert.equal(conf.mainBinaryName, EXE);
  assert.equal(conf.app.windows[0].title, "HS Studio");
  assert.deepEqual(conf.bundle.fileAssociations.map((a) => a.name), ["HS Studio Video", "HS Studio Audio", "HS Studio Image", "HS Studio Subtitle"]);
  assert.match(readFileSync(join(ROOT, "src-tauri/src/identity.rs"), "utf8"), /\("com\.turkuazcode\.hsstudio", &\["com\.vho\.app"\]\),/);
  for (const lang of ["tr", "en"]) {
    const text = readFileSync(join(ROOT, `src/i18n/${lang}.json`), "utf8");
    assert.doesNotMatch(text, /\bVHO\b/, `${lang}.json has no VHO left`);
  }
  assert.match(readFileSync(join(ROOT, "src/i18n/tr.json"), "utf8"), /HS Studio'yu seçin/, "Turkish suffix kept");
  assert.match(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8"), /VHO_TEST_NO_SKIP/, "env vars are not renamed");
  assert.deepEqual(verify(ROOT), [], "no leftover user-visible VHO");
});

test("dry run with the chosen identity plans nothing and writes nothing", () => {
  const before = hashAll(ROOT);
  const r = run({ apply: false, identifier: ID, exeName: EXE });
  assert.deepEqual(r.changes, [], "already renamed");
  assert.deepEqual(r.missing, [], "every file of the rename table exists");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(hashAll(ROOT), before, "dry run must not modify files");
});

test("--apply needs a valid reverse-DNS identifier", () => {
  assert.throws(() => run({ root: copyRepoSubset(), apply: true }), /--identifier/);
  assert.throws(() => run({ root: copyRepoSubset(), apply: true, identifier: "HS Studio" }), /--identifier/);
});

test("apply again on a temporary copy is idempotent (one CHANGELOG line, verification clean)", () => {
  const dir = copyRepoSubset();
  try {
    const r = run({ root: dir, apply: true, identifier: ID, exeName: EXE });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.changes, [], "second run changes nothing");
    assert.equal((readFileSync(join(dir, "CHANGELOG.md"), "utf8").match(/Product renamed/g) ?? []).length, 1);
    assert.deepEqual(verify(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
