// ==========================================================================
// Compare mode: 2-4 photos side by side with synchronised zoom and pan.
// ==========================================================================

import { compareColumns, zoomAt } from "./logic.js";

const TEMPLATE = `
  <div class="ps-compare-bar">
    <strong>Karşılaştır</strong>
    <span class="ps-compare-hint">Tekerlek: yakınlaştır · Sürükle: kaydır · Senkron</span>
    <span class="ps-spacer"></span>
    <button class="ps-btn" data-act="out" title="Uzaklaştır (-)">−</button>
    <button class="ps-btn ps-compare-zoom" data-act="reset" title="Sığdır (0)">Sığdır</button>
    <button class="ps-btn" data-act="in" title="Yakınlaştır (+)">+</button>
    <button class="ps-btn" data-act="close" title="Kapat (Esc)">✕ Kapat</button>
  </div>
  <div class="ps-compare-panes"></div>`;

/** root: overlay element. deps: { invoke, convertFileSrc, onClose } */
export function createCompare(root, { invoke, convertFileSrc, onClose }) {
  root.innerHTML = TEMPLATE;
  const panes = root.querySelector(".ps-compare-panes");
  const zoomBtn = root.querySelector(".ps-compare-zoom");
  let view = { zoom: 1, x: 0, y: 0 };
  let drag = null;

  function apply() {
    for (const img of panes.querySelectorAll("img")) {
      img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    }
    zoomBtn.textContent = Math.abs(view.zoom - 1) < 0.01 ? "Sığdır" : `${Math.round(view.zoom * 100)}%`;
    root.dataset.zoom = view.zoom.toFixed(3);
    root.dataset.pan = `${Math.round(view.x)},${Math.round(view.y)}`;
  }

  function zoom(factor, e, pane) {
    let ox = 0, oy = 0;
    if (e && pane) {
      const r = pane.getBoundingClientRect();
      ox = e.clientX - (r.left + r.width / 2);
      oy = e.clientY - (r.top + r.height / 2);
    }
    view = zoomAt(view, factor, ox, oy);
    apply();
  }

  async function open(items) {
    root.hidden = false;
    view = { zoom: 1, x: 0, y: 0 };
    panes.style.gridTemplateColumns = `repeat(${compareColumns(items.length)}, 1fr)`;
    panes.replaceChildren(...items.map((it) => {
      const pane = document.createElement("div");
      pane.className = "ps-compare-pane";
      pane.innerHTML = '<img alt="" draggable="false"><span class="ps-compare-label"></span>';
      pane.querySelector(".ps-compare-label").textContent = it.name;
      return pane;
    }));
    apply();
    root.dataset.loaded = "0";
    let loaded = 0;
    await Promise.all(items.map(async (it, i) => {
      const img = panes.children[i].querySelector("img");
      try {
        const r = it.browserNative ? { path: it.path } : await invoke("photo_decode", { path: it.path, maxSize: 4096 });
        img.src = convertFileSrc(r.path);
        await img.decode().catch(() => {});
      } catch (e) {
        panes.children[i].querySelector(".ps-compare-label").textContent = `${it.name} — açılamadı`;
      }
      root.dataset.loaded = String(++loaded);
    }));
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    panes.replaceChildren();
    onClose?.();
  }

  panes.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e, e.target.closest(".ps-compare-pane"));
  }, { passive: false });
  panes.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || view.zoom <= 1) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    panes.setPointerCapture(e.pointerId);
    panes.classList.add("panning");
  });
  panes.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
    apply();
  });
  panes.addEventListener("pointerup", () => { drag = null; panes.classList.remove("panning"); });
  panes.addEventListener("dblclick", (e) => {
    if (view.zoom > 1.01) { view = { zoom: 1, x: 0, y: 0 }; apply(); } else zoom(2.5, e, e.target.closest(".ps-compare-pane"));
  });
  root.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "in") zoom(1.25);
    else if (act === "out") zoom(0.8);
    else if (act === "reset") { view = { zoom: 1, x: 0, y: 0 }; apply(); }
    else if (act === "close") close();
  });

  return {
    open, close,
    get isOpen() { return !root.hidden; },
    handleKey(e) {
      if (root.hidden) return false;
      if (e.key === "Escape") close();
      else if (e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd") zoom(1.25);
      else if (e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract") zoom(0.8);
      else if (e.key === "0" || e.code === "Numpad0") { view = { zoom: 1, x: 0, y: 0 }; apply(); }
      else return false;
      return true;
    },
  };
}
