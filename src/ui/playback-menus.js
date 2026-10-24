// ==========================================================================
// Minimal video HUD (UI principles, docs/plans/00-YOL-HARITASI.md "Arayüz ilkeleri"):
// the HUD keeps play/pause, seek, volume, CC (+ compact track menu), "⋯" and
// fullscreen. Everything rarely used lives in the "⋯" popup menu built here:
// audio tracks, chapters, bookmarks, speed, aspect, picture (rotate / flip / zoom),
// A-B loop, snapshot, PiP, picture / audio settings panels; fine-tuning is in the
// Settings window (media/engine-settings.js).
// Also: chapter / bookmark markers, Ctrl+wheel zoom + Ctrl+drag pan, libmpv
// geometry (video inside the viewport, subtitles above the HUD), engine info,
// audio-only layout. Everything goes through the engine facade (app.engine).
// ==========================================================================

import { formatTime } from "../core/format.js";
import { loadJson, saveJson } from "../core/storage.js";
import {
  DEFAULT_VIEW, addBookmark, chapterAt, isAudioOnlyMedia, nextZoom, subMarginFor,
} from "../media/engine/engine.js";
import { createPopupMenu } from "./menus.js";

/** Bookmark storage key for the current file (same identity as the resume position). */
export const bookmarkKey = (fileKey) => (fileKey ? `vho_bm_${fileKey}` : "");

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ASPECTS = [["contain", "Orijinal"], ["16-9", "16:9"], ["21-9", "21:9"], ["4-3", "4:3"], ["fill", "Ekrana yay"]];

/**
 * app: { dom, state, bus, engine, toast, hud, timeline, subtitles, video, snapshot, settingsModal }
 */
