// R02: CI / release workflow hygiene (no YAML parser needed: line-level checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, ".github", "workflows");
const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(join(DIR, f), "utf8")]);

test("every third-party action is pinned to a full commit SHA", () => {
  assert.ok(workflows.length >= 3, "ci.yml, native-windows.yml, release.yml");
  for (const [f, text] of workflows) {
    for (const m of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) {
      const ref = m[1];
      if (ref.startsWith("./")) continue; // local reusable workflow
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${ref} is not pinned to a commit SHA`);
    }
  }
});

test("least privilege: read-only default permissions, no pull_request_target, no persisted checkout token", () => {
  for (const [f, text] of workflows) {
    assert.match(text, /^permissions:\s*\n\s+contents: read/m, `${f}: top-level permissions must be contents: read`);
    assert.doesNotMatch(text, /pull_request_target/, `${f}: pull_request_target exposes secrets to fork PRs`);
    assert.doesNotMatch(text, /^\s*contents:\s*write/m,`${f}: no write permission until publishing is decided`);
    for (const m of text.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n((?:\s+with:\s*\n(?:\s{8,}.*\n)*)?)/g)) {
      assert.match(m[1], /persist-credentials: false/, `${f}: checkout without persist-credentials: false`);
    }
  }
});

test("signing stays disabled until SignPath accepts the project; no private keys in the repository", () => {
  const release = workflows.find(([f]) => f === "release.yml")[1];
  for (const m of release.matchAll(/uses: signpath\/[^\n]+/g)) {
    const before = release.slice(0, m.index).split("\n").slice(-3).join("\n");
    assert.match(before, /if: env\.SIGNED == 'true'/, "SignPath steps are gated by vars.SIGNPATH_ENABLED");
  }
  assert.match(release, /SIGNED: \$\{\{ vars\.SIGNPATH_ENABLED == 'true' \}\}/);
  const updater = readFileSync(join(ROOT, "src-tauri", "packaging", "updater.conf.json"), "utf8");
  assert.doesNotMatch(updater, /untrusted comment: .*secret key/i, "never commit the updater private key");
});
