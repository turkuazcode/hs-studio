// ==========================================================================
// Virtualised thumbnail grid: only the visible rows (+ overscan) exist in the
// DOM, cells are recycled, thumbnails are requested for the visible range only.
// ==========================================================================

import { gridWindow, nextFrame, scrollToShow } from "./logic.js";

const GAP = 8;
const LABEL_H = 24;

const VIDEO_ICON = '<svg viewBox="0 0 24 24" width="38" height="38" fill="currentColor" aria-hidden="true"><path d="M4 5h11a2 2 0 012 2v2.5l4-2.5v10l-4-2.5V17a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z"/></svg>';
const BROKEN_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M21 5v6.6l-3-3-4 4-4-4-4 4-3-3V5a2 2 0 012-2h14a2 2 0 012 2zM3 13.4l3 3 4-4 4 4 4-4 3 3V19a2 2 0 01-2 2H5a2 2 0 01-2-2v-5.6z"/></svg>';

/**
 * el: scroll container. opts: { thumbs (thumb service), onActivate(index, event),
 * onPointerSelect(index, event), onContext(index, event), onRender(window) }
 */
export function createGrid(el, { thumbs, onActivate, onPointerSelect, onRender }) {
  const sizer = document.createElement("div");
  sizer.className = "ps-grid-sizer";
  el.append(sizer);

  let items = [];
  let selected = new Set();
  let focus = -1;
  let minCell = 168;
  let layout = { cols: 1, cellW: minCell, cellH: minCell + LABEL_H, start: 0, end: 0 };
  const cells = new Map(); // index -> element
  const pool = [];
  let raf = 0;
  let thumbTimer = 0;

  function measure() {
    const width = el.clientWidth - 2 * GAP;
    const w = gridWindow({ count: items.length, width, height: el.clientHeight, scrollTop: el.scrollTop, cellWidth: minCell, cellHeight: 1, gap: GAP });
    const cols = w.cols;
    const cellW = Math.floor((width - GAP * (cols - 1)) / cols);
    const cellH = cellW + LABEL_H;
    const win = gridWindow({
      count: items.length, width, height: el.clientHeight, scrollTop: Math.max(0, el.scrollTop - GAP),
      cellWidth: cellW, cellHeight: cellH, gap: GAP, overscan: 2,
    });
    return { ...win, cols: win.cols, cellW, cellH };
  }

  function makeCell() {
    const c = pool.pop() ?? Object.assign(document.createElement("div"), {
      className: "ps-cell",
      innerHTML: '<div class="ps-thumb"><img alt="" draggable="false" decoding="async"></div><div class="ps-name"></div>',
    });
    return c;
  }

  function fillCell(c, i) {
    const it = items[i];
    c.dataset.index = i;
    c.dataset.path = it.path;
    c.title = it.name;
    c.classList.toggle("selected", selected.has(it.path));
    c.classList.toggle("focused", i === focus);
    c.classList.toggle("is-video", it.kind === "video");
    // library star rating (Plan 13/L02), drawn by CSS
    if (it.rating > 0) c.dataset.stars = "★".repeat(Math.min(5, it.rating));
    else delete c.dataset.stars;
    const name = c.lastChild;
    if (name.textContent !== it.name) name.textContent = it.name;
    setThumb(c, it);
  }

  function setThumb(c, it) {
    const box = c.firstChild;
    const img = box.querySelector("img");
    box.querySelector(".ps-icon")?.remove();
    box.classList.toggle("loading", false);
    if (it.kind === "video") {
      img.removeAttribute("src");
      img.hidden = true;
      box.insertAdjacentHTML("beforeend", `<span class="ps-icon">${VIDEO_ICON}</span>`);
      return;
    }
    const url = thumbs.get(it.path);
    if (url) {
      if (img.getAttribute("src") !== url) img.src = url;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      if (thumbs.has(it.path)) {
        // the error text can carry a file name: set it as a property, never as markup (Q04)
        box.insertAdjacentHTML("beforeend", `<span class="ps-icon ps-broken">${BROKEN_ICON}</span>`);
        box.lastElementChild.title = thumbs.error(it.path) ?? "";
      } else {
        box.classList.add("loading");
      }
    }
    // Format badge for formats the webview cannot show directly (HEIC, RAW...)
    let badge = box.querySelector(".ps-badge");
    const label = it.kind === "raw" ? "RAW" : it.kind === "heif" ? "HEIC" : it.kind === "video" ? "" : (!it.browserNative ? it.ext.toUpperCase() : "");
    if (label) {
      if (!badge) box.append(badge = Object.assign(document.createElement("span"), { className: "ps-badge" }));
      badge.textContent = label;
    } else badge?.remove();
  }

  function render() {
    raf = 0;
    layout = measure();
    sizer.style.height = `${layout.totalHeight + 2 * GAP}px`;
    const { start, end, cols, cellW, cellH } = layout;
    for (const [i, c] of cells) {
      if (i < start || i >= end) {
        c.remove();
        cells.delete(i);
        pool.push(c);
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      let c = cells.get(i);
      const fresh = !c;
      if (fresh) {
        c = makeCell();
        cells.set(i, c);
      }
      if (fresh || c.dataset.path !== items[i].path) fillCell(c, i);
      const x = GAP + (i % cols) * (cellW + GAP);
      const y = GAP + Math.floor(i / cols) * (cellH + GAP);
      c.style.cssText = `width:${cellW}px;height:${cellH}px;transform:translate(${x}px,${y}px)`;
      if (fresh) frag.append(c);
    }
    if (frag.childNodes.length) el.append(frag);
    el.dataset.rendered = cells.size;
    onRender?.(layout);
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(requestThumbs, 50);
  }

  function requestThumbs() {
    const { start, end } = layout;
    const paths = [];
    for (let i = start; i < end; i++) if (items[i] && items[i].kind !== "video") paths.push(items[i].path);
    if (paths.length) thumbs.request("grid", paths);
  }

  const schedule = () => { if (!raf) raf = nextFrame(render); };

  thumbs.onThumb((path) => {
    for (const c of cells.values()) {
      if (c.dataset.path === path) setThumb(c, items[Number(c.dataset.index)]);
    }
  });

  el.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(el);

  const indexOf = (e) => {
    const c = e.target.closest?.(".ps-cell");
    return c && el.contains(c) ? Number(c.dataset.index) : -1;
  };
  el.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const i = indexOf(e);
    el.focus({ preventScroll: true });
    if (i >= 0) onPointerSelect?.(i, e);
    else if (!e.ctrlKey && !e.shiftKey) onPointerSelect?.(-1, e);
  });
  el.addEventListener("dblclick", (e) => {
    const i = indexOf(e);
    if (i >= 0) onActivate?.(i, e);
  });

  return {
    el,
    /** New item list (view order). */
    setItems(next, { keepScroll = false } = {}) {
      items = next;
      for (const c of cells.values()) {
        c.remove();
        pool.push(c);
      }
      cells.clear();
      if (!keepScroll) el.scrollTop = 0;
      render();
    },
    /** Items appended / replaced in place (scan pages): keeps cells, refreshes content. */
    refresh(next) {
      items = next;
      for (const [i, c] of cells) {
        if (i >= items.length) {
          c.remove();
          cells.delete(i);
          pool.push(c);
        } else if (c.dataset.path !== items[i].path) fillCell(c, i);
      }
      render();
    },
    setSelection(sel, focusIndex) {
      selected = sel;
      focus = focusIndex;
      for (const [i, c] of cells) {
        c.classList.toggle("selected", selected.has(items[i]?.path));
        c.classList.toggle("focused", i === focus);
      }
    },
    setCellSize(px) {
      minCell = px;
      schedule();
    },
    /** Scrolls so that item `index` is visible. */
    reveal(index) {
      if (index < 0) return;
      const l = measure();
      const top = scrollToShow(index, { cols: l.cols, cellHeight: l.cellH, gap: GAP, height: el.clientHeight - 2 * GAP, scrollTop: el.scrollTop });
      if (top !== el.scrollTop) el.scrollTop = top;
      render();
    },
    get columns() { return layout.cols; },
    get visibleRows() { return Math.max(1, Math.floor(el.clientHeight / (layout.cellH + GAP))); },
    renderNow: render,
  };
}
