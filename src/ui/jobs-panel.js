// ==========================================================================
// Background jobs indicator + panel (Plan 11/A02). Unobtrusive by design: the titlebar
// button exists only while jobs are running/queued, need a decision (interrupted / failed /
// paused) or finished in this session and were not looked at yet. The panel lists the
// jobs with progress, cancel / pause, "Continue" / "Restart" after an interruption, remove,
// and "clear finished". No new settings.
// ==========================================================================

import { t } from "../core/i18n.js";
import {
  canCancel, canContinue, canPause, canRemove, canRestart, isActive, jobCounts, jobProgress,
} from "../core/jobs.js";
import { invoke } from "../core/tauri.js";
import { h } from "./action-dialogs.js";

const ICON = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
  <path d="M3 4.5A1.5 1.5 0 014.5 3h11A1.5 1.5 0 0117 4.5v1A1.5 1.5 0 0115.5 7h-11A1.5 1.5 0 013 5.5v-1zM3 10a1.5 1.5 0 011.5-1.5h11A1.5 1.5 0 0117 10v0a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 10zM4.5 13A1.5 1.5 0 003 14.5v1A1.5 1.5 0 004.5 17h6a1.5 1.5 0 001.5-1.5v-1A1.5 1.5 0 0010.5 13h-6z"/></svg>`;

const basename = (p) => String(p ?? "").split(/[\\/]/).pop();

/** Display name of a job (no full paths on screen). */
export function jobLabel(job) {
  if (job.kind === "export") return t("jobs.kind.export", { name: job.title || "?" });
  if (job.kind === "ai-photo-enhance") return t("jobs.kind.aiPhoto", { name: job.title || "?" });
  if (job.kind === "photo-batch") {
    return job.total === 1 && job.title ? t("jobs.kind.photoOne", { name: job.title }) : t("jobs.kind.photoBatch", { n: job.total ?? "?" });
  }
  return job.title || t("jobs.kind.other");
}

/** Error line of a job that needs a decision. */
export function jobErrorText(job) {
  const code = job.resumeBlock || job.errorCode;
  if (!code) return "";
  if (code === "itemsFailed") return t("jobs.error.itemsFailed", { n: job.failed || 1 });
  const key = `jobs.error.${code}`;
  const text = t(key);
  return text === key ? t("jobs.error.failed") : text;
}

export function createJobsPanel(app) {
  const jobs = app.jobs;
  const bar = document.querySelector(".titlebar-actions");
  if (!jobs || !bar) return null;

  const count = h("span", { class: "vho-jobs-count" });
  const button = h("button", {
    id: "btn-jobs", class: "titlebar-action-btn vho-jobs-btn", type: "button", hidden: true,
    "data-i18n-title": "jobs.button", title: t("jobs.button"), "aria-label": t("jobs.button"),
    "aria-haspopup": "dialog", "aria-expanded": "false",
  });
  button.innerHTML = ICON;
  button.append(count);
  bar.prepend(button);

  const list = h("ul", { class: "vho-jobs-list" });
  const clear = h("button", { class: "vho-jobs-link", type: "button", "data-act": "clear", text: t("jobs.clearFinished") });
  const closeBtn = h("button", { class: "btn-icon-close", type: "button", "data-act": "close", title: t("common.close"), "aria-label": t("common.close"), text: "✕" });
  const panel = h("div", { id: "vho-jobs-panel", class: "vho-jobs-panel", role: "dialog", "aria-label": t("jobs.title"), hidden: true },
    h("div", { class: "vho-jobs-head" }, h("h3", { text: t("jobs.title") }), clear, closeBtn),
    list);
  document.body.append(panel);

  // jobs that finished while the app ran and were not looked at yet keep the button visible
  const unseen = new Set();
  const lastState = new Map();

  function visibleJobs() {
    return jobs.list;
  }

  function updateButton() {
    const all = visibleJobs();
    const { active, attention } = jobCounts(all);
    const show = active > 0 || attention > 0 || all.some((j) => j.state === "paused") || unseen.size > 0 || !panel.hidden;
    button.hidden = !show;
    count.textContent = active > 0 ? String(active) : "";
    button.dataset.active = String(active);
    button.dataset.attention = attention > 0 ? "1" : "0";
    button.classList.toggle("is-running", active > 0);
  }

  function actionButton(act, label, job, extra = {}) {
    return h("button", { class: "vho-jobs-act", type: "button", "data-act": act, "data-id": job.id, text: label, ...extra });
  }

  function row(job) {
    const p = jobProgress(job);
    const progress = h("div", { class: `vho-jobs-progress${p == null && isActive(job) ? " is-indeterminate" : ""}` },
      h("div", { class: "vho-jobs-progress-bar", style: p == null ? "" : `width:${Math.round(p * 100)}%` }));
    progress.hidden = !(isActive(job) || job.state === "paused" || job.state === "interrupted");
    const state = [t(`jobs.state.${job.state}`)];
    if ((job.total ?? 0) > 1) state.push(t("jobs.items", { done: job.done + (job.failed || 0), total: job.total }));
    else if (job.state === "running" && p != null) state.push(`%${Math.round(p * 100)}`);
    const err = jobErrorText(job);
    const output = job.state === "completed" ? job.result?.results?.find((r) => r.output)?.output : null;
    const actions = [
      canContinue(job) ? actionButton("continue", t("jobs.action.continue"), job, { title: t("jobs.continueHint") }) : null,
      canRestart(job) ? actionButton("restart", t("jobs.action.restart"), job) : null,
      canPause(job) ? actionButton("pause", t("jobs.action.pause"), job) : null,
      canCancel(job) && isActive(job) ? actionButton("cancel", t("jobs.action.cancel"), job) : null,
      output ? actionButton("reveal", t("jobs.action.reveal"), job, { "data-path": output }) : null,
      canRemove(job) ? actionButton("remove", t("jobs.action.remove"), job) : null,
    ];
    return h("li", { class: "vho-jobs-item", "data-id": job.id, "data-state": job.state },
      h("div", { class: "vho-jobs-line" },
        h("span", { class: "vho-jobs-name", text: jobLabel(job), title: output ? basename(output) : jobLabel(job) }),
        h("span", { class: "vho-jobs-state", text: state.join(" · ") })),
      progress,
      err ? h("p", { class: "vho-jobs-error", text: err, title: job.errorDetail ?? "" }) : null,
      h("div", { class: "vho-jobs-actions" }, actions));
  }

  function render() {
    for (const j of jobs.list) {
      const prev = lastState.get(j.id);
      if (prev && isActive({ state: prev }) && !isActive(j) && panel.hidden) unseen.add(j.id);
      lastState.set(j.id, j.state);
    }
    for (const id of [...unseen]) if (!jobs.get(id)) unseen.delete(id);
    updateButton();
    if (panel.hidden) return;
    const all = visibleJobs();
    list.replaceChildren(...(all.length ? all.map(row) : [h("li", { class: "vho-jobs-empty", text: t("jobs.empty") })]));
    clear.hidden = !all.some((j) => j.state === "completed" || j.state === "cancelled");
  }

  function place() {
    const r = button.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  function open() {
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    place();
    render();
    panel.querySelector("button")?.focus();
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    unseen.clear();
    render();
    if (!button.hidden) button.focus();
  }

  const toggle = () => (panel.hidden ? open() : close());

  async function act(name, id, el) {
    try {
      if (name === "continue") await jobs.resume(id, "continue");
      else if (name === "restart") await jobs.resume(id, "restart");
      else if (name === "pause") await jobs.pause(id);
      else if (name === "cancel") await jobs.cancel(id);
      else if (name === "remove") await jobs.remove(id);
      else if (name === "reveal") await invoke?.("file_reveal", { path: el.dataset.path });
    } catch (e) {
      const code = e?.code;
      app.toast?.(code && t(`jobs.error.${code}`) !== `jobs.error.${code}` ? t(`jobs.error.${code}`) : String(e?.message ?? e));
      jobs.refresh().catch(() => {});
    }
  }

  button.addEventListener("click", toggle);
  panel.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "close") close();
    else if (b.dataset.act === "clear") jobs.clearFinished().catch(() => {});
    else if (b.dataset.id) act(b.dataset.act, b.dataset.id, b);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close();
  });
  window.addEventListener("resize", () => { if (!panel.hidden) place(); });

  jobs.subscribe(() => render());

  /** First load: interrupted jobs from the last run are announced once. */
  async function init() {
    try {
      const all = await jobs.refresh();
      for (const j of all) lastState.set(j.id, j.state);
      if (all.some((j) => j.state === "interrupted")) app.toast?.(t("jobs.interruptedNotice"));
    } catch {
      // queue unavailable this session: exports / batches run directly (jobs.available === false)
    }
    render();
  }

  return { init, open, close, render, get button() { return button; }, get panel() { return panel; } };
}
