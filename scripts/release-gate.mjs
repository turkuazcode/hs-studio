// Release gate (plan 14/R03, audit D01): compares a release target with the live status table of
// docs/plans/08-uygulama-sirasi-ve-durum.md, the test-layer results (tests/.results/*.json), the
// release package and the manual (device / human) evidence file.
//
//   node scripts/release-gate.mjs                          # default target: windows-alpha
//   node scripts/release-gate.mjs --target desktop-beta
//   node scripts/release-gate.mjs --manifest <bundle>/package-manifest-release-0.1.0.json
//   node scripts/release-gate.mjs --results win32-x64=tests/.results --results linux-x64=<dir>
//   node scripts/release-gate.mjs --evidence docs/releases/evidence/windows-alpha.json
//   node scripts/release-gate.mjs --markdown out.md --json out.json --plan-ref main
//   node scripts/release-gate.mjs --stage candidate --manifest <…>   # release workflow: automated
//                                       evidence only; manual checks listed as pending, not required
//
// Rules (docs/releases/release-gate.md):
// - A card counts only when plan 08 says "doğrulandı" for every platform of the target. A plain
//   "doğrulandı" is Windows evidence (every test of this project so far ran on Windows); it never
//   stands in for macOS or Linux unless the target declares the card platform-neutral.
// - A layer result counts only when it is the whole layer (no file list / name filter), ran on the
//   target platform at HEAD without uncommitted changes, exited 0, ran at least one test, has no
//   failure / cancellation, and every skip or todo is covered by a declared exception of the target
//   (id + reason + scope). Layers that launch the app must name a binary that is not older than the
//   sources; with --manifest it must be the binary inside the release package.
// - The release package (--manifest) must be the "release" variant built from HEAD.
// - Manual checks (clean install, screen reader, ...) come only from the evidence file and must
//   name the tested installer's SHA-256. Automated results never fill them.
// It never decides on its own that something is "verified". Exit code 1 when the target is not met.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PLATFORM_OF = { "win32-x64": "windows", "win32-arm64": "windows", "darwin-arm64": "macos", "darwin-x64": "macos", "linux-x64": "linux", "linux-arm64": "linux" };
/** Layers that launch the app binary: their result must name a fresh binary. */
const EXE_LAYERS = new Set(["e2e", "ai", "quality"]);

/** `#[ignore]` Rust tests that are manual tools or long measurements, not part of the automated layer. */
const RUST_MANUAL_TOOLS = {
  id: "rust-manual-tools",
  layer: "rust",
  kind: "skip",
  test: /^(photo::enhance::tests::(enhance_file_tool|enhance_perf_3mp_2x)|photo::thumbs::tests::photo_thumb_bench_500_12mp|restoration::tests::(enhance_speed_one_minute_480p|enhance_trial_on_a_given_clip)|transcode::tests::probe_and_transcode_real_file)$/,
  reason: "Elle çalıştırılan araç / ölçüm testleri (#[ignore]): bir dosya yolu ortam değişkeni ya da dakikalarca süren ölçüm ister. Otomatik katmanın parçası değil; yeni bir #[ignore] bu listede yoksa kapı reddeder.",
  scope: "Yalnızca adı geçen altı test.",
};

