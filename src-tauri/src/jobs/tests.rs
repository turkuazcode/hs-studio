//! Job queue tests: state machine, crash + restart recovery, validation (source / model /
//! recipe), cancel authority, name collisions, temp dir cleanup, the real photo adapter.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use super::scheduler::{Adapter, Planned, RunCtx, TEMP_PREFIX, temp_dir_name};
use super::*;
use crate::storage::Storage;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

#[derive(Default)]
struct TestEnv {
    events: Mutex<Vec<JobEvent>>,
    model: Mutex<Option<String>>,
    free: Mutex<Option<u64>>,
}

impl JobEnv for TestEnv {
    fn emit(&self, ev: &JobEvent) {
        self.events.lock().unwrap().push(ev.clone());
    }
    fn model_version(&self, id: &str) -> Option<String> {
        (id == "test-model").then(|| self.model.lock().unwrap().clone()).flatten()
    }
    fn free_space(&self, _dir: &Path) -> Option<u64> {
        *self.free.lock().unwrap()
    }
}

/// Copies each input to `<out>/<stem>.out` through the queue's reservation/temp/placement.
/// `crash_at`: panics (= process killed) after writing that item's partial file.
/// `block`: waits until cancelled (for cancel/pause tests).
#[derive(Default)]
struct CopyAdapter {
    runs: Mutex<HashMap<i64, usize>>,
    crash_at: Mutex<Option<i64>>,
    block: AtomicBool,
    started: AtomicBool,
}

impl Adapter for CopyAdapter {
    fn kind(&self) -> &'static str {
        "test-copy"
    }
    fn schema_version(&self) -> u32 {
        1
    }
    fn plan(&self, request: &Value, env: &dyn JobEnv) -> Result<Planned, JobError> {
        let inputs = request["files"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(PathBuf::from).collect();
        let model = env.model_version("test-model").map(|version| ModelPin { id: "test-model".into(), version });
        Ok(Planned { title: "copy".into(), inputs, model })
    }
    fn run(&self, ctx: &RunCtx<'_>) -> Result<(), JobError> {
        let out_dir = PathBuf::from(ctx.request["out"].as_str().unwrap());
        for item in &ctx.pending {
            if ctx.cancelled() {
                return Ok(());
            }
            ctx.begin_item(item.idx)?;
            self.started.store(true, Ordering::SeqCst);
            *self.runs.lock().unwrap().entry(item.idx).or_default() += 1;
            if self.block.load(Ordering::SeqCst) {
                while !ctx.cancelled() {
                    std::thread::sleep(Duration::from_millis(10));
                }
                ctx.release_item(item.idx)?;
                return Ok(());
            }
            let src = Path::new(&item.path);
            let stem = src.file_stem().unwrap().to_string_lossy().into_owned();
            let target = ctx.reserve(item.idx, &out_dir.join(format!("{stem}.out")), false)?;
            let temp = ctx.temp_dir(&out_dir)?;
            let part = temp.join(format!("{}.part", item.idx));
            std::fs::copy(src, &part).unwrap();
            if *self.crash_at.lock().unwrap() == Some(item.idx) {
                panic!("simulated crash while item {} is half done", item.idx);
            }
            let fin = crate::actions::files::place_no_clobber(&part, &target).map_err(|e| JobError::new(code::FAILED, e))?;
            let bytes = std::fs::metadata(&fin).unwrap().len();
            ctx.complete_item(item.idx, &fin, bytes)?;
        }
        Ok(())
    }
}

