// ==========================================================================
// "Enhance video…" (faithful, model-free; user decision 2026-10-28). Opened from the video "⋯"
// menu. Recommended settings first; the user can change denoise / sharpen / upscale. A 10 s
// side-by-side preview (left original, right enhanced) before the full run; the full result
// is a new file next to the source (the original is never touched).
// Backend: src-tauri/src/restoration/enhance.rs, queue job "video-enhance".
// ==========================================================================

import { t } from "../core/i18n.js";
import { convertFileSrc, invoke } from "../core/tauri.js";
import { jobProgress } from "../core/jobs.js";
import { field, h, select } from "../ui/action-dialogs.js";

export const PREVIEW_SECONDS = 10;
export const DEFAULT_OPTIONS = Object.freeze({ denoise: "light", sharpen: "light", upscale: false });

/** Preview start: the current position, so that 10 s still fit before the end. */
export function previewStart(time, duration) {
  const t0 = Number.isFinite(time) && time > 0 ? time : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.floor(t0);
  return Math.max(0, Math.min(Math.floor(t0), Math.floor(duration - PREVIEW_SECONDS)));
}

/** Blocker codes of the plan → one user message key (field order is asked for, not shown). */
export function blockerKey(blockers = []) {
  const real = blockers.filter((b) => b !== "field-order-unconfirmed");
  if (!real.length) return null;
  if (real.includes("hdr-unsupported") || real.includes("dynamic-range-unknown")) return "videoEnhance.blocker.hdr";
  if (real.some((b) => b.startsWith("filter-missing"))) return "videoEnhance.blocker.filters";
  return "videoEnhance.blocker.generic";
}

