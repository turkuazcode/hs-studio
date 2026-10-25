// ==========================================================================
// Media loader: every way of opening media (dialog, drop, file inputs,
// command line, playlist add) ends up in openEntries(). Also owns the
// ObjectURL of browser File sources and source URL resolution.
// ==========================================================================

import { appWindow, convertFileSrc, dialogOpen, invoke } from "../core/tauri.js";
import { classify, DIALOG_FILTERS } from "./classify.js";
import { t } from "../core/i18n.js";

/**
 * Splits dropped/picked entries into media and subtitles.
 * Returns { media, subs, rejected } where rejected counts unsupported entries.
 */
export function partitionEntries(entries) {
  const subs = entries.filter(f => classify(f) === "sub");
  const media = entries.filter(f => ["video", "image"].includes(classify(f)));
  return { media, subs, rejected: entries.length - subs.length - media.length };
}

/** Browser File -> { file, name, isImage }, backend entry -> { path, name, size, isImage }. */
export function toPlaylistItem(f, isFile = typeof File !== "undefined" && f instanceof File) {
  const isImage = classify(f) === "image";
  return isFile
    ? { file: f, name: f.name, isImage }
    : { path: f.path, name: f.name, size: f.size, isImage };
}

/**
 * app: { dom, state, bus, toast, video, photo, playlist, subtitles }  (resolved lazily)
 */
export function createLoader(app) {
  const { dom, state } = app;
  const { fileInput, playlistFileInput, btnBrowse, playlistDrawer } = dom;

  let activeObjectUrl = null;

  function acquireObjectUrl(file) {
    releaseObjectUrl();
    activeObjectUrl = URL.createObjectURL(file);
    return activeObjectUrl;
  }

  function releaseObjectUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  /** URL the <video>/<img> element should load for a playlist item. */
  function resolveSource(item) {
    if (item.file) return acquireObjectUrl(item.file);
    releaseObjectUrl();
    if (item.path) return convertFileSrc(item.playPath || item.path);
    return item.url;
  }

  // Master unified media source loader (video or image)
  function loadMediaSource(item) {
    app.video.cancelTranscode();
    app.bus.emit("media:loading", { item, kind: item.isImage ? "image" : "video" });
    if (item.isImage) {
      app.photo.load(item);
    } else {
      app.video.load(item);
    }
  }

  /**
   * All entry points (dialog, drop, file input, playlist add) go through here.
   * entries: File objects (browser) or { path, name, size } from the backend.
   */
  async function openEntries(entries, { playFirstNew = true } = {}) {
    const { media, subs, rejected } = partitionEntries(entries);
    if (rejected > 0) app.toast(t("ui.loader.skipped", { n: rejected }));

    if (media.length) {
      const firstNewIndex = app.playlist.append(media.map((f) => toPlaylistItem(f)));
      if (playFirstNew || state.get("currentPlaylistIndex") === -1) app.playlist.play(firstNewIndex);
      else app.playlist.render();
      if (media.length > 1) playlistDrawer.classList.add("open");
    }
    // Apply the subtitle AFTER the media load reset subtitles (guaranteed order)
    if (subs.length) await app.subtitles.load(subs[0].path ?? subs[0]);
  }

  const openFiles = (fileList, opts) => openEntries(Array.from(fileList ?? []), opts);

  /** Local paths (Tauri): register them with the asset protocol, then open. */
  async function openPaths(paths, opts) {
    if (!paths?.length) return;
    try {
      openEntries(await invoke("prepare_media", { paths }), opts);
    } catch (e) {
      console.error("prepare_media", e);
      app.toast(t("ui.loader.openFailed"));

    }
  }

  /** Native file picker in the app (gives real paths), <input type=file> in a browser. */
  async function pickFiles(fallbackInput, opts) {
    if (!dialogOpen) {
      fallbackInput.click();
      return;
    }
    try {
      const picked = await dialogOpen({ multiple: true, filters: DIALOG_FILTERS });
      openPaths(Array.isArray(picked) ? picked : picked ? [picked] : [], opts);
    } catch (e) {
      console.error("dialog.open", e);
      fallbackInput.click();
    }
  }

  /** Network URL from the URL modal: added to the playlist so index/auto-advance stay consistent. */
  function openUrlItem(item) {
    const index = app.playlist.append([item]);
    app.playlist.play(index);
  }

  // ------------------------------------------------------------------------
  // Drag and drop (multiple files + photos + subtitles)
  // ------------------------------------------------------------------------
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add("is-dragging");
  });

  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove("is-dragging");
    }
  });

  window.addEventListener("dragover", (e) => e.preventDefault());

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("is-dragging");
    openFiles(e.dataTransfer?.files);
  });

  // In the app, the OS file drop is handled natively by Tauri (gives real paths)
  appWindow?.onDragDropEvent?.((e) => {
    const { type, paths } = e.payload;
    if (type === "enter" || type === "over") {
      document.body.classList.add("is-dragging");
    } else {
      document.body.classList.remove("is-dragging");
      if (type === "drop") openPaths(paths);
    }
  }).catch?.((err) => console.warn("onDragDropEvent", err));

  // File browse
  btnBrowse.addEventListener("click", () => pickFiles(fileInput));
  fileInput.addEventListener("change", (e) => {
    openFiles(e.target.files);
    e.target.value = "";
  });

  playlistFileInput.addEventListener("change", (e) => {
    openFiles(e.target.files, { playFirstNew: false });
    e.target.value = "";
  });

  return {
    resolveSource,
    loadMediaSource,
    openEntries,
    openFiles,
    openPaths,
    pickFiles,
    openUrlItem,
    releaseObjectUrl,
  };
}