/** Release targets of plan 08 ("Sürüm kapsamları ve çıkış koşulları"). */
export const TARGETS = {
  "windows-alpha": {
    title: "Windows alfa",
    platforms: ["windows"],
    cards: ["S05", "A01", "A02", "A03", "A04", "A05", "A06", "V01", "V03", "L01", "L02", "L03", "P01", "P04", "P05", "Q01", "Q02", "Q03", "Q04", "R01", "R02", "R03"],
    // plan 08: the alpha needs only the local R02 preparation (workflows written, not run remotely)
    partialOk: { R02: /kod hazır \(yerel\)/i },
    layers: { windows: ["unit", "rust", "e2e", "ai", "quality", "installer"] },
    exceptions: [
      RUST_MANUAL_TOOLS,
      {
        id: "birefnet-experimental",
        layer: "ai",
        kind: "skip",
        test: /^(BiRefNet (portrait|general)\b|queue job: background \()/,
        reason: "Arka plan kaldırma (BiRefNet) deneysel ve varsayılan olarak gizli; referans cihazda WASM bellek sınırı (A06). Alfa notlarında desteklenmiyor yazılır.",
        scope: "Yalnızca arka plan kaldırma testleri; nesne silme ve renklendirme testleri zorunlu.",
      },
      {
        id: "legacy-photo-ai-out-of-scope",
        layer: "quality",
        // fail: the legacy profiles ran and missed the baseline; skip: the release run leaves them out
        // (VHO_QUALITY_PROFILES=lanczos,classic-x4: DAT-2 x4 on the runner CPU takes over 30 min per sample)
        kind: ["fail", "skip"],
        test: /^legacy experimental photo AI \(vho-x4, vho-x4-faces; out of the Windows alpha\)/,
        reason: "Eski nöral fotoğraf iyileştirme bu sürümde kapalı (giriş noktası yok). Başarısız sonucu kayıtta kalır: p10-alpha PSNR 32,89 dB, taban 36,95 dB. Özellik yeniden açılmadan önce çözülmeli.",
        scope: "Yalnızca eski vho-x4 / vho-x4-faces profillerinin taban karşılaştırması; Lanczos ve klasik (A05) profilleri zorunlu.",
      },
    ],
    // visible in the product but not part of what this target promises; listed in the report
    outOfScope: [
      { id: "L04", reason: "Ağ akışı ve DLNA: gerçek TV/hoparlör ile doğrulanmadı; alfa notlarında “test edilmedi” yazılır. Chromecast yok." },
      { id: "V02, V04–V06", reason: "Model tabanlı video iyileştirme ertelendi (kullanıcı kararı). V03 modelsiz yol kapsamda." },
      { id: "Eski nöral fotoğraf AI", reason: "DAT-2 ×4 + GFPGAN yolu kapatıldı (src/core/scope.js, kullanıcı kararı 2026-10-28): panel bölümü, E kısayolu ve denetleyici yok. Varsayılan iyileştirme modelsiz A05." },
    ],
    manual: ["win-clean-install", "win-uninstall", "win-upgrade", "win-file-associations", "win-os-actions", "win-screen-reader"],
  },
  "desktop-beta": {
    title: "Masaüstü beta",
    platforms: ["windows", "macos", "linux"],
    cards: ["P02", "P03", "P04", "P05", "L01", "L02", "L03", "R01", "R02", "R03"],
    partialOk: {},
    // documents / the gate tool itself: the same on every platform
    platformNeutral: ["R01", "R03"],
    layers: {
      windows: ["unit", "rust", "e2e", "ai", "quality", "installer"],
      macos: ["unit", "rust", "e2e", "ai", "quality"],
      linux: ["unit", "rust", "e2e", "ai", "quality"],
    },
    exceptions: [RUST_MANUAL_TOOLS],
    outOfScope: [],
    manual: ["win-clean-install", "win-uninstall", "win-upgrade", "win-file-associations", "win-os-actions", "win-screen-reader",
      "mac-install", "mac-os-actions", "mac-screen-reader", "linux-x11", "linux-wayland", "linux-packages"],
  },
};

/** "A03–A06" / "Q02–Q04, R03–R04" / "S01" -> ["A03", ...]; null when any part is not a card id. */
export function expandIds(cell) {
  const out = [];
  for (const part of cell.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z])(\d{2})\s*[–-]\s*([A-Z])?(\d{2})$/);
    if (m && (!m[3] || m[3] === m[1])) {
      for (let n = Number(m[2]); n <= Number(m[4]); n++) out.push(`${m[1]}${String(n).padStart(2, "0")}`);
    } else if (/^[A-Z]\d{2}$/.test(part)) {
      out.push(part);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Status rows of plan 08: Map(id -> { status, evidence }). A single-card row beats a range row.
 * Rows whose first cell starts like a card id but is not one ("V03 (scope)") are collected in
 * `map.unparsed`: the gate fails on them instead of silently reading an older range row.
 */
export function parseStatus(markdown) {
  const map = new Map();
  map.unparsed = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !/^[A-Z]\d{2}/.test(cells[1])) continue;
    const ids = expandIds(cells[1]);
    if (!ids) {
      map.unparsed.push(cells[1]);
      continue;
    }
    for (const id of ids) {
      const prev = map.get(id);
      if (prev && prev.single && ids.length > 1) continue;
      map.set(id, { status: cells[2], evidence: cells[3], single: ids.length === 1 });
    }
  }
  return map;
}