struct Fx {
    dir: PathBuf,
    src: PathBuf,
    out: PathBuf,
    env: Arc<TestEnv>,
    adapter: Arc<CopyAdapter>,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let dir = std::env::temp_dir().join(format!("vho-jobs-{tag}-{}-{}", std::process::id(), crate::storage::now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let (src, out) = (dir.join("src"), dir.join("out"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        Fx { dir, src, out, env: Arc::new(TestEnv::default()), adapter: Arc::new(CopyAdapter::default()) }
    }

    fn files(&self, n: usize) -> Vec<PathBuf> {
        (0..n)
            .map(|i| {
                let p = self.src.join(format!("f{i}.bin"));
                std::fs::write(&p, format!("content of file {i}").repeat(10)).unwrap();
                p
            })
            .collect()
    }

    fn storage(&self) -> Arc<Storage> {
        Arc::new(Storage::open(&self.dir.join("data")).unwrap())
    }

    fn sched(&self, storage: Arc<Storage>) -> Arc<Scheduler> {
        let adapters: Vec<Arc<dyn Adapter>> = vec![self.adapter.clone(), Arc::new(adapters::PhotoBatchAdapter)];
        Scheduler::open(storage, self.env.clone(), adapters).unwrap()
    }

    fn request(&self, files: &[PathBuf]) -> Value {
        json!({ "files": files, "out": self.out })
    }

    fn outputs(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(&self.out).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    fn runs(&self) -> Vec<(i64, usize)> {
        let mut v: Vec<_> = self.adapter.runs.lock().unwrap().iter().map(|(k, v)| (*k, *v)).collect();
        v.sort();
        v
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn artifacts(s: &Storage, job: &str) -> i64 {
    s.read(|c| c.query_row("SELECT COUNT(*) FROM artifacts WHERE job_id = ?1", [job], |r| r.get(0))).unwrap()
}

fn sha(p: &Path) -> String {
    crate::ai::hash_file(p).unwrap().1
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

#[test]
fn recipe_hash_ignores_key_order_and_run_ids() {
    let a = json!({ "input": "a.mp4", "kind": "cut", "start": 1, "jobId": "x", "nested": { "b": 1, "a": [1, 2] } });
    let b = json!({ "nested": { "a": [1, 2], "b": 1 }, "start": 1, "kind": "cut", "input": "a.mp4", "jobId": "other" });
    assert_eq!(recipe_hash("export", 1, &a), recipe_hash("export", 1, &b));
    assert_ne!(recipe_hash("export", 1, &a), recipe_hash("export", 2, &a));
    let c = json!({ "input": "a.mp4", "kind": "cut", "start": 2, "nested": { "b": 1, "a": [1, 2] } });
    assert_ne!(recipe_hash("export", 1, &a), recipe_hash("export", 1, &c));
    assert_eq!(canonical_json(&json!({"b": 1, "a": "x\"y"})), r#"{"a":"x\"y","b":1}"#);
}

#[test]
fn fingerprint_detects_content_and_mtime_changes() {
    let fx = Fx::new("fp");
    let small = fx.src.join("small.bin");
    std::fs::write(&small, b"hello").unwrap();
    let a = fingerprint(&small).unwrap();
    assert_eq!(a, fingerprint(&small).unwrap());
    std::fs::write(&small, b"hellO").unwrap();
    assert_ne!(a.sample, fingerprint(&small).unwrap().sample);

    // large file: first/middle/last MiB are sampled
    let big = fx.src.join("big.bin");
    let mut data = vec![7u8; 5 << 20];
    std::fs::write(&big, &data).unwrap();
    let b = fingerprint(&big).unwrap();
    data[(5 << 20) / 2] = 8; // middle
    std::fs::write(&big, &data).unwrap();
    assert_ne!(b.sample, fingerprint(&big).unwrap().sample);

    // same bytes, new mtime: the time differs (validation treats it as changed)
    let f = std::fs::File::options().write(true).open(&small).unwrap();
    f.set_modified(std::time::SystemTime::now() + Duration::from_secs(60)).unwrap();
    drop(f);
    assert_ne!(fingerprint(&small).unwrap().mtime_ns, a.mtime_ns);
    assert!(fingerprint(&fx.src.join("missing.bin")).is_err());
}

#[test]
fn error_codes_from_runner_messages() {
    assert_eq!(classify_error("[no-ffmpeg] yok"), code::NO_FFMPEG);
    assert_eq!(classify_error("ffmpeg hatası: No space left on device"), code::DISK_FULL);
    assert_eq!(classify_error("[unsupported] x"), code::UNSUPPORTED);
    assert_eq!(classify_error("something"), code::FAILED);
}

// ---------------------------------------------------------------------------
// Queue behaviour
// ---------------------------------------------------------------------------

#[test]
fn job_runs_to_completion_with_events_and_artifacts() {
    let fx = Fx::new("complete");
    let files = fx.files(3);
    let storage = fx.storage();
    let s = fx.sched(storage.clone());
    let snap = s.submit("test-copy", fx.request(&files), None).unwrap();
    assert_eq!((snap.state.as_str(), snap.total, snap.done), ("queued", Some(3), 0));
    assert!(s.run_next().unwrap());
    assert!(!s.run_next().unwrap(), "queue empty");
    let done = s.snapshot(&snap.id).unwrap();
    assert_eq!((done.state.as_str(), done.done, done.failed), ("completed", 3, 0));
    assert_eq!(done.attempts, 1);
    assert_eq!(fx.outputs(), ["f0.out", "f1.out", "f2.out"]);
    assert_eq!(artifacts(&storage, &snap.id), 3);
    let r = done.result.unwrap();
    assert_eq!((r["total"].as_u64(), r["succeeded"].as_u64(), r["cancelled"].as_bool()), (Some(3), Some(3), Some(false)));

    // events: strictly increasing seq, every event carries the attempt after the claim
    let ev = fx.env.events.lock().unwrap();
    assert!(ev.windows(2).all(|w| w[1].seq > w[0].seq), "seq strictly increasing");
    let attempt = done.attempt_id.clone().unwrap();
    assert!(ev.iter().skip(1).all(|e| e.attempt_id.as_deref() == Some(attempt.as_str())));
    assert_eq!(ev.iter().filter(|e| e.item.as_ref().is_some_and(|i| i.state == "completed")).count(), 3);
    assert_eq!(ev.last().unwrap().job.state, "completed");
    // the snapshot read from the DB equals the last event (UI may read either)
    assert_eq!(ev.last().unwrap().job, s.snapshot(&snap.id).unwrap());
}

#[test]
fn forced_kill_and_restart_continues_without_repeating_completed_items() {
    let fx = Fx::new("crash");
    let files = fx.files(5);
    let hashes: Vec<String> = files.iter().map(|f| sha(f)).collect();
    let id;
    {
        let storage = fx.storage();
        let s = fx.sched(storage.clone());
        id = s.submit("test-copy", fx.request(&files), None).unwrap().id;
        *fx.adapter.crash_at.lock().unwrap() = Some(2);
        let crashed = std::panic::catch_unwind(AssertUnwindSafe(|| s.run_next()));
        assert!(crashed.is_err(), "simulated crash");
        // as the dead process left it: running, item 2 half done in the temp dir
        let snap = s.snapshot(&id).unwrap();
        assert_eq!((snap.state.as_str(), snap.done), ("running", 2));
        let temp = fx.out.join(temp_dir_name(&id));
        assert!(temp.join("2.part").exists(), "partial file exists at the crash");
        assert_eq!(artifacts(&storage, &id), 2);
    } // process gone (storage + scheduler dropped)

    *fx.adapter.crash_at.lock().unwrap() = None;
    let storage = fx.storage(); // restart: library.db opened again
    let s = fx.sched(storage.clone());
    let snap = s.snapshot(&id).unwrap();
    assert_eq!(snap.state, "interrupted");
    assert!(!fx.out.join(temp_dir_name(&id)).exists(), "temp dir of the job removed at start");
    let items = s.items(&id).unwrap();
    let states: Vec<&str> = items.iter().map(|i| i.state.as_str()).collect();
    assert_eq!(states, ["completed", "completed", "pending", "pending", "pending"]);
    assert!(items[2].output_path.is_none(), "partial never counted as output");
    assert_eq!(fx.outputs(), ["f0.out", "f1.out"]);
    // no automatic resume
    assert!(!s.run_next().unwrap());
    assert_eq!(s.snapshot(&id).unwrap().state, "interrupted");

    s.resume_continue(&id).unwrap();
    assert!(s.run_next().unwrap());
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.done, snap.attempts), ("completed", 5, 2));
    assert_eq!(fx.runs(), [(0, 1), (1, 1), (2, 2), (3, 1), (4, 1)], "completed items not repeated");
    assert_eq!(fx.outputs(), ["f0.out", "f1.out", "f2.out", "f3.out", "f4.out"], "no duplicates");
    assert_eq!(artifacts(&storage, &id), 5);
    for (f, h) in files.iter().zip(&hashes) {
        assert_eq!(&sha(f), h, "source unchanged");
        assert_eq!(&sha(&fx.out.join(format!("{}.out", f.file_stem().unwrap().to_string_lossy()))), h);
    }
}

fn interrupted_job(fx: &Fx, files: &[PathBuf]) -> String {
    let storage = fx.storage();
    let s = fx.sched(storage);
    let id = s.submit("test-copy", fx.request(files), None).unwrap().id;
    *fx.adapter.crash_at.lock().unwrap() = Some(1);
    assert!(std::panic::catch_unwind(AssertUnwindSafe(|| s.run_next())).is_err());
    *fx.adapter.crash_at.lock().unwrap() = None;
    id
}

#[test]
fn changed_source_blocks_continue_but_restart_works() {
    let fx = Fx::new("srcchg");
    let files = fx.files(3);
    let id = interrupted_job(&fx, &files);
    std::fs::write(&files[2], b"edited by the user meanwhile").unwrap();

    let s = fx.sched(fx.storage());
    assert_eq!(s.snapshot(&id).unwrap().state, "interrupted");
    s.resume_continue(&id).unwrap();
    assert!(s.run_next().unwrap());
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.error_code.as_deref(), snap.resume_block.as_deref()), ("failed", Some(code::SOURCE_CHANGED), Some(code::SOURCE_CHANGED)));
    assert_eq!(fx.runs(), [(0, 1), (1, 1)], "nothing ran after the failed validation");
    let e = s.resume_continue(&id).unwrap_err();
    assert_eq!(e.code, code::SOURCE_CHANGED);

    // restart: new fingerprints, everything again; earlier outputs kept, new names
    s.restart(&id).unwrap();
    assert!(s.run_next().unwrap());
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.done), ("completed", 3));
    assert_eq!(fx.outputs(), ["f0 (2).out", "f0.out", "f1.out", "f2.out"]);
    assert_eq!(std::fs::read(fx.out.join("f2.out")).unwrap(), b"edited by the user meanwhile");
}

#[test]
fn missing_source_blocks_continue() {
    let fx = Fx::new("srcgone");
    let files = fx.files(3);
    let id = interrupted_job(&fx, &files);
    std::fs::remove_file(&files[1]).unwrap();
    let s = fx.sched(fx.storage());
    s.resume_continue(&id).unwrap();
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().error_code.as_deref(), Some(code::SOURCE_MISSING));
    assert_eq!(s.restart(&id).unwrap_err().code, code::SOURCE_MISSING);
}

#[test]
fn changed_model_blocks_continue() {
    let fx = Fx::new("model");
    *fx.env.model.lock().unwrap() = Some("1.0".into());
    let files = fx.files(3);
    let id = interrupted_job(&fx, &files);
    *fx.env.model.lock().unwrap() = Some("2.0".into()); // model upgraded meanwhile
    let s = fx.sched(fx.storage());
    s.resume_continue(&id).unwrap();
    s.run_next().unwrap();
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.resume_block.as_deref()), ("failed", Some(code::MODEL_CHANGED)));
    assert!(snap.error_detail.unwrap().contains("1.0 -> 2.0"));
    assert_eq!(fx.runs(), [(0, 1), (1, 1)]);
    // restart pins the new version
    s.restart(&id).unwrap();
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().state, "completed");
}

