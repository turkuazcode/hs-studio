// ==========================================================================
// Batch processing dialog: rename pattern, convert, resize, rotate, strip
// EXIF/GPS for the selection; live name preview, progress, cancel.
// Everything runs in the backend's photo_batch (parallel, EXIF aware), through the persistent
// job queue (Plan 11/A02) when it is available: an interrupted batch continues later at the
// completed-file boundary.
// ==========================================================================

import { batchPreview } from "./logic.js";
import { t } from "../core/i18n.js";

const PREVIEW_LIMIT = 200;

// Built when the dialog is created; texts carry their i18n keys (re-translated on a language switch).
const tx = (key) => `data-i18n="${key}">${t(key)}`;
const ti = (key) => `data-i18n-title="${key}" title="${t(key)}"`;
const ta = (key) => `data-i18n-aria-label="${key}" aria-label="${t(key)}"`;
const template = () => `
  <div class="ps-modal-card ps-batch-card" role="dialog" ${ta("ui.studio.batch")}>
    <div class="ps-modal-head">
      <h3 ${tx("ui.studio.batch")}</h3>
      <span class="ps-batch-count"></span>
      <button class="btn-icon-close" data-act="close" ${ti("common.close")}>✕</button>
    </div>
    <div class="ps-batch-body">
      <form class="ps-batch-form" autocomplete="off">
        <fieldset>
          <legend ${tx("studio.batch.rename")}</legend>
          <input name="template" class="modal-input" value="{name}" spellcheck="false" ${ta("studio.batch.pattern")}>
          <div class="ps-chips ps-token-chips">
            <button type="button" class="ps-chip" data-token="{name}">{name}</button>
            <button type="button" class="ps-chip" data-token="{counter:3}">{counter:3}</button>
            <button type="button" class="ps-chip" data-token="{date}">{date}</button>
            <button type="button" class="ps-chip" data-token="{ext}">{ext}</button>
          </div>
          <label class="ps-inline"><span ${tx("studio.batch.counterStart")}</span> <input name="counterStart" type="number" min="0" value="1" class="modal-input ps-num"></label>
        </fieldset>
        <fieldset>
          <legend ${tx("studio.batch.convert")}</legend>
          <label class="ps-inline"><span ${tx("studio.info.format")}</span>
            <select name="format" class="modal-select">
              <option value="same" ${tx("studio.batch.sameFormat")}</option><option value="jpeg">JPEG</option><option value="png">PNG</option>
              <option value="webp">WebP</option><option value="avif">AVIF</option>
            </select>
          </label>
          <label class="ps-inline"><span ${tx("studio.batch.quality")}</span> <input name="quality" type="range" min="1" max="100" value="90" class="filter-slider"><output name="qualityOut">90</output></label>
        </fieldset>
        <fieldset>
          <legend ${tx("studio.batch.resizeRotate")}</legend>
          <label class="ps-inline">
            <select name="resizeMode" class="modal-select">
              <option value="none" ${tx("studio.batch.noResize")}</option><option value="longEdge" ${tx("studio.batch.longEdge")}</option><option value="percent" ${tx("studio.batch.percent")}</option>
            </select>
            <input name="resizeValue" type="number" min="1" value="1920" class="modal-input ps-num">
          </label>
          <label class="ps-inline"><span ${tx("studio.batch.rotate")}</span>
            <select name="rotate" class="modal-select">
              <option value="0" ${tx("studio.batch.none")}</option><option value="90" ${tx("studio.batch.rot90r")}</option><option value="180">180°</option><option value="-90" ${tx("studio.batch.rot90l")}</option>
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend ${tx("studio.batch.metaOutput")}</legend>
          <label class="ps-inline">EXIF
            <select name="metadata" class="modal-select">
              <option value="keep" ${tx("studio.batch.keep")}</option><option value="stripGps" ${tx("studio.batch.stripGps")}</option><option value="strip" ${tx("studio.batch.stripAll")}</option>
            </select>
          </label>
          <label class="ps-inline"><span ${tx("studio.batch.folder")}</span>
            <select name="dest" class="modal-select"><option value="same" ${tx("studio.batch.sameFolder")}</option><option value="dir" ${tx("studio.batch.otherFolder")}</option></select>
          </label>
          <div class="ps-batch-dir" hidden></div>
          <label class="ps-check"><input type="checkbox" name="removeSource"> <span ${tx("studio.batch.removeSource")}</span></label>
        </fieldset>
      </form>
      <div class="ps-batch-preview">
        <div class="ps-batch-preview-head" ${tx("studio.batch.preview")}</div>
        <ol class="ps-batch-list"></ol>
      </div>
    </div>
    <div class="ps-batch-progress" hidden>
      <div class="ps-progress"><div class="ps-progress-bar"></div></div>
      <span class="ps-batch-status" role="status"></span>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-primary btn-sm" data-act="start" ${tx("ui.sleep.start")}</button>
      <button class="btn-secondary btn-sm" data-act="cancel" hidden ${tx("common.cancel")}</button>
      <button class="btn-ghost btn-sm" data-act="close" ${tx("common.close")}</button>
    </div>
  </div>`;

