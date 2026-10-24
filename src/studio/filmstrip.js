// ==========================================================================
// Filmstrip under the photo viewer: thumbnails of the folder session around
// the current photo; click to jump. Only the visible window exists in the DOM.
// ==========================================================================

import { stripWindow } from "./logic.js";

const THUMB_W = 76; // cell width incl. gap

/** host: viewport element. deps: { thumbs, onPick(index) } */
export function createFilmstrip(host, { thumbs, onPick }) {
  const el = document.createElement("div");
  el.id = "ps-filmstrip";
  el.className = "ps-filmstrip";
  el.hidden = true;
  host.append(el);

  let items = [];
  let current = -1;

  function render() {
    if (el.hidden) return;
    const visible = Math.max(3, Math.floor((el.clientWidth || host.clientWidth) / THUMB_W));
    const { start, end } = stripWindow(current, items.length, visible);
    const nodes = [];
    for (let i = start; i < end; i++) {
      const it = items[i];
      const b = document.createElement("button");
      b.className = "ps-strip-item" + (i === current ? " active" : "");
      b.dataset.index = i;
      b.title = it.name;
      const url = thumbs.get(it.path);
      if (url) b.style.backgroundImage = `url("${url}")`;
      nodes.push(b);
    }
    el.replaceChildren(...nodes);
    el.dataset.current = current;
    thumbs.request("strip", items.slice(start, end).map((i) => i.path));
  }

  thumbs.onThumb((path, url) => {
    if (el.hidden || !url) return;
    for (const b of el.children) {
      if (items[Number(b.dataset.index)]?.path === path) b.style.backgroundImage = `url("${url}")`;
    }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".ps-strip-item");
    if (b) onPick?.(Number(b.dataset.index));
  });
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onPick?.(Math.max(0, Math.min(items.length - 1, current + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1))));
  }, { passive: false });
  new ResizeObserver(() => render()).observe(host);

  return {
    el,
    show(list, index) {
      items = list;
      current = index;
      el.hidden = false;
      document.body.classList.add("ps-strip-on");
      render();
    },
    hide() {
      el.hidden = true;
      document.body.classList.remove("ps-strip-on");
    },
    get visible() { return !el.hidden; },
  };
}
