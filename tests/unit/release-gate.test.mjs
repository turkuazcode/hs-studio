// R03 / audit D01: the release gate reads plan 08 statuses honestly and refuses every kind of
// incomplete evidence (failed exit code, todo, stale binary, zero tests, missing commit, partial
// run, wrong suite / platform / artifact), while declared out-of-scope exceptions stay visible.
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { checkArtifact, checkLayer, readArtifactFile, checkManual, classify, expandIds, gate, parseStatus, TARGETS, verifiedOn } from "../../scripts/release-gate.mjs";
import { isFullRun, parseCargoTest } from "../../scripts/run-rust-tests.mjs";

const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const EXE = "e".repeat(64);
const INSTALLER = "1".repeat(64);
const alpha = TARGETS["windows-alpha"];

function layerResult(layer, extra = {}) {
  return {
    layer, commit: HEAD.slice(0, 7), commitFull: HEAD, dirty: false, platform: "win32-x64", full: true, exitCode: 0,
    pass: 10, fail: 0, skip: 0, todo: 0, cancelled: 0, skipped: [], failed: [], todos: [],
    exe: ["e2e", "ai", "quality"].includes(layer) ? { path: "x.exe", sha256: EXE, stale: null } : null,
    ...(layer === "installer" ? { identity: "test", installer: { name: "t.exe", sha256: "2".repeat(64) } } : {}),
    ...extra,
  };
}
const goodResults = () => ({ "win32-x64": Object.fromEntries(alpha.layers.windows.map((l) => [l, layerResult(l)])) });
const goodPlan = alpha.cards.map((id) => `| ${id} | doğrulandı | e |`).join("\n");
const manifest = (extra = {}) => ({
  installer: "HS Studio_0.1.0_x64-setup.exe", sha256: INSTALLER, variant: "release", sourceCommit: HEAD, nativeHashesMatchInventory: true,
  files: [{ path: "HS Studio.exe (main binary, before installation)", sha256: EXE }], ...extra,
});
const evidence = (extra = {}) => ({ checks: alpha.manual.map((id) => ({ id, result: "pass", os: "Windows 11 24H2", date: "2026-11-01", tester: "t", artifactSha256: INSTALLER, ...extra })) });
const okFile = { exists: true, sha256: INSTALLER, checksumFile: INSTALLER };
const opts = (o = {}) => ({ head: HEAD, manifest: manifest(), artifactFile: okFile, evidence: evidence(), ...o });
const problemsOf = (layer, r, ctx = {}) => checkLayer(layer, r, alpha, { head: HEAD, platformKey: "win32-x64", ...ctx }).problems.join(" | ");

test("card id cells expand ranges and lists; anything else is not a card id", () => {
  assert.deepEqual(expandIds("A03–A06"), ["A03", "A04", "A05", "A06"]);
  assert.deepEqual(expandIds("Q02–Q04, R03–R04"), ["Q02", "Q03", "Q04", "R03", "R04"]);
  assert.deepEqual(expandIds("S01"), ["S01"]);
  assert.equal(expandIds("V03 (modelsiz yeniden kapsam)"), null);
});

test("plan rows: a single-card row beats a range row; a decorated id is reported, not silently skipped", () => {
  const s = parseStatus([
    "| V03 (modelsiz yeniden kapsam) | doğrulandı (Windows) | x |",
    "| V03–V06 | ertelendi | y |",
  ].join("\n"));
  assert.deepEqual(s.unparsed, ["V03 (modelsiz yeniden kapsam)"]);
  assert.equal(s.get("V03").status, "ertelendi", "the range row is all that is left: the gate must fail on the unparsed row");
  const fixed = parseStatus("| V03 | doğrulandı (Windows; modelsiz yeniden kapsam) | x |\n| V03–V06 | ertelendi | y |");
  assert.equal(fixed.unparsed.length, 0);
  assert.match(fixed.get("V03").status, /^doğrulandı/);
  assert.equal(fixed.get("V04").status, "ertelendi");
  const report = gate("windows-alpha", goodPlan + "\n| V03 (x) | doğrulandı | y |", goodResults(), opts());
  assert.equal(report.met, false);
  assert.deepEqual(report.plan.unparsed, ["V03 (x)"]);
});

