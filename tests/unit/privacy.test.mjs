// Q04: no telemetry, no hidden network use. Every remote host in the app's source must be in
// the reviewed list below (with the user action that reaches it), and the webview's CSP must
// not let page scripts talk to remote servers. A new host or a looser CSP fails here until it
// is reviewed and documented in docs/security/q04-review.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** host -> why the app may reach it (all only after a user action, never at start-up). */
const REVIEWED_HOSTS = {
  "huggingface.co": "AI model download (Settings > AI models / first use, user confirms)",
  "cdn.jsdelivr.net": "ONNX Runtime Web download with the AI models",
  "raw.githubusercontent.com": "license files of the AI runtime, downloaded with it",
  "github.com": "source link shown in Settings > AI models (not fetched)",
  "tile.openstreetmap.org": "photo map tiles, only when the user opens the map of a geotagged photo",
  "www.openstreetmap.org": "map attribution link (not fetched)",
  "leafletjs.com": "map attribution link (not fetched)",
  "www.opensubtitles.org": "subtitle search page opened in the system browser by the user",
  "ns.adobe.com": "XMP namespace URI (not fetched)",
  "ornek.com": "URL dialog placeholder text",
  "purl.org": "Dublin Core XML namespace in the UPnP DIDL-Lite metadata (L04, not fetched)",
  "schemas.xmlsoap.org": "SOAP envelope XML namespace for UPnP control (L04, not fetched)",
};
/** Hosts that only appear in test data. */
const TEST_HOSTS = new Set(["example.invalid", "radyo.example", "x", "example.org", "example.com", "www.w3.org", "a", "h", "host", "user"]);
/** Local network addresses (RFC 1918): UPnP devices the user picks, never remote servers (L04). */
const LAN = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function* files(dir, exts) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "vendor") yield* files(p, exts);
    } else if (exts.some((e) => name.endsWith(e))) yield p;
  }
}

test("privacy: every remote host in the app source is reviewed (no telemetry / analytics)", () => {
  const found = new Map();
  for (const f of [...files(join(ROOT, "src"), [".js", ".html", ".css"]), ...files(join(ROOT, "src-tauri/src"), [".rs"])]) {
    for (const m of readFileSync(f, "utf8").matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || LAN.test(host) || TEST_HOSTS.has(host)) continue;
      if (!found.has(host)) found.set(host, relative(ROOT, f));
    }
  }
  const unknown = [...found].filter(([h]) => !(h in REVIEWED_HOSTS));
  assert.deepEqual(unknown, [], "new remote host(s): review, document in docs/security/q04-review.md and add here");
  for (const word of ["analytics", "telemetry", "sentry", "mixpanel", "segment.io", "google-analytics", "posthog"]) {
    assert.ok(![...found.keys()].some((h) => h.includes(word)), `tracking host: ${word}`);
  }
});

test("privacy: the CSP keeps page scripts local (no remote connect/script, no eval)", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const csp = Object.fromEntries(conf.app.security.csp.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
  const remote = (v) => v === "https:" || v === "http:" || v === "*" || /^https?:\/\/(?!(asset|ipc)\.localhost)/.test(v);
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.ok(!csp["script-src"].some(remote), `remote script source: ${csp["script-src"]}`);
  assert.ok(!csp["script-src"].includes("'unsafe-inline'") && !csp["script-src"].includes("'unsafe-eval'"), "inline/eval scripts allowed");
  assert.ok(!csp["connect-src"].some(remote), `page scripts may fetch remote servers: ${csp["connect-src"]}`);
  const cap = JSON.parse(readFileSync(join(ROOT, "src-tauri/capabilities/default.json"), "utf8"));
  assert.equal(cap.remote, undefined, "no remote origin may call IPC");
  for (const p of cap.permissions) assert.ok(!/^(fs|shell|http|process):/.test(typeof p === "string" ? p : p.identifier), `broad plugin permission: ${JSON.stringify(p)}`);
});

test("privacy: the updater is off by default and has no endpoint until the repository exists", () => {
  const settings = readFileSync(join(ROOT, "src/ui/updates.js"), "utf8");
  assert.match(settings, /key: "general\.checkUpdates", type: "boolean", default: false/, "automatic update check must default to off");
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  assert.deepEqual(conf.plugins.updater.endpoints, [], "the shipped config has no update endpoint yet");
});
