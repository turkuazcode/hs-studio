//! SQL of the job queue (tables of migration v2 `jobs`; docs/jobs-api.md).

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;

use super::{JobItem, JobSnapshot, JobState, item_state};
use crate::storage::now_ms;

const SNAPSHOT_COLS: &str = "j.id, j.kind, j.state, j.title, j.attempt_id, j.attempts, j.seq, j.stage, j.done, j.total,
  j.fraction, j.result, j.error_code, j.error_detail, j.resume_block, j.created_at, j.updated_at, j.started_at,
  j.finished_at,
  (SELECT COUNT(*) FROM job_items i WHERE i.job_id = j.id AND i.state = 'failed'),
  (SELECT COUNT(*) FROM job_items i WHERE i.job_id = j.id AND i.state = 'skipped')";

fn snapshot_row(r: &Row) -> rusqlite::Result<JobSnapshot> {
    let result: Option<String> = r.get(11)?;
    Ok(JobSnapshot {
        id: r.get(0)?,
        kind: r.get(1)?,
        state: r.get(2)?,
        title: r.get(3)?,
        attempt_id: r.get(4)?,
        attempts: r.get(5)?,
        seq: r.get(6)?,
        stage: r.get(7)?,
        done: r.get(8)?,
        total: r.get(9)?,
        fraction: r.get(10)?,
        result: result.and_then(|s| serde_json::from_str(&s).ok()),
        error_code: r.get(12)?,
        error_detail: r.get(13)?,
        resume_block: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        started_at: r.get(17)?,
        finished_at: r.get(18)?,
        failed: r.get(19)?,
        skipped: r.get(20)?,
    })
}

pub fn snapshot(conn: &Connection, id: &str) -> rusqlite::Result<Option<JobSnapshot>> {
    conn.query_row(&format!("SELECT {SNAPSHOT_COLS} FROM jobs j WHERE j.id = ?1"), [id], snapshot_row).optional()
}

/// Newest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<JobSnapshot>> {
    let mut st = conn.prepare(&format!("SELECT {SNAPSHOT_COLS} FROM jobs j ORDER BY j.created_at DESC, j.rowid DESC LIMIT 200"))?;
    st.query_map([], snapshot_row)?.collect()
}

pub fn items(conn: &Connection, id: &str) -> rusqlite::Result<Vec<JobItem>> {
    let mut st = conn.prepare(
        "SELECT idx, input_path, state, attempt_id, reserved_path, output_path, output_bytes, error_code, error_detail
         FROM job_items WHERE job_id = ?1 ORDER BY idx",
    )?;
    st.query_map([id], |r| {
        Ok(JobItem {
            idx: r.get(0)?,
            input_path: r.get(1)?,
            state: r.get(2)?,
            attempt_id: r.get(3)?,
            reserved_path: r.get(4)?,
            output_path: r.get(5)?,
            output_bytes: r.get(6)?,
            error_code: r.get(7)?,
            error_detail: r.get(8)?,
        })
    })?
    .collect()
}

/// Internal view of a job row.
#[derive(Debug, Clone)]
pub struct JobRow {
    pub id: String,
    pub kind: String,
    pub schema_version: u32,
    pub state: JobState,
    pub request: Value,
    pub request_text: String,
    pub recipe_hash: String,
    pub model: Option<String>,
    pub attempt_id: Option<String>,
    pub resume_block: Option<String>,
}

pub fn row(conn: &Connection, id: &str) -> rusqlite::Result<Option<JobRow>> {
    conn.query_row(
        "SELECT id, kind, schema_version, state, request, recipe_hash, model, attempt_id, resume_block FROM jobs WHERE id = ?1",
        [id],
        |r| {
            let text: String = r.get(4)?;
            let state: String = r.get(3)?;
            Ok(JobRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                schema_version: r.get(2)?,
                state: JobState::parse(&state).unwrap_or(JobState::Failed),
                request: serde_json::from_str(&text).unwrap_or(Value::Null),
                request_text: text,
                recipe_hash: r.get(5)?,
                model: r.get(6)?,
                attempt_id: r.get(7)?,
                resume_block: r.get(8)?,
            })
        },
    )
    .optional()
}

