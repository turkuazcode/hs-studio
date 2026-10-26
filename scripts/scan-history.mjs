// Read-only scan of the WHOLE git history (every ref: all branches, tags, worktree HEADs) for
// things that must not be published with the repository (R01, docs/plans/14):
//   - secrets: private keys, cloud/API tokens, signing keys, credential assignments
//   - private media / binaries: images, video, audio, model weights, archives, executables
//   - large blobs (default >= 1 MiB)
//   - personal data hints: absolute user-profile paths, e-mail addresses in file contents
//
//   node scripts/scan-history.mjs [--min-mb 1] [--json out.json] [--repo <git dir or worktree>]
//
// Nothing is modified: the script only runs `git rev-list` / `git cat-file`. Secret VALUES are
// never printed — only blob id, path, rule and line number — so the output can be shared.
// Findings are reported to the repository owner; history is NOT rewritten by this tool.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
// --repo scans another repository (e.g. the cleaned mirror of scripts/prepare-public-history.ps1)
const ROOT = resolve(opt("--repo", resolve(dirname(fileURLToPath(import.meta.url)), "..")));
const MIN_BYTES = Number(opt("--min-mb", "1")) * 1024 * 1024;
const JSON_OUT = opt("--json", null);
const MAX_TEXT_BYTES = 8 * 1024 * 1024; // larger blobs are reported as large, not grepped

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30 });

export const SECRET_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["minisign/tauri-updater-secret-key", /untrusted comment: (?:minisign|rsign) (?:encrypted )?secret key/i],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["openai/anthropic-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["stripe-key", /\b[rs]k_live_[0-9A-Za-z]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credential-assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i],
  ["connection-string-with-password", /\b[a-z]+:\/\/[^\s:/@]+:[^\s@/]{4,}@[^\s]+/i],
];
const PERSONAL_RULES = [
  ["user-profile-path", /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s"'`<>]+/],
  ["home-path", /\/(?:home|Users)\/[a-z][a-z0-9._-]+\//],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
// Placeholder/known-public values that are not secrets or personal data
const ALLOW = [
  /noreply@anthropic\.com/i, /@users\.noreply\.github\.com/i, /example\.(?:com|org)/i,
  /git@github\.com/i, /@types\//, /@tauri-apps\//, /@[0-9]/, /\.(?:png|jpe?g|svg|webp)@/i,
];
const MEDIA_EXT = /\.(jpe?g|png|gif|bmp|webp|avif|heic|heif|tiff?|dng|cr2|cr3|nef|arw|raw|psd|mp4|m4v|mkv|mov|avi|wmv|webm|flv|ts|m2ts|mts|3gp|mpg|mpeg|mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i;
const BINARY_EXT = /\.(onnx|pt|pth|ckpt|safetensors|bin|gguf|tflite|pb|dll|exe|so|dylib|lib|a|o|obj|pdb|msi|zip|7z|rar|tar|gz|tgz|xz|zst|whl|jar|pfx|p12|pem|key|keystore|jks|der|crt|cer|db|sqlite|sqlite3)$/i;
const SENSITIVE_NAME = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|.*\.(pfx|p12|pem|key|keystore|jks))$/i;

function listObjects() {
  // every object reachable from any ref, with the first path it was seen at
  const out = git("rev-list", "--objects", "--all");
  const paths = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const id = line.slice(0, sp);
    const p = line.slice(sp + 1);
    if (!paths.has(id)) paths.set(id, new Set());
    paths.get(id).add(p);
  }
  return paths;
}

function batchCheck(ids) {
  const res = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: ROOT, input: ids.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30,
  });
  const info = new Map();
  for (const line of res.split("\n")) {
    const [id, type, size] = line.split(" ");
    if (type === "blob") info.set(id, Number(size));
  }
  return info;
}

/** Streams blob contents through one `git cat-file --batch` process. */
function readBlobs(ids, onBlob) {
  return new Promise((resolveP, reject) => {
    const p = spawn("git", ["cat-file", "--batch"], { cwd: ROOT });
    let buf = Buffer.alloc(0);
    let idx = 0;
    p.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        const size = Number(header.split(" ")[2]);
        if (buf.length < nl + 1 + size + 1) return;
        onBlob(ids[idx++], buf.subarray(nl + 1, nl + 1 + size));
        buf = buf.subarray(nl + 1 + size + 1);
      }
    });
    p.on("error", reject);
    p.on("close", () => resolveP());
    p.stdin.end(ids.join("\n") + "\n");
  });
}