test("statuses: Windows evidence never stands in for macOS / Linux", () => {
  assert.deepEqual([...verifiedOn("doğrulandı")], ["windows"], "plain 'doğrulandı' is Windows evidence");
  assert.deepEqual([...verifiedOn("doğrulandı (Windows; `5fd03e9`); macOS/Linux ortam bekliyor")], ["windows"]);
  assert.deepEqual([...verifiedOn("Windows: doğrulandı (…); macOS/Linux: ortam bekliyor")], ["windows"]);
  assert.deepEqual([...verifiedOn("Windows: doğrulandı; macOS: doğrulandı; Linux: doğrulandı")].sort(), ["linux", "macos", "windows"]);
  assert.equal(verifiedOn("kod hazır (Linux); ortam bekliyor").size, 0);
  const beta = TARGETS["desktop-beta"];
  const row = (status) => ({ status });
  assert.equal(classify("P04", row("doğrulandı (Windows; x); macOS/Linux ortam bekliyor"), alpha), "ok");
  assert.equal(classify("P04", row("doğrulandı (Windows; x); macOS/Linux ortam bekliyor"), beta), "partial");
  assert.equal(classify("L01", row("doğrulandı"), beta), "partial", "a plain status is not three-platform evidence");
  assert.equal(classify("R01", row("doğrulandı"), beta), "ok", "R01 is declared platform-neutral");
  assert.equal(classify("R02", row("kod hazır (yerel); ortam bekliyor"), alpha), "ok", "alpha needs only local R02 preparation");
  assert.equal(classify("R02", row("kod hazır (yerel); ortam bekliyor"), beta), "partial");
  assert.equal(classify("P02", row("ortam bekliyor"), beta), "missing");
  assert.equal(classify("X01", undefined, alpha), "missing");
});

test("gate: met with complete evidence for every card, layer, package and manual check", () => {
  const r = gate("windows-alpha", goodPlan, goodResults(), opts());
  assert.equal(r.met, true, JSON.stringify(r.layers.filter((l) => l.result !== "ok")));
  assert.equal(gate("windows-alpha", goodPlan.replace("| A03 | doğrulandı", "| A03 | bekliyor"), goodResults(), opts()).met, false);
});

test("layer: the five insufficient results of the audit are refused", () => {
  // todo (the two HLS tests) without a declared exception
  const todo = layerResult("e2e", { todo: 1, todos: [{ name: "HLS from the URL dialog plays", reason: "open issue" }] });
  assert.match(problemsOf("e2e", todo), /todo: HLS from the URL dialog plays/);
  // failing process exit code although the counts look clean
  assert.match(problemsOf("e2e", layerResult("e2e", { exitCode: 1 })), /çıkış kodu 1/);
  assert.match(problemsOf("unit", layerResult("unit", { exitCode: undefined })), /çıkış kodu kayıtlı değil/);
  // stale binary
  assert.match(problemsOf("e2e", layerResult("e2e", { exe: { path: "x", sha256: EXE, stale: "src/main.js" } })), /binary kaynaklardan eski/);
  // zero tests
  assert.match(problemsOf("unit", layerResult("unit", { pass: 0 })), /0 test/);
  // no commit
  assert.match(problemsOf("unit", layerResult("unit", { commit: null, commitFull: null })), /commit bilgisi yok/);
  for (const r of [todo, layerResult("e2e", { exitCode: 1 }), layerResult("unit", { pass: 0 })]) {
    const res = goodResults();
    res["win32-x64"][r.layer] = r;
    assert.equal(gate("windows-alpha", goodPlan, res, opts()).met, false);
  }
});

test("layer: partial runs, wrong suites, other platforms, dirty trees and old commits are refused", () => {
  assert.match(problemsOf("e2e", layerResult("e2e", { full: false })), /katmanın tamamı değil/);
  assert.match(problemsOf("ai", layerResult("ai", { full: undefined })), /katmanın tamamı değil/, "old result files without the flag");
  assert.match(problemsOf("e2e", layerResult("unit")), /yanlış katman/);
  assert.match(problemsOf("unit", layerResult("unit", { platform: "linux-x64" })), /platform linux-x64/);
  assert.match(problemsOf("unit", layerResult("unit", { platform: undefined })), /platform bilgisi yok/);
  assert.match(problemsOf("unit", layerResult("unit", { dirty: true })), /commitlenmemiş/);
  assert.equal(checkLayer("unit", layerResult("unit", { commitFull: "0000000aaaa", commit: "0000000" }), alpha, { head: HEAD, platformKey: "win32-x64" }).result, "stale");
  assert.match(problemsOf("unit", layerResult("unit", { fail: 1 })), /1 başarısız/);
  assert.match(problemsOf("unit", layerResult("unit", { cancelled: 2 })), /2 iptal/);
  assert.match(problemsOf("unit", layerResult("unit", { skip: 2, skipped: [] })), /2 skip sayıldı, 0 tanesi/);
  assert.equal(checkLayer("unit", null, alpha).result, "missing");
});

