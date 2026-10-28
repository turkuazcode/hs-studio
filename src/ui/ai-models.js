// ==========================================================================
// Settings > AI models: the downloadable AI components (runtime + models).
// Shows size / license / author / source before anything is downloaded, the state
// (missing, downloading, installed, ready, damaged) and the rare maintenance actions:
// download, cancel, verify, repair, remove. Nothing of this is on the main screen.
// ==========================================================================

import { t } from "../core/i18n.js";
import { isTauri, listen, openUrl } from "../core/tauri.js";
import { aiDiagnostics, componentStatuses, installComponent, lastAiRun, removeComponent, verifyComponent } from "../media/ai-engine.js";
import { componentActions, progressFraction, sizeText } from "../media/ai-status.js";

/** Downloads started from this panel: id -> AbortController (survive panel re-renders). */
const running = new Map();
/** Verifications in progress (ids). */
const verifying = new Set();
/** Last error per component id: { code, message } (shown until the next action). */
const lastError = new Map();
let listening = false;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role") e.setAttribute(k, v);
    else e[k] = v;
  }
  e.append(...children.filter(Boolean));
  return e;
}

const rowOf = (id) => document.querySelector(`.vho-ai-model[data-component="${CSS.escape(id)}"]`);

function setProgress(id, fraction, phase) {
  const row = rowOf(id);
  if (!row) return;
  const wrap = row.querySelector(".vho-ai-model-progress");
  wrap.hidden = fraction === null;
  if (fraction === null) return;
  wrap.querySelector(".vho-ai-model-progress-bar").style.width = `${Math.round(fraction * 100)}%`;
  const label = row.querySelector(".vho-ai-model-progress-text");
  label.textContent = t(`aiModels.phase.${phase || "download"}`, { percent: Math.round(fraction * 100) });
}

function taskLabel(task) {
  const key = `aiModels.task.${task}`;
  const label = t(key);
  return label === key ? task : label;
}

function renderRow(st, list, app) {
  const busy = running.has(st.id) || verifying.has(st.id);
  // A download started elsewhere (e.g. a photo job) is shown, but only its owner cancels it
  const actions = st.state === "downloading" && !running.has(st.id) ? [] : componentActions(st, { busy });
  const row = el("div", { class: "vho-ai-model", role: "listitem", "data-component": st.id, "data-state": st.state });
  const stateKey = verifying.has(st.id) ? "verifying" : st.state;
  row.append(
    el("div", { class: "vho-ai-model-head" },
      el("strong", { class: "vho-ai-model-title", text: st.title }),
      el("span", { class: `vho-ai-model-state is-${stateKey}`, text: t(`aiModels.state.${stateKey}`) })),
    el("small", { class: "vho-ai-model-meta", text: `${taskLabel(st.task)} · ${t("aiModels.settings.version", { version: st.version })}` }),
    el("small", { class: "vho-ai-model-license", text: t("aiModels.settings.byline", { author: st.author, license: st.license }) }),
    el("small", { class: "vho-ai-model-size", text: t("aiModels.settings.size", { download: sizeText(st.totalBytes), disk: sizeText(st.diskBytes) }) }),
  );
  if (st.badFiles?.length) {
    row.append(el("small", { class: "vho-ai-model-bad", text: t("aiModels.settings.badFiles", { files: st.badFiles.join(", ") }) }));
  }
  const progress = el("div", { class: "vho-ai-model-progress", hidden: true },
    el("div", { class: "vho-ai-model-progress-track" }, el("div", { class: "vho-ai-model-progress-bar" })),
    el("small", { class: "vho-ai-model-progress-text", "aria-live": "polite" }));
  row.append(progress);

  const err = lastError.get(st.id);
  row.append(el("small", { class: "vho-ai-model-error", role: "status", "data-code": err?.code ?? "", hidden: !err, text: err?.message ?? "" }));

  const buttons = el("div", { class: "vho-ai-model-actions" });
  for (const action of actions) {
    const b = el("button", {
      type: "button", class: action === "remove" ? "btn-ghost btn-sm vho-danger" : "btn-secondary btn-sm",
      "data-action": action, text: t(`aiModels.actions.${action}`),
    });
    b.addEventListener("click", () => runAction(action, st, list, app));
    buttons.append(b);
  }
  if (/^https:\/\//.test(st.source)) {
    const src = el("button", { type: "button", class: "btn-ghost btn-sm", "data-action": "source", text: t("aiModels.actions.source"), title: st.source });
    src.addEventListener("click", () => openUrl(st.source).catch(() => {}));
    buttons.append(src);
  }
  row.append(buttons);
  setTimeout(() => {
    const f = progressFraction(st.progress);
    if (f !== null && st.state === "downloading") setProgress(st.id, f, st.progress.phase);
  });
  return row;
}

async function refresh(list, app) {
  // The settings window re-renders its panels (language change...): after the await, write
  // into the list that is in the document (a freshly rendered one is attached by then)
  const live = () => (list.isConnected ? list : document.getElementById("ai-model-list") ?? list);
  try {
    const statuses = await componentStatuses();
    list = live();
    list.replaceChildren(...statuses.map((st) => renderRow(st, list, app)));
    list.dataset.loaded = "1";
  } catch (e) {
    console.error("[ai-models]", e);
    live().replaceChildren(el("p", { class: "vho-settings-hint", text: e?.message || String(e) }));
  }
}

