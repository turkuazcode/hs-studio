// Release gate (plan 14/R03): compares a release target with the live status table of
// docs/plans/08-uygulama-sirasi-ve-durum.md and the latest test-layer results (tests/.results/*.json).
//
//   node scripts/release-gate.mjs                         # default target: windows-photo-alpha
//   node scripts/release-gate.mjs --target desktop-beta
//   node scripts/release-gate.mjs --markdown out.md       # also write the report as Markdown
//   node scripts/release-gate.mjs --plan-ref main         # read plan 08 from a git ref (e.g. main)
//
// It never decides on its own that something is "verified": it only reads what plan 08 says
// ("doğrulandı" / "kod hazır" / "bekliyor" / "ortam bekliyor" / "ertelendi") and what the test
// runner recorded. Exit code 1 when the target is not met (expected today for every target).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Release targets of plan 08 ("Sürüm kapsamları ve çıkış koşulları"). */
export const TARGETS = {
  "windows-photo-alpha": {
    title: "Windows fotoğraf alfa",
    cards: ["S05", "A01", "A02", "A03", "A04", "A05", "P01", "P04", "P05", "Q01", "Q02", "Q03", "Q04", "R01", "R02"],
    // cards where a Windows-only / local-preparation status is enough for this target
    partialOk: { P04: /windows: doğrulandı/i, P05: /windows: doğrulandı/i, R02: /kod hazır \(yerel\)|doğrulandı/i },
    layers: ["unit", "e2e", "installer"],
  },
  "desktop-beta": {
    title: "Masaüstü beta",
    cards: ["P02", "P03", "P04", "P05", "L01", "L02", "L03", "R01", "R02", "R03"],
    partialOk: {},
    layers: ["unit", "e2e", "installer", "ai"],
  },
};

/** "A03–A06" / "Q02–Q04, R03–R04" / "S01" -> ["A03", "A04", "A05", "A06", ...] */
export function expandIds(cell) {
  const out = [];
  for (const part of cell.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Z])(\d{2})\s*[–-]\s*([A-Z])?(\d{2})$/);
    if (m) {
      for (let n = Number(m[2]); n <= Number(m[4]); n++) out.push(`${m[1]}${String(n).padStart(2, "0")}`);
    } else if (/^[A-Z]\d{2}$/.test(part)) {
      out.push(part);
    }
  }
  return out;
}

/** Status rows of plan 08: Map(id -> { status, evidence }). Later rows win (a split row overrides a range). */
export function parseStatus(markdown) {
  const map = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !/^[A-Z]\d{2}/.test(cells[1])) continue;
    const ids = expandIds(cells[1]);
    for (const id of ids) {
      const prev = map.get(id);
      // an explicit single-card row beats a range row
      if (prev && prev.single && ids.length > 1) continue;
      map.set(id, { status: cells[2], evidence: cells[3], single: ids.length === 1 });
    }
  }
  return map;
}

/** ok | partial | missing for one card of a target. */
export function classify(id, row, target) {
  if (!row) return "missing";
  const s = row.status.toLowerCase();
  if (/^doğrulandı/.test(s)) return "ok";
  const partial = target.partialOk?.[id];
  if (partial && partial.test(row.status)) return "ok";
  if (/kod hazır/.test(s)) return "partial";
  return "missing";
}

function readResults(layer) {
  const p = join(ROOT, "tests", ".results", `${layer}.json`);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
    if (Array.isArray(r)) { // installer.json: list of checks
      const fail = r.filter((c) => !c.ok).length;
      return { layer, pass: r.length - fail, fail, skip: 0, commit: null };
    }
    return r;
  } catch {
    return null;
  }
}

export function gate(targetName, planText, results, head) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target ${targetName} (${Object.keys(TARGETS).join(", ")})`);
  const status = parseStatus(planText);
  const cards = target.cards.map((id) => {
    const row = status.get(id);
    return { id, result: classify(id, row, target), status: row?.status ?? "(no row)" };
  });
  const layers = target.layers.map((layer) => {
    const r = results[layer];
    if (!r) return { layer, result: "missing", detail: "no result file (run the layer)" };
    const stale = head && r.commit && !head.startsWith(r.commit) ? ` · from ${r.commit}, HEAD ${head.slice(0, 7)}` : "";
    const ok = r.fail === 0 && (r.skip ?? 0) === 0 && (r.cancelled ?? 0) === 0;
    return { layer, result: ok ? (stale ? "stale" : "ok") : "fail", detail: `pass ${r.pass} · fail ${r.fail} · skip ${r.skip ?? 0}${stale}` };
  });
  const met = cards.every((c) => c.result === "ok") && layers.every((l) => l.result === "ok");
  return { target: targetName, title: target.title, met, cards, layers };
}

export function toMarkdown(report) {
  const icon = { ok: "✅", partial: "🟡", missing: "❌", fail: "❌", stale: "🟡" };
  const lines = [
    `### Kapı: ${report.title} (\`${report.target}\`) — ${report.met ? "**karşılandı**" : "**karşılanmadı**"}`,
    "",
    "| Kart | Durum (plan 08) | Sonuç |",
    "|---|---|---|",
    ...report.cards.map((c) => `| ${c.id} | ${c.status.replace(/\|/g, "/").slice(0, 120)} | ${icon[c.result]} ${c.result} |`),
    "",
    "| Test katmanı | Son sonuç | Sonuç |",
    "|---|---|---|",
    ...report.layers.map((l) => `| ${l.layer} | ${l.detail} | ${icon[l.result]} ${l.result} |`),
    "",
  ];
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const targetName = opt("--target", "windows-photo-alpha");
  const planRef = opt("--plan-ref", null);
  const planPath = "docs/plans/08-uygulama-sirasi-ve-durum.md";
  const plan = planRef
    ? execFileSync("git", ["show", `${planRef}:${planPath}`], { cwd: ROOT, encoding: "utf8" })
    : readFileSync(join(ROOT, planPath), "utf8");
  const results = Object.fromEntries(["unit", "e2e", "ai", "installer", "quality"].map((l) => [l, readResults(l)]));
  let head = "";
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
  const report = gate(targetName, plan, results, head);
  const md = toMarkdown(report);
  console.log(md);
  const out = opt("--markdown", null);
  if (out) writeFileSync(resolve(out), md + "\n");
  process.exitCode = report.met ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