test("layer: exceptions cover only their declared tests; the report names them", () => {
  const ai = layerResult("ai", { skip: 1, skipped: [{ name: "BiRefNet portrait on WASM: background transparent, subject kept, reference", reason: "bad_alloc" }] });
  const c = checkLayer("ai", ai, alpha, { head: HEAD, platformKey: "win32-x64" });
  assert.equal(c.result, "ok");
  assert.deepEqual(c.excepted, ["birefnet-experimental"]);
  const lama = layerResult("ai", { skip: 1, skipped: [{ name: "LaMa object removal on WASM", reason: "x" }] });
  assert.equal(checkLayer("ai", lama, alpha, { head: HEAD, platformKey: "win32-x64" }).result, "fail", "a shipped AI feature cannot be skipped");
  const asTodo = layerResult("ai", { todo: 1, todos: [{ name: "BiRefNet general (objects) on WASM: runs" }] });
  assert.equal(checkLayer("ai", asTodo, alpha, { head: HEAD, platformKey: "win32-x64" }).result, "fail", "the exception is for skips only");
  const res = goodResults();
  res["win32-x64"].ai = ai;
  const report = gate("windows-alpha", goodPlan, res, opts());
  assert.equal(report.met, true);
  assert.deepEqual(report.exceptions.map((e) => e.id), ["birefnet-experimental"]);
  // a Rust #[ignore] outside the declared manual tools
  const rust = layerResult("rust", { skip: 2, skipped: [{ name: "restoration::tests::enhance_speed_one_minute_480p" }, { name: "jobs::tests::new_slow_case" }] });
  assert.match(problemsOf("rust", rust), /skip: jobs::tests::new_slow_case/);
  assert.doesNotMatch(problemsOf("rust", rust), /enhance_speed_one_minute_480p/);
});

test("artifact: only the release package built from HEAD, and the tests must have used its binary", () => {
  assert.equal(checkArtifact(null, HEAD).result, "missing");
  assert.match(checkArtifact(manifest(), HEAD).problems.join(), /kurulum dosyası okunmadı/, "a manifest alone is not a package");
  assert.match(checkArtifact(manifest(), HEAD, { exists: false }).problems.join(), /kurulum dosyası yok/);
  assert.match(checkArtifact(manifest(), HEAD, { ...okFile, sha256: "0".repeat(64) }).problems.join(), /sonradan değişmiş/);
  assert.match(checkArtifact(manifest(), HEAD, { ...okFile, checksumFile: "0".repeat(64) }).problems.join(), /\.sha256 dosyası/);
  assert.equal(checkArtifact(manifest(), HEAD, okFile).result, "ok");
  assert.match(checkArtifact(manifest({ variant: "test" }), HEAD).problems.join(), /paket türü "test"/);
  assert.match(checkArtifact(manifest({ sourceCommit: "0".repeat(40) }), HEAD).problems.join(), /0000000 commitinden/);
  assert.match(checkArtifact(manifest({ nativeHashesMatchInventory: false }), HEAD).problems.join(), /envanter/);
  assert.match(checkArtifact(manifest({ files: [] }), HEAD).problems.join(), /ana binary yok/);
  const res = goodResults();
  res["win32-x64"].e2e = layerResult("e2e", { exe: { path: "x", sha256: "f".repeat(64), stale: null } });
  const r = gate("windows-alpha", goodPlan, res, opts());
  assert.equal(r.met, false);
  assert.match(r.layers.find((l) => l.layer === "e2e").problems.join(), /yayın paketindeki değil/);
  assert.equal(gate("windows-alpha", goodPlan, goodResults(), opts({ manifest: null })).met, false, "no package, no release");
});

test("manual checks: never filled by automated results; must name the tested installer", () => {
  assert.equal(checkManual(["win-clean-install"], null, INSTALLER)[0].result, "missing");
  assert.equal(checkManual(["win-clean-install"], { checks: [{ id: "win-clean-install", result: "not-run" }] }, INSTALLER)[0].result, "missing");
  const pass = { id: "win-clean-install", result: "pass", os: "W11", date: "d", tester: "t", artifactSha256: "9".repeat(64) };
  assert.match(checkManual(["win-clean-install"], { checks: [pass] }, INSTALLER)[0].detail, /başka bir kurulum dosyası/);
  assert.match(checkManual(["win-clean-install"], { checks: [{ ...pass, artifactSha256: INSTALLER, tester: null }] }, INSTALLER)[0].detail, /tester yok/);
  assert.equal(checkManual(["win-clean-install"], { checks: [{ ...pass, artifactSha256: INSTALLER }] }, INSTALLER)[0].result, "ok");
  assert.equal(gate("windows-alpha", goodPlan, goodResults(), opts({ evidence: evidence({ result: "not-run" }) })).met, false);
});

