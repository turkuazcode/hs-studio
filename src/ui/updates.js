// ==========================================================================
// Updates (plan 14/R02): signed self-update, off by default.
//  - Settings > General: "Check for updates automatically" (default off) + a status row with
//    "Check now" and, when a newer signed release exists, "Install".
//  - Automatic check: once, a few seconds after start, only when the toggle is on. A newer
//    version gives one quiet toast per version; "offline" and "not configured" stay silent.
//  - Download, signature check (minisign public key + signed version) and the installer start
//    happen in Rust (src-tauri/src/updater.rs); the app closes while the installer runs.
// ==========================================================================

import { t } from "../core/i18n.js";
import { invoke, isTauri } from "../core/tauri.js";

const STARTUP_DELAY_MS = 8000;

/** Text key of a check / install outcome (pure, unit tested). */
export function statusKey(status) {
  return {
    available: "updates.status.available",
    none: "updates.status.none",
    offline: "updates.status.offline",
    "not-configured": "updates.status.notConfigured",
    signature: "updates.status.signature",
    download: "updates.status.download",
    verified: "updates.status.verified",
    checking: "updates.status.checking",
    installing: "updates.status.installing",
  }[status] ?? "updates.status.error";
}

/** Error string of updater_install ("<code>: detail") -> code. */
export const errorCode = (e) => String(e ?? "").split(":")[0].trim() || "error";

/**
 * app: { settings, toast }. Registers its fields in the "general" settings tab and starts the
 * optional startup check. Returns { check(), install(), state }.
 */
export function createUpdates(app) {
  const { settings } = app;
  const state = { status: "", version: null, current: null, busy: false, notified: new Set() };
  let view = null; // { text, checkBtn, installBtn } of the rendered settings row

  function render() {
    if (!view) return;
    const key = state.status ? statusKey(state.status) : null;
    const vars = { version: state.version ?? "", current: state.current ?? "" };
    view.text.textContent = key ? t(key, vars) : "";
    if (key) { view.text.dataset.i18n = key; view.text.dataset.i18nVars = JSON.stringify(vars); }
    view.text.dataset.status = state.status;
    view.checkBtn.disabled = state.busy;
    view.installBtn.hidden = state.status !== "available";
    view.installBtn.disabled = state.busy;
  }

  async function check({ quiet = false } = {}) {
    if (!isTauri || state.busy) return state;
    state.busy = true;
    if (!quiet) { state.status = "checking"; render(); }
    try {
      const r = await invoke("updater_check");
      state.current = r.currentVersion;
      state.version = r.version ?? null;
      // Quiet (automatic) checks never surface offline / errors
      if (quiet && r.status !== "available") state.status = r.status === "none" ? "none" : "";
      else state.status = r.status;
      if (r.status === "available" && !state.notified.has(r.version)) {
        state.notified.add(r.version);
        app.toast?.(t("updates.toast", { version: r.version }));
      }
    } catch (e) {
      console.warn("updater_check", e);
      state.status = quiet ? "" : "error";
    } finally {
      state.busy = false;
      render();
    }
    return state;
  }

  async function install() {
    if (!isTauri || state.busy || state.status !== "available") return state;
    if (!globalThis.window?.confirm?.(t("updates.confirmInstall", { version: state.version }))) return state;
    state.busy = true;
    state.status = "installing";
    render();
    try {
      state.status = await invoke("updater_install"); // "verified" (test dry run) / "installing"
    } catch (e) {
      console.warn("updater_install", e);
      state.status = errorCode(e);
    } finally {
      state.busy = false;
      render();
    }
    return state;
  }

  settings.register("general", [
    { key: "general.checkUpdates", type: "boolean", default: false, control: "toggle", labelKey: "settings.fields.checkUpdates", helpKey: "settings.help.checkUpdates" },
    isTauri && {
      id: "updates", control: "custom",
      render(container) {
        const text = document.createElement("span");
        text.className = "vho-update-status";
        text.id = "update-status";
        text.setAttribute("role", "status");
        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "btn-secondary btn-sm";
        checkBtn.id = "update-check-now";
        checkBtn.dataset.i18n = "updates.checkNow";
        checkBtn.textContent = t("updates.checkNow");
        checkBtn.addEventListener("click", () => check());
        const installBtn = document.createElement("button");
        installBtn.type = "button";
        installBtn.className = "btn-secondary btn-sm";
        installBtn.id = "update-install";
        installBtn.dataset.i18n = "updates.install";
        installBtn.textContent = t("updates.install");
        installBtn.hidden = true;
        installBtn.addEventListener("click", () => install());
        const row = document.createElement("div");
        row.className = "vho-update-row";
        row.append(checkBtn, installBtn, text);
        container.append(row);
        view = { text, checkBtn, installBtn };
        render();
      },
    },
  ].filter(Boolean));

  if (isTauri && settings.get("general.checkUpdates")) {
    setTimeout(() => check({ quiet: true }), STARTUP_DELAY_MS);
  }

  return { check, install, state };
}
