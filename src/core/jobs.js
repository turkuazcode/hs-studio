// ==========================================================================
// Persistent job queue client (Plan 11/A02; contract: docs/jobs-api.md).
//   jobs.run("export", request, { onUpdate })   -> final JobSnapshot (waits)
//   jobs.submit / cancel / pause / resume(id, "continue" | "restart") / remove
// The backend keeps every job in library.db and emits "job-event"
// { jobId, attemptId, itemId?, seq, job, item? }. Events with a seq not newer than the
// known snapshot are dropped; after a restart the UI reads the stored snapshots
// (jobs_list) instead of waiting for events.
// ==========================================================================

export const ACTIVE_STATES = Object.freeze(["queued", "running", "pausing", "cancelling"]);
/** Waiting for the user: continue / restart / remove. */
export const DECISION_STATES = Object.freeze(["failed", "interrupted", "paused"]);
export const TERMINAL_STATES = Object.freeze(["completed", "cancelled"]);

export const isActive = (job) => ACTIVE_STATES.includes(job?.state);
/** Continue keeps the completed items; blocked when the source/model/recipe changed. */
export const canContinue = (job) => DECISION_STATES.includes(job?.state) && !job.resumeBlock;
export const canRestart = (job) => DECISION_STATES.includes(job?.state) || job?.state === "cancelled";
export const canCancel = (job) => ["queued", "running", "pausing", "paused", "interrupted"].includes(job?.state);
export const canPause = (job) => job?.state === "running" || job?.state === "queued";
export const canRemove = (job) => !isActive(job);

/**
 * Applies a job-event to the snapshot map. Returns false for a stale/duplicate event
 * (seq not newer than the stored snapshot).
 */
export function applyEvent(jobs, ev) {
  if (!ev?.jobId || !ev.job) return false;
  const cur = jobs.get(ev.jobId);
  if (cur && Number(ev.seq) <= Number(cur.seq)) return false;
  jobs.set(ev.jobId, ev.job);
  return true;
}

/** Replaces the map with a jobs_list result, keeping a newer snapshot from an event. */
export function mergeList(jobs, list) {
  const ids = new Set();
  for (const snap of list ?? []) {
    ids.add(snap.id);
    const cur = jobs.get(snap.id);
    if (!cur || Number(snap.seq) >= Number(cur.seq)) jobs.set(snap.id, snap);
  }
  for (const id of [...jobs.keys()]) if (!ids.has(id)) jobs.delete(id);
}

/**
 * Overall progress 0..1, or null when it is not known (no fake percentage):
 * several items -> finished items (+ the running item's share when known);
 * one item -> its own fraction.
 */
export function jobProgress(job) {
  if (!job) return null;
  if (job.state === "completed") return 1;
  const total = Number(job.total);
  if (!total) return null;
  const inItem = typeof job.fraction === "number" ? job.fraction : null;
  if (total === 1) return job.done >= 1 ? 1 : inItem;
  const running = job.state === "running" && inItem != null ? inItem : 0;
  return Math.min(1, (Number(job.done) + Number(job.failed ?? 0) + running) / total);
}

/** Indicator counters: active jobs, jobs that need a decision (interrupted / failed). */
export function jobCounts(list) {
  let active = 0;
  let attention = 0;
  for (const j of list ?? []) {
    if (isActive(j)) active++;
    else if (j.state === "interrupted" || j.state === "failed") attention++;
  }
  return { active, attention };
}

const errorCodeOf = (e) => (e && typeof e === "object" && typeof e.code === "string" ? e.code : null);

export function createJobs({ invoke, listen, pollMs = 1000 } = {}) {
  const jobs = new Map();
  const subs = new Set();
  let available = null; // null = not asked yet, false = queue unavailable (storage)

  const sorted = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id)));
  const notify = (job) => {
    for (const fn of subs) {
      try { fn(job, sorted()); } catch (e) { console.error("[jobs] subscriber", e); }
    }
  };
  const upsert = (snap) => {
    const cur = jobs.get(snap.id);
    if (!cur || Number(snap.seq) >= Number(cur.seq)) {
      jobs.set(snap.id, snap);
      notify(snap);
    }
    return jobs.get(snap.id);
  };

  listen?.("job-event", (e) => {
    if (applyEvent(jobs, e.payload)) notify(e.payload.job);
  })?.catch?.(() => {});

  async function refresh() {
    if (!invoke) return [];
    try {
      mergeList(jobs, await invoke("jobs_list"));
      available = true;
    } catch (e) {
      if (errorCodeOf(e) === "storageUnavailable") available = false;
      throw e;
    }
    notify(null);
    return sorted();
  }

  async function submit(kind, request, title) {
    const snap = await invoke("jobs_submit", { job: { kind, request, title } });
    available = true;
    return upsert(snap);
  }

  /** Resolves with the snapshot once the job is no longer active (events + a slow poll). */
  function wait(id) {
    return new Promise((resolve) => {
      let timer = null;
      const done = (job) => {
        if (!job || job.id !== id || isActive(job)) return false;
        unsub();
        clearInterval(timer);
        resolve(job);
        return true;
      };
      const unsub = subscribe((job) => { done(job); });
      if (done(jobs.get(id))) return;
      timer = setInterval(() => {
        invoke("jobs_get", { id }).then((d) => done(upsert(d.job))).catch(() => {});
      }, pollMs);
    });
  }

  /** Submits and waits; onUpdate(snapshot) for every change of this job. */
  async function run(kind, request, { title, onUpdate, onSubmitted } = {}) {
    const snap = await submit(kind, request, title);
    onSubmitted?.(snap);
    const unsub = onUpdate ? subscribe((job) => { if (job?.id === snap.id) onUpdate(job); }) : null;
    try {
      onUpdate?.(jobs.get(snap.id));
      return await wait(snap.id);
    } finally {
      unsub?.();
    }
  }

  const command = (cmd) => async (id, extra) => upsert(await invoke(cmd, { id, ...extra }));
  const cancel = command("jobs_cancel");
  const pause = command("jobs_pause");
  const resume = (id, mode) => command("jobs_resume")(id, { mode });

  async function remove(id) {
    await invoke("jobs_remove", { id });
    jobs.delete(id);
    notify(null);
  }

  async function clearFinished() {
    await invoke("jobs_clear_finished");
    return refresh();
  }

  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  return {
    refresh, submit, wait, run, cancel, pause, resume, remove, clearFinished, subscribe,
    detail: (id) => invoke("jobs_get", { id }),
    get: (id) => jobs.get(id) ?? null,
    get list() { return sorted(); },
    /** false when the queue cannot be used this session (callers fall back to direct runs). */
    get available() { return available; },
  };
}
