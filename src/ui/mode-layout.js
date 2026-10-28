// ==========================================================================
// Per-media layout (approved mockup 2026-10-28; docs/plans/00 "Arayüz ilkeleri"):
//   empty: logo/menu · "HS Studio" ............ Kütüphane · ⚙         (no player bar)
//   video: logo/menu · file name .............. Liste · ⋯             HUD: … CC▾ · Filtreler · ⛶
//   photo: logo/menu · file name ‹ n / N › .... Düzenle · ⋯           HUD: − % + · ⤢ ⟲ ⟳ · İyileştir
//   music: logo/menu · Artist — Title ......... Sıradakiler · ⋯       HUD: ⤨ ⏮ ▶ ⏭ ⟳ · volume
// The mode comes from ui/media-actions.js (<html data-media-mode>); CSS (styles/layout-modes.css)
// shows each mode's buttons. This module only moves the few elements whose place depends on the
// mode; their logic, ids and shortcuts stay where they were.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";

const GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

/** Where the enhance / filters button sits per mode: [parent selector, insert before (selector or null)]. */
export const ENHANCE_PLACE = Object.freeze({
  video: [".controls-hud .controls-group.right", "#btn-fullscreen"],
  photo: [".photo-hud-right", null],
  none: [".titlebar-actions", null],
  music: [".titlebar-actions", null],
});

/** app: { settingsModal } (lazy) */
export function createModeLayout(app) {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const actions = document.querySelector(".titlebar-actions");

  // "⋯" of the media actions is the rightmost titlebar button
  const mediaBar = $("media-actions");
  if (mediaBar && actions) actions.after(mediaBar);

  // Settings (empty screen only; elsewhere it is in "⋯" and the logo menu)
  const settingsBtn = document.createElement("button");
  Object.assign(settingsBtn, { id: "btn-titlebar-settings", type: "button", className: "titlebar-action-btn titlebar-icon-btn" });
  settingsBtn.dataset.tauriDragRegion = "false";
  settingsBtn.innerHTML = GEAR;
  settingsBtn.addEventListener("click", () => app.settingsModal?.open());
  actions?.append(settingsBtn);

  // photo: previous · n / N · next next to the file name
  const photoNav = document.createElement("span");
  photoNav.className = "titlebar-photo-nav";
  photoNav.dataset.tauriDragRegion = "false";
  photoNav.append(...["btn-photo-prev", "photo-counter-badge", "btn-photo-next"].map($).filter(Boolean));
  $("current-filename")?.after(photoNav);

  function labels() {
    settingsBtn.title = t("menu.settings").replace(/…$/, "");
    settingsBtn.setAttribute("aria-label", settingsBtn.title);
  }

  function apply() {
    const mode = root.dataset.mediaMode || "none";
    const enhance = $("btn-toggle-ai-restore");
    const [parentSel, beforeSel] = ENHANCE_PLACE[mode] ?? ENHANCE_PLACE.none;
    const parent = document.querySelector(parentSel);
    if (enhance && parent) {
      const before = beforeSel ? parent.querySelector(beforeSel) : null;
      if (enhance.parentElement !== parent || (before && enhance.nextElementSibling !== before)) {
        parent.insertBefore(enhance, before && before.parentElement === parent ? before : null);
      }
      enhance.classList.toggle("hud-text-btn", mode === "video" || mode === "photo");
    }
  }

  labels();
  apply();
  i18n.onChange?.(labels);
  new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ["data-media-mode"] });
  return { apply };
}