#[test]
fn tampered_recipe_blocks_continue() {
    let fx = Fx::new("recipe");
    let files = fx.files(2);
    let id = interrupted_job(&fx, &files);
    let storage = fx.storage();
    storage
        .write(|tx| Ok(tx.execute("UPDATE jobs SET request = replace(request, '\"files\"', '\"extra\":1,\"files\"') WHERE id = ?1", [&id])?))
        .unwrap();
    let s = fx.sched(storage);
    s.resume_continue(&id).unwrap();
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().resume_block.as_deref(), Some(code::RECIPE_CHANGED));
}

#[test]
fn cancel_queued_running_and_only_its_own_job() {
    let fx = Fx::new("cancel");
    let files = fx.files(2);
    let s = fx.sched(fx.storage());

    // queued: cancelled at once, nothing ran
    let q = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    let snap = s.cancel(&q).unwrap();
    assert_eq!(snap.state, "cancelled");
    assert!(s.items(&q).unwrap().iter().all(|i| i.state == "cancelled"));
    assert!(!s.run_next().unwrap());
    assert_eq!(s.cancel(&q).unwrap_err().code, code::INVALID_STATE);

    // running: another job registered in the shared registry is not touched
    let other = crate::photo::JobGuard::register("unrelated-export");
    fx.adapter.block.store(true, Ordering::SeqCst);
    let id = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    let s2 = s.clone();
    let worker = std::thread::spawn(move || s2.run_next());
    while !fx.adapter.started.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(s.snapshot(&id).unwrap().state, "running");
    assert_eq!(s.cancel(&id).unwrap().state, "cancelling");
    worker.join().unwrap().unwrap();
    let snap = s.snapshot(&id).unwrap();
    assert_eq!(snap.state, "cancelled");
    assert_eq!(snap.result.unwrap()["cancelled"], true);
    assert!(!other.cancelled(), "cancel reached only its own job");
    assert!(fx.outputs().is_empty());
    assert!(!crate::photo::cancel(&id), "registry entry released");
}