export function createVideoEnhance(app) {
  function open(item) {
    if (!invoke || !app.jobs || app.jobs.available === false) { app.toast(t("videoEnhance.status.desktopOnly")); return null; }
    let options = { ...DEFAULT_OPTIONS };
    let fieldOrder = null;
    let jobId = null;
    let cancelRequested = false; // Cancel before the job had an id: cancelled as soon as it has one
    let running = false;
    let fieldAsked = false;

    const levels = () => [
      { value: "off", label: t("videoEnhance.level.off") },
      { value: "light", label: t("videoEnhance.level.light") },
      { value: "medium", label: t("videoEnhance.level.medium") },
    ];
    const denoise = select("vho-venh-denoise", levels(), options.denoise);
    const sharpen = select("vho-venh-sharpen", levels(), options.sharpen);
    const upscale = select("vho-venh-upscale", [
      { value: "no", label: t("videoEnhance.upscale.none") },
      { value: "x2", label: t("videoEnhance.upscale.x2") },
    ], "no");
    const fieldSel = select("vho-venh-field", [
      { value: "tff", label: t("videoEnhance.fieldOrder.tff") },
      { value: "bff", label: t("videoEnhance.fieldOrder.bff") },
      { value: "progressive", label: t("videoEnhance.fieldOrder.progressive") },
    ], "tff");
    const fieldRow = field(t("videoEnhance.fieldOrder.label"), fieldSel, t("videoEnhance.fieldOrder.hint"));
    fieldRow.hidden = true;
    const video = h("video", { id: "vho-venh-video", class: "vho-venh-preview", controls: true, muted: true, loop: true, playsinline: true, hidden: true });
    const caption = h("p", { id: "vho-venh-caption", class: "vho-venh-caption", text: t("videoEnhance.previewCaption"), hidden: true });
    const body = [
      h("p", { class: "vho-venh-recommended", text: t("videoEnhance.recommended") }),
      field(t("videoEnhance.denoise"), denoise),
      field(t("videoEnhance.sharpen"), sharpen),
      field(t("videoEnhance.upscale.label"), upscale),
      fieldRow,
      h("p", { class: "vho-venh-note", text: t("videoEnhance.note") }),
      video,
      caption,
    ];
    const dlg = app.dialogs.open({ id: "vho-venh", title: t("videoEnhance.title"), body, wide: true });
    dlg.el.dataset.state = "planning";

    const read = () => {
      options = { denoise: denoise.value, sharpen: sharpen.value, upscale: upscale.value === "x2" };
      fieldOrder = fieldRow.hidden ? null : fieldSel.value;
    };
    const setIdleActions = (blocked) => dlg.setActions([
      { id: "preview", label: t("videoEnhance.preview"), primary: true, keepOpen: true, run: () => (blocked ? false : runJob(true)) },
      { id: "full", label: t("videoEnhance.full"), keepOpen: true, run: () => (blocked ? false : runJob(false)) },
      { id: "reset", label: t("videoEnhance.reset"), keepOpen: true, run: reset },
      { id: "close", label: t("actions.common.close"), cancel: true },
    ]);
    const setRunningActions = () => dlg.setActions([
      { id: "stop", label: t("actions.common.cancel"), danger: true, disableWhileBusy: false, keepOpen: true, run: () => { stop(); return false; } },
    ]);

    function stop() {
      cancelRequested = true;
      if (jobId) app.jobs.cancel(jobId).catch(() => {});
      dlg.setStatus(t("actions.job.cancelling"));
    }

    async function plan() {
      read();
      dlg.el.dataset.state = "planning";
      dlg.setStatus(t("videoEnhance.status.planning"));
      try {
        const resp = await invoke("video_enhance_plan", { path: item.path, options, fieldOrder });
        if (dlg.closed) return;
        const blockers = resp?.assessment?.blockers ?? [];
        if (blockers.includes("field-order-unconfirmed") && !fieldAsked) {
          // first question: preselect what the file says, else the probe's suggestion (never
          // "interlaced" for a file flagged progressive)
          fieldAsked = true;
          const fo = resp?.report?.video?.fieldOrder ?? {};
          const pick = ["progressive", "tff", "bff"].includes(fo.metadata) ? fo.metadata : fo.suggestion;
          if (["progressive", "tff", "bff"].includes(pick)) fieldSel.value = pick;
        }
        fieldRow.hidden = !(blockers.includes("field-order-unconfirmed") || fieldOrder);
        const key = blockerKey(blockers);
        const blocked = !!key || (blockers.includes("field-order-unconfirmed") && !fieldOrder);
        dlg.el.dataset.state = blocked ? "blocked" : "ready";
        setIdleActions(!!key);
        if (key) dlg.setStatus(t(key, { codes: blockers.join(", ") }), "error");
        else if (blockers.includes("field-order-unconfirmed") && !fieldOrder) dlg.setStatus(t("videoEnhance.fieldOrder.ask"), "warn");
        else dlg.setStatus(t("videoEnhance.status.ready", { w: resp.recipe?.scale?.width ?? "", h: resp.recipe?.scale?.height ?? "" }));
      } catch (e) {
        if (dlg.closed) return;
        dlg.el.dataset.state = "blocked";
        setIdleActions(true);
        dlg.setStatus(t("videoEnhance.status.failed", { error: e?.message ?? String(e) }), "error");
      }
    }

    async function runJob(preview) {
      if (running) return false;
      read();
      running = true;
      jobId = null;
      cancelRequested = false;
      dlg.el.dataset.state = preview ? "previewing" : "running";
      setRunningActions();
      dlg.setBusy(true);
      dlg.onCancel(() => stop());
      dlg.setProgress(0);
      dlg.setStatus(t("jobs.waiting"));
      const request = {
        input: item.path, options, fieldOrder, preview,
        start: preview ? previewStart(app.engine?.time, app.engine?.duration) : 0,
      };
      try {
        const final = await app.jobs.run("video-enhance", request, {
          onSubmitted: (snap) => { jobId = snap.id; if (cancelRequested) app.jobs.cancel(snap.id).catch(() => {}); },
          onUpdate: (job) => {
            const p = jobProgress(job);
            if (job.state === "running" && p != null) {
              dlg.setProgress(p);
              dlg.setStatus(t(preview ? "videoEnhance.status.previewRunning" : "videoEnhance.status.running", { pct: Math.round(p * 100) }));
            }
          },
        });
        if (dlg.closed) return false;
        const output = final.result?.results?.[0]?.output;
        if (final.state === "completed" && output) {
          if (preview) {
            video.src = convertFileSrc(output);
            video.hidden = false;
            caption.hidden = false;
            video.play?.().catch(() => {});
            dlg.el.dataset.state = "previewed";
            dlg.setStatus(t("videoEnhance.status.previewDone"), "ok");
          } else {
            dlg.el.dataset.state = "done";
            dlg.el.dataset.output = output;
            dlg.setStatus(t("videoEnhance.status.done", { name: output.split(/[\\/]/).pop() }), "ok");
          }
        } else if (final.state === "cancelled") {
          dlg.el.dataset.state = "cancelled";
          dlg.setStatus(t("videoEnhance.status.cancelled"));
        } else {
          const code = final.result?.results?.[0]?.errorCode ?? final.errorCode ?? "failed";
          const detail = final.result?.results?.[0]?.error ?? final.errorDetail ?? "";
          const m = /\[video-blocked\]\s*(.*)/.exec(detail);
          const key = `jobs.error.${code}`;
          const error = m ? t(blockerKey(m[1].split(",")) ?? "videoEnhance.blocker.generic", { codes: m[1] }) : (t(key) !== key ? t(key) : detail || t("jobs.error.failed"));
          dlg.el.dataset.state = "failed";
          dlg.setStatus(t("videoEnhance.status.failed", { error }), "error");
        }
      } catch (e) {
        if (dlg.closed) return false;
        dlg.el.dataset.state = "failed";
        const key = `jobs.error.${e?.code}`;
        dlg.setStatus(t("videoEnhance.status.failed", { error: t(key) !== key ? t(key) : e?.message ?? String(e) }), "error");
      } finally {
        running = false;
        jobId = null;
        dlg.onCancel(null);
        dlg.setBusy(false);
        dlg.setProgress(null);
        if (!dlg.closed) setIdleActions(false);
      }
      return false;
    }

    function reset() {
      denoise.value = DEFAULT_OPTIONS.denoise;
      sharpen.value = DEFAULT_OPTIONS.sharpen;
      upscale.value = DEFAULT_OPTIONS.upscale ? "x2" : "no";
      video.hidden = true;
      caption.hidden = true;
      video.removeAttribute("src");
      plan();
      return false;
    }

    for (const s of [denoise, sharpen, upscale, fieldSel]) s.addEventListener("change", () => { if (!running) plan(); });
    setIdleActions(true);
    dlg.focus();
    plan();
    return dlg;
  }

  return { open };
}