/** Form values -> photo_batch { ops, output } (pure; exported for tests). */
export function batchJobFromForm(v) {
  const ops = [];
  const rot = Number(v.rotate) || 0;
  if (rot) ops.push({ op: "rotate", degrees: rot });
  const size = Number(v.resizeValue);
  if (v.resizeMode === "longEdge" && size > 0) ops.push({ op: "resize", longEdge: Math.round(size) });
  if (v.resizeMode === "percent" && size > 0) ops.push({ op: "resize", percent: size });
  const output = {
    format: v.format || "same",
    quality: Math.max(1, Math.min(100, Number(v.quality) || 90)),
    nameTemplate: v.template?.trim() || "{name}",
    counterStart: Math.max(0, Number(v.counterStart) || 0),
    conflict: "rename",
    metadata: v.metadata || "keep",
    lossless: true,
    removeSource: !!v.removeSource,
    dir: v.dest === "dir" && v.dir ? v.dir : null,
  };
  return { ops, output };
}

/** root: modal overlay element. deps: { invoke, listen, dialogOpen, toast, jobs?, onDone(summary) } */
export function createBatch(root, { invoke, listen, dialogOpen, toast, jobs, onDone }) {
  root.innerHTML = template();
  const $ = (s) => root.querySelector(s);
  const form = $(".ps-batch-form");
  const list = $(".ps-batch-list");
  const bar = $(".ps-progress-bar");
  const statusEl = $(".ps-batch-status");
  const progress = $(".ps-batch-progress");
  const dirEl = $(".ps-batch-dir");
  let items = [];
  let outDir = null;
  let running = null; // jobId (queue job id once submitted)
  let localId = null;
  let cancelRequested = false;

  const values = () => {
    const f = new FormData(form);
    return {
      template: f.get("template"), counterStart: f.get("counterStart"), format: f.get("format"), quality: f.get("quality"),
      resizeMode: f.get("resizeMode"), resizeValue: f.get("resizeValue"), rotate: f.get("rotate"), metadata: f.get("metadata"),
      dest: f.get("dest"), dir: outDir, removeSource: f.get("removeSource") === "on",
    };
  };

  function updatePreview() {
    const v = values();
    form.qualityOut.value = v.quality;
    form.resizeValue.disabled = v.resizeMode === "none";
    const rows = batchPreview(items.slice(0, PREVIEW_LIMIT), { nameTemplate: v.template, counterStart: Number(v.counterStart) || 0, format: v.format });
    list.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("span"), { className: "ps-from", textContent: r.from });
      const b = Object.assign(document.createElement("span"), { className: "ps-to", textContent: r.to });
      li.append(a, " → ", b);
      return li;
    }));
    if (items.length > PREVIEW_LIMIT) {
      list.append(Object.assign(document.createElement("li"), { className: "ps-more", textContent: t("studio.batch.more", { n: items.length - PREVIEW_LIMIT }) }));
    }
    dirEl.hidden = v.dest !== "dir";
    dirEl.textContent = outDir ?? t("studio.batch.noFolder");
  }

  async function chooseDir() {
    if (!dialogOpen) return;
    const picked = await dialogOpen({ directory: true, multiple: false }).catch(() => null);
    if (picked) outDir = Array.isArray(picked) ? picked[0] : picked;
    else if (!outDir) form.dest.value = "same";
    updatePreview();
  }

  function setRunning(on) {
    $('[data-act="start"]').disabled = on;
    $('[data-act="cancel"]').hidden = !on;
    for (const el of form.elements) el.disabled = on;
    root.dataset.running = on ? "1" : "0";
    if (!on) updatePreview();
  }

  async function start() {
    if (running || !items.length) return;
    const v = values();
    if (v.dest === "dir" && !outDir) {
      toast(t("studio.batch.pickOutput"));
      return;
    }
    const { ops, output } = batchJobFromForm(v);
    if (output.removeSource && !window.confirm(t("studio.batch.removeConfirm", { n: items.length }))) return;
    const jobId = `batch-${Date.now()}`;
    running = jobId;
    localId = jobId;
    cancelRequested = false;
    setRunning(true);
    progress.hidden = false;
    bar.style.width = "0%";
    statusEl.textContent = `0 / ${items.length}`;
    const request = { files: items.map((i) => i.path), ops, output };
    const un = queued() ? null : await listen?.("photo-batch-progress", (e) => {
      const p = e.payload;
      if (p.jobId !== jobId) return;
      bar.style.width = `${(100 * p.done) / p.total}%`;
      statusEl.textContent = `${p.done} / ${p.total}${p.error && p.error !== "[cancelled]" ? ` · ${t("studio.batch.errorIn", { name: p.input.split(/[\\/]/).pop() })}` : ""}`;
      root.dataset.done = p.done;
    });
    try {
      const s = queued() ? await runQueued(request) : await invoke("photo_batch", { job: { jobId, ...request } });
      root.dataset.summary = JSON.stringify({ total: s.total, succeeded: s.succeeded, failed: s.failed, skipped: s.skipped, cancelled: s.cancelled, elapsedMs: s.elapsedMs });
      const cancelledN = s.results.filter((r) => r.error === "[cancelled]").length;
      statusEl.textContent = [
        t("studio.batch.succeeded", { n: s.succeeded }), s.failed ? t("studio.batch.failed", { n: s.failed }) : "",
        s.skipped ? t("studio.batch.skipped", { n: s.skipped }) : "",
        s.cancelled ? t("studio.batch.cancelledN", { n: cancelledN }) : "", t("studio.info.seconds", { v: (s.elapsedMs / 1000).toFixed(1) }),
      ].filter(Boolean).join(" · ");
      const firstError = s.results.find((r) => !r.ok && r.error && r.error !== "[cancelled]");
      if (firstError) statusEl.title = `${firstError.input}: ${firstError.error}`;
      toast(s.cancelled ? t("studio.batch.cancelledToast") : t("studio.batch.doneToast", { n: s.succeeded }));
      onDone?.(s);
    } catch (e) {
      statusEl.textContent = t("studio.batch.error", { error: e });
    } finally {
      un?.();
      running = null;
      setRunning(false);
    }
  }

  const queued = () => !!jobs && jobs.available !== false;

  /** Queue path: same summary shape as photo_batch (results[] with input/output/ok/error). */
  async function runQueued(request) {
    const show = (job) => {
      if (!job?.total) return;
      const n = job.done + (job.failed || 0);
      bar.style.width = `${(100 * n) / job.total}%`;
      statusEl.textContent = `${n} / ${job.total}`;
      root.dataset.done = n;
    };
    let final;
    try {
      final = await jobs.run("photo-batch", request, {
        onSubmitted: (snap) => {
          running = snap.id;
          root.dataset.jobId = snap.id;
          if (cancelRequested) jobs.cancel(snap.id).catch(() => {});
        },
        onUpdate: show,
      });
    } catch (e) {
      if (e?.code !== "storageUnavailable") throw e;
      return invoke("photo_batch", { job: { jobId: localId, ...request } }); // queue unavailable
    }
    show(final);
    return final.result ?? { total: final.total, succeeded: 0, failed: final.total, skipped: 0, cancelled: final.state === "cancelled", elapsedMs: 0, results: [] };
  }

  /** Cancels the running job; retries while the backend has not registered it yet. */
  async function cancel() {
    const id = running;
    if (!id) return;
    statusEl.textContent = t("studio.batch.cancelling");
    if (queued()) {
      cancelRequested = true; // reaches the job as soon as it is queued (onSubmitted)
      if (id !== localId) await jobs.cancel(id).catch(() => {});
      return;
    }
    while (running === id) {
      const ok = await invoke("photo_cancel", { id }).catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  form.addEventListener("input", updatePreview);
  form.addEventListener("change", (e) => {
    if (e.target.name === "dest" && e.target.value === "dir" && !outDir) chooseDir();
    updatePreview();
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  dirEl.addEventListener("click", chooseDir);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.token) {
      const input = form.template;
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + b.dataset.token + input.value.slice(input.selectionEnd ?? pos);
      updatePreview();
    } else if (b.dataset.act === "start") start();
    else if (b.dataset.act === "cancel") cancel();
    else if (b.dataset.act === "close") close();
  });
  root.addEventListener("mousedown", (e) => { if (e.target === root && !running) close(); });

  function open(selection) {
    items = selection.filter((i) => i.kind !== "video");
    root.hidden = false;
    progress.hidden = true;
    statusEl.textContent = "";
    root.dataset.summary = "";
    root.dataset.done = "0";
    $(".ps-batch-count").textContent = t("studio.batch.count", { n: items.length });

    updatePreview();
    form.template.focus();
  }

  function close() {
    if (running) return false;
    root.hidden = true;
    return true;
  }

  return {
    open, close, start, cancel,
    get isOpen() { return !root.hidden; },
    handleKey(e) {
      if (root.hidden) return false;
      if (e.key === "Escape") { running ? cancel() : close(); return true; }
      return false; // typing in the form must work
    },
  };
}