test("candidate stage: automated evidence only; never a release, never without the package", () => {
  const none = evidence({ result: "not-run" });
  const cand = gate("windows-alpha", goodPlan, goodResults(), opts({ evidence: none, stage: "candidate" }));
  assert.equal(cand.met, true);
  assert.ok(cand.manual.every((m) => m.result === "missing"), "still listed as open");
  assert.equal(gate("windows-alpha", goodPlan, goodResults(), opts({ evidence: none })).met, false, "the release stage needs them");
  assert.equal(gate("windows-alpha", goodPlan, goodResults(), opts({ evidence: none, stage: "candidate", manifest: null })).met, false);
  const res = goodResults();
  res["win32-x64"].e2e = layerResult("e2e", { fail: 1 });
  assert.equal(gate("windows-alpha", goodPlan, res, opts({ stage: "candidate" })).met, false, "a failing layer refuses the candidate");
  assert.throws(() => gate("windows-alpha", goodPlan, goodResults(), opts({ stage: "beta" })), /unknown stage/);
});

test("desktop beta: Windows results alone never meet a three-platform target", () => {
  const beta = TARGETS["desktop-beta"];
  const plan = beta.cards.map((id) => `| ${id} | Windows: doğrulandı; macOS: doğrulandı; Linux: doğrulandı | e |`).join("\n");
  const r = gate("desktop-beta", plan, goodResults(), { head: HEAD, manifest: manifest(), evidence: { checks: beta.manual.map((id) => ({ id, result: "pass", os: "x", date: "d", tester: "t", artifactSha256: INSTALLER })) } });
  assert.equal(r.met, false);
  assert.ok(r.layers.filter((l) => l.platform !== "windows").every((l) => l.result === "missing"));
  assert.ok(r.cards.every((c) => c.result === "ok"));
});

test("rust runner: cargo test output -> counts; ignored tests are skips, not passes", () => {
  const s = parseCargoTest([
    "running 4 tests",
    "test a::b ... ok",
    "test a::c ... FAILED",
    "test a::d ... ignored",
    "test a::e ... ignored, needs VHO_TEST_MEDIA",
    "",
    "test result: FAILED. 1 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.1s",
  ].join("\r\n"));
  assert.equal(s.pass, 1);
  assert.equal(s.fail, 1);
  assert.equal(s.skip, 2);
  assert.deepEqual(s.skipped.map((t) => t.name), ["a::d", "a::e"]);
  assert.equal(s.skipped[1].reason, "needs VHO_TEST_MEDIA");
  assert.equal(s.resultLines, 1);
});

test("the real plan 08: every card row parses; V03 is the model-free row, V04-V06 are separate", () => {
  const s = parseStatus(readFileSync(new URL("../../docs/plans/08-uygulama-sirasi-ve-durum.md", import.meta.url), "utf8"));
  assert.deepEqual(s.unparsed, []);
  assert.match(s.get("V03").status, /^doğrulandı \(Windows; modelsiz/);
  assert.match(s.get("V04").status, /^kısmen kod hazır/);
  assert.match(s.get("V05").status, /^ertelendi/);
  assert.match(s.get("V06").status, /^bekliyor/);
  assert.equal(classify("P02", s.get("P02"), TARGETS["desktop-beta"]), "missing");
  assert.match(s.get("P02").status, /kod eksik/);
});

test("rust runner: a run with libtest filters or skips is never the whole layer", () => {
  const out = (filtered) => parseCargoTest(`test a ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; ${filtered} filtered out; finished in 0.1s`);
  assert.equal(isFullRun(out(0), []), true);
  assert.equal(out(218).filteredOut, 218);
  assert.equal(isFullRun(out(218), []), false, "--skip=x or a name after -- filters tests out");
  assert.equal(isFullRun(out(0), ["--skip=restoration"]), false, "an option that filters, even when nothing matched");
  assert.equal(isFullRun(out(0), ["restoration"]), false);
  assert.equal(isFullRun(parseCargoTest("error[E0425]: cannot find value"), []), false, "compile error: no result line");
});

test("artifact on disk: missing file, changed file and a stale .sha256 are found", () => {
  const dir = mkdtempSync(join(tmpdir(), "vho-gate-art-"));
  try {
    const mp = join(dir, "package-manifest-release-0.1.0.json");
    const bytes = Buffer.from("installer bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const m = { ...manifest(), installer: "HS Studio_0.1.0_x64-UNSIGNED-setup.exe", sha256: sha };
    assert.equal(readArtifactFile(mp, { ...m, installer: "does-not-exist.exe" }).exists, false);
    writeFileSync(join(dir, m.installer), bytes);
    writeFileSync(join(dir, `${m.installer}.sha256`), `${sha}  ${m.installer}
`);
    const f = readArtifactFile(mp, m);
    assert.deepEqual([f.exists, f.sha256 === sha, f.checksumFile === sha], [true, true, true]);
    assert.equal(checkArtifact(m, HEAD, f).result, "ok");
    writeFileSync(join(dir, m.installer), Buffer.concat([bytes, Buffer.from("x")]));
    assert.match(checkArtifact(m, HEAD, readArtifactFile(mp, m)).problems.join(), /sonradan değişmiş/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