const PLATFORM_RE = { windows: /windows/i, macos: /macos|mac os/i, linux: /linux/i };

/**
 * Platforms a status cell calls "doğrulandı":
 *   "doğrulandı"                          -> windows (all evidence of this project is Windows)
 *   "doğrulandı (Windows; …)"             -> windows
 *   "Windows: doğrulandı …; macOS/Linux: ortam bekliyor" -> windows
 */
export function verifiedOn(status) {
  const out = new Set();
  for (const m of status.matchAll(/((?:windows|macos|linux)(?:\s*\/\s*(?:windows|macos|linux))*)\s*:\s*([^;]*)/gi)) {
    if (/^doğrulandı/i.test(m[2].trim())) for (const p of m[1].split("/")) out.add(p.trim().toLowerCase());
  }
  const lead = status.match(/^doğrulandı\s*(?:\(([^;)]*))?/i);
  if (lead) {
    const named = Object.keys(PLATFORM_RE).filter((p) => PLATFORM_RE[p].test(lead[1] ?? ""));
    (named.length ? named : ["windows"]).forEach((p) => out.add(p));
  }
  return out;
}

/** ok | partial | missing for one card of a target. */
export function classify(id, row, target) {
  if (!row) return "missing";
  const platforms = target.platforms ?? ["windows"];
  const on = verifiedOn(row.status);
  if (target.platformNeutral?.includes(id) && on.size) return "ok";
  if (platforms.every((p) => on.has(p))) return "ok";
  const partial = target.partialOk?.[id];
  if (partial && partial.test(row.status)) return "ok";
  if (on.size || /kod hazır/i.test(row.status)) return "partial";
  return "missing";
}

const sameCommit = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * One layer result -> { result: ok | stale | fail | missing, problems[], excepted[] }.
 * ctx: { head, platformKey (e.g. "win32-x64"), exeSha256 (release package binary, optional) }.
 */
export function checkLayer(layer, r, target, ctx = {}) {
  if (!r) return { layer, result: "missing", problems: ["sonuç dosyası yok (katmanı çalıştırın)"], excepted: [] };
  const problems = [];
  let stale = false;
  if (r.layer !== layer) problems.push(`yanlış katman: dosya "${r.layer ?? "?"}" diyor`);
  const commit = r.commitFull ?? r.commit;
  if (!commit) problems.push("commit bilgisi yok");
  else if (ctx.head && !sameCommit(commit, ctx.head)) { stale = true; problems.push(`${String(commit).slice(0, 7)} commitinden, HEAD ${ctx.head.slice(0, 7)}`); }
  if (r.dirty === true) problems.push("commitlenmemiş değişikliklerle çalıştı");
  if (!r.platform) problems.push("platform bilgisi yok");
  else if (ctx.platformKey && r.platform !== ctx.platformKey) problems.push(`platform ${r.platform}, beklenen ${ctx.platformKey}`);
  if (r.full !== true) problems.push("katmanın tamamı değil (dosya listesi / ad filtresi ya da kayıt yok)");
  const n = (k) => Number(r[k] ?? 0);
  if (!(n("pass") > 0)) problems.push("hiç test geçmedi (0 test)");
  if (n("cancelled") > 0) problems.push(`${n("cancelled")} iptal`);
  const excepted = new Set();
  // a failure passes only when a declared out-of-scope exception names that very test
  const failed = r.failed ?? [];
  if (n("fail") + n("cancelled") !== failed.length) problems.push(`${n("fail")} başarısız sayıldı, ${failed.length} tanesi adıyla listelenmiş`);
  let failuresExcused = n("fail") > 0 && n("cancelled") === 0;
  for (const t of failed) {
    const ex = (target.exceptions ?? []).find((e) => e.layer === layer && [e.kind].flat().includes("fail") && e.test.test(t.name));
    if (ex) excepted.add(ex.id);
    else { failuresExcused = false; problems.push(`başarısız: ${t.name}${t.error ? ` — ${t.error}` : ""}`); }
  }
  // the runner exits 1 on any failure: accepted only when every failure is an excepted one
  if (r.exitCode !== 0 && !(failuresExcused && r.exitCode === 1)) problems.push(`çıkış kodu ${r.exitCode ?? "kayıtlı değil"}`);

  // every skip / todo must be listed and covered by a declared exception of this target
  for (const [kind, count, list] of [["skip", n("skip"), r.skipped ?? []], ["todo", n("todo"), r.todos ?? []]]) {
    if (count !== list.length) problems.push(`${count} ${kind} sayıldı, ${list.length} tanesi adıyla listelenmiş`);
    for (const t of list) {
      const ex = (target.exceptions ?? []).find((e) => e.layer === layer && [e.kind].flat().includes(kind) && e.test.test(t.name));
      if (ex) excepted.add(ex.id);
      else problems.push(`${kind}: ${t.name}${t.reason ? ` — ${t.reason}` : ""}`);
    }
  }

  if (EXE_LAYERS.has(layer)) {
    if (!r.exe || r.exe.missing) problems.push("test edilen binary kaydı yok");
    else {
      if (r.exe.stale) problems.push(`binary kaynaklardan eski (${r.exe.stale})`);
      if (!r.exe.sha256) problems.push("binary SHA-256 kaydı yok");
      else if (ctx.exeSha256 && r.exe.sha256 !== ctx.exeSha256) problems.push("test edilen binary yayın paketindeki değil");
    }
  }
  if (layer === "installer") {
    if (!r.installer?.sha256) problems.push("test edilen kurulum dosyası kaydı yok");
  }
  const result = problems.length === 0 ? "ok" : stale && problems.length === 1 ? "stale" : "fail";
  return { layer, result, problems, excepted: [...excepted] };
}

