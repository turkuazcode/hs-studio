// Reads the isolated test library.db (Plan 13/L01) from the test process, read-only, with
// Node's built-in SQLite. Never used on the user's real data folder.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sleep } from "./cdp.mjs";

export const dbPath = (dataDir) => join(dataDir, "library.db");

/** Runs `fn(db)` on a read-only connection (null when the file does not exist yet). */
export function withDb(dataDir, fn) {
  const p = dbPath(dataDir);
  if (!existsSync(p)) return null;
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The library as the app sees it: { recent, resume, favorites, bookmarks, version }. */
export function readLibraryDb(dataDir) {
  try {
    return withDb(dataDir, (db) => ({
      version: db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v,
      recent: db.prepare(`SELECT m.id AS mediaId, m.path, m.url, m.name, m.kind AS type, m.duration, m.thumb, m.resume_key AS resumeKey
        FROM recent r JOIN media m ON m.id = r.media_id ORDER BY r.position`).all(),
      resume: db.prepare("SELECT key, seconds FROM resume_positions ORDER BY seq").all(),
      favorites: db.prepare("SELECT path FROM media WHERE favorite = 1 ORDER BY favorited_at, rowid").all().map((r) => r.path),
      bookmarks: db.prepare("SELECT file_key AS fileKey, time, label FROM bookmarks ORDER BY file_key, time").all(),
      imported: db.prepare("SELECT value FROM meta WHERE key = 'legacy_json_import'").get()?.value ?? null,
    }));
  } catch {
    return null; // being created / locked for a moment
  }
}

export async function waitLibraryDb(dataDir, pred, what, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = readLibraryDb(dataDir);
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`library.db: timed out waiting for ${what}; last=${JSON.stringify(last)?.slice(0, 400)}`);
}
