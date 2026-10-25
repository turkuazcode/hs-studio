// Shared storage library.db (Plan 13/L01) in the real app: one-time import of the old JSON
// stores (synthetic "old format" files in an isolated VHO_DATA_DIR), restart idempotency,
// damaged database restored from the backup, database from a newer VHO left untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HTML5_ENGINE, fixture, launchApp, makeDataDir, removeDir } from "./lib/app.mjs";
import { dbPath, readLibraryDb, waitLibraryDb } from "./lib/db.mjs";

const VIDEO = fixture("sample-h264.mp4");
/** Schema version of this build (src-tauri/src/storage/migrations.rs; L02 = 3). */
const SCHEMA = 3;
const PHOTO = fixture("photo-a.jpg");
const VIDEO_KEY = `vho_file_sample-h264.mp4_${statSync(VIDEO).size}`;

/** library.json + settings.json as written by the builds before library.db. */
function writeOldFormat(dataDir) {
  const library = { library: {
    version: 1,
    recent: [
      { id: PHOTO, path: PHOTO, name: "photo-a.jpg", type: "image", duration: 0, resumeKey: "", thumb: "", openedAt: 1700000002000 },
      { id: VIDEO, path: VIDEO, name: "sample-h264.mp4", type: "video", duration: 3, resumeKey: VIDEO_KEY, thumb: "", openedAt: 1700000001000 },
    ],
    resume: { "vho_file_other.mkv_1": 40, [VIDEO_KEY]: 1.5 },
    legacyMigrated: true,
  } };
  const settings = { settings: { version: 1, values: { "sleep.pcSleep": false, "actions.favorites": { paths: [VIDEO] } } } };
  writeFileSync(join(dataDir, "library.json"), JSON.stringify(library, null, 2));
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify(settings, null, 2));
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const platformReady = (app) => app.waitFor(`document.documentElement.dataset.platformReady === "1"`, { timeoutMs: 15000, message: "platform ready" });
const recentNames = (app) => app.eval(`[...document.querySelectorAll("#recent-files .vho-recent-item")].map((li) => li.dataset.id)`);
const waitToast = (app, re) =>
  app.waitFor(`${re}.test(document.querySelector("#snapshot-toast span")?.textContent ?? "")`, { timeoutMs: 8000, message: `toast ${re}` });

async function importOnce(dataDir) {
  const app = await launchApp({ dataDir, env: HTML5_ENGINE });
  try {
    await platformReady(app);
    await waitLibraryDb(dataDir, (l) => l.recent.length === 2 && l.imported, "import");
  } finally {
    await app.close();
  }
}

test("storage: old JSON stores move into library.db once", { timeout: 150000 }, async (t) => {
  const dataDir = await makeDataDir();
  writeOldFormat(dataDir);
  const before = { lib: sha(join(dataDir, "library.json")), set: sha(join(dataDir, "settings.json")) };
  let marker = null;
  try {
    const app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await t.test("start screen shows the migrated recent files and resume position", async () => {
        await app.waitFor(`document.querySelectorAll("#recent-files .vho-recent-item").length === 2`, { timeoutMs: 8000 });
        assert.deepEqual(await recentNames(app), [PHOTO, VIDEO]);
        const sel = `#recent-files .vho-recent-item[data-id=${JSON.stringify(VIDEO)}]`;
        const meta = await app.eval(`document.querySelector(${JSON.stringify(sel)}).textContent`);
        assert.match(meta, /konumunda kaldı/);
      });
      await t.test("library.db holds recent/resume/favorites; old files kept and backed up", async () => {
        const db = await waitLibraryDb(dataDir, (l) => l.imported, "import marker");
        marker = db.imported;
        assert.equal(db.version, SCHEMA);
        assert.deepEqual(db.recent.map((r) => r.path), [PHOTO, VIDEO]);
        assert.deepEqual(db.resume.map((r) => [r.key, r.seconds]), [["vho_file_other.mkv_1", 40], [VIDEO_KEY, 1.5]]);
        assert.deepEqual(db.favorites, [VIDEO]);
        assert.match(db.recent[0].mediaId, /^[0-9a-f-]{36}$/);
        assert.equal(sha(join(dataDir, "library.json")), before.lib, "library.json untouched");
        const backups = readdirSync(join(dataDir, "backups"));
        assert.ok(backups.some((f) => /^library\.json\.\d+\.pre-db\.bak$/.test(f)), backups.join());
        assert.ok(backups.some((f) => /^settings\.json\.\d+\.pre-db\.bak$/.test(f)), backups.join());
        assert.ok(backups.some((f) => f.startsWith(`library-v${SCHEMA}-`) && /^library-v\d+-\d+-periodic\.db$/.test(f)), backups.join());
      });
      await t.test("the migrated favorite is used by the favorite action", async () => {
        await app.eval(`window.__vhoEngine.openPaths([${JSON.stringify(VIDEO)}]), true`);
        await app.waitFor(`window.__vhoActions.current().item?.path === ${JSON.stringify(VIDEO)}`, { timeoutMs: 10000 });
        await app.eval(`(window.__vhoActions.run("favorite"), true)`);
        await waitToast(app, /favorilerden çıkarıldı/);
        await waitLibraryDb(dataDir, (l) => l.favorites.length === 0, "favorite removed");
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }

    const app2 = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app2);
      await t.test("second start: no second import, changes kept", async () => {
        await app2.waitFor(`document.querySelectorAll("#recent-files .vho-recent-item").length === 2`, { timeoutMs: 8000 });
        const db = readLibraryDb(dataDir);
        assert.equal(db.imported, marker, "import marker unchanged");
        assert.deepEqual(db.favorites, [], "the old settings favorite is not imported again");
        assert.equal(sha(join(dataDir, "library.json")), before.lib);
        const report = await app2.eval(`__TAURI__.core.invoke("library_load").then((r) => r.report)`);
        assert.equal(report.imported, null);
        assert.equal(report.recovered, null);
      });
      assert.deepEqual(await app2.errors(), []);
    } finally {
      await app2.close();
    }
  } finally {
    await removeDir(dataDir);
  }
});

