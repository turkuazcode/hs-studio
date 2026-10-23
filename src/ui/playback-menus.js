// ==========================================================================
// Playback menus that came with the libmpv engine (Plan 02 §3):
// audio track menu, subtitle track list (via the subtitles module), chapters
// (menu + timeline markers), per-file bookmarks, picture menu (rotate / flip /
// zoom, Ctrl+wheel zoom, Ctrl+drag pan), HUD-aware subtitle margin, engine info
// and advanced engine settings (hwdec, profile=fast).
// Everything goes through the engine facade (app.engine).
// ==========================================================================

import { formatTime } from "../core/format.js";
import { loadJson, saveJson } from "../core/storage.js";
import {
  DEFAULT_VIEW, addBookmark, chapterAt, nextZoom, removeBookmark, subMarginFor,
} from "../media/engine/engine.js";

/** Bookmark storage key for the current file (same identity as the resume position). */
export const bookmarkKey = (fileKey) => (fileKey ? `vho_bm_${fileKey}` : "");

/** Profile "fast" values and their gpu-next defaults (restored when switched off). */
const FAST_PROPS = ["scale", "dscale", "cscale", "dither", "correct-downscaling", "linear-downscaling", "sigmoid-upscaling", "hdr-compute-peak"];

/**
 * app: { dom, state, bus, engine, toast, hud, timeline, subtitles, video, menus }
 */
