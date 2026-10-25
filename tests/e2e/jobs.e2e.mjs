// Persistent job queue (Plan 11/A02) in the real app: forced kill of OUR test vho.exe (by its
// PID) during a photo batch and an export, restart with the same isolated VHO_DATA_DIR,
// "interrupted" + no automatic resume, continue without repeating completed files, partial
// files never counted, changed source / tool version blocks continue, cancel stops only its
// own ffmpeg child, name collision without data loss. Sources are synthetic temp copies; their
// hashes are compared before/after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HTML5_ENGINE, defaultExe, fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";
import { withDb } from "./lib/db.mjs";

const FFMPEG = ["", "mpv", join("resources", "mpv")]
  .map((sub) => join(dirname(defaultExe()), sub, "ffmpeg.exe"))
  .find((p) => existsSync(p)) ?? join(dirname(defaultExe()), "ffmpeg.exe");
const skipFfmpeg = existsSync(FFMPEG) ? false : "ffmpeg.exe not staged next to vho.exe (npm run stage:mpv)";

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const inv = (cmd, args = {}) => `__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;
const J = (x) => JSON.stringify(x);

const platformReady = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });

/** Kills only the vho.exe this test launched (TerminateProcess on its PID) - no graceful exit. */
async function kill(app) {
  app.cdp.close();
  const exited = new Promise((res) => (app.proc.exitCode !== null ? res() : app.proc.once("exit", res)));
  process.kill(app.proc.pid);
  await exited;
  await sleep(600);
  rmSync(app.userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 });
}

const jobRow = (dataDir, id) => withDb(dataDir, (db) => db.prepare("SELECT state, done, attempts, error_code AS code, resume_block AS block FROM jobs WHERE id = ?").get(id));
const itemStates = (dataDir, id) => withDb(dataDir, (db) => db.prepare("SELECT state FROM job_items WHERE job_id = ? ORDER BY idx").all(id).map((r) => r.state));

async function waitDb(dataDir, pred, what, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = pred();
      if (last) return last;
    } catch (e) {
      last = String(e); // being written right now
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}; last=${J(last)}`);
}

const waitJob = (app, id, states, timeoutMs = 90000) => app.waitFor(
  `${inv("jobs_get", { id })}.then((d) => ${J(states)}.includes(d.job.state))`,
  { timeoutMs, message: `job ${id} -> ${states}` },
);

function photoSet(dir, n) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const p = join(dir, `IMG_${String(i).padStart(2, "0")}.jpg`);
    copyFileSync(fixture("photo-a.jpg"), p);
    // distinct content per copy (appended bytes after EOI are ignored by decoders)
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from(`vho-e2e-${i}`)]));
    files.push(p);
  }
  return files;
}

const outputs = (dir) => readdirSync(dir).sort();