#[test]
fn legacy_cancel_command_reaches_the_queue_job() {
    // media_job_cancel / photo_cancel use the same registry: one cancel authority
    let fx = Fx::new("legacy");
    let files = fx.files(1);
    let s = fx.sched(fx.storage());
    fx.adapter.block.store(true, Ordering::SeqCst);
    let id = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    let s2 = s.clone();
    let worker = std::thread::spawn(move || s2.run_next());
    while !fx.adapter.started.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(crate::photo::cancel(&id));
    worker.join().unwrap().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().state, "cancelled");
}

#[test]
fn pause_then_continue() {
    let fx = Fx::new("pause");
    let files = fx.files(2);
    let s = fx.sched(fx.storage());
    fx.adapter.block.store(true, Ordering::SeqCst);
    let id = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    let s2 = s.clone();
    let worker = std::thread::spawn(move || s2.run_next());
    while !fx.adapter.started.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(s.pause(&id).unwrap().state, "pausing");
    worker.join().unwrap().unwrap();
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.done), ("paused", 0));
    assert!(s.items(&id).unwrap().iter().all(|i| i.state == "pending"));
    fx.adapter.block.store(false, Ordering::SeqCst);
    s.resume_continue(&id).unwrap();
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().state, "completed");
    // queued job paused before it ran
    let q = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    assert_eq!(s.pause(&q).unwrap().state, "paused");
    assert!(!s.run_next().unwrap());
}