/**
 * The installer the manifest names, read from disk next to the manifest: { exists, sha256,
 * checksumFile } (checksumFile: the hash written in `<installer>.sha256`, if that file exists).
 */
export function readArtifactFile(manifestPath, manifest) {
  if (!manifestPath || !manifest?.installer) return null;
  const file = join(dirname(resolve(manifestPath)), manifest.installer);
  if (!existsSync(file)) return { file, exists: false };
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const sumPath = `${file}.sha256`;
  const checksumFile = existsSync(sumPath) ? readFileSync(sumPath, "utf8").trim().split(/\s+/)[0].toLowerCase() : null;
  return { file, exists: true, sha256, checksumFile };
}

/** The release package manifest written by scripts/package-windows.ps1, and the file it names. */
export function checkArtifact(manifest, head, file = undefined) {
  if (!manifest) return { result: "missing", problems: ["yayın paketi verilmedi (--manifest)"], installerSha256: null, exeSha256: null };
  const problems = [];
  if (manifest.variant !== "release") problems.push(`paket türü "${manifest.variant}", beklenen release`);
  if (!sameCommit(manifest.sourceCommit, head)) problems.push(`paket ${String(manifest.sourceCommit ?? "?").slice(0, 7)} commitinden, HEAD ${String(head).slice(0, 7)}`);
  if (manifest.nativeHashesMatchInventory !== true) problems.push("yerel DLL seti lisans envanteriyle eşleşmiyor");
  const exe = (manifest.files ?? []).find((f) => /main binary/.test(f.path));
  if (!exe?.sha256) problems.push("paket manifestinde ana binary yok");
  if (!manifest.sha256) problems.push("paket manifestinde kurulum SHA-256 yok");
  // the manifest alone proves nothing: the file it names must exist and hash to the same value
  if (!file) problems.push("kurulum dosyası okunmadı (manifestin yanında aranır)");
  else if (!file.exists) problems.push(`kurulum dosyası yok: ${manifest.installer}`);
  else {
    if (file.sha256 !== manifest.sha256) problems.push("kurulum dosyasının gerçek SHA-256'sı manifestle uyuşmuyor (sonradan değişmiş)");
    if (file.checksumFile && file.checksumFile !== file.sha256) problems.push(".sha256 dosyası kurulum dosyasıyla uyuşmuyor");
  }
  return { result: problems.length ? "fail" : "ok", problems, installerSha256: manifest.sha256 ?? null, exeSha256: exe?.sha256 ?? null, name: manifest.installer };
}

