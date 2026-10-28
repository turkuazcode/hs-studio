// node --test reporter that writes one JSON summary (used next to the spec reporter by
// scripts/run-tests.mjs): pass / fail / skip / todo / cancelled are counted separately, and
// every skipped or failed test is listed with its reason. Suites are not counted as tests.
export default async function* summaryReporter(source) {
  const s = { pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0, skipped: [], failed: [], todos: [] };
  const where = (d) => (d.file ? `${d.file.replace(/\\/g, "/").split("/").slice(-2).join("/")}` : "");
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    if (d.details?.type === "suite") continue;
    const entry = { name: d.name, file: where(d) };
    // a failing todo test is reported as test:fail by node:test but does not fail the run
    if (ev.type === "test:fail" && d.todo !== undefined && d.todo !== false) {
      s.todo++;
      s.todos.push({ ...entry, reason: `${d.todo === true ? "" : String(d.todo)} (failing)` });
    } else if (ev.type === "test:fail") {
      const err = d.details?.error;
      const cause = err?.cause ?? err;
      if (err?.failureType === "cancelledByParent") s.cancelled++;
      else s.fail++;
      s.failed.push({ ...entry, error: String(cause?.message ?? cause ?? "").split("\n")[0].slice(0, 400) });
    } else if (d.skip !== undefined && d.skip !== false) {
      s.skip++;
      s.skipped.push({ ...entry, reason: d.skip === true ? "" : String(d.skip) });
    } else if (d.todo !== undefined && d.todo !== false) {
      s.todo++;
      s.todos.push({ ...entry, reason: d.todo === true ? "" : String(d.todo) });
    } else {
      s.pass++;
    }
  }
  yield JSON.stringify(s, null, 2);
}