test("storage: a damaged library.db is restored from the backup", { timeout: 150000 }, async (t) => {
  const dataDir = await makeDataDir();
  writeOldFormat(dataDir);
  try {
    await importOnce(dataDir);
    // damage the database file (header + first pages)
    const p = dbPath(dataDir);
    const bytes = readFileSync(p);
    bytes.fill(0x5a, 0, Math.min(bytes.length, 4096));
    writeFileSync(p, bytes);
    for (const s of ["-wal", "-shm"]) rmSync(p + s, { force: true });
    // and the old JSON so that only the backup can explain a full list
    writeFileSync(join(dataDir, "library.json"), JSON.stringify({ library: { recent: [] } }));

    const app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await t.test("user is told; recent files come back from the backup", async () => {
        await waitToast(app, /yedekten geri yüklendi/);
        await app.waitFor(`document.querySelectorAll("#recent-files .vho-recent-item").length === 2`, { timeoutMs: 8000 });
        const report = await app.eval(`__TAURI__.core.invoke("library_load").then((r) => r.report)`);
        assert.equal(report.recovered, "backup");
        assert.ok(existsSync(report.quarantined), "damaged file kept");
        assert.match(report.restoredFrom, /library-v\d+-\d+-periodic\.db$/);
        assert.ok(report.restoredFrom.includes(`library-v${SCHEMA}-`), report.restoredFrom);
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
  }
});

test("storage: a library.db from a newer VHO is not opened or changed", { timeout: 150000 }, async (t) => {
  const dataDir = await makeDataDir();
  writeOldFormat(dataDir);
  try {
    await importOnce(dataDir);
    {
      const db = new DatabaseSync(dbPath(dataDir));
      db.exec("INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (99, 'future', 0, '99.0.0'); PRAGMA user_version = 99;");
      db.close();
    }
    const dbHash = sha(dbPath(dataDir));

    const app = await launchApp({ dataDir, env: HTML5_ENGINE });
    try {
      await platformReady(app);
      await t.test("notice; the app keeps working on the JSON store", async () => {
        await waitToast(app, /daha yeni bir VHO sürümüne ait/);
        await app.waitFor(`document.querySelectorAll("#recent-files .vho-recent-item").length === 2`, { timeoutMs: 8000 });
        await app.eval(`window.__vhoEngine.openPaths([${JSON.stringify(PHOTO)}]), true`);
        await app.waitFor(`document.getElementById("current-filename").textContent === "photo-a.jpg"`, { timeoutMs: 10000 });
      });
      await t.test("database untouched (no downgrade, no writes)", async () => {
        await app.eval(`new Promise((r) => setTimeout(r, 1500)).then(() => true)`); // past the save debounce
        assert.equal(sha(dbPath(dataDir)), dbHash);
        const db = new DatabaseSync(dbPath(dataDir), { readOnly: true });
        try {
          assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 99);
        } finally {
          db.close();
        }
      });
      assert.deepEqual(await app.errors(), []);
    } finally {
      await app.close();
    }
  } finally {
    await removeDir(dataDir);
  }
});
