// Persistent job queue client (Plan 11/A02): event ordering by seq, snapshot merge,
// progress without fake percentages, decision predicates, run()/wait() lifecycle, TR/EN keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "../../src/core/i18n.js";
import {
  ACTIVE_STATES, DECISION_STATES, TERMINAL_STATES, applyEvent, canCancel, canContinue, canPause, canRemove, canRestart,
  createJobs, jobCounts, jobProgress, mergeList,
} from "../../src/core/jobs.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const dict = (lang) => JSON.parse(readFileSync(join(SRC, "i18n", `${lang}.json`), "utf8"));
const snap = (o) => ({ id: "j1", kind: "export", state: "queued", title: "a.mp4", seq: 1, done: 0, total: 1, fraction: null, failed: 0, createdAt: 1, ...o });

test("jobs: events apply only when newer (seq), stale/duplicate events are dropped", () => {
  const m = new Map();
  assert.equal(applyEvent(m, { jobId: "j1", seq: 2, job: snap({ seq: 2, state: "running" }) }), true);
  assert.equal(applyEvent(m, { jobId: "j1", seq: 2, job: snap({ seq: 2, state: "queued" }) }), false, "duplicate");
  assert.equal(applyEvent(m, { jobId: "j1", seq: 1, job: snap({ seq: 1, state: "queued" }) }), false, "older");
  assert.equal(m.get("j1").state, "running");
  assert.equal(applyEvent(m, { jobId: "j1", seq: 5, job: snap({ seq: 5, state: "completed" }) }), true);
  assert.equal(applyEvent(m, null), false);
  // list snapshot: an older stored seq does not overwrite a newer event; removed jobs vanish
  m.set("gone", snap({ id: "gone" }));
  mergeList(m, [snap({ seq: 4, state: "running" }), snap({ id: "j2", seq: 1 })]);
  assert.equal(m.get("j1").state, "completed");
  assert.ok(m.has("j2") && !m.has("gone"));
});

test("jobs: progress is real or null (no fake percentage)", () => {
  assert.equal(jobProgress(snap({ state: "queued" })), null);
  assert.equal(jobProgress(snap({ state: "running", fraction: null })), null, "unknown duration");
  assert.equal(jobProgress(snap({ state: "running", fraction: 0.4 })), 0.4);
  assert.equal(jobProgress(snap({ state: "completed" })), 1);
  assert.equal(jobProgress(snap({ state: "running", total: null })), null);
  assert.equal(jobProgress(snap({ kind: "photo-batch", state: "running", total: 4, done: 1, failed: 1 })), 0.5);
  assert.equal(jobProgress(snap({ kind: "photo-batch", state: "running", total: 4, done: 2, fraction: 0.5 })), 0.625);
  assert.equal(jobProgress(snap({ kind: "photo-batch", state: "interrupted", total: 4, done: 2, fraction: 0.5 })), 0.5);
});

test("jobs: decision predicates follow the state machine", () => {
  for (const s of ACTIVE_STATES) assert.equal(canRemove({ state: s }), false, s);
  for (const s of [...DECISION_STATES, ...TERMINAL_STATES]) assert.equal(canRemove({ state: s }), true, s);
  assert.equal(canContinue({ state: "interrupted" }), true);
  assert.equal(canContinue({ state: "interrupted", resumeBlock: "sourceChanged" }), false, "changed source blocks continue");
  assert.equal(canRestart({ state: "interrupted", resumeBlock: "sourceChanged" }), true);
  assert.equal(canContinue({ state: "completed" }), false);
  assert.equal(canRestart({ state: "cancelled" }), true);
  assert.equal(canPause({ state: "running" }), true);
  assert.equal(canPause({ state: "paused" }), false);
  assert.equal(canCancel({ state: "running" }), true);
  assert.equal(canCancel({ state: "completed" }), false);
  assert.deepEqual(jobCounts([{ state: "running" }, { state: "queued" }, { state: "interrupted" }, { state: "failed" }, { state: "completed" }]),
    { active: 2, attention: 2 });
});