/// Items not finished yet (the next attempt's work), with their submit-time fingerprint.
#[derive(Debug, Clone)]
pub struct PendingRow {
    pub idx: i64,
    pub path: String,
    pub size: Option<i64>,
    pub mtime_ns: Option<i64>,
    pub fp: Option<String>,
}

pub fn pending(conn: &Connection, id: &str) -> rusqlite::Result<Vec<PendingRow>> {
    let mut st = conn.prepare(
        "SELECT idx, input_path, input_size, input_mtime_ns, input_fp FROM job_items
         WHERE job_id = ?1 AND state = 'pending' ORDER BY idx",
    )?;
    st.query_map([id], |r| Ok(PendingRow { idx: r.get(0)?, path: r.get(1)?, size: r.get(2)?, mtime_ns: r.get(3)?, fp: r.get(4)? }))?
        .collect()
}

/// Compare-and-set of the job state. Returns true when the row was in one of `from`.
pub fn cas_state(conn: &Connection, id: &str, from: &[JobState], to: JobState) -> rusqlite::Result<bool> {
    let list = from.iter().map(|s| format!("'{}'", s.as_str())).collect::<Vec<_>>().join(",");
    let n = conn.execute(
        &format!("UPDATE jobs SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state IN ({list})"),
        params![id, to.as_str(), now_ms()],
    )?;
    Ok(n == 1)
}

/// Next event number; also refreshes `done` and `updated_at`.
pub fn bump(conn: &Connection, id: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "UPDATE jobs SET seq = seq + 1, updated_at = ?2,
           done = (SELECT COUNT(*) FROM job_items WHERE job_id = ?1 AND state IN ('completed', 'skipped'))
         WHERE id = ?1",
        params![id, now_ms()],
    )?;
    conn.query_row("SELECT seq FROM jobs WHERE id = ?1", [id], |r| r.get(0))
}

pub fn next_queued(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM jobs WHERE state = 'queued' ORDER BY priority DESC, created_at, rowid LIMIT 1",
        [],
        |r| r.get(0),
    )
    .optional()
}

pub fn temp_dirs(conn: &Connection, id: Option<&str>) -> rusqlite::Result<Vec<(String, String)>> {
    let mut st = conn.prepare("SELECT job_id, path FROM job_temp_dirs WHERE ?1 IS NULL OR job_id = ?1")?;
    st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

/// Item counters for the result summary.
pub fn count_items(conn: &Connection, id: &str, state: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM job_items WHERE job_id = ?1 AND state = ?2", params![id, state], |r| r.get(0))
}

/// `{ total, succeeded, failed, skipped, cancelled, elapsedMs, results: [...] }` (same shape as
/// the photo batch summary; `results[0].output/bytes` is the export result).
pub fn summary(conn: &Connection, id: &str, cancelled: bool, elapsed_ms: i64) -> rusqlite::Result<Value> {
    let mut st = conn.prepare(
        "SELECT idx, input_path, state, output_path, output_bytes, error_code, error_detail FROM job_items
         WHERE job_id = ?1 ORDER BY idx",
    )?;
    let results: Vec<Value> = st
        .query_map([id], |r| {
            let state: String = r.get(2)?;
            let code: Option<String> = r.get(5)?;
            let detail: Option<String> = r.get(6)?;
            Ok(serde_json::json!({
                "index": r.get::<_, i64>(0)?,
                "input": r.get::<_, String>(1)?,
                "output": r.get::<_, Option<String>>(3)?,
                "bytes": r.get::<_, Option<i64>>(4)?,
                "ok": state == item_state::COMPLETED || state == item_state::SKIPPED,
                "skipped": state == item_state::SKIPPED,
                "state": state,
                "errorCode": code,
                "error": if state == item_state::CANCELLED { Some("[cancelled]".to_string()) } else { detail },
            }))
        })?
        .collect::<Result<_, _>>()?;
    let n = |s: &str| results.iter().filter(|r| r["state"] == s).count();
    Ok(serde_json::json!({
        "total": results.len(),
        "succeeded": n(item_state::COMPLETED),
        "failed": n(item_state::FAILED),
        "skipped": n(item_state::SKIPPED),
        "cancelled": cancelled,
        "elapsedMs": elapsed_ms,
        "results": results,
    }))
}