#[test]
fn name_collisions_never_overwrite() {
    let fx = Fx::new("names");
    // the user's own file already has the output name
    std::fs::write(fx.out.join("f0.out"), b"user data").unwrap();
    let files = fx.files(1);
    // a second source with the same stem in another folder -> same output name
    let other_dir = fx.src.join("sub");
    std::fs::create_dir_all(&other_dir).unwrap();
    let twin = other_dir.join("f0.bin");
    std::fs::write(&twin, b"twin").unwrap();
    let s = fx.sched(fx.storage());
    let id = s.submit("test-copy", fx.request(&[files[0].clone(), twin]), None).unwrap().id;
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().state, "completed");
    assert_eq!(std::fs::read(fx.out.join("f0.out")).unwrap(), b"user data", "existing file untouched");
    assert_eq!(fx.outputs(), ["f0 (2).out", "f0 (3).out", "f0.out"]);
    assert_eq!(std::fs::read(fx.out.join("f0 (3).out")).unwrap(), b"twin");
}

#[test]
fn recovery_cleans_only_its_own_temp_dirs_and_finishes_cancelling() {
    let fx = Fx::new("recover");
    let files = fx.files(2);
    let id = interrupted_job(&fx, &files);
    let foreign = fx.out.join(format!("{TEMP_PREFIX}notours1"));
    std::fs::create_dir_all(&foreign).unwrap();
    let storage = fx.storage();
    // a job that was being cancelled when the app died
    let c = {
        let s = fx.sched(storage.clone());
        let c = s.submit("test-copy", fx.request(&files), None).unwrap().id;
        storage.write(|tx| Ok(tx.execute("UPDATE jobs SET state = 'cancelling' WHERE id = ?1", [&c])?)).unwrap();
        c
    };
    let s = fx.sched(storage);
    assert_eq!(s.snapshot(&c).unwrap().state, "cancelled");
    assert!(s.items(&c).unwrap().iter().all(|i| i.state == "cancelled"));
    assert_eq!(s.snapshot(&id).unwrap().state, "interrupted");
    assert!(foreign.exists(), "a temp dir of another job/app is never removed");
}