const isBinary = (b) => b.subarray(0, 8000).includes(0);

async function main() {
  const refs = git("for-each-ref", "--format=%(refname)").trim().split("\n");
  const paths = listObjects();
  const sizes = batchCheck([...paths.keys()]);
  const blobs = [...sizes.keys()];
  const findings = { refs: refs.length, blobs: blobs.length, large: [], media: [], binary: [], sensitiveNames: [], secrets: [], personal: {} };

  for (const id of blobs) {
    const size = sizes.get(id);
    const ps = [...(paths.get(id) || [])];
    const entry = { blob: id.slice(0, 12), bytes: size, paths: ps };
    if (size >= MIN_BYTES) findings.large.push(entry);
    if (ps.some((p) => MEDIA_EXT.test(p))) findings.media.push(entry);
    if (ps.some((p) => BINARY_EXT.test(p))) findings.binary.push(entry);
    if (ps.some((p) => SENSITIVE_NAME.test(p))) findings.sensitiveNames.push(entry);
  }

  const textIds = blobs.filter((id) => sizes.get(id) <= MAX_TEXT_BYTES);
  await readBlobs(textIds, (id, data) => {
    if (isBinary(data)) return;
    const text = data.toString("utf8");
    const lines = text.split("\n");
    const ps = [...(paths.get(id) || [])];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue; // minified/vendored blobs: too noisy, checked by name
      for (const [rule, re] of SECRET_RULES) {
        if (re.test(line)) findings.secrets.push({ rule, blob: id.slice(0, 12), paths: ps, line: i + 1 });
      }
      for (const [rule, re] of PERSONAL_RULES) {
        const m = line.match(new RegExp(re.source, re.flags + "g"));
        if (!m) continue;
        for (const v of m) {
          if (ALLOW.some((a) => a.test(v))) continue;
          const key = `${rule}: ${rule === "email" ? v.toLowerCase() : v.replace(/\\\\/g, "\\")}`;
          const f = (findings.personal[key] ??= { count: 0, paths: new Set() });
          f.count++;
          ps.forEach((p) => f.paths.add(p));
        }
      }
    }
  });
  for (const v of Object.values(findings.personal)) v.paths = [...v.paths].sort().slice(0, 8);

  const authors = git("log", "--all", "--format=%an <%ae>|%cn <%ce>").split("\n").flatMap((l) => l.split("|")).filter(Boolean);
  findings.identities = [...new Set(authors)].sort();
  findings.commits = Number(git("rev-list", "--all", "--count").trim());

  const mb = (n) => (n / 1048576).toFixed(2) + " MiB";
  const show = (list, n = 40) => list.sort((a, b) => b.bytes - a.bytes).slice(0, n).forEach((e) => console.log(`  ${mb(e.bytes).padStart(10)}  ${e.blob}  ${e.paths.join(", ")}`));
  console.log(`refs: ${refs.length} · commits: ${findings.commits} · blobs: ${blobs.length}`);
  console.log(`\nlarge blobs (>= ${mb(MIN_BYTES)}): ${findings.large.length}`); show(findings.large);
  console.log(`\nmedia files in history: ${findings.media.length}`); show(findings.media, 200);
  console.log(`\nbinary/model/archive/key files in history: ${findings.binary.length}`); show(findings.binary, 200);
  console.log(`\nsensitive file names: ${findings.sensitiveNames.length}`); show(findings.sensitiveNames, 200);
  console.log(`\nsecret pattern hits (values not shown): ${findings.secrets.length}`);
  for (const s of findings.secrets) console.log(`  ${s.rule}  ${s.blob}  ${s.paths.join(", ")}:${s.line}`);
  console.log(`\npersonal-data hints:`);
  for (const [k, v] of Object.entries(findings.personal).sort((a, b) => b[1].count - a[1].count)) console.log(`  ${String(v.count).padStart(5)}  ${k}   e.g. ${v.paths.slice(0, 3).join(", ")}`);
  console.log(`\ncommit identities:`); findings.identities.forEach((i) => console.log(`  ${i}`));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(findings, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
