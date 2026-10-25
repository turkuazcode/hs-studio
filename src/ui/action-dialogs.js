// ==========================================================================
// Small dialog toolkit for the media actions (Plan 06): modal shell, confirm, prompt,
// key/value info sheet and the ffmpeg job runner (progress + cancel + result).
// Dialogs reuse the app's .modal-overlay / .modal-card styles; Esc closes the topmost.
// ==========================================================================

import { t } from "../core/i18n.js";
import { invoke, listen } from "../core/tauri.js";
import { jobProgress } from "../core/jobs.js";
import { basename, errorCode, errorText, formatBytes, newJobId } from "../media/actions-logic.js";

/** h("div", { class: "x", onclick: fn }, child...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Labelled form row. */
export const field = (label, control, hint) =>
  h("label", { class: "vho-act-field" }, h("span", { class: "vho-act-label", text: label }), control, hint ? h("small", { text: hint }) : null);

/** <select> from [{ value, label }]. */
export function select(id, options, value) {
  const s = h("select", { id, class: "modal-select" });
  for (const o of options) s.append(h("option", { value: String(o.value), text: o.label }));
  if (value !== undefined) s.value = String(value);
  return s;
}

export function createDialogs(app) {
  const stack = [];
  app.shortcuts?.onEscape?.(() => {
    const top = stack.at(-1);
    if (!top) return false;
    top.cancel();
    return true;
  });

  /**
   * opts: { id, title, body: Node | Node[], actions: [{ id, label, primary?, danger?, run?(dlg) }],
   *         onClose?(reason), className?, wide? }
   * An action's run() may return false (or a Promise of false) to keep the dialog open.
   */
  function open(opts) {
    const host = document.getElementById("viewport") ?? document.body;
    const status = h("p", { class: "vho-act-status", role: "status", "aria-live": "polite" });
    const bar = h("div", { class: "vho-act-progress", hidden: true }, h("div", { class: "vho-act-progress-bar" }));
    const actions = h("div", { class: "modal-actions" });
    const body = h("div", { class: "vho-act-body" }, opts.body ?? []);
    const title = h("h3", { text: opts.title ?? "" });
    const card = h("div", { class: `modal-card vho-act-card${opts.wide ? " modal-large" : ""}`, role: "dialog", "aria-modal": "true" },
      title, body, bar, status, actions);
    const el = h("div", { id: opts.id, class: `modal-overlay active vho-act-dialog ${opts.className ?? ""}` }, card);
    let closed = false;
    let busy = false;
    let onCancel = null;

    const dlg = {
      el, card, body, title,
      get closed() { return closed; },
      close(reason = "close") {
        if (closed) return;
        closed = true;
        el.remove();
        const i = stack.indexOf(dlg);
        if (i >= 0) stack.splice(i, 1);
        opts.onClose?.(reason);
      },
      /** Esc / overlay click / cancel button. */
      cancel() {
        if (onCancel) return onCancel();
        if (!busy) dlg.close("cancel");
      },
      /** While busy, Esc runs this instead (e.g. cancel the running job). */
      onCancel(fn) { onCancel = fn; },
      setBusy(b) {
        busy = b;
        card.classList.toggle("is-busy", b);
        for (const btn of actions.querySelectorAll("button[data-busy-disable]")) btn.disabled = b;
      },
      setProgress(p) {
        bar.hidden = p === null || p === undefined;
        if (!bar.hidden) bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
        bar.dataset.progress = bar.hidden ? "" : String(p);
      },
      setStatus(text, kind = "") {
        status.textContent = text ?? "";
        status.className = `vho-act-status ${kind ? `is-${kind}` : ""}`;
      },
      setActions(list) {
        actions.replaceChildren(...list.map((a) => {
          const b = h("button", {
            type: "button", id: a.id ? `${opts.id}-${a.id}` : undefined,
            class: a.primary ? "btn-primary" : a.danger ? "btn-ghost vho-danger" : "btn-secondary", text: a.label,
          });
          if (a.disableWhileBusy !== false && !a.cancel) b.dataset.busyDisable = "1";
          b.addEventListener("click", async () => {
            if (a.cancel) return dlg.cancel();
            if (!a.run) return dlg.close(a.id ?? "ok");
            const keep = await a.run(dlg);
            if (keep !== false && !closed && !a.keepOpen) dlg.close(a.id ?? "ok");
          });
          return b;
        }));
      },
      /** Focus the first input, else the primary button. */
      focus() {
        const f = card.querySelector("input:not([type=hidden]),select,textarea") ?? actions.querySelector(".btn-primary") ?? actions.querySelector("button");
        f?.focus();
      },
    };
    dlg.setActions(opts.actions ?? [{ id: "close", label: t("actions.common.close") }]);
    // keys stay inside the dialog (no player shortcuts underneath); Esc cancels
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dlg.cancel();
      } else if (e.key === "Enter" && e.target.tagName === "INPUT" && opts.enterAction) {
        e.preventDefault();
        actions.querySelector(`#${opts.id}-${opts.enterAction}`)?.click();
      }
      e.stopPropagation();
    });
    el.addEventListener("mousedown", (e) => { if (e.target === el) dlg.cancel(); });
    host.append(el);
    stack.push(dlg);
    requestAnimationFrame(() => dlg.focus());
    return dlg;
  }

  /** Yes/no question. Resolves true when confirmed. */
  function confirm({ id = "vho-confirm", title, message, confirmLabel, danger = false }) {
    return new Promise((resolve) => {
      const d = open({
        id, title, body: h("p", { text: message }),
        onClose: (reason) => resolve(reason === "ok"),
        actions: [
          { id: "cancel", label: t("actions.common.cancel"), cancel: true },
          { id: "ok", label: confirmLabel ?? t("actions.common.ok"), primary: !danger, danger },
        ],
      });
      // the confirming button gets the focus (Enter = yes, Esc = no)
      requestAnimationFrame(() => d.el.querySelector(`#${id}-ok`)?.focus());
    });
  }

  /** Text input. validate(value) -> error text or null. Resolves the value or null. */
  function prompt({ id = "vho-prompt", title, label, value = "", selection, validate, okLabel }) {
    return new Promise((resolve) => {
      const input = h("input", { id: `${id}-input`, class: "modal-input", type: "text", spellcheck: "false", value });
      let result = null;
      const d = open({
        id, title, enterAction: "ok",
        body: field(label, input),
        onClose: () => resolve(result),
        actions: [
          { id: "cancel", label: t("actions.common.cancel"), cancel: true },
          {
            id: "ok", label: okLabel ?? t("actions.common.ok"), primary: true,
            run: (dlg) => {
              const err = validate?.(input.value);
              if (err) {
                dlg.setStatus(err, "error");
                input.focus();
                return false;
              }
              result = input.value.trim();
              return true;
            },
          },
        ],
      });
      const select = () => {
        input.focus();
        const [a, b] = selection ?? [0, value.length];
        input.setSelectionRange(a, b);
      };
      select();
      requestAnimationFrame(select);
      input.addEventListener("input", () => d.setStatus(""));
    });
  }

  /** Key/value sheet (properties). sections: [{ title, rows: [[label, value]] }] */
  function info({ id = "vho-info", title, sections }) {
    const body = sections.filter((s) => s.rows.some(([, v]) => v !== "" && v != null)).map((s) => h("section", { class: "vho-act-props" },
      s.title ? h("h4", { text: s.title }) : null,
      h("dl", {}, s.rows.filter(([, v]) => v !== "" && v != null).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v), title: String(v) })]))));
    return open({ id, title, body, wide: true, actions: [{ id: "close", label: t("actions.common.close"), primary: true }] });
  }

  // ------------------------------------------------------------------------
  // ffmpeg jobs
  // ------------------------------------------------------------------------
  const running = new Map(); // jobId -> dlg
  listen?.("media-job-progress", (e) => {
    const { jobId, progress } = e.payload ?? {};
    const d = running.get(jobId);
    if (d) {
      d.setProgress(progress);
      d.setStatus(t("actions.job.progress", { p: Math.round(progress * 100) }));
    }
  })?.catch?.(() => {});

  /**
   * Export through the persistent job queue (Plan 11/A02). Resolves the JobResult like
   * media_job; rejects with "[cancelled]" / "[no-ffmpeg] ..." / an error text. Falls back
   * to the direct runner when the queue is unavailable this session.
   */
  async function runQueued(queue, request, d, onId) {
    const show = (job) => {
      if (job.state === "queued") return d.setStatus(t("jobs.waiting"));
      if (job.state !== "running") return;
      const p = jobProgress(job);
      d.setProgress(p ?? 0);
      d.setStatus(p == null ? t("actions.job.starting") : t("actions.job.progress", { p: Math.round(p * 100) }));
    };
    let job;
    try {
      job = await queue.run("export", request, { title: basename(request.input), onSubmitted: (snap) => onId(snap.id), onUpdate: show });
    } catch (e) {
      if (e?.code === "storageUnavailable") return invoke("media_job", { job: { ...request, jobId: newJobId("job") } });
      throw new Error(e?.message ?? String(e));
    }
    const item = job.result?.results?.[0];
    if (job.state === "completed" && item?.output) return { output: item.output, size: item.bytes ?? 0 };
    if (job.state === "cancelled" || job.state === "paused") throw new Error("[cancelled]");
    const code = item?.errorCode ?? job.errorCode;
    if (code === "noFfmpeg") throw new Error(`[no-ffmpeg] ${item?.error ?? ""}`);
    const known = code && t(`jobs.error.${code}`) !== `jobs.error.${code}` && code !== "failed";
    throw new Error(known ? t(`jobs.error.${code}`) : (item?.error || job.errorDetail || t("jobs.error.failed")));
  }

  /**
   * Runs an export with a progress dialog. request: backend JobRequest without jobId.
   * Resolves the JobResult, or null (cancelled / failed). The dialog stays open with the
   * result (show in folder / open / close) unless `quiet`.
   */
  async function runJob({ title, request, onDone, quiet = false }) {
    const jobId = newJobId("job");
    let cancelled = false;
    const d = open({
      id: "vho-job", title,
      body: h("p", { class: "vho-act-file", text: basename(request.input) }),
      actions: [{ id: "cancel", label: t("actions.common.cancel"), cancel: true }],
    });
    d.el.dataset.jobId = jobId;
    d.el.dataset.state = "running";
    d.setBusy(true);
    d.setProgress(0);
    d.setStatus(t("actions.job.starting"));
    running.set(jobId, d);
    const queue = app.jobs && app.jobs.available !== false ? app.jobs : null;
    let queueId = null;
    const setQueueId = (id) => {
      queueId = id;
      d.el.dataset.queueJobId = id;
      if (cancelled) queue.cancel(id).catch(() => {});
    };
    d.onCancel(() => {
      if (d.el.dataset.state !== "running") return d.close("cancel");
      cancelled = true;
      d.setStatus(t("actions.job.cancelling"));
      if (queue) {
        if (queueId) queue.cancel(queueId).catch(() => {});
      } else invoke("media_job_cancel", { jobId }).catch(() => {});
    });
    try {
      const result = queue ? await runQueued(queue, request, d, setQueueId) : await invoke("media_job", { job: { ...request, jobId } });
      running.delete(jobId);
      d.setBusy(false);
      d.onCancel(null);
      d.el.dataset.state = "done";
      d.el.dataset.output = result.output;
      d.setProgress(1);
      d.setStatus(t("actions.job.done", { name: basename(result.output), size: formatBytes(result.size) }), "ok");
      onDone?.(result);
      if (quiet) d.close("ok");
      else {
        d.setActions([
          { id: "reveal", label: t("actions.menu.showInFolder"), run: () => { invoke("file_reveal", { path: result.output }).catch(() => {}); return false; } },
          { id: "open", label: t("actions.job.openResult"), run: () => { app.loader.openPaths([result.output]); } },
          { id: "close", label: t("actions.common.close"), primary: true },
        ]);
      }
      return result;
    } catch (e) {
      running.delete(jobId);
      d.setBusy(false);
      d.onCancel(null);
      d.el.dataset.state = "error";
      d.setProgress(null);
      if (cancelled || errorCode(e) === "cancelled") {
        d.close("cancel");
        app.toast(t("actions.job.cancelled"));
        return null;
      }
      d.el.dataset.error = String(e);
      d.setStatus(errorCode(e) === "no-ffmpeg" ? t("actions.job.noFfmpeg") : errorText(e), "error");
      d.setActions([{ id: "close", label: t("actions.common.close"), primary: true }]);
      return null;
    }
  }

  return { open, confirm, prompt, info, runJob, get top() { return stack.at(-1) ?? null; }, get count() { return stack.length; } };
}