#[test]
fn remove_and_clear_finished() {
    let fx = Fx::new("remove");
    let files = fx.files(1);
    let s = fx.sched(fx.storage());
    let a = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    let b = s.submit("test-copy", fx.request(&files), None).unwrap().id;
    assert_eq!(s.remove(&b).unwrap_err().code, code::INVALID_STATE, "queued job cannot be removed");
    s.run_next().unwrap();
    s.cancel(&b).ok();
    assert_eq!(s.list().unwrap().len(), 2);
    assert_eq!(s.clear_finished().unwrap(), 2);
    assert!(s.list().unwrap().is_empty());
    assert_eq!(s.snapshot(&a).unwrap_err().code, code::NOT_FOUND);
    assert_eq!(fx.outputs(), ["f0.out"], "outputs stay");
}

#[test]
fn submit_validates_inputs_and_kind() {
    let fx = Fx::new("submit");
    let s = fx.sched(fx.storage());
    assert_eq!(s.submit("nope", json!({}), None).unwrap_err().code, code::INVALID_REQUEST);
    assert_eq!(s.submit("test-copy", fx.request(&[]), None).unwrap_err().code, code::INVALID_REQUEST);
    let e = s.submit("test-copy", fx.request(&[fx.src.join("missing.bin")]), None).unwrap_err();
    assert_eq!(e.code, code::SOURCE_MISSING);
    assert!(s.list().unwrap().is_empty());
}

#[test]
fn disk_space_check_fails_the_item() {
    let fx = Fx::new("disk");
    let jpg = fx.src.join("a.jpg");
    std::fs::write(&jpg, crate::photo::testutil::jpeg_bytes(&crate::photo::testutil::pattern(64, 48), 90)).unwrap();
    *fx.env.free.lock().unwrap() = Some(1 << 20);
    let s = fx.sched(fx.storage());
    let id = s
        .submit("photo-batch", json!({ "files": [jpg], "ops": [], "output": { "format": "png", "dir": fx.out } }), None)
        .unwrap()
        .id;
    s.run_next().unwrap();
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.error_code.as_deref()), ("failed", Some(code::ITEMS_FAILED)));
    assert_eq!(s.items(&id).unwrap()[0].error_code.as_deref(), Some(code::DISK_FULL));
    assert!(fx.outputs().is_empty());
}

