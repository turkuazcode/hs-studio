// ==========================================================================
// Recent files: recorded on every media load, shown as a grid on the empty start
// screen (and in the titlebar menu). Video thumbnails are a small frame captured
// once (stored in library.json); photo thumbnails come from the backend thumbnail
// cache (photo_thumb), video positions from the resume store.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { formatTime } from "../core/format.js";
import { recentId } from "../core/library.js";
import { convertFileSrc, invoke } from "../core/tauri.js";
import { isAudioOnlyName } from "../media/classify.js";
import { resumeKey } from "../media/video-player.js";

const THUMB_W = 192;
const THUMB_H = 108;

/** Library entry for a playlist item (null for items that cannot be reopened, e.g. dropped File objects). */
export function entryFromItem(item, now = Date.now()) {
  const id = recentId(item);
  if (!id) return null;
  const name = item.name || id.split(/[\\/]/).pop() || id;
  const type = item.isImage ? "image" : isAudioOnlyName(name) ? "audio" : "video";
  return {
    id,
    path: item.path || undefined,
    url: item.path ? undefined : item.url,
    name,
    type,
    resumeKey: type === "image" ? "" : resumeKey(item),
    openedAt: now,
  };
}

/** Progress 0..1 of a resume position (0 when unknown). */
export const progressOf = (position, duration) =>
  position > 0 && duration > 0 ? Math.min(1, position / duration) : 0;

/**
 * app: { dom, bus, settings, library, resume, loader, toast }
 */