async function runAction(action, st, list, app) {
  lastError.delete(st.id);
  const done = (msgKey) => { if (msgKey) app.toast?.(t(msgKey, { title: st.title })); };
  try {
    if (action === "install" || action === "repair") {
      const ctrl = new AbortController();
      running.set(st.id, ctrl);
      await refresh(list, app);
      try {
        await installComponent(st.id, { signal: ctrl.signal, onProgress: (f, phase) => setProgress(st.id, f, phase) });
      } finally {
        running.delete(st.id);
      }
      done("aiModels.toasts.installed");
    } else if (action === "cancel") {
      running.get(st.id)?.abort();
      return;
    } else if (action === "verify") {
      verifying.add(st.id);
      await refresh(list, app);
      let res;
      try {
        res = await verifyComponent(st.id);
      } finally {
        verifying.delete(st.id);
      }
      done(res.state === "ready" ? "aiModels.toasts.verified" : "aiModels.toasts.damaged");
    } else if (action === "remove") {
      if (!window.confirm(t("aiModels.settings.confirmRemove", { title: st.title }))) return;
      await removeComponent(st.id);
      done("aiModels.toasts.removed");
    }
  } catch (e) {
    lastError.set(st.id, { code: e?.code ?? "io", message: e?.message || String(e) });
    if (e?.detail) console.warn(`[ai-models] ${st.id} ${action}:`, e.code, e.detail);
  }
  await refresh(list, app);
}

function ensureListener() {
  if (listening || !isTauri) return;
  listening = true;
  listen("ai-download", (e) => {
    const p = e.payload;
    const f = progressFraction(p);
    if (f !== null && rowOf(p.id)) setProgress(p.id, f, p.phase);
  })?.catch?.((err) => console.warn("ai-download listener", err));
}

/** Registers the "AI models" settings tab. */
export function registerAiModelSettings(app) {
  app.settings.register("components", [
    {
      id: "ai-models", control: "custom",
      render(container) {
        container.classList.add("vho-ai-models");
        const list = el("div", { id: "ai-model-list", class: "vho-ai-model-list", role: "list" });
        container.append(el("p", { class: "vho-settings-hint", "data-i18n": "aiModels.settings.intro", text: t("aiModels.settings.intro") }), list);
        if (!isTauri) {
          list.append(el("p", { class: "vho-settings-hint", "data-i18n": "aiModels.settings.desktopOnly", text: t("aiModels.settings.desktopOnly") }));
          return;
        }
        ensureListener();
        refresh(list, app);
      },
    },
    // A03: a running AI job pauses while a video / music plays and continues afterwards
    { key: "ai.pauseDuringPlayback", type: "boolean", default: true, control: "toggle",
      labelKey: "aiRuntime.settings.pauseDuringPlayback", helpKey: "aiRuntime.settings.pauseDuringPlaybackHelp" },
    // A04: metadata of AI results (like the photo batch): keep / without GPS / none
    { key: "ai.output.metadata", type: "enum", values: ["keep", "stripGps", "strip"], default: "keep", control: "select",
      labelKey: "aiRuntime.settings.metadata",
      options: [
        { value: "keep", labelKey: "studio.batch.keep" },
        { value: "stripGps", labelKey: "studio.batch.stripGps" },
        { value: "strip", labelKey: "studio.batch.stripAll" },
      ] },
    // A06: background removal is experimental (BiRefNet does not fit ORT Web on every device):
    // hidden in the photo editor until turned on here
    { key: "ai.smart.backgroundExperimental", type: "boolean", default: false, control: "toggle",
      labelKey: "studio.smart.settings.experimental", helpKey: "studio.smart.settings.experimentalHelp" },
    // A06: background removal model of the photo editor; "general" downloads a second model
    { key: "ai.smart.background", type: "enum", values: ["portrait", "general"], default: "portrait", control: "select",
      labelKey: "studio.smart.settings.background", helpKey: "studio.smart.settings.backgroundHelp",
      options: [
        { value: "portrait", labelKey: "studio.smart.settings.portrait" },
        { value: "general", labelKey: "studio.smart.settings.general" },
      ] },
    {
      id: "ai-diagnostics", control: "custom",
      render(container) {
        container.classList.add("vho-ai-diagnostics");
        const out = el("p", { id: "ai-diagnostics", class: "vho-settings-hint", "aria-live": "polite" });
        container.append(out);
        out.textContent = diagnosticsText();
      },
    },
  ]);
}

/** Last AI run and the fallbacks of this session (backend, tile size, error class). */
export function diagnosticsText() {
  const run = lastAiRun();
  const parts = [];
  if (run) {
    parts.push(t("aiRuntime.settings.lastRun", {
      backend: t(run.backend === "webgpu" ? "aiRuntime.backend.webgpu" : "aiRuntime.backend.wasm"),
      tile: run.tile ?? "-", sec: run.seconds.toFixed(1),
    }));
  } else {
    parts.push(t("aiRuntime.settings.noRun"));
  }
  const fallbacks = aiDiagnostics().filter((d) => d.outcome !== "ok");
  if (fallbacks.length) {
    parts.push(t("aiRuntime.settings.fallbacks", {
      list: fallbacks.slice(-5).map((d) => `${d.backend}${d.tile ? `/${d.tile}` : ""}: ${d.cls ?? d.outcome}`).join(", "),
    }));
  }
  return parts.join(" ");
}
