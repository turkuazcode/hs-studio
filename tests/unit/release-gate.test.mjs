// R03: the release gate reads plan 08 statuses honestly (ranges, split rows, partial states).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, expandIds, gate, parseStatus, TARGETS } from "../../scripts/release-gate.mjs";

test("card id cells expand ranges and lists", () => {
  assert.deepEqual(expandIds("A03–A06"), ["A03", "A04", "A05", "A06"]);
  assert.deepEqual(expandIds("Q02–Q04, R03–R04"), ["Q02", "Q03", "Q04", "R03", "R04"]);
  assert.deepEqual(expandIds("S01"), ["S01"]);
});

test("plan rows: a single-card row beats a range row; statuses map to ok / partial / missing", () => {
  const plan = [
    "| P02–P05 | bekliyor | x |",
    "| P05 | Windows: kod hazır (…); macOS/Linux: ortam bekliyor | y |",
    "| A01 | doğrulandı | z |",
    "| R02 | kod hazır (yerel); ortam bekliyor | w |",
  ].join("\n");
  const s = parseStatus(plan);
  assert.equal(s.get("P03").status, "bekliyor");
  assert.match(s.get("P05").status, /^Windows: kod hazır/);
  const alpha = TARGETS["windows-photo-alpha"];
  assert.equal(classify("A01", s.get("A01"), alpha), "ok");
  assert.equal(classify("P05", s.get("P05"), alpha), "partial", "Windows 'kod hazır' is not 'doğrulandı'");
  assert.equal(classify("R02", s.get("R02"), alpha), "ok", "alpha needs only local R02 preparation");
  assert.equal(classify("P03", s.get("P03"), alpha), "missing");
  assert.equal(classify("X01", undefined, alpha), "missing");
});

test("gate: met only when every card is ok and every layer passed without skips", () => {
  const plan = TARGETS["windows-photo-alpha"].cards.map((id) => `| ${id} | doğrulandı | e |`).join("\n");
  const good = { unit: { pass: 1, fail: 0, skip: 0, commit: "abc1234" }, e2e: { pass: 1, fail: 0, skip: 0 }, installer: { pass: 28, fail: 0, skip: 0 } };
  assert.equal(gate("windows-photo-alpha", plan, good, "abc1234ffff").met, true);
  assert.equal(gate("windows-photo-alpha", plan, { ...good, e2e: { pass: 1, fail: 0, skip: 2 } }, "abc1234").met, false);
  assert.equal(gate("windows-photo-alpha", plan, { ...good, unit: { ...good.unit, commit: "0000000" } }, "abc1234").met, false, "stale results");
  assert.equal(gate("windows-photo-alpha", plan.replace("| A03 | doğrulandı", "| A03 | bekliyor"), good, "abc1234").met, false);
});