// ---------------------------------------------------------------------------
// Real photo batch adapter
// ---------------------------------------------------------------------------

#[test]
fn photo_batch_adapter_converts_resumes_and_keeps_existing_files() {
    use crate::photo::testutil::{jpeg_bytes, pattern};
    let fx = Fx::new("photo");
    let files: Vec<PathBuf> = (0..4)
        .map(|i| {
            let p = fx.src.join(format!("IMG_{i}.jpg"));
            std::fs::write(&p, jpeg_bytes(&pattern(64 + i * 8, 48), 90)).unwrap();
            p
        })
        .collect();
    let hashes: Vec<String> = files.iter().map(|f| sha(f)).collect();
    // the user already has a file with the first output name
    std::fs::write(fx.out.join("IMG_0_x.png"), b"keep me").unwrap();
    let storage = fx.storage();
    let s = fx.sched(storage.clone());
    let req = json!({ "jobId": "ignored", "files": files, "ops": [{ "op": "rotate", "degrees": 90 }],
                      "output": { "format": "png", "dir": fx.out, "nameTemplate": "{name}_x" } });
    let id = s.submit("photo-batch", req, None).unwrap().id;
    // pretend items 0 and 1 were finished by an earlier attempt: they must not run again
    s.run_next().unwrap();
    let snap = s.snapshot(&id).unwrap();
    assert_eq!((snap.state.as_str(), snap.done, snap.failed), ("completed", 4, 0), "{:?}", s.items(&id).unwrap());
    assert_eq!(std::fs::read(fx.out.join("IMG_0_x.png")).unwrap(), b"keep me");
    let outs = fx.outputs();
    assert!(outs.contains(&"IMG_0_x (1).png".to_string()) || outs.contains(&"IMG_0_x (2).png".to_string()), "{outs:?}");
    for i in 1..4 {
        let p = fx.out.join(format!("IMG_{i}_x.png"));
        let img = image::open(&p).unwrap();
        assert_eq!((img.width(), img.height()), (48, 64 + i as u32 * 8), "rotated output {p:?}");
    }
    assert!(!outs.iter().any(|n| n.starts_with(TEMP_PREFIX)), "temp dir removed: {outs:?}");
    assert_eq!(artifacts(&storage, &id), 4);
    for (f, h) in files.iter().zip(&hashes) {
        assert_eq!(&sha(f), h, "source unchanged");
    }
    let r = snap.result.unwrap();
    assert_eq!(r["succeeded"], 4);
    assert_eq!(r["results"].as_array().unwrap().len(), 4);

    // continue after an interruption: only the pending items run
    storage
        .write(|tx| {
            tx.execute("UPDATE jobs SET state = 'interrupted' WHERE id = ?1", [&id])?;
            Ok(tx.execute("UPDATE job_items SET state = 'pending', output_path = NULL WHERE job_id = ?1 AND idx = 3", [&id])?)
        })
        .unwrap();
    std::fs::remove_file(fx.out.join("IMG_3_x.png")).unwrap();
    let before: Vec<_> = (1..3).map(|i| std::fs::metadata(fx.out.join(format!("IMG_{i}_x.png"))).unwrap().modified().unwrap()).collect();
    s.resume_continue(&id).unwrap();
    s.run_next().unwrap();
    assert_eq!(s.snapshot(&id).unwrap().state, "completed");
    assert!(fx.out.join("IMG_3_x.png").exists());
    let after: Vec<_> = (1..3).map(|i| std::fs::metadata(fx.out.join(format!("IMG_{i}_x.png"))).unwrap().modified().unwrap()).collect();
    assert_eq!(before, after, "completed items were not written again");
}
