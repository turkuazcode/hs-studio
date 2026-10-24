// ==========================================================================
// Settings > Kısayollar: user-editable key bindings with conflict detection.
// Overrides are stored in settings "shortcuts.bindings" as { actionId: [combo, ...] }.
// ==========================================================================

import { t } from "../core/i18n.js";
import { comboFromEvent, conflictsFor, formatCombo } from "../core/keymap.js";

export const SCOPE_ORDER = ["global", "video", "photo"];

/** Display label of an action (literal label, labelKey, or shortcuts.actions.<id>). */
export const actionLabel = (a) => a.label ?? t(a.labelKey ?? `shortcuts.actions.${a.id}`);

/** Key names in the current language. */
export const keyNames = () => ({ Space: t("keys.space"), Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" });

export function renderShortcutEditor(container, app) {
  const { settings, shortcuts } = app;
  if (!shortcuts) return;
  let capturing = null; // { id, row, stop() }

  const status = document.createElement("p");
  status.className = "vho-shortcut-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const table = document.createElement("div");
  table.className = "vho-shortcut-table";

  const overrides = () => settings.get("shortcuts.bindings") ?? {};

  function setKeys(id, keys) {
    const actions = shortcuts.actions();
    const action = actions.find((a) => a.id === id);
    const isDefault = action && JSON.stringify(keys) === JSON.stringify(action.keys);
    const clash = conflictsFor(actions, overrides(), id, keys);
    if (clash.length) {
      const other = actions.find((a) => a.id === clash[0].id);
      status.textContent = t("shortcuts.conflict", { key: formatCombo(clash[0].combo, keyNames()), action: other ? actionLabel(other) : clash[0].id });
      status.classList.add("is-error");
      return false;
    }
    const next = { ...overrides() };
    if (isDefault) delete next[id];
    else next[id] = keys;
    settings.set("shortcuts.bindings", next);
    status.textContent = t("shortcuts.saved");
    status.classList.remove("is-error");
    return true;
  }

  function stopCapture() {
    if (!capturing) return;
    window.removeEventListener("keydown", capturing.onKey, true);
    capturing = null;
  }

  function startCapture(id, button) {
    stopCapture();
    button.textContent = t("shortcuts.pressKey");
    button.classList.add("is-capturing");
    const onKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === "Escape") { stopCapture(); render(); return; }
      if (e.code === "Backspace" || e.code === "Delete") { stopCapture(); setKeys(id, []); render(); return; }
      const combo = comboFromEvent(e);
      if (!combo) return; // lone modifier: keep waiting
      stopCapture();
      setKeys(id, [combo]);
      render();
    };
    capturing = { id, onKey };
    window.addEventListener("keydown", onKey, true);
  }

  function render() {
    table.replaceChildren();
    const actions = shortcuts.actions();
    const custom = overrides();
    for (const scope of SCOPE_ORDER) {
      const group = actions.filter((a) => a.scope === scope);
      if (!group.length) continue;
      const h = document.createElement("h4");
      h.className = "vho-settings-heading";
      h.textContent = t(`shortcuts.scopes.${scope}`);
      table.append(h);
      for (const a of group) {
        const row = document.createElement("div");
        row.className = "vho-shortcut-row";
        row.dataset.action = a.id;
        const name = document.createElement("span");
        name.className = "vho-shortcut-name";
        name.textContent = actionLabel(a);
        const keys = document.createElement("span");
        keys.className = "vho-shortcut-keys";
        const current = shortcuts.keysOf(a.id);
        if (!current.length) keys.textContent = t("shortcuts.none");
        for (const c of current) {
          const k = document.createElement("kbd");
          k.textContent = formatCombo(c, keyNames());
          keys.append(k);
        }
        const change = document.createElement("button");
        change.type = "button";
        change.className = "btn-secondary btn-sm vho-shortcut-change";
        change.textContent = t("shortcuts.change");
        change.setAttribute("aria-label", `${t("shortcuts.change")}: ${actionLabel(a)}`);
        change.addEventListener("click", () => startCapture(a.id, change));
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "btn-ghost btn-sm";
        reset.textContent = t("settings.buttons.reset");
        reset.setAttribute("aria-label", `${t("settings.buttons.reset")}: ${actionLabel(a)}`);
        reset.disabled = !Object.hasOwn(custom, a.id);
        reset.addEventListener("click", () => { setKeys(a.id, a.keys.slice()); render(); });
        row.append(name, keys, change, reset);
        table.append(row);
      }
    }
  }

  const resetAll = document.createElement("button");
  resetAll.type = "button";
  resetAll.className = "btn-ghost btn-sm";
  resetAll.id = "btn-shortcuts-reset-all";
  resetAll.textContent = t("shortcuts.resetAll");
  resetAll.addEventListener("click", () => {
    settings.set("shortcuts.bindings", {});
    status.textContent = t("shortcuts.saved");
    status.classList.remove("is-error");
    render();
  });

  const hint = document.createElement("p");
  hint.className = "vho-settings-hint";
  hint.textContent = t("shortcuts.hint");

  container.append(hint, status, table, resetAll);
  render();
}
