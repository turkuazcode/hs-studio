// ==========================================================================
// Small popup menu for the photo studio ("⋯" buttons and right-click).
// items: [{ id, label, run, enabled?: () => bool, separator?: true }]
// ==========================================================================

export function createMenu(items) {
  const el = document.createElement("div");
  el.className = "ps-menu";
  el.setAttribute("role", "menu");
  el.hidden = true;
  document.body.append(el);
  let onClose = null;

  function render() {
    el.replaceChildren(...items.map((it) => {
      if (it.separator) return Object.assign(document.createElement("div"), { className: "ps-menu-sep" });
      const b = Object.assign(document.createElement("button"), { className: "ps-menu-item", textContent: it.label, type: "button" });
      b.setAttribute("role", "menuitem");
      b.dataset.menu = it.id;
      b.disabled = it.enabled ? !it.enabled() : false;
      return b;
    }));
  }

  function close() {
    if (el.hidden) return;
    el.hidden = true;
    onClose?.();
  }

  /** Opens at viewport point (x, y), kept inside the window. */
  function openAt(x, y, closeCb) {
    render();
    onClose = closeCb;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    el.querySelector(".ps-menu-item:not(:disabled)")?.focus({ preventScroll: true });
  }

  /** Opens below (or above) a button. */
  function openFor(button, closeCb) {
    const r = button.getBoundingClientRect();
    openAt(r.right - 200, r.bottom + 4, closeCb);
    const m = el.getBoundingClientRect();
    if (m.bottom > innerHeight - 4) el.style.top = `${Math.max(4, r.top - m.height - 4)}px`;
  }

  el.addEventListener("click", (e) => {
    const b = e.target.closest(".ps-menu-item");
    if (!b || b.disabled) return;
    close();
    items.find((i) => i.id === b.dataset.menu)?.run();
  });
  el.addEventListener("keydown", (e) => {
    const btns = [...el.querySelectorAll(".ps-menu-item:not(:disabled)")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") btns[(i + 1) % btns.length]?.focus();
    else if (e.key === "ArrowUp") btns[(i - 1 + btns.length) % btns.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("mousedown", (e) => { if (!el.hidden && !el.contains(e.target)) close(); }, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);

  return { el, openAt, openFor, close, get isOpen() { return !el.hidden; } };
}
