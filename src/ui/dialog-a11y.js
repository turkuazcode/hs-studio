// ==========================================================================
// Dialog accessibility for every overlay of the app (Plan 14 Q03).
//
// All modal windows are `.modal-overlay` elements that are shown by adding the class
// `active` (URL, subtitle search, licences, sleep timer, settings, shortcut help, action
// dialogs). Instead of repeating the same code in each of them, one observer gives every
// overlay the same behaviour:
//   - dialog semantics (role="dialog", aria-modal, labelled by its heading) when missing
//   - focus moves into the dialog when it opens (unless the dialog already focused something)
//   - Tab / Shift+Tab stay inside the topmost open dialog
//   - when it closes, focus returns to the control that opened it
//   - Escape closes it through its own Cancel / Close button (`closeTopmost`, the lowest
//     priority Escape handler: dialogs with their own Escape logic run first)
// ==========================================================================

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

const isShown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

/** Focusable, visible elements inside `root`, in DOM (= tab) order. */
export function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => isShown(el) && !el.closest("[inert]"));
}

let headingSeq = 0;

/** Adds dialog semantics to an overlay that has none (static HTML modals). */
function ensureDialogRole(overlay) {
  if (overlay.matches("[role=dialog]") || overlay.querySelector("[role=dialog]")) return;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const heading = overlay.querySelector("h1, h2, h3, h4");
  if (heading && !overlay.hasAttribute("aria-labelledby") && !overlay.hasAttribute("aria-label")) {
    if (!heading.id) heading.id = `vho-dialog-title-${++headingSeq}`;
    overlay.setAttribute("aria-labelledby", heading.id);
  }
}

export function initDialogA11y(doc = document) {
  const open = new Set();
  const openers = new Map();

  const topmost = () => [...doc.querySelectorAll(".modal-overlay.active")].filter(isShown).pop() ?? null;

  // Last focused control outside every dialog: a dialog that focuses its own field while it
  // opens (before the observer runs) still gives focus back to the button that opened it
  let lastOutside = null;
  doc.addEventListener("focusin", (e) => {
    if (!e.target.closest?.(".modal-overlay")) lastOutside = e.target;
  }, true);

  function opened(overlay) {
    ensureDialogRole(overlay);
    const from = doc.activeElement;
    openers.set(overlay, from && from !== doc.body && !overlay.contains(from) ? from : lastOutside);
    // Let the dialog's own code focus its preferred control first
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!overlay.classList.contains("active") || overlay.contains(doc.activeElement)) return;
      const first = focusablesIn(overlay)[0];
      if (first) first.focus();
      else {
        const card = overlay.querySelector(".modal-card") ?? overlay;
        if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
        card.focus();
      }
    }));
  }

  function closed(overlay) {
    const opener = openers.get(overlay);
    openers.delete(overlay);
    const lost = doc.activeElement === doc.body || doc.activeElement === null || overlay.contains(doc.activeElement) || !overlay.isConnected;
    // Another dialog still open: focus stays with it
    if (!lost || topmost()) return;
    // opened from a menu item that has closed since: back to the button of that menu
    const menu = opener?.closest?.("[role=menu]");
    const target = menu?.id && !isShown(opener) ? doc.querySelector(`[aria-controls="${menu.id}"]`) : opener;
    if (target?.isConnected && isShown(target) && !target.disabled) target.focus();
  }

  function sync() {
    const now = new Set(doc.querySelectorAll(".modal-overlay.active"));
    for (const el of now) if (!open.has(el)) { open.add(el); opened(el); }
    for (const el of [...open]) if (!now.has(el)) { open.delete(el); closed(el); }
  }

  new MutationObserver(sync).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  sync();

  // Focus trap: Tab cycles inside the topmost dialog
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const dlg = topmost();
    if (!dlg) return;
    const items = focusablesIn(dlg);
    if (!items.length) { e.preventDefault(); return; }
    const i = items.indexOf(doc.activeElement);
    const last = items.length - 1;
    if (i === -1 || (!e.shiftKey && i === last) || (e.shiftKey && i === 0)) {
      e.preventDefault();
      items[e.shiftKey ? last : 0].focus();
    }
  }, true);

  /** Clicks the topmost dialog's Cancel / Close button; false when there is none. */
  function closeTopmost() {
    const dlg = topmost();
    const btn = dlg?.querySelector("[data-dialog-close], [id^='btn-cancel'], [id^='btn-close']");
    if (!btn || !isShown(btn) || btn.disabled) return false;
    btn.click();
    return true;
  }

  return { sync, topmost, closeTopmost };
}