export function createRecentFiles(app) {
  const { dom, settings, library } = app;
  const enabled = () => settings.get("general.rememberRecent");
  let current = null; // { id, captured } for the item being played

  // ------------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------------
  app.bus.on("media:loading", ({ item }) => {
    current = null;
    if (!enabled()) return;
    const entry = entryFromItem(item);
    if (!entry) return;
    library.recent.add(entry);
    current = { id: entry.id, type: entry.type, captured: entry.type !== "video" };
    if (entry.type === "image" && entry.path) photoThumb(entry.path).catch(() => {});
  });

  app.bus.on("media:loaded", ({ kind }) => {
    if (!current || kind !== "video") return;
    const d = app.engine?.duration ?? dom.video.duration;
    if (Number.isFinite(d) && d > 0) library.recent.update(current.id, { duration: d });
  });

  // One frame a little into the video (the first frame is often black)
  app.bus.on("media:time", ({ time }) => {
    if (!current || current.captured) return;
    const d = dom.video.duration;
    const target = Number.isFinite(d) && d > 0 ? Math.min(3, d * 0.2) : 3;
    if (time < target || dom.video.videoWidth === 0) return;
    current.captured = true;
    const thumb = captureFrame(dom.video);
    if (thumb) library.recent.update(current.id, { thumb });
  });

  function captureFrame(video) {
    try {
      const c = document.createElement("canvas");
      c.width = THUMB_W;
      c.height = THUMB_H;
      const ctx = c.getContext("2d");
      const s = Math.min(THUMB_W / video.videoWidth, THUMB_H / video.videoHeight);
      const w = video.videoWidth * s, h = video.videoHeight * s;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, THUMB_W, THUMB_H);
      ctx.drawImage(video, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
      return c.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      console.warn("[recent] thumbnail", e); // tainted / no frame
      return "";
    }
  }

  /** Backend thumbnail cache (also re-allows the cache folder for the asset protocol). */
  const thumbCache = new Map();
  function photoThumb(path) {
    if (!invoke) return Promise.reject(new Error("no backend"));
    if (!thumbCache.has(path)) {
      thumbCache.set(path, invoke("photo_thumb", { path, size: 256 }).then((r) => convertFileSrc(r.path)));
      thumbCache.get(path).catch(() => thumbCache.delete(path));
    }
    return thumbCache.get(path);
  }

  // ------------------------------------------------------------------------
  // Opening / removing
  // ------------------------------------------------------------------------
  async function open(entry) {
    if (entry.url) {
      app.loader.openUrlItem({ url: entry.url, name: entry.name, isImage: entry.type === "image" });
      return;
    }
    let entries = [];
    try {
      entries = await invoke("prepare_media", { paths: [entry.path] });
    } catch (e) {
      console.warn("prepare_media", e);
    }
    if (!entries?.length) {
      app.toast(t("recent.missing", { name: entry.name }));
      library.recent.remove(entry.id);
      return;
    }
    app.loader.openEntries(entries);
  }

  function remove(entry) {
    library.recent.remove(entry.id);
    app.toast(t("recent.removed", { name: entry.name }));
  }

  function clear() {
    library.recent.clear();
    app.toast(t("recent.cleared"));
  }

  // ------------------------------------------------------------------------
  // Start screen grid
  // ------------------------------------------------------------------------
  const section = document.createElement("section");
  section.id = "recent-files";
  section.className = "vho-recent";
  section.setAttribute("aria-labelledby", "recent-files-title");
  section.innerHTML = `
    <div class="vho-recent-header">
      <h3 id="recent-files-title" data-i18n="recent.title"></h3>
      <button type="button" id="btn-recent-clear" class="btn-ghost btn-sm" data-i18n="recent.clear"></button>
    </div>
    <ul class="vho-recent-grid" role="list"></ul>`;
  dom.dropZone.append(section);
  dom.dropZone.classList.add("has-recent-host");
  const grid = section.querySelector(".vho-recent-grid");
  section.querySelector("#btn-recent-clear").addEventListener("click", clear);

  const typeIcon = { video: "🎬", audio: "🎵", image: "🖼️" };

  function card(entry) {
    const li = document.createElement("li");
    li.className = "vho-recent-item";
    li.dataset.id = entry.id;

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "vho-recent-open";
    openBtn.title = entry.path || entry.url;
    openBtn.setAttribute("aria-label", t("recent.openItem", { name: entry.name }));
    openBtn.addEventListener("click", () => open(entry));

    const thumb = document.createElement("div");
    thumb.className = "vho-recent-thumb";
    thumb.dataset.type = entry.type;
    const icon = document.createElement("span");
    icon.className = "vho-recent-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = typeIcon[entry.type] ?? "🎬";
    thumb.append(icon);
    const setImg = (src) => {
      if (!src) return;
      const img = new Image();
      img.alt = "";
      img.decoding = "async";
      img.onload = () => thumb.replaceChildren(img, ...thumb.querySelectorAll(".vho-recent-progress, .vho-recent-duration"));
      img.src = src;
    };
    if (entry.thumb) setImg(entry.thumb);
    else if (entry.type === "image" && entry.path) photoThumb(entry.path).then(setImg).catch(() => {});

    const position = entry.resumeKey ? app.resume.get(entry.resumeKey) ?? 0 : 0;
    const p = progressOf(position, entry.duration);
    if (p > 0) {
      const bar = document.createElement("div");
      bar.className = "vho-recent-progress";
      bar.innerHTML = "<span></span>";
      bar.firstChild.style.width = `${Math.round(p * 100)}%`;
      thumb.append(bar);
    }
    if (entry.duration > 0) {
      const d = document.createElement("span");
      d.className = "vho-recent-duration";
      d.textContent = formatTime(entry.duration);
      thumb.append(d);
    }

    const name = document.createElement("span");
    name.className = "vho-recent-name";
    name.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "vho-recent-meta";
    meta.textContent = p > 0 ? t("recent.resumeAt", { time: formatTime(position) }) : t(`recent.types.${entry.type}`);
    openBtn.append(thumb, name, meta);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "vho-recent-remove";
    del.textContent = "✕";
    del.title = t("recent.remove");
    del.setAttribute("aria-label", t("recent.removeItem", { name: entry.name }));
    del.addEventListener("click", (e) => { e.stopPropagation(); remove(entry); });

    li.append(openBtn, del);
    return li;
  }

  function render() {
    const list = enabled() ? library.recent.list() : [];
    section.hidden = list.length === 0;
    grid.replaceChildren(...list.map(card));
    i18n.applyTranslations(section);
  }

  library.recent.subscribe(render);
  settings.subscribe("general.rememberRecent", render);
  i18n.onChange(render);
  // Positions change while playing: refresh when the start screen shows again
  new MutationObserver(() => { if (dom.dropZone.classList.contains("visible")) render(); })
    .observe(dom.dropZone, { attributes: true, attributeFilter: ["class"] });
  render();

  return { open, remove, clear, render, entryFromItem };
}