function fakeBackend() {
  let handler = null;
  const calls = [];
  const jobs = new Map();
  let seq = 0;
  const emit = (job) => handler?.({ payload: { jobId: job.id, attemptId: job.attemptId, seq: job.seq, job } });
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "jobs_submit") {
      const j = snap({ id: `j${jobs.size + 1}`, seq: ++seq, title: args.job.title ?? "", kind: args.job.kind });
      jobs.set(j.id, j);
      return j;
    }
    if (cmd === "jobs_list") return [...jobs.values()];
    if (cmd === "jobs_get") return { job: jobs.get(args.id), items: [] };
    if (cmd === "jobs_cancel") {
      const j = { ...jobs.get(args.id), state: "cancelled", seq: ++seq };
      jobs.set(j.id, j);
      return j;
    }
    if (cmd === "jobs_remove") return jobs.delete(args.id);
    throw new Error(`unexpected ${cmd}`);
  };
  const advance = (id, patch) => {
    const j = { ...jobs.get(id), ...patch, seq: ++seq };
    jobs.set(id, j);
    emit(j);
    return j;
  };
  return { invoke, listen: async (name, fn) => { assert.equal(name, "job-event"); handler = fn; return () => {}; }, advance, calls };
}

test("jobs: run() submits, reports updates in order and resolves when the job stops", async () => {
  const be = fakeBackend();
  const jobs = createJobs({ invoke: be.invoke, listen: be.listen, pollMs: 20 });
  const seen = [];
  let submitted = null;
  const p = jobs.run("export", { input: "a.mp4", kind: "cut" }, { title: "a.mp4", onSubmitted: (s) => { submitted = s.id; }, onUpdate: (j) => seen.push(j.state) });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(submitted, "j1");
  be.advance("j1", { state: "running", fraction: 0.5 });
  be.advance("j1", { state: "completed", done: 1, result: { results: [{ output: "out.mp4", bytes: 9 }] } });
  const final = await p;
  assert.equal(final.state, "completed");
  assert.deepEqual(seen, ["queued", "running", "completed"]);
  assert.equal(jobs.available, true);
  assert.equal(jobs.list.length, 1);
});

test("jobs: wait() also works when events were missed (poll), cancel and remove update the list", async () => {
  const be = fakeBackend();
  const jobs = createJobs({ invoke: be.invoke, listen: async () => () => {}, pollMs: 10 }); // no events at all
  const s = await jobs.submit("photo-batch", { files: ["a.jpg"] });
  const w = jobs.wait(s.id);
  await jobs.cancel(s.id);
  assert.equal((await w).state, "cancelled");
  await jobs.remove(s.id);
  assert.equal(jobs.get(s.id), null);
});

test("jobs: storage unavailable switches callers to the direct runners", async () => {
  const jobs = createJobs({ invoke: async () => { throw { code: "storageUnavailable", message: "x" }; }, listen: undefined });
  assert.equal(jobs.available, null);
  await assert.rejects(jobs.refresh());
  assert.equal(jobs.available, false);
});

test("jobs: every state / action / error code shown by the panel exists in TR and EN", () => {
  const panel = readFileSync(join(SRC, "ui", "jobs-panel.js"), "utf8");
  const used = new Set([...panel.matchAll(/\bt\(\s*"([\w.]+)"/g)].map((m) => m[1]));
  for (const s of [...ACTIVE_STATES, ...DECISION_STATES, ...TERMINAL_STATES]) used.add(`jobs.state.${s}`);
  for (const c of ["sourceChanged", "sourceMissing", "modelChanged", "recipeChanged", "diskFull", "itemsFailed", "noFfmpeg",
    "unsupported", "invalidState", "notFound", "storageUnavailable", "failed"]) used.add(`jobs.error.${c}`);
  for (const a of ["continue", "restart", "pause", "cancel", "reveal", "remove"]) used.add(`jobs.action.${a}`);
  used.add("jobs.waiting");
  for (const lang of ["tr", "en"]) {
    const d = dict(lang);
    assert.deepEqual([...used].filter((k) => !lookup(d, k)), [], lang);
  }
});
