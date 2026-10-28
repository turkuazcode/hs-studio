// Verifies the updater signature of the FINAL distribution file (audit D04): after code signing
// (SignPath) the installer bytes change, so the `.sig` written while bundling no longer matches
// and the app would refuse the update. Run on exactly the file that is published.
//
//   node scripts/verify-updater-sig.mjs <file> [--sig <file>.sig] [--config src-tauri/packaging/updater.conf.json]
//                                       [--pubkey <base64 public key>] [--version 0.1.0]
//
// Checks (minisign, as written by `tauri signer sign`): the public key is a real key (not the
// template placeholder), the key ids match, the Ed25519 signature over the BLAKE2b-512 of the
// file, the global signature over the trusted comment, and — with --version — that the trusted
// comment carries that version (the app requires it: `requireSignedVersion`). Exit code 1 on
// any failure. Only Node's crypto; no private key is ever read.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** "untrusted comment: …\n<base64>" (Tauri stores the whole text base64-encoded once more). */
function minisignText(value) {
  const text = /untrusted comment:/.test(value) ? value : Buffer.from(value.trim(), "base64").toString("utf8");
  return text.replace(/\r/g, "").split("\n");
}

export function parsePublicKey(value) {
  const lines = minisignText(value);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign Ed25519 public key");
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

export function parseSignature(value) {
  const lines = minisignText(value);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  if (raw.length !== 74 || !trusted.startsWith("trusted comment: ")) throw new Error("not a minisign signature");
  return { alg: raw.subarray(0, 2).toString(), keyId: raw.subarray(2, 10), sig: raw.subarray(10), trusted: trusted.slice(17), global: Buffer.from(lines[3] ?? "", "base64") };
}

const ed25519 = (key) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" });

/** Returns a list of problems (empty = valid). */
export function verifyUpdaterSignature(fileBytes, sigText, pubText, { version } = {}) {
  if (!pubText || /REPLACE_WITH|<owner>/.test(pubText)) return ["no real updater public key (template placeholder): set it before enabling updates"];
  let pk, s;
  try { pk = parsePublicKey(pubText); } catch (e) { return [`public key: ${e.message}`]; }
  try { s = parseSignature(sigText); } catch (e) { return [`signature: ${e.message}`]; }
  const problems = [];
  if (!s.keyId.equals(pk.keyId)) problems.push(`signed with key ${s.keyId.toString("hex")}, expected ${pk.keyId.toString("hex")}`);
  const key = ed25519(pk.key);
  const data = s.alg === "ED" ? createHash("blake2b512").update(fileBytes).digest() : s.alg === "Ed" ? fileBytes : null;
  if (!data) problems.push(`unknown signature algorithm ${s.alg}`);
  else if (!verify(null, data, key, s.sig)) problems.push("the signature does not match this file (signed before code signing changed it?)");
  if (!verify(null, Buffer.concat([s.sig, Buffer.from(s.trusted)]), key, s.global)) problems.push("trusted comment signature invalid");
  if (version && !s.trusted.split("\t").includes(`version:${version}`)) problems.push(`trusted comment has no version:${version} (${s.trusted})`);
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!file) { console.error("usage: node scripts/verify-updater-sig.mjs <file> [--sig f] [--config f | --pubkey k] [--version v]"); process.exit(2); }
  const config = opt("--config") ?? resolve(ROOT, "src-tauri/packaging/updater.conf.json");
  const pub = opt("--pubkey") ?? JSON.parse(readFileSync(config, "utf8")).plugins?.updater?.pubkey;
  const problems = verifyUpdaterSignature(readFileSync(file), readFileSync(opt("--sig") ?? `${file}.sig`, "utf8"), pub, { version: opt("--version") });
  if (problems.length) {
    console.error(`updater signature of ${file}: INVALID\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`updater signature of ${file}: valid${opt("--version") ? ` (version ${opt("--version")})` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
