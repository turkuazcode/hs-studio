// Audit D04: the published file must carry an updater signature made AFTER code signing. The
// verifier is checked against real `tauri signer` output (throwaway keys, made here, never kept).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyUpdaterSignature } from "../../scripts/verify-updater-sig.mjs";

const TAURI = join(import.meta.dirname, "..", "..", "node_modules", "@tauri-apps", "cli", "tauri.js");
const tauri = (args) => execFileSync(process.execPath, [TAURI, ...args], { env: { ...process.env, CI: "true" }, stdio: "pipe" });
let dir, keyA, pubA, pubB;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vho-updsig-"));
  for (const n of ["a", "b"]) tauri(["signer", "generate", "--ci", "-p", "pw", "-w", join(dir, `${n}.key`)]);
  keyA = join(dir, "a.key");
  pubA = readFileSync(`${keyA}.pub`, "utf8");
  pubB = readFileSync(join(dir, "b.key.pub"), "utf8");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function signed(name, bytes, version = "0.1.0") {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  tauri(["signer", "sign", "-f", keyA, "-p", "pw", "--app-version", version, p]);
  return { bytes: readFileSync(p), sig: readFileSync(`${p}.sig`, "utf8") };
}

test("a file signed with the configured key and version is valid", () => {
  const f = signed("setup.exe", Buffer.from("installer bytes"));
  assert.deepEqual(verifyUpdaterSignature(f.bytes, f.sig, pubA, { version: "0.1.0" }), []);
});

test("code signing after the updater signature: the final file no longer matches", () => {
  const f = signed("setup2.exe", Buffer.from("installer bytes"));
  const authenticode = Buffer.concat([f.bytes, Buffer.from("…signature block appended by SignPath…")]);
  assert.match(verifyUpdaterSignature(authenticode, f.sig, pubA).join(), /does not match this file/);
});

test("another key, another version, a placeholder key and a changed trusted comment are refused", () => {
  const f = signed("setup3.exe", Buffer.from("x"), "0.1.0");
  assert.match(verifyUpdaterSignature(f.bytes, f.sig, pubB).join(), /signed with key/);
  assert.match(verifyUpdaterSignature(f.bytes, f.sig, pubA, { version: "0.2.0" }).join(), /no version:0\.2\.0/);
  assert.match(verifyUpdaterSignature(f.bytes, f.sig, "REPLACE_WITH_THE_PUBLIC_KEY_CONTENT").join(), /placeholder/);
  assert.match(verifyUpdaterSignature(f.bytes, f.sig, "").join(), /placeholder/);
  const text = Buffer.from(f.sig, "base64").toString("utf8").replace("version:0.1.0", "version:9.9.9");
  assert.match(verifyUpdaterSignature(f.bytes, Buffer.from(text).toString("base64"), pubA).join(), /trusted comment signature invalid/);
});