test("jobs: forced kill during a photo batch, restart, continue without repeating", { timeout: 300000 }, async (t) => {
  const dataDir = await makeDataDir();
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-jobs-"));
  const src = join(work, "src");
  const out = join(work, "out");
  execFileSync("cmd", ["/c", "mkdir", src, out]);
  const files = photoSet(src, 12);
  const hashes = files.map(sha256);
  const request = { files, ops: [{ op: "rotate", degrees: 90 }], output: { format: "png", dir: out, nameTemplate: "{name}_q" } };
  let id;
  let doneBefore = [];
  let mtimes = {};
  try {
    // 1) slow items (test hook: pause between temp write and final placement), kill mid-way
    let app = await launchApp({ dataDir, env: { ...HTML5_ENGINE, VHO_JOBS_TEST_ITEM_DELAY_MS: "1200" } });
    try {
      await platformReady(app);
      const snap = await app.eval(inv("jobs_submit", { job: { kind: "photo-batch", request } }));
      id = snap.id;
      assert.equal(snap.state, "queued");
      await waitDb(dataDir, () => jobRow(dataDir, id)?.done >= 2, "2 items completed");
      // the indicator is visible while the job runs
      assert.equal(await app.eval(`document.getElementById("btn-jobs").hidden`), false);
    } finally {
      await kill(app);
    }
    const killed = jobRow(dataDir, id);
    t.diagnostic(`killed with ${killed.done}/12 items done`);
    assert.equal(killed.state, "running", "the dead process left it running");
    assert.ok(killed.done < 12, J(killed));
    doneBefore = outputs(out).filter((f) => f.endsWith(".png"));
    assert.equal(doneBefore.length, killed.done, `only completed items have final names: ${outputs(out)}`);
    const temp = outputs(out).filter((f) => f.startsWith(".vho-job-"));
    assert.equal(temp.length, 1, "the job's temp dir exists after the kill");
    const partials = readdirSync(join(out, temp[0]));
    t.diagnostic(`partial files at kill: ${partials.join(", ")}`);
    for (const f of doneBefore) mtimes[f] = statSync(join(out, f)).mtimeMs;

    // 2) restart: interrupted, temp cleaned, nothing resumes by itself
    app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await app.waitFor(`!document.getElementById("btn-jobs").hidden && document.getElementById("btn-jobs").dataset.attention === "1"`,
        { timeoutMs: 10000, message: "jobs indicator with attention" });
      await t.test("interrupted job, partial not counted, temp dir removed", async () => {
        const list = await app.eval(inv("jobs_list"));
        const job = list.find((j) => j.id === id);
        assert.equal(job.state, "interrupted");
        assert.equal(job.done, killed.done);
        assert.deepEqual(outputs(out).filter((f) => f.startsWith(".vho-job-")), [], "temp dir removed at start");
        const states = itemStates(dataDir, id);
        assert.equal(states.filter((s) => s === "completed").length, killed.done);
        assert.ok(states.every((s) => s === "completed" || s === "pending"), J(states));
        const arts = withDb(dataDir, (db) => db.prepare("SELECT path FROM artifacts WHERE job_id = ?").all(id).map((r) => r.path.split(/[\\/]/).pop()).sort());
        assert.deepEqual(arts, doneBefore, "only finished outputs are artifacts");
        await sleep(1500);
        assert.equal(jobRow(dataDir, id).state, "interrupted", "no automatic resume");
      });
      await t.test("continue from the panel: completed files are not written again", async () => {
        await app.click("#btn-jobs");
        await app.waitFor(`!document.getElementById("vho-jobs-panel").hidden`, { message: "panel open" });
        const label = await app.text(`#vho-jobs-panel li[data-id="${id}"] .vho-jobs-state`);
        assert.match(label, /Yarıda kaldı|Interrupted/);
        await app.click(`#vho-jobs-panel button[data-act="continue"][data-id="${id}"]`);
        await waitJob(app, id, ["completed"]);
        const row = jobRow(dataDir, id);
        assert.deepEqual([row.state, row.done, row.attempts], ["completed", 12, 2]);
        const pngs = outputs(out).filter((f) => f.endsWith(".png"));
        assert.deepEqual(pngs, files.map((f) => f.split(/[\\/]/).pop().replace(".jpg", "_q.png")), "every file once, no duplicates");
        for (const f of doneBefore) assert.equal(statSync(join(out, f)).mtimeMs, mtimes[f], `${f} not repeated`);
        assert.deepEqual(outputs(out).filter((f) => f.startsWith(".vho-job-")), []);
        const panelState = await app.text(`#vho-jobs-panel li[data-id="${id}"] .vho-jobs-state`);
        assert.match(panelState, /Tamamlandı|Completed/);
      });
      await t.test("sources unchanged", async () => {
        files.forEach((f, i) => assert.equal(sha256(f), hashes[i], f));
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
    rmSync(work, { recursive: true, force: true });
  }
});

test("jobs: changed source after a kill blocks continue, restart works", { timeout: 300000 }, async () => {
  const dataDir = await makeDataDir();
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-jobs-"));
  const out = join(work, "out");
  execFileSync("cmd", ["/c", "mkdir", out]);
  const files = photoSet(work, 24); // more files than worker threads: some stay pending at the kill
  const request = { files, ops: [], output: { format: "png", dir: out } };
  let id;
  try {
    let app = await launchApp({ dataDir, env: { ...HTML5_ENGINE, VHO_JOBS_TEST_ITEM_DELAY_MS: "1500" } });
    try {
      await platformReady(app);
      id = (await app.eval(inv("jobs_submit", { job: { kind: "photo-batch", request } }))).id;
      await waitDb(dataDir, () => jobRow(dataDir, id)?.done >= 1, "1 item completed");
    } finally {
      await kill(app);
    }
    // the user edits a file that was not processed yet while VHO is closed
    const pendingIdx = itemStates(dataDir, id).findIndex((s) => s !== "completed");
    assert.ok(pendingIdx >= 0, "an item was still pending at the kill");
    writeFileSync(files[pendingIdx], Buffer.concat([readFileSync(files[pendingIdx]), Buffer.from("edited")]));

    app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await app.waitFor(`${inv("jobs_get", { id })}.then((d) => d.job.state === "interrupted")`, { message: "interrupted" });
      await app.eval(inv("jobs_resume", { id, mode: "continue" }));
      await waitJob(app, id, ["failed"]);
      const row = jobRow(dataDir, id);
      assert.deepEqual([row.code, row.block], ["sourceChanged", "sourceChanged"]);
      // the panel offers only "Restart" and explains why
      await app.click("#btn-jobs");
      await app.waitFor(`!!document.querySelector('#vho-jobs-panel li[data-id="${id}"] .vho-jobs-error')`, { message: "error line" });
      assert.match(await app.text(`#vho-jobs-panel li[data-id="${id}"] .vho-jobs-error`), /değişti|changed/);
      assert.equal(await app.eval(`!!document.querySelector('#vho-jobs-panel button[data-act="continue"][data-id="${id}"]')`), false);
      const err = await app.eval(`${inv("jobs_resume", { id, mode: "continue" })}.then(() => null, (e) => e.code)`);
      assert.equal(err, "sourceChanged");
      await app.click(`#vho-jobs-panel button[data-act="restart"][data-id="${id}"]`);
      await waitJob(app, id, ["completed"]);
      assert.equal(jobRow(dataDir, id).done, 24);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
    rmSync(work, { recursive: true, force: true });
  }
});

test("jobs: export queue - cancel stops only its own ffmpeg, kill + changed tool version, name collision", { skip: skipFfmpeg, timeout: 300000 }, async (t) => {
  const dataDir = await makeDataDir();
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-jobs-"));
  const long = join(work, "uzun.mp4");
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=90",
    "-c:v", "mpeg4", "-q:v", "8", long], { cwd: dirname(FFMPEG), stdio: "pipe", timeout: 120000 });
  const longHash = sha256(long);
  const short = join(work, "kisa.mp4");
  copyFileSync(fixture("sample-h264.mp4"), short);
  const shortHash = sha256(short);
  // the user's own file already has the name the export would use
  const taken = join(work, "kisa_720p.mp4");
  writeFileSync(taken, "user data, must survive");
  const takenHash = sha256(taken);
  let exportId;
  try {
    let app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await t.test("cancel: the queued export stops, a direct export of the same file finishes", async () => {
        const direct = app.eval(`${inv("media_job", { job: { jobId: "e2e-direct", input: long, kind: "convert", preset: "720p", outputDir: join(work, "direct") } })}.then((r) => r.output, (e) => "ERR " + String(e))`, { timeoutMs: 240000 });
        const q = await app.eval(inv("jobs_submit", { job: { kind: "export", request: { input: long, kind: "convert", preset: "720p" } } }));
        await app.waitFor(`${inv("jobs_get", { id: q.id })}.then((d) => d.job.state === "running" && d.job.fraction > 0)`, { timeoutMs: 60000, message: "queued export running" });
        const c = await app.eval(inv("jobs_cancel", { id: q.id }));
        assert.ok(["cancelling", "cancelled"].includes(c.state), c.state);
        await waitJob(app, q.id, ["cancelled"]);
        const res = await direct;
        assert.ok(res.endsWith("uzun_720p.mp4"), `direct export completed: ${res}`);
        assert.deepEqual(readdirSync(work).filter((f) => f.startsWith("uzun_") || f.startsWith(".vho-job-") || f.includes("vho-part")), [],
          "no partial/temp of the cancelled queued export");
        assert.equal(sha256(long), longHash);
      });
      await t.test("name collision: existing file kept, new name chosen", async () => {
        const q = await app.eval(inv("jobs_submit", { job: { kind: "export", request: { input: short, kind: "convert", preset: "720p" } } }));
        await waitJob(app, q.id, ["completed"]);
        const d = await app.eval(inv("jobs_get", { id: q.id }));
        assert.ok(d.items[0].outputPath.endsWith("kisa_720p (2).mp4"), d.items[0].outputPath);
        assert.equal(sha256(taken), takenHash, "existing file untouched");
        assert.equal(sha256(short), shortHash);
      });
      // a long export to interrupt
      exportId = (await app.eval(inv("jobs_submit", { job: { kind: "export", request: { input: long, kind: "convert", preset: "1080p" } } }))).id;
      await app.waitFor(`${inv("jobs_get", { id: exportId })}.then((d) => d.job.state === "running" && d.job.fraction > 0.02)`, { timeoutMs: 60000, message: "export running" });
    } finally {
      await kill(app);
    }
    assert.equal(jobRow(dataDir, exportId).state, "running");
    assert.deepEqual(readdirSync(work).filter((f) => f.startsWith("uzun_1080p")), [], "no final name for the partial export");

    // restart with a different ffmpeg version string (test hook): continue is blocked
    app = await launchApp({ dataDir, env: { ...HTML5_ENGINE, VHO_JOBS_TEST_MODEL_VERSION: "ffmpeg version e2e-changed" } });
    try {
      await platformReady(app);
      await t.test("interrupted export: partial removed, changed tool version blocks continue", async () => {
        await app.waitFor(`${inv("jobs_get", { id: exportId })}.then((d) => d.job.state === "interrupted")`, { message: "interrupted export" });
        assert.deepEqual(readdirSync(work).filter((f) => f.startsWith(".vho-job-")), [], "temp dir with the partial removed");
        const items = await app.eval(`${inv("jobs_get", { id: exportId })}.then((d) => d.items)`);
        assert.equal(items[0].state, "pending");
        assert.equal(items[0].outputPath, null, "partial never counted");
        await app.eval(inv("jobs_resume", { id: exportId, mode: "continue" }));
        await waitJob(app, exportId, ["failed"]);
        const row = jobRow(dataDir, exportId);
        assert.deepEqual([row.code, row.block], ["modelChanged", "modelChanged"]);
        await app.eval(inv("jobs_cancel", { id: exportId }));
        assert.equal(sha256(long), longHash);
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
    rmSync(work, { recursive: true, force: true });
  }
});