/** Manual checks from the evidence file; each must pass on the tested installer. */
export function checkManual(ids, evidence, installerSha256) {
  return ids.map((id) => {
    const c = evidence?.checks?.find((x) => x.id === id);
    if (!c) return { id, result: "missing", detail: "kanıt dosyasında yok" };
    const problems = [];
    if (c.result !== "pass") problems.push(`sonuç: ${c.result ?? "not-run"}`);
    else {
      for (const k of ["date", "tester", "os"]) if (!c[k]) problems.push(`${k} yok`);
      if (!c.artifactSha256) problems.push("hangi kurulum dosyasıyla yapıldığı yazılmamış");
      else if (!installerSha256) problems.push("karşılaştırılacak paket yok (--manifest)");
      else if (c.artifactSha256 !== installerSha256) problems.push("başka bir kurulum dosyasıyla yapılmış");
    }
    return { id, title: c.title, result: problems.length ? (c.result === "pass" ? "fail" : "missing") : "ok", detail: problems.join("; ") || `${c.os}, ${c.date}, ${c.tester}` };
  });
}

/**
 * results: { "<platform>-<arch>": { unit: {...}, rust: {...}, ... } }
 * opts: { head, manifest, evidence }
 */
export function gate(targetName, planText, results, opts = {}) {
  const stage = opts.stage ?? "release";
  if (!["candidate", "release"].includes(stage)) throw new Error(`unknown stage ${stage} (candidate, release)`);
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target ${targetName} (${Object.keys(TARGETS).join(", ")})`);
  const head = opts.head ?? "";
  const status = parseStatus(planText);
  const cards = target.cards.map((id) => {
    const row = status.get(id);
    return { id, result: classify(id, row, target), status: row?.status ?? "(no row)" };
  });
  const artifact = checkArtifact(opts.manifest, head, opts.artifactFile);
  const layers = [];
  for (const platform of target.platforms) {
    const keys = Object.keys(results).filter((k) => PLATFORM_OF[k] === platform);
    const platformKey = keys[0] ?? Object.keys(PLATFORM_OF).find((k) => PLATFORM_OF[k] === platform);
    const set = results[platformKey] ?? {};
    for (const layer of target.layers[platform] ?? []) {
      // the release package binary binds only the platform it was built for (Windows today)
      const exeSha256 = platform === "windows" ? artifact.exeSha256 : null;
      const c = checkLayer(layer, set[layer], target, { head, platformKey, exeSha256 });
      if (layer === "installer" && c.result === "ok" && artifact.installerSha256 && set[layer].identity === "release"
        && set[layer].installer.sha256 !== artifact.installerSha256) {
        c.result = "fail";
        c.problems.push("kurulum testi yayın paketindeki dosyayla yapılmamış");
      }
      layers.push({ platform, ...c });
    }
  }
  const manual = checkManual(target.manual ?? [], opts.evidence, artifact.installerSha256);
  const usedExceptions = new Set(layers.flatMap((l) => l.excepted));
  const exceptions = (target.exceptions ?? []).filter((e) => usedExceptions.has(e.id));
  const plan = { unparsed: status.unparsed };
  // a candidate is the package the manual checks are then run on: they cannot exist yet
  const met = plan.unparsed.length === 0 && cards.every((c) => c.result === "ok") && layers.every((l) => l.result === "ok")
    && artifact.result === "ok" && (stage === "candidate" || manual.every((m) => m.result === "ok"));
  return { target: targetName, title: target.title, stage, platforms: target.platforms, met, plan, cards, layers, artifact, manual, exceptions, outOfScope: target.outOfScope ?? [] };
}

export function toMarkdown(report) {
  const icon = { ok: "✅", partial: "🟡", missing: "❌", fail: "❌", stale: "🟡" };
  const cell = (s) => String(s).replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const lines = [
    `### Kapı: ${report.title} (\`${report.target}\`, ${report.platforms.join(" + ")}, ${report.stage === "candidate" ? "aday: elle doğrulamalar henüz istenmez" : "yayın"}) — ${report.met ? "**karşılandı**" : "**karşılanmadı**"}`,
    "",
  ];
  if (report.plan.unparsed.length) {
    lines.push(`❌ Plan 08'de okunamayan kart satırı: ${report.plan.unparsed.map((u) => `\`${cell(u)}\``).join(", ")} (kimlik hücresinde yalnızca kart kimliği olmalı)`, "");
  }
  lines.push("| Kart | Durum (plan 08) | Sonuç |", "|---|---|---|",
    ...report.cards.map((c) => `| ${c.id} | ${cell(c.status).slice(0, 120)} | ${icon[c.result]} ${c.result} |`), "",
    "| Platform | Test katmanı | Sorunlar | Sonuç |", "|---|---|---|---|",
    ...report.layers.map((l) => `| ${l.platform} | ${l.layer} | ${cell(l.problems.join("; ") || "—").slice(0, 300)}${l.excepted.length ? ` (istisna: ${l.excepted.join(", ")})` : ""} | ${icon[l.result]} ${l.result} |`), "",
    `**Yayın paketi:** ${icon[report.artifact.result]} ${report.artifact.result}${report.artifact.name ? ` — ${report.artifact.name}` : ""}${report.artifact.problems.length ? ` — ${report.artifact.problems.join("; ")}` : ""}`, "");
  if (report.manual.length) {
    lines.push("| Elle doğrulama (cihaz / insan) | Sonuç |", "|---|---|",
      ...report.manual.map((m) => `| ${m.id}${m.title ? ` — ${cell(m.title)}` : ""} | ${icon[m.result]} ${cell(m.detail)} |`), "");
  }
  if (report.exceptions.length) {
    lines.push("**Kullanılan kapsam istisnaları** (geçti sayılmaz; yalnızca bu hedefin kapsamı dışında):", "",
      ...report.exceptions.map((e) => `- \`${e.id}\` (${e.layer}, ${[e.kind].flat().join("/")}): ${e.reason} Kapsam: ${e.scope}`), "");
  }
  if (report.outOfScope.length) {
    lines.push("**Bu hedefin vaat etmediği özellikler:**", "", ...report.outOfScope.map((o) => `- ${o.id}: ${o.reason}`), "");
  }
  return lines.join("\n");
}