export function createPlaybackMenus(app) {
  const { dom, state, engine } = app;
  const {
    audioTrackContainer, btnAudioTracks, audioTrackLabel, audioTrackMenu, chaptersContainer, btnChapters,
    chapterLabel, chaptersMenu, btnBookmarks, bookmarksMenu, bookmarkAdd, bookmarkList, btnViewMenu, viewMenu,
    mpvSurface, viewport, controlsHud, engineInfo, selectHwdec, checkFastProfile,
  } = dom;

  // ------------------------------------------------------------------------
  // Dropdown bookkeeping: one menu open at a time
  // ------------------------------------------------------------------------
  const menus = [audioTrackMenu, chaptersMenu, bookmarksMenu, viewMenu];
  function closeAll(except = null) {
    for (const m of menus) if (m !== except) m.classList.remove("show");
    for (const id of ["speed-menu", "aspect-menu", "subtitles-menu"]) {
      const m = document.getElementById(id);
      if (m && m !== except && except) m.classList.remove("show");
    }
  }
  function toggleMenu(btn, menu) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("show");
      closeAll(menu);
      menu.classList.toggle("show", open);
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
  }
  toggleMenu(btnAudioTracks, audioTrackMenu);
  toggleMenu(btnChapters, chaptersMenu);
  toggleMenu(btnBookmarks, bookmarksMenu);
  toggleMenu(btnViewMenu, viewMenu);

  const menuItem = (text, active, onClick) => {
    const el = document.createElement("div");
    el.className = "dropdown-item" + (active ? " active" : "");
    el.textContent = text;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return el;
  };

  // ------------------------------------------------------------------------
  // Audio / subtitle tracks
  // ------------------------------------------------------------------------
  let tracks = { audio: [], sub: [], video: [] };
  function renderAudioTracks() {
    const list = tracks.audio;
    audioTrackContainer.hidden = list.length < 2;
    const sel = list.find((t) => t.selected);
    audioTrackLabel.textContent = sel ? `Ses: ${sel.lang ? sel.lang.toUpperCase() : sel.id}` : "Ses";
    audioTrackMenu.replaceChildren(...list.map((t) => {
      const el = menuItem(t.label, t.selected, () => {
        audioTrackMenu.classList.remove("show");
        engine.selectTrack("audio", t.id).catch((e) => console.warn("aid", e));
        app.toast(`Ses kanalı: ${t.label}`);
      });
      el.dataset.aid = t.id;
      return el;
    }));
  }

  engine.on("tracks", (t) => {
    tracks = t;
    renderAudioTracks();
    app.subtitles.setNativeTracks(t.sub);
  });

  // ------------------------------------------------------------------------
  // Chapters
  // ------------------------------------------------------------------------
  let chapters = [];
  let currentChapter = -1;
  function renderChapters() {
    chaptersContainer.hidden = !chapters.length;
    chapterLabel.textContent = currentChapter >= 0 && chapters.length
      ? `Bölüm ${currentChapter + 1}/${chapters.length}` : "Bölümler";
    chaptersMenu.replaceChildren(...chapters.map((c) => {
      const el = menuItem(`${formatTime(c.time)}  ${c.title}`, c.index === currentChapter, () => {
        chaptersMenu.classList.remove("show");
        jumpToChapter(c.index);
      });
      el.dataset.chapter = c.index;
      return el;
    }));
  }

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
    renderChapters();
  });
  engine.on("chapter", (i) => {
    if (i === currentChapter) return;
    currentChapter = i;
    renderChapters();
  });

  // ------------------------------------------------------------------------
  // Bookmarks (per file, localStorage, markers on the timeline)
  // ------------------------------------------------------------------------
  let bookmarks = [];
  const bmKey = () => bookmarkKey(state.get("currentFileKey"));

  function renderBookmarks() {
    app.timeline.setMarkers("bookmark", bookmarks.map((b, i) => ({ time: b.time, title: b.label || `Yer imi ${i + 1}` })));
    bookmarkList.replaceChildren(...bookmarks.map((b, i) => {
      const el = menuItem(`${formatTime(b.time)}  ${b.label || `Yer imi ${i + 1}`}`, false, () => {
        bookmarksMenu.classList.remove("show");
        engine.seek(b.time);
        app.hud.poke();
      });
      el.classList.add("bookmark-item");
      el.dataset.time = b.time;
      const del = document.createElement("span");
      del.className = "bookmark-del";
      del.textContent = "✕";
      del.title = "Sil";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        bookmarks = removeBookmark(bookmarks, i);
        saveJson(bmKey(), bookmarks);
        renderBookmarks();
      });
      el.append(del);
      return el;
    }));
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

  bookmarkAdd.addEventListener("click", (e) => {
    e.stopPropagation();
    bookmarksMenu.classList.remove("show");
    addCurrentBookmark();
  });

  app.bus.on("media:loading", ({ kind }) => {
    tracks = { audio: [], sub: [], video: [] };
    chapters = [];
    currentChapter = -1;
    renderAudioTracks();
    renderChapters();
    if (kind === "video") {
      // the file key is set by the video player right after this event
      queueMicrotask(() => {
        bookmarks = loadJson(bmKey(), []);
        renderBookmarks();
      });
    }
  });
  engine.on("duration", () => renderBookmarks());

  // ------------------------------------------------------------------------
  // Picture: rotate / flip / zoom / pan
  // ------------------------------------------------------------------------
  let view = { ...DEFAULT_VIEW };
  function setView(next, msg) {
    view = { ...view, ...next };
    engine.setView(view);
    if (msg) app.toast(msg);
  }

  viewMenu.querySelectorAll("[data-view]").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      viewMenu.classList.remove("show");
      switch (item.dataset.view) {
        case "rotate": setView({ rotate: (view.rotate + 90) % 360 }, `Döndürme: ${(view.rotate + 90) % 360}°`); break;
        case "hflip": setView({ hflip: !view.hflip }, view.hflip ? "Yatay yansıtma kapalı" : "Yatay yansıtıldı"); break;
        case "vflip": setView({ vflip: !view.vflip }, view.vflip ? "Dikey yansıtma kapalı" : "Dikey yansıtıldı"); break;
        case "zoom-in": setView({ zoom: nextZoom(view.zoom, -1, 0.25) }, "Yakınlaştırıldı"); break;
        case "zoom-out": setView({ zoom: nextZoom(view.zoom, 1, 0.25), ...(view.zoom <= 0.25 ? { panX: 0, panY: 0 } : {}) }, "Uzaklaştırıldı"); break;
        default: setView({ ...DEFAULT_VIEW }, "Görüntü sıfırlandı");
      }
    });
  });

  // Ctrl + wheel over the picture: zoom; Ctrl + drag: pan while zoomed
  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey || state.get("currentMediaType") !== "video") return;
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
  // Engine info + advanced settings
  // ------------------------------------------------------------------------
  const status = app.engineStatus ?? {};
  const fastDefault = !!status.gpu?.integrated;
  let fastDefaults = null; // gpu-next values before profile=fast (to switch it off again)

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

  async function applyAdvanced() {
    if (engine.kind !== "mpv") return;
    engine.set("hwdec", selectHwdec.value).catch(() => {});
    const want = checkFastProfile.checked;
    if (want === !!applyAdvanced.fastOn) return;
    if (want) {
      engine.impl.command(["apply-profile", "fast"]).catch(() => {});
    } else if (fastDefaults) {
      for (const [k, v] of Object.entries(fastDefaults)) engine.set(k, v).catch(() => {});
    } else {
      // started with profile=fast (integrated GPU): gpu-next defaults
      const defaults = { scale: "lanczos", dscale: "hermite", cscale: "lanczos", dither: "fruit",
        "correct-downscaling": true, "linear-downscaling": true, "sigmoid-upscaling": true, "hdr-compute-peak": "auto" };
      for (const [k, v] of Object.entries(defaults)) engine.set(k, v).catch(() => {});
    }
    applyAdvanced.fastOn = want;
  }

  if (status.available) {
    selectHwdec.value = loadJson("vho_hwdec", "auto-safe");
    checkFastProfile.checked = loadJson("vho_fast_profile", fastDefault);
    applyAdvanced.fastOn = fastDefault; // the backend starts mpv with profile=fast on integrated GPUs
    if (!fastDefault) {
      Promise.all(FAST_PROPS.map((k) => app.engines.mpv.get(k).then((v) => [k, v]).catch(() => null)))
        .then((pairs) => { fastDefaults = Object.fromEntries(pairs.filter(Boolean)); });
    }
    selectHwdec.addEventListener("change", () => {
      saveJson("vho_hwdec", selectHwdec.value);
      applyAdvanced();
      app.toast(selectHwdec.value === "no" ? "Donanım ile çözme kapalı" : "Donanım ile çözme otomatik");
    });
    checkFastProfile.addEventListener("change", () => {
      saveJson("vho_fast_profile", checkFastProfile.checked);
      applyAdvanced();
    });
  }

  app.bus.on("engine:changed", () => {
    lastMargins = "";
    lastSubMargin = null;
    renderEngineInfo();
    syncGeometry();
    syncSubMargin();
    applyAdvanced();
  });
  renderEngineInfo();

  // K adds a bookmark; "." / "," step frames (registered in ui/shortcuts.js)
  return {
    closeAll,
    addBookmark: addCurrentBookmark,
    jumpToChapter,
    get view() { return { ...view }; },
    /** New media: the picture view applies to the new file too. */
    reapply: () => engine.setView(view),
    get bookmarks() { return bookmarks; },
  };
}
