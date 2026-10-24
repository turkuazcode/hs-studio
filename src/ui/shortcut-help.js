// ==========================================================================
// Shortcut help overlay ("?" or F1): every action with its current keys.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { formatCombo } from "../core/keymap.js";
import { actionLabel, keyNames, SCOPE_ORDER } from "./shortcut-editor.js";

export function createShortcutHelp(app) {
  const overlay = document.createElement("div");
  overlay.id = "shortcut-help";
  overlay.className = "modal-overlay vho-help-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "shortcut-help-title");
  overlay.innerHTML = `
    <div class="modal-card modal-large vho-help-card">
      <div class="modal-header-row">
        <h3 id="shortcut-help-title" data-i18n="shortcuts.helpTitle"></h3>
        <button type="button" id="btn-close-shortcut-help" class="btn-icon-close" data-i18n-aria-label="common.close" data-i18n-title="common.close">✕</button>
      </div>
      <p data-i18n="shortcuts.helpHint"></p>
      <div class="vho-help-grid"></div>
      <div class="modal-actions">
        <button type="button" id="btn-help-edit-shortcuts" class="btn-secondary btn-sm" data-i18n="shortcuts.edit"></button>
      </div>
    </div>`;
  (document.getElementById("viewport") ?? document.body).append(overlay);
  const grid = overlay.querySelector(".vho-help-grid");
  let lastFocus = null;

  function render() {
    grid.replaceChildren();
    const actions = app.shortcuts.actions();
    for (const scope of SCOPE_ORDER) {
      const group = actions.filter((a) => a.scope === scope && app.shortcuts.keysOf(a.id).length);
      if (!group.length) continue;
      const col = document.createElement("section");
      col.className = "vho-help-group";
      const h = document.createElement("h4");
      h.textContent = t(`shortcuts.scopes.${scope}`);
      const dl = document.createElement("dl");
      for (const a of group) {
        const dt = document.createElement("dt");
        for (const c of app.shortcuts.keysOf(a.id)) {
          const k = document.createElement("kbd");
          k.textContent = formatCombo(c, keyNames());
          dt.append(k);
        }
        const dd = document.createElement("dd");
        dd.textContent = actionLabel(a);
        dl.append(dt, dd);
      }
      col.append(h, dl);
      grid.append(col);
    }
    i18n.applyTranslations(overlay);
  }

  const isOpen = () => overlay.classList.contains("active");
  function open() {
    lastFocus = document.activeElement;
    render();
    overlay.classList.add("active");
    overlay.querySelector("#btn-close-shortcut-help").focus();
  }
  function close() {
    if (!isOpen()) return false;
    overlay.classList.remove("active");
    lastFocus?.focus?.();
    return true;
  }

  overlay.querySelector("#btn-close-shortcut-help").addEventListener("click", close);
  overlay.querySelector("#btn-help-edit-shortcuts").addEventListener("click", () => {
    close();
    app.settingsModal?.open("shortcuts");
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  app.shortcuts.onEscape(close);
  app.shortcuts.onChange(() => { if (isOpen()) render(); });
  i18n.onChange(() => (isOpen() ? render() : i18n.applyTranslations(overlay)));
  i18n.applyTranslations(overlay);

  return { open, close, toggle: () => (isOpen() ? close() : open()), get isOpen() { return isOpen(); } };
}