export function createPlaybackMenus(app) {
  const { dom, state, engine } = app;
  const { mpvSurface, viewport, controlsHud, engineInfo, btnHudMore, btnSubMenu, subtitlesMenu } = dom;

  // ------------------------------------------------------------------------
  // "⋯" popup menu (drill-down: a submenu re-opens the popup at the same place)
  // ------------------------------------------------------------------------
  const more = createPopupMenu({ id: "hud-more-menu", className: "vho-hud-more" });
  app.shortcuts?.onEscape?.(() => more.close(true));
  let anchor = { x: 0, y: 0 };
  const audioOnly = () => document.documentElement.classList.contains("media-audio-only");

  function openMenu(items) {
    btnHudMore.setAttribute("aria-expanded", "true");
    more.openAt(anchor.x, anchor.y, items, {
      shortcutKeys: (id) => app.shortcuts?.keysOf(id) ?? [],
      onClosed: () => btnHudMore.setAttribute("aria-expanded", "false"),
    });
    // open upwards from the button
    const r = more.element.getBoundingClientRect();
    more.element.style.top = `${Math.max(4, anchor.y - r.height - 8)}px`;
  }
  const sub = (items) => () => setTimeout(() => openMenu([{ id: "back", label: "‹ Geri", run: sub(rootItems()) }, { separator: true }, ...items]), 0);
  const check = (on) => (on ? "✓ " : "    ");

  function rootItems() {
    const items = [];
    if (tracks.audio.length > 1) {
      const sel = tracks.audio.find((t) => t.selected);
      items.push({ id: "audio-tracks", label: `Ses kanalı: ${sel ? sel.label : "—"} ›`, run: sub(audioTrackItems()) });
    }
    if (chapters.length) items.push({ id: "chapters", label: `Bölümler (${chapters.length}) ›`, run: sub(chapterItems()) });
    items.push({ id: "bookmarks", label: `Yer imleri${bookmarks.length ? ` (${bookmarks.length})` : ""} ›`, run: sub(bookmarkItems()) });
    items.push({ id: "speed", label: `Oynatma hızı: ${engine.rate}x ›`, run: sub(speedItems()) });
    const loop = app.timeline.loop;
    items.push({
      id: "ab-loop", label: loop.a === null ? "A-B döngü: A noktası" : loop.b === null ? "A-B döngü: B noktası" : "A-B döngüyü kapat",
      run: () => dom.btnAbLoop.click(),
    });
    if (!audioOnly()) {
      items.push(
        { separator: true },
        { id: "aspect", label: `En-boy oranı ›`, run: sub(aspectItems()) },
        { id: "view", label: "Görüntü: döndür, yansıt, yakınlaştır ›", run: sub(viewItems()) },
        { id: "snapshot", label: "Ekran görüntüsü", shortcut: "snapshot", run: () => app.snapshot.capture() },
      );
      if (engine.caps.pip) items.push({ id: "pip", label: "Resim içinde resim", shortcut: "pip", run: () => app.video.clickPip() });
    }
    items.push({ separator: true });
    if (!audioOnly()) items.push({ id: "video-settings", label: "Görüntü ayarları…", run: () => dom.btnToggleEffects.click() });
    items.push(
      { id: "audio-settings", label: "Ses ayarları (ekolayzır, gecikme)…", run: () => dom.btnToggleAudioPanel.click() },
      { id: "settings", label: "Ayarlar…", shortcut: "settings", run: () => app.settingsModal?.open() },
    );
    return items;
  }

  btnHudMore.addEventListener("click", (e) => {
    e.stopPropagation();
    if (more.isOpen) { more.close(); return; }
    const r = btnHudMore.getBoundingClientRect();
    anchor = { x: r.right - 240, y: r.top };
    openMenu(rootItems());
  });

  /** Opens a "⋯" path, e.g. open("chapters") (tests / other modules). */
  function openPath(id) {
    const r = btnHudMore.getBoundingClientRect();
    anchor = { x: r.right - 240, y: r.top };
    const root = rootItems();
    const hit = root.find((i) => i.id === id);
    if (hit) hit.run(); else openMenu(root);
  }

  // Compact CC menu (subtitle tracks, load / search / remove)
  btnSubMenu?.addEventListener("click", (e) => {
    e.stopPropagation();
    more.close();
    subtitlesMenu.classList.toggle("show");
  });

  // ------------------------------------------------------------------------
  // Audio / subtitle tracks, audio-only layout
  // ------------------------------------------------------------------------
  let tracks = { audio: [], sub: [], video: [] };
  let mediaName = "";
  function syncLayout() {
    const isAudio = state.get("currentMediaType") === "video" &&
      isAudioOnlyMedia(mediaName, engine.kind === "mpv" && tracks.audio.length ? tracks : null);
    document.documentElement.classList.toggle("media-audio-only", isAudio);
  }

  const audioTrackItems = () => tracks.audio.map((t) => ({
    id: `audio:${t.id}`, label: check(t.selected) + t.label,
    run: () => {
      engine.selectTrack("audio", t.id).catch((e) => console.warn("aid", e));
      app.toast(`Ses kanalı: ${t.label}`);
    },
  }));

  engine.on("tracks", (t) => {
    tracks = t;
    app.subtitles.setNativeTracks(t.sub);
    syncLayout();
  });

  // ------------------------------------------------------------------------
  // Chapters
  // ------------------------------------------------------------------------
  let chapters = [];
  let currentChapter = -1;
  const chapterItems = () => chapters.map((c) => ({
    id: `chapter:${c.index}`, label: `${check(c.index === currentChapter)}${formatTime(c.time)}  ${c.title}`,
    run: () => jumpToChapter(c.index),
  }));

  function jumpToChapter(index) {
    const c = chapters.find((x) => x.index === index);
    if (!c) return;
    engine.setChapter(index);
    app.toast(`${c.title} (${formatTime(c.time)})`);
    app.hud.poke();
  }

  engine.on("chapters", (list) => {
    chapters = list;
    currentChapter = chapterAt(chapters, engine.time);
    app.timeline.setMarkers("chapter", chapters);
  });
  engine.on("chapter", (i) => { currentChapter = i; });

  // ------------------------------------------------------------------------
  // Bookmarks (per file, markers on the timeline)
  // ------------------------------------------------------------------------
  let bookmarks = [];
  const bmKey = () => bookmarkKey(state.get("currentFileKey"));
  const renderBookmarks = () =>
    app.timeline.setMarkers("bookmark", bookmarks.map((b, i) => ({ time: b.time, title: b.label || `Yer imi ${i + 1}` })));

  function bookmarkItems() {
    return [
      { id: "bookmark-add", label: "+ Yer imi ekle", shortcut: "bookmarkAdd", run: () => addCurrentBookmark() },
      ...bookmarks.map((b, i) => ({
        id: `bookmark:${i}`, label: `${formatTime(b.time)}  ${b.label || `Yer imi ${i + 1}`}`,
        run: () => { engine.seek(b.time); app.hud.poke(); },
      })),
      ...(bookmarks.length ? [{ separator: true }, { id: "bookmark-clear", label: "Yer imlerini sil", run: () => clearBookmarks() }] : []),
    ];
  }

  function addCurrentBookmark() {
    if (state.get("currentMediaType") !== "video" || !bmKey()) return;
    const before = bookmarks.length;
    bookmarks = addBookmark(bookmarks, engine.time);
    if (bookmarks.length === before) {
      app.toast("Bu noktada zaten bir yer imi var");
      return;
    }
    saveJson(bmKey(), bookmarks);
    renderBookmarks();
    app.toast(`Yer imi eklendi: ${formatTime(engine.time)}`);
  }

  function clearBookmarks() {
    bookmarks = [];
    saveJson(bmKey(), bookmarks);
    renderBookmarks();
    app.toast("Yer imleri silindi");
  }

  app.bus.on("media:loading", ({ item, kind }) => {
    tracks = { audio: [], sub: [], video: [] };
    chapters = [];
    currentChapter = -1;
    mediaName = item?.name ?? "";
    if (kind === "video") {
      // the file key is set by the video player right after this event
      queueMicrotask(() => {
        bookmarks = loadJson(bmKey(), []);
        renderBookmarks();
        syncLayout();
      });
    } else {
      queueMicrotask(syncLayout);
    }
  });
  engine.on("duration", () => renderBookmarks());

  // ------------------------------------------------------------------------
  // Speed / aspect (the hidden HUD dropdowns keep their logic and settings bindings)
  // ------------------------------------------------------------------------
  const speedItems = () => SPEEDS.map((s) => ({
    id: `speed:${s}`, label: `${check(Math.abs(engine.rate - s) < 1e-6)}${s}x`,
    run: () => document.querySelector(`#speed-menu [data-speed="${s === 1 ? "1.0" : s === 2 ? "2.0" : s}"]`)?.click(),
  }));
  const aspectItems = () => ASPECTS.map(([value, label]) => ({
    id: `aspect:${value}`, label: check(state.get("currentAspect") === value) + label,
    run: () => document.querySelector(`#aspect-menu [data-aspect="${value}"]`)?.click(),
  }));

  // ------------------------------------------------------------------------
  // Picture: rotate / flip / zoom / pan
  // ------------------------------------------------------------------------
  let view = { ...DEFAULT_VIEW };
  function setView(next, msg) {
    view = { ...view, ...next };
    engine.setView(view);
    if (msg) app.toast(msg);
  }
  const viewItems = () => [
    { id: "view:rotate", label: `↻ 90° döndür (şu an ${view.rotate}°)`, run: () => setView({ rotate: (view.rotate + 90) % 360 }, `Döndürme: ${(view.rotate + 90) % 360}°`) },
    { id: "view:hflip", label: `${check(view.hflip)}Yatay yansıt`, run: () => setView({ hflip: !view.hflip }, view.hflip ? "Yatay yansıtma kapalı" : "Yatay yansıtıldı") },
    { id: "view:vflip", label: `${check(view.vflip)}Dikey yansıt`, run: () => setView({ vflip: !view.vflip }, view.vflip ? "Dikey yansıtma kapalı" : "Dikey yansıtıldı") },
    { id: "view:zoom-in", label: "+ Yakınlaştır", keyHint: "Ctrl+tekerlek", run: () => setView({ zoom: nextZoom(view.zoom, -1, 0.25) }, "Yakınlaştırıldı") },
    { id: "view:zoom-out", label: "− Uzaklaştır", run: () => setView({ zoom: nextZoom(view.zoom, 1, 0.25), ...(view.zoom <= 0.25 ? { panX: 0, panY: 0 } : {}) }, "Uzaklaştırıldı") },
    { id: "view:reset", label: "⟲ Görüntüyü sıfırla", run: () => setView({ ...DEFAULT_VIEW }, "Görüntü sıfırlandı") },
  ];

  // Ctrl + wheel over the picture: zoom; Ctrl + drag: pan while zoomed
  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || state.get("currentMediaType") !== "video" || audioOnly()) return;
    e.preventDefault();
    const zoom = nextZoom(view.zoom, e.deltaY);
    setView(zoom === 0 ? { zoom, panX: 0, panY: 0 } : { zoom });
    app.hud.poke();
  }, { passive: false });

  let drag = null;
  for (const surface of [mpvSurface, dom.video]) {
    surface?.addEventListener("mousedown", (e) => {
      if (!e.ctrlKey || view.zoom <= 0) return;
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, w: surface.clientWidth, h: surface.clientHeight };
    });
  }
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const s = 2 ** view.zoom;
    const clampPan = (v) => Math.max(-1, Math.min(1, v));
    setView({
      panX: clampPan(drag.panX + (e.clientX - drag.x) / (drag.w * s)),
      panY: clampPan(drag.panY + (e.clientY - drag.y) / (drag.h * s)),
    });
  });
  window.addEventListener("mouseup", () => { drag = null; });

  // ------------------------------------------------------------------------
  // libmpv geometry: video inside the viewport (not under the titlebar) and
  // subtitles above the HUD while it is visible
  // ------------------------------------------------------------------------
  let lastMargins = "";
  function syncGeometry() {
    if (engine.kind !== "mpv") return;
    const r = viewport.getBoundingClientRect();
    const W = window.innerWidth || 1, H = window.innerHeight || 1;
    const m = {
      "video-margin-ratio-top": +(r.top / H).toFixed(4),
      "video-margin-ratio-left": +(r.left / W).toFixed(4),
      "video-margin-ratio-right": +(Math.max(0, W - r.right) / W).toFixed(4),
      "video-margin-ratio-bottom": +(Math.max(0, H - r.bottom) / H).toFixed(4),
    };
    const key = JSON.stringify(m);
    if (key === lastMargins) return;
    lastMargins = key;
    for (const [k, v] of Object.entries(m)) engine.set(k, v).catch(() => {});
  }
  new ResizeObserver(syncGeometry).observe(viewport);

  let hudVisible = true;
  let lastSubMargin = null;
  function syncSubMargin() {
    if (engine.kind !== "mpv") return;
    const visible = hudVisible && controlsHud.style.display !== "none";
    const margin = subMarginFor(visible, controlsHud.offsetHeight + 24, viewport.clientHeight);
    if (margin === lastSubMargin) return;
    lastSubMargin = margin;
    engine.set("sub-margin-y", margin).catch(() => {});
  }
  app.bus.on("hud:visibility", ({ visible }) => {
    hudVisible = visible;
    syncSubMargin();
  });

  // ------------------------------------------------------------------------
  // Engine info (options: Settings > Gelişmiş, media/engine-settings.js)
  // ------------------------------------------------------------------------
  const status = app.engineStatus ?? {};
  function renderEngineInfo() {
    if (engine.kind === "mpv") {
      const gpu = status.gpu?.name ? ` · GPU: ${status.gpu.name}` : "";
      engineInfo.textContent = `libmpv (${status.mpvVersion ?? "?"}, FFmpeg ${status.ffmpegVersion ?? "?"})${gpu}`;
    } else {
      engineInfo.textContent = status.available
        ? "HTML5 <video> (bu öğe için: tarayıcı dosyası)"
        : `HTML5 <video> yedek motoru${status.error ? ` — libmpv yok: ${status.error}` : ""}`;
    }
  }

  app.bus.on("engine:changed", () => {
    lastMargins = "";
    lastSubMargin = null;
    renderEngineInfo();
    syncGeometry();
    syncSubMargin();
  });
  renderEngineInfo();

  return {
    /** Closes the "⋯" popup (other dropdowns are closed by their owners). */
    closeAll: () => more.close(),
    open: openPath,
    addBookmark: addCurrentBookmark,
    jumpToChapter,
    get view() { return { ...view }; },
    /** New media: the picture view applies to the new file too. */
    reapply: () => engine.setView(view),
    get bookmarks() { return bookmarks; },
  };
}