function readJson(p) {
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const all = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
  const targetName = opt("--target", "windows-alpha");
  const planRef = opt("--plan-ref", null);
  const planPath = "docs/plans/08-uygulama-sirasi-ve-durum.md";
  const plan = planRef
    ? execFileSync("git", ["show", `${planRef}:${planPath}`], { cwd: ROOT, encoding: "utf8" })
    : readFileSync(join(ROOT, planPath), "utf8");
  const dirs = all("--results");
  const sources = dirs.length ? dirs.map((d) => d.split("=")) : [[`${process.platform}-${process.arch}`, join(ROOT, "tests", ".results")]];
  const results = {};
  for (const [key, dir] of sources) {
    results[key] = Object.fromEntries(["unit", "rust", "e2e", "ai", "quality", "installer"].map((l) => [l, readJson(join(resolve(dir), `${l}.json`))]));
  }
  let head = "";
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
  const manifestPath = opt("--manifest", null);
  const manifest = manifestPath ? readJson(resolve(manifestPath)) : null;
  if (manifestPath && !manifest) throw new Error(`cannot read the package manifest ${manifestPath}`);
  const evidence = readJson(resolve(opt("--evidence", join(ROOT, "docs", "releases", "evidence", `${targetName}.json`))));
  const artifactFile = manifest ? readArtifactFile(manifestPath, manifest) : undefined;
  const report = gate(targetName, plan, results, { head, manifest, artifactFile, evidence, stage: opt("--stage", "release") });
  const md = toMarkdown(report);
  console.log(md);
  const out = opt("--markdown", null);
  if (out) writeFileSync(resolve(out), md + "\n");
  const json = opt("--json", null);
  if (json) writeFileSync(resolve(json), JSON.stringify({ ...report, head }, (k, v) => (v instanceof RegExp ? String(v) : v), 2));
  process.exitCode = report.met ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
