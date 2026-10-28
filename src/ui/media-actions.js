// ==========================================================================
// Media actions (Plan 06): one slim toolbar per media type in the titlebar
//   Photo: Edit · Delete · Print · Share · ⋯      Video: Cut · Save frame · Convert · Share · ⋯
//   Music: Tags · Lyrics · Share · ⋯
// Everything else lives in the "⋯" menu and the right-click menu (ui/menus.js asks
// contextItems()); options are in the Settings window (registerSettings); shortcuts go
// into the central table (ACTION_SHORTCUTS). UI principles: docs/plans/00-YOL-HARITASI.md.
//
// Common: delete (recycle bin, confirm), rename (F2, conflict check), show in folder, open
// with, copy file / path, share, properties, favorite, add to playlist.
// Photo: copy image, print preview, desktop background / lock screen, OCR (ui/photo-tools.js).
// Video: frame save / copy, cut, GIF, clip, convert, extract audio, rotate, subtitles, contact
// sheet (ui/export-dialogs.js), always on top, mini player.
// Music: tags + cover, lyrics, audio convert, ReplayGain, ringtone (ui/music-tools.js).
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { appWindow, invoke } from "../core/tauri.js";
import {
  ACTION_SHORTCUTS, basename, errorCode, errorText, formatBytes, mediaKind, renamedItem, splitName, toggleFavorite,
  validateFileName,
} from "../media/actions-logic.js";
import { resumeKey } from "../media/video-player.js";
import { createDialogs, h } from "./action-dialogs.js";
import { createExportDialogs } from "./export-dialogs.js";
import { createPopupMenu } from "./menus.js";
import { createMusicTools } from "./music-tools.js";
import { createPhotoTools } from "./photo-tools.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICONS = {
  edit: '<path d="M13.6 2.6a2 2 0 012.8 2.8l-9 9L4 15l.6-3.4 9-9zM3 17h14v1.5H3z"/>',
  delete: '<path d="M7 2h6l1 2h4v2H2V4h4l1-2zm-3 5h12l-1 11H5L4 7zm4 2v7h1.5V9H8zm2.5 0v7H12V9h-1.5z"/>',
  print: '<path d="M5 2h10v4H5V2zM3 7h14a2 2 0 012 2v5h-3v4H4v-4H1V9a2 2 0 012-2zm3 6v3.5h8V13H6z"/>',
  share: '<path d="M14 2a3 3 0 11-2.8 4.1L7.9 8a3 3 0 010 2l3.3 1.9A3 3 0 1114 16a3 3 0 01.1-.9l-3.4-1.9a3 3 0 110-4.4l3.4-1.9A3 3 0 0114 2z"/>',
  cut: '<path d="M5 3a3 3 0 012.8 4l2.2 1.6L16.5 4l1.5 1.2-6.3 4.8 6.3 4.8-1.5 1.2L10 11.4 7.8 13A3 3 0 115 11a3 3 0 011.4.3L8.3 10 6.4 8.7A3 3 0 115 3zm0 1.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm0 8a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/>',
  frame: '<path d="M4 4h3l1.5-2h3L13 4h3a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm6 3a3.5 3.5 0 100 7 3.5 3.5 0 000-7z"/>',
  convert: '<path d="M4 6h9l-2.5-2.5L12 2l5 5-5 5-1.5-1.5L13 8H4V6zm12 8H7l2.5 2.5L8 18l-5-5 5-5 1.5 1.5L7 12h9v2z"/>',
  tags: '<path d="M2 3a1 1 0 011-1h6l9 9-7 7-9-9V3zm4 1.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/>',
  lyrics: '<path d="M3 4h10v2H3V4zm0 4h10v2H3V8zm0 4h6v2H3v-2zm12-8h3v2h-1.5v8.5a2.5 2.5 0 11-1.5-2.3V4z"/>',
};
const icon = (name) => `<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;

/**
 * Titlebar buttons per media type, then "⋯" (approved layout 2026-10-28: at most two buttons
 * in the titlebar; the playlist / queue button is the other one, ui/mode-layout.js). The former
 * toolbar actions open the "⋯" menu (moreItems).
 */
export const TOOLBAR = Object.freeze({
  photo: [["editPhoto", "edit"]],
  video: [],
  music: [],
});

/**
 * app: the full app context (main.js): dom, state, bus, engine, loader, playlist, photo, video,
 * snapshot, timeline, settings, library, resume, shortcuts, toast, settingsModal, studio...
 */
export function createMediaActions(app) {
  const { dom, state } = app;
  app.dialogs = createDialogs(app);
  const { dialogs } = app;
  let caps = { wallpaper: true, lockScreen: true, share: true, openWith: true, ocr: true, print: true, ffmpeg: true };
  invoke?.("actions_capabilities").then((c) => { caps = c; render(); }).catch(() => {});

  /** The shown media: { item, kind: "photo" | "video" | "music" | "none" }. */
  function current() {
    const item = state.get("playlist")[state.get("currentPlaylistIndex")];
    if (!item || state.get("currentMediaType") === "none") return { item: null, kind: "none" };
    return { item, kind: mediaKind(item, { audioOnly: document.documentElement.classList.contains("media-audio-only") }) };
  }
  const local = () => !!current().item?.path;

  // ------------------------------------------------------------------------
  // Releasing the file (mpv keeps it open: rename / delete / tag writes need it closed)
  // ------------------------------------------------------------------------
  function reloadAt(index, time, paused) {
    const off = app.engine.on("loaded", () => {
      off();
      if (time > 0.5) app.engine.seek(time);
      if (paused) app.engine.pause();
    });
    app.playlist.play(index);
  }

  /** Runs fn with the current video/music file closed, then reopens it at the same position. */
  async function withReleased(fn) {
    const { kind } = current();
    if (kind !== "video" && kind !== "music") return fn();
    const index = state.get("currentPlaylistIndex");
    const time = app.engine.time, paused = app.engine.paused;
    await Promise.resolve(app.engine.unload()).catch(() => {});
    await sleep(150);
    try {
      return await fn();
    } finally {
      if (state.get("currentPlaylistIndex") === index) reloadAt(index, time, paused);
    }
  }

  /** Empty screen (last item deleted). */
  function closeMedia() {
    app.photo.toggleSlideshow?.(false, { silent: true });
    app.video.unloadElements();
    app.photo.unload();
    app.photo.hideUi();
    state.set("currentPlaylistIndex", -1);
    state.set("currentMediaType", "none");
    document.documentElement.classList.remove("media-audio-only");
    if (dom.controlsHud) dom.controlsHud.style.display = "none";
    dom.dropZone?.classList.add("visible");
    if (dom.currentFilename) {
      dom.currentFilename.dataset.i18n = "actions.common.noMedia";
      dom.currentFilename.textContent = t("actions.common.noMedia");
    }
    app.playlist.render();
    render();
  }

  // ------------------------------------------------------------------------
  // Common actions
  // ------------------------------------------------------------------------
  async function deletePaths(paths, { confirmName } = {}) {
    if (!paths.length) return false;
    if (app.settings?.get("actions.confirmDelete") !== false) {
      const ok = await dialogs.confirm({
        id: "vho-delete", title: t("actions.delete.title"), danger: true, confirmLabel: t("actions.delete.confirm"),
        message: paths.length === 1 ? t("actions.delete.message", { name: confirmName ?? basename(paths[0]) }) : t("actions.delete.messageMany", { n: paths.length }),
      });
      if (!ok) return false;
    }
    const cur = current();
    const list = state.get("playlist");
    const curIndex = state.get("currentPlaylistIndex");
    const deletingCurrent = cur.item?.path && paths.includes(cur.item.path);
    if (deletingCurrent && cur.kind !== "photo") {
      await Promise.resolve(app.engine.unload()).catch(() => {});
      await sleep(150);
    }
    const failed = [];
    for (const p of paths) {
      try {
        await invoke("file_trash", { path: p });
        app.library?.recent?.remove?.(p);
        app.bus.emit("file:deleted", { path: p });
      } catch (e) {
        failed.push(`${basename(p)}: ${errorText(e, t)}`);
      }
    }
    const deleted = paths.filter((p) => !failed.some((f) => f.startsWith(`${basename(p)}:`)));
    // playlist: removed in place (photo studio sessions keep their list identity)
    let index = curIndex;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].path && deleted.includes(list[i].path)) {
        list.splice(i, 1);
        if (i < index) index--;
      }
    }
    if (failed.length) app.toast(`⚠️ ${failed[0]}`);
    else app.toast(deleted.length === 1 ? t("actions.toast.deleted", { name: basename(deleted[0]) }) : t("actions.toast.deletedMany", { n: deleted.length }));
    if (deletingCurrent && deleted.includes(cur.item.path)) {
      if (list.length) app.playlist.play(Math.min(Math.max(0, index), list.length - 1));
      else closeMedia();
    } else {
      if (deletingCurrent) reloadAt(curIndex, 0, false); // failed: reopen
      state.set("currentPlaylistIndex", Math.min(index, list.length - 1));
      app.playlist.render();
    }
    return !failed.length;
  }

  const deleteCurrent = () => {
    const { item } = current();
    return item?.path ? deletePaths([item.path], { confirmName: item.name }) : false;
  };

  async function renameCurrent() {
    const { item, kind } = current();
    if (!item?.path) return;
    const name = await dialogs.prompt({
      id: "vho-rename", title: t("actions.rename.title"), label: t("actions.rename.label"), value: item.name,
      selection: [0, splitName(item.name).stem.length], okLabel: t("actions.rename.ok"),
      validate: (v) => { const c = validateFileName(v); return c ? t(`actions.rename.errors.${c}`) : null; },
    });
    if (!name || name === item.name) return;
    const oldPath = item.path, oldKey = resumeKey(item);
    try {
      await (kind === "photo" ? (f) => f() : withReleased)(async () => {
        const newPath = await invoke("file_rename", { path: oldPath, newName: name });
        const list = state.get("playlist");
        const i = list.indexOf(item);
        const next = renamedItem(item, newPath);
        if (i >= 0) list[i] = next;
        // recent entry, favorite, resume position and bookmarks follow the file (L02)
        if (app.library?.applyMove) app.library.applyMove({ oldPath, newPath, oldKey, newKey: resumeKey(next) });
        else {
          app.library?.recent?.update?.(oldPath, { id: newPath, path: newPath, name: next.name });
          const pos = app.resume?.get?.(oldKey);
          if (pos) { app.resume.set(resumeKey(next), pos); app.resume.remove(oldKey); }
        }
        app.bus.emit("file:renamed", { path: oldPath, newPath });
        if (dom.currentFilename && kind === "photo") {
          delete dom.currentFilename.dataset.i18n;
          dom.currentFilename.textContent = next.name;
        }

        app.playlist.render();
        app.toast(t("actions.toast.renamed", { name: next.name }));
      });
    } catch (e) {
      app.toast(errorCode(e) === "exists" ? `⚠️ ${t("actions.rename.exists", { name })}` : `⚠️ ${errorText(e, t)}`);
    }
  }

  const call = (cmd, args, okKey) => invoke(cmd, args).then((r) => { if (okKey) app.toast(t(okKey)); return r; })
    .catch((e) => { app.toast(`⚠️ ${errorText(e, t)}`); return null; });
  const withPath = (fn) => () => { const { item } = current(); return item?.path ? fn(item) : null; };

  const copyFiles = (paths) => call("clipboard_copy_files", { paths }, paths.length > 1 ? "actions.toast.filesCopied" : "actions.toast.fileCopied");
  const copyPaths = (paths) => call("clipboard_copy_text", { text: paths.join("\r\n") }, "actions.toast.pathCopied");
  const reveal = (path) => call("file_reveal", { path });

  async function share(item) {
    const r = await call("file_share", { path: item.path });
    if (r === "skipped") app.toast(t("actions.toast.systemSkipped"));
  }

  async function copyFrame() {
    try {
      if (app.engine.kind === "mpv") await invoke("clipboard_copy_frame");
      else {
        const v = dom.video;
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        await invoke("clipboard_copy_image_data", { data: c.toDataURL("image/png") });
      }
      app.toast(t("actions.toast.frameCopied"));
    } catch (e) {
      app.toast(`⚠️ ${errorText(e, t)}`);
    }
  }

  // Favorites: library store (library.db, Plan 13/L01). The old "actions.favorites" setting
  // is imported once by the backend and kept untouched as a fallback copy.
  const favorites = () => app.library?.favorites?.list() ?? app.settings?.get("actions.favorites")?.paths ?? [];
  const isFavorite = (path) => favorites().includes(path);
  function toggleFav(item) {
    const r = toggleFavorite(favorites(), item.path);
    if (app.library?.favorites) app.library.favorites.set(r.paths);
    else app.settings?.set("actions.favorites", { paths: r.paths });
    app.toast(t(r.favorite ? "actions.toast.favoriteAdded" : "actions.toast.favoriteRemoved", { name: item.name }));
    render();
  }

  async function properties(item, kind) {
    const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString(i18n.language === "en" ? "en-GB" : "tr-TR") : "");
    const sections = [];
    try {
      const fp = await invoke("file_properties", { path: item.path });
      sections.push({ title: t("actions.props.file"), rows: [
        [t("actions.props.name"), fp.name], [t("actions.props.folder"), fp.folder], [t("actions.props.size"), `${formatBytes(fp.size, i18n.language)} (${fp.size.toLocaleString()} B)`],
        [t("actions.props.modified"), fmtDate(fp.modifiedMs)], [t("actions.props.created"), fmtDate(fp.createdMs)],
      ] });
    } catch (e) {
      app.toast(`⚠️ ${errorText(e, t)}`);
      return;
    }
    if (kind === "photo") {
      const pi = await invoke("photo_info", { path: item.path }).catch(() => null);
      const x = pi?.exif ?? {};
      if (pi) sections.push({ title: t("actions.props.image"), rows: [
        [t("actions.props.resolution"), pi.width ? `${pi.width} × ${pi.height}` : ""], [t("actions.props.format"), pi.format?.toUpperCase()],
        [t("actions.props.camera"), [x.make, x.model].filter(Boolean).join(" ")], [t("actions.props.lens"), x.lens],
        [t("actions.props.taken"), x.dateTaken?.replace("T", " ")],
        [t("actions.props.exposure"), [x.exposureTime && `${x.exposureTime} sn`, x.fNumber && `f/${x.fNumber}`, x.iso && `ISO ${x.iso}`, x.focalLength && `${x.focalLength} mm`].filter(Boolean).join(" · ")],
        [t("actions.props.gps"), x.gps ? `${x.gps.latitude.toFixed(5)}, ${x.gps.longitude.toFixed(5)}` : ""],
      ] });
    } else {
      const mi = await invoke("media_probe", { path: item.path }).catch(() => null);
      if (mi) {
        const v = mi.video, a = mi.audio?.[0];
        const dur = mi.duration ? new Date(mi.duration * 1000).toISOString().slice(mi.duration >= 3600 ? 11 : 14, 19) : "";
        sections.push({ title: t("actions.props.media"), rows: [
          [t("actions.props.duration"), dur], [t("actions.props.container"), mi.format],
          [t("actions.props.bitrate"), mi.bitRate ? `${Math.round(mi.bitRate / 1000)} kb/s` : ""],
          [t("actions.props.video"), v ? `${v.codec.toUpperCase()} · ${v.width} × ${v.height}${v.fps ? ` · ${Math.round(v.fps * 100) / 100} fps` : ""}${v.rotation ? ` · ${v.rotation}°` : ""}` : ""],
          [t("actions.props.audio"), a ? `${a.codec.toUpperCase()} · ${a.channels} ch · ${a.sampleRate} Hz${a.language ? ` · ${a.language}` : ""}` : ""],
          [t("actions.props.audioTracks"), mi.audio?.length > 1 ? String(mi.audio.length) : ""],
          [t("actions.props.subtitles"), mi.subtitles?.length ? mi.subtitles.map((s) => s.language || s.codec).join(", ") : ""],
        ] });
      }
      if (kind === "music") {
        const tg = await invoke("tags_read", { path: item.path }).catch(() => null);
        if (tg) sections.push({ title: t("actions.props.tags"), rows: [
          [t("actions.tags.title"), tg.title], [t("actions.tags.artist"), tg.artist], [t("actions.tags.album"), tg.album],
          [t("actions.tags.year"), tg.year ?? ""], [t("actions.tags.genre"), tg.genre], [t("actions.tags.track"), tg.track ?? ""],
          ["ReplayGain", tg.replaygainTrackGain], [t("actions.props.cover"), tg.cover ? `${tg.cover.mime} · ${formatBytes(tg.cover.size, i18n.language)}` : ""],
        ] });
      }
    }
    dialogs.info({ id: "vho-properties", title: t("actions.props.title", { name: item.name }), sections });
  }

  // ------------------------------------------------------------------------
  // Window: always on top, mini player
  // ------------------------------------------------------------------------
  let onTop = false;
  let mini = null;
  async function setOnTop(v) {
    onTop = v;
    await appWindow?.setAlwaysOnTop?.(v).catch?.((e) => console.warn("always on top", e));
    document.documentElement.classList.toggle("always-on-top", v);
  }
  async function toggleOnTop() {
    await setOnTop(!onTop);
    app.toast(t(onTop ? "actions.toast.onTopOn" : "actions.toast.onTopOff"));
    render();
  }
  async function toggleMini() {
    const w = appWindow;
    const LogicalSize = globalThis.window?.__TAURI__?.dpi?.LogicalSize;
    if (!w || !LogicalSize) return;
    try {
      if (!mini) {
        const factor = await w.scaleFactor();
        const size = await w.innerSize();
        mini = { w: size.width / factor, h: size.height / factor, maximized: await w.isMaximized(), onTop };
        if (mini.maximized) await w.unmaximize();
        app.fullscreen?.exit?.();
        document.documentElement.classList.add("mini-player");
        await w.setMinSize(new LogicalSize(320, 160));
        const music = current().kind === "music";
        await w.setSize(new LogicalSize(music ? 440 : 520, music ? 190 : 320));
        await setOnTop(true);
      } else {
        const m = mini;
        mini = null;
        document.documentElement.classList.remove("mini-player");
        await w.setMinSize(new LogicalSize(640, 420));
        await w.setSize(new LogicalSize(Math.max(640, m.w), Math.max(420, m.h)));
        if (m.maximized) await w.maximize();
        await setOnTop(m.onTop);
      }
    } catch (e) {
      console.warn("mini player", e);
      app.toast(`⚠️ ${errorText(e, t)}`);
    }
    render();
  }

  // ------------------------------------------------------------------------
  // Exports / photo / music tools
  // ------------------------------------------------------------------------
  const exports = createExportDialogs(app, current);
  const photo = createPhotoTools(app, current);
  const music = createMusicTools(app, current, { withReleased });

  const needFfmpeg = (fn) => () => {
    if (caps.ffmpeg === false) { app.toast(t("actions.job.noFfmpeg")); return null; }
    return fn();
  };

  function editPhoto() {
    const b = document.getElementById("ps-viewer-edit");
    if (b && !b.hidden) b.click();
    else app.toast(t("actions.toast.editUnavailable"));
  }

  /** Every action: run(item, kind), kinds (where it is offered), label key. */
  const ACTIONS = {
    deleteFile: { label: "actions.menu.delete", run: deleteCurrent },
    renameFile: { label: "actions.menu.rename", run: renameCurrent },
    copyFile: { label: "actions.menu.copyFile", run: withPath((i) => copyFiles([i.path])) },
    copyPath: { label: "actions.menu.copyPath", run: withPath((i) => copyPaths([i.path])) },
    showInFolder: { label: "actions.menu.showInFolder", run: withPath((i) => reveal(i.path)) },
    openWith: { label: "actions.menu.openWith", run: withPath((i) => call("file_open_with", { path: i.path })), when: () => caps.openWith },
    shareFile: { label: "actions.menu.share", run: withPath(share), when: () => caps.share },
    properties: { label: "actions.menu.properties", run: withPath((i) => properties(i, current().kind)) },
    favorite: { label: "actions.menu.favorite", run: withPath(toggleFav) },
    addToPlaylist: { label: "actions.menu.addToPlaylist", run: () => app.loader.pickFiles(dom.playlistFileInput, { playFirstNew: false }), any: true },
    // photo
    editPhoto: { label: "actions.menu.edit", kinds: ["photo"], run: editPhoto },
    copyImage: { label: "actions.menu.copyImage", kinds: ["photo"], any: true, run: () => {
      const sel = String(globalThis.getSelection?.() ?? "");
      if (sel.trim()) return call("clipboard_copy_text", { text: sel }, "actions.toast.textCopied"); // OCR text layer
      return photo.copyImage();
    } },
    printPhoto: { label: "actions.menu.print", kinds: ["photo"], any: true, run: () => photo.print(), when: () => caps.print !== false },
    ocr: { label: "actions.menu.ocr", kinds: ["photo"], run: () => photo.ocr(), when: () => caps.ocr },
    setWallpaper: { label: "actions.menu.setWallpaper", kinds: ["photo"], run: () => photo.setBackground("desktop"), when: () => caps.wallpaper },
    setLockScreen: { label: "actions.menu.setLockScreen", kinds: ["photo"], run: () => photo.setBackground("lock"), when: () => caps.lockScreen },
    // video
    saveFrame: { label: "actions.menu.saveFrame", kinds: ["video"], any: true, run: () => app.snapshot.capture() },
    copyFrame: { label: "actions.menu.copyFrame", kinds: ["video"], any: true, run: copyFrame },
    cutVideo: { label: "actions.menu.cut", kinds: ["video", "music"], run: needFfmpeg(() => exports.openRange(current().kind === "music" ? "segment" : "cut")) },
    gif: { label: "actions.menu.gif", kinds: ["video"], run: needFfmpeg(() => exports.openRange("gif")) },
    clip: { label: "actions.menu.clip", kinds: ["video"], run: needFfmpeg(() => exports.openRange("clip")) },
    // faithful video enhance (model-free; media/video-enhance.js)
    enhanceVideo: { label: "actions.menu.enhanceVideo", kinds: ["video"], run: needFfmpeg(() => withPath((i) => app.videoEnhance?.open(i))()), when: () => !!app.videoEnhance },
    convertMedia: { label: "actions.menu.convert", kinds: ["video", "music"], run: needFfmpeg(() => (current().kind === "music" ? exports.openAudioConvert() : exports.openConvert())) },
    extractAudio: { label: "actions.menu.extractAudio", kinds: ["video"], run: needFfmpeg(() => exports.openExtractAudio()) },
    rotateVideo: { label: "actions.menu.rotate", kinds: ["video"], run: needFfmpeg(() => exports.openRotate()) },
    embedSubtitle: { label: "actions.menu.embedSubtitle", kinds: ["video"], run: needFfmpeg(() => exports.embedSubtitle()) },
    extractSubtitle: { label: "actions.menu.extractSubtitle", kinds: ["video"], run: needFfmpeg(() => exports.openExtractSubtitle()) },
    contactSheet: { label: "actions.menu.contactSheet", kinds: ["video"], run: needFfmpeg(() => exports.contactSheet()) },
    alwaysOnTop: { label: "actions.menu.alwaysOnTop", any: true, run: toggleOnTop, check: () => onTop },
    // L04: UPnP/DLNA renderer on the local network (local files only)
    castDevice: { label: "actions.menu.cast", kinds: ["video", "music", "photo"], run: withPath((i) => app.cast?.open(i)), when: () => !!app.cast },
    miniPlayer: { label: "actions.menu.miniPlayer", kinds: ["video", "music"], any: true, run: toggleMini, check: () => !!mini },
    // music
    tagEditor: { label: "actions.menu.tags", kinds: ["music"], run: () => music.openTags() },
    lyrics: { label: "actions.menu.lyrics", kinds: ["music"], run: () => music.toggleLyrics(), check: () => music.lyricsOpen },
    replayGain: { label: "actions.menu.replayGain", kinds: ["music"], run: needFfmpeg(() => withReleased(() => exports.replayGain())) },
    ringtone: { label: "actions.menu.ringtone", kinds: ["music"], run: needFfmpeg(() => exports.openRange("segment")) },
    settings: { label: "actions.menu.settings", any: true, run: () => app.settingsModal?.open() },
    // controls that left the titlebar / photo HUD (their buttons stay, hidden, with their logic)
    findSubtitles: { label: "actions.menu.findSubtitles", kinds: ["video"], any: true, run: () => document.getElementById("btn-search-subtitles")?.click() },
    sleepTimer: { label: "actions.menu.sleepTimer", kinds: ["video", "music"], any: true, run: () => document.getElementById("btn-sleep-timer")?.click() },
    photoInfo: { label: "actions.menu.photoInfo", kinds: ["photo"], any: true, run: () => document.getElementById("btn-photo-info")?.click() },
    playlist: { label: "actions.menu.playlist", kinds: ["photo", "music"], any: true, run: () => app.playlist.toggleDrawer() },
  };

  /** Offered for the current media? (kind filter, local file, platform support) */
  function available(id) {
    const a = ACTIONS[id];
    if (!a) return false;
    const { item, kind } = current();
    if (kind === "none") return id === "alwaysOnTop" || id === "settings";
    if (a.kinds && !a.kinds.includes(kind)) return false;
    if (!a.any && !item?.path) return false;
    return a.when ? a.when() !== false : true;
  }

  function run(id) {
    if (!available(id)) return null;
    return ACTIONS[id].run();
  }

  const labelOf = (id) => {
    if (id === "favorite") return t(isFavorite(current().item?.path) ? "actions.menu.unfavorite" : "actions.menu.favorite");
    if (id === "cutVideo" && current().kind === "music") return t("actions.menu.ringtone");
    if (id === "convertMedia" && current().kind === "music") return t("actions.menu.audioConvert");
    return t(ACTIONS[id].label);
  };
  const item = (id) => (available(id) ? {
    id, label: `${ACTIONS[id].check ? (ACTIONS[id].check() ? "✓ " : "    ") : ""}${labelOf(id)}`,
    shortcut: ACTION_SHORTCUTS.some((s) => s.id === id) ? id : undefined, run: () => run(id),
  } : null);
  const group = (...ids) => ids.map(item).filter(Boolean);
  const sections = (...groups) => groups.filter((g) => g.length).flatMap((g, i) => (i ? [{ separator: true }, ...g] : g));

  /** "⋯" menu of the toolbar. */
  function moreItems() {
    const { kind } = current();
    if (kind === "photo") {
      return sections(
        group("deleteFile", "printPhoto", "shareFile"),
        group("photoInfo", "setWallpaper", "setLockScreen", "ocr", "castDevice"),
        group("openWith", "showInFolder"),
        group("copyImage", "copyFile", "copyPath"),
        group("renameFile", "favorite", "addToPlaylist", "playlist", "properties"),
        group("settings"));
    }
    if (kind === "music") {
      return sections(
        group("tagEditor", "lyrics", "shareFile"),
        group("castDevice", "sleepTimer", "playlist"),
        group("openWith", "showInFolder"),
        group("copyFile", "copyPath"),
        group("convertMedia", "ringtone", "replayGain"),
        group("miniPlayer", "alwaysOnTop"),
        group("renameFile", "deleteFile", "favorite", "addToPlaylist", "properties"),
        group("settings"));
    }
    return sections(
      group("cutVideo", "saveFrame", "enhanceVideo", "convertMedia", "shareFile"),
      group("findSubtitles", "sleepTimer", "castDevice"),
      group("openWith", "showInFolder"),
      group("copyFrame", "copyFile", "copyPath"),
      [...(available("gif") ? [{ heading: "actions.menu.exportHeading" }] : []), ...group("gif", "clip", "extractAudio", "rotateVideo", "embedSubtitle", "extractSubtitle", "contactSheet")],
      group("miniPlayer", "alwaysOnTop"),
      group("renameFile", "deleteFile", "favorite", "addToPlaylist", "properties"),
      group("settings"));
  }

  /** Right-click menu entries (ui/menus.js). */
  function contextItems() {
    const { kind } = current();
    if (kind === "none") return [];
    const copy = kind === "photo" ? group("copyImage", "copyPath") : kind === "video" ? group("copyFrame", "copyPath") : group("copyFile", "copyPath");
    return sections(copy, group("shareFile", "openWith", "showInFolder"), group("renameFile", "deleteFile", "properties"));
  }

  // ------------------------------------------------------------------------
  // Toolbar
  // ------------------------------------------------------------------------
  const bar = h("div", { id: "media-actions", class: "media-actions", role: "toolbar", "data-tauri-drag-region": "false", hidden: true });
  // aria-controls: a dialog opened from this menu gives focus back to this button (ui/dialog-a11y.js)
  const moreBtn = h("button", { id: "ma-more", type: "button", class: "ma-btn ma-more", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "media-actions-menu" }, "⋯");
  const miniExit = h("button", { id: "ma-mini-exit", type: "button", class: "ma-btn ma-mini-exit", onclick: () => toggleMini() }, "⤢");
  dom.titlebar?.querySelector(".titlebar-brand")?.after(bar);
  dom.titlebar?.querySelector(".titlebar-controls")?.before(miniExit);
  const menu = createPopupMenu({ id: "media-actions-menu", className: "vho-media-actions-menu" });
  app.shortcuts?.onEscape?.(() => menu.close(true));
  moreBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.isOpen) { menu.close(); return; }
    const r = moreBtn.getBoundingClientRect();
    moreBtn.setAttribute("aria-expanded", "true");
    menu.openAt(r.left, r.bottom + 6, moreItems(), {
      shortcutKeys: (id) => app.shortcuts?.keysOf(id) ?? [],
      focusFirst: e.detail === 0,
      onClosed: () => moreBtn.setAttribute("aria-expanded", "false"),
    });
  });

  let signature = "";
  function render() {
    const { item, kind } = current();
    // per-media layout switch for CSS and ui/mode-layout.js: none | video | photo | music
    const mode = kind === "none" || (!item?.path && !item?.url) ? "none" : kind;
    if (document.documentElement.dataset.mediaMode !== mode) document.documentElement.dataset.mediaMode = mode;
    const ids = (TOOLBAR[kind] ?? []).filter(([id]) => available(id)).map(([id]) => `${id}${ACTIONS[id].check?.() ? "+" : ""}`);
    const sig = [kind, item?.path ?? "", i18n.language, ids.join(","), JSON.stringify(caps), !!mini].join("|");
    if (sig === signature) return;
    signature = sig;
    bar.dataset.kind = kind;
    bar.hidden = kind === "none" || !item?.path;
    miniExit.title = t("actions.menu.miniPlayerExit");
    moreBtn.title = t("actions.toolbar.more");
    moreBtn.setAttribute("aria-label", t("actions.toolbar.more"));
    bar.setAttribute("aria-label", t("actions.toolbar.label"));
    if (bar.hidden) return;
    const buttons = (TOOLBAR[kind] ?? []).filter(([id]) => available(id)).map(([id, ic]) => {
      const keys = app.shortcuts?.keysOf?.(id) ?? [];
      const b = h("button", { id: `ma-${id}`, type: "button", class: "ma-btn ma-labeled" });
      b.innerHTML = icon(ic);
      b.append(h("span", { text: labelOf(id) }));
      b.title = keys.length ? `${labelOf(id)} (${keys[0].replace(/Key|Digit/g, "")})` : labelOf(id);
      if (ACTIONS[id].check?.()) b.classList.add("active");
      b.addEventListener("click", () => run(id));
      return b;
    });
    bar.replaceChildren(...buttons, moreBtn);
  }

  app.bus.on("media:loading", () => queueMicrotask(render));
  app.bus.on("media:loaded", render);
  app.engine.on?.("tracks", () => setTimeout(render, 0)); // audio-only layout decided on tracks
  i18n.onChange(render);
  new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  render();

  // ------------------------------------------------------------------------
  // Shortcuts (central table: Settings > Kısayollar, F1 help)
  // ------------------------------------------------------------------------
  for (const s of ACTION_SHORTCUTS) {
    app.shortcuts?.register?.({ ...s, labelKey: `shortcuts.actions.${s.id}`, run: () => run(s.id) });
  }

  // ------------------------------------------------------------------------
  // Photo studio grid (selection based)
  // ------------------------------------------------------------------------
  const forPaths = {
    delete: (paths) => deletePaths(paths),
    copyFiles: (paths) => copyFiles(paths),
    copyPaths: (paths) => copyPaths(paths),
    reveal: (paths) => paths[0] && reveal(paths[0]),
    addToPlaylist: (items) => {
      if (!items.length) return;
      const first = app.playlist.append(items.map((i) => ({ path: i.path, name: i.name, size: i.size, isImage: i.kind !== "video" })));
      if (state.get("currentPlaylistIndex") === -1) app.playlist.play(first);
      else app.playlist.render();
      app.toast(t("actions.toast.addedToPlaylist", { n: items.length }));
    },
  };

  // ------------------------------------------------------------------------
  // Settings window
  // ------------------------------------------------------------------------
  async function registerSettings() {
    const s = app.settings;
    if (!s?.register || s.has("actions.confirmDelete")) return;
    const langs = await invoke?.("ocr_languages").catch(() => []) ?? [];
    s.register("general", [
      { control: "heading", labelKey: "actions.settings.heading" },
      { key: "actions.confirmDelete", type: "boolean", default: true, control: "toggle", labelKey: "actions.settings.confirmDelete" },
      {
        key: "actions.outputLocation", type: "enum", values: ["source", "library"], default: "source", control: "select",
        labelKey: "actions.settings.outputLocation", helpKey: "actions.settings.outputLocationHelp",
        options: [{ value: "source", labelKey: "actions.settings.outputSource" }, { value: "library", labelKey: "actions.settings.outputLibrary" }],
      },
      {
        key: "actions.favorites", type: "object", default: { paths: [] }, validate: (v) => Array.isArray(v.paths),
        control: "custom", render: (row) => {
          const n = favorites().length;
          row.append(h("span", { class: "vho-field-label", text: t("actions.settings.favorites", { n }) }),
            h("button", { type: "button", class: "btn-ghost btn-sm", text: t("actions.settings.clearFavorites"), disabled: !n, onclick: (e) => { if (app.library?.favorites) app.library.favorites.clear(); else s.set("actions.favorites", { paths: [] }); e.target.disabled = true; } }));
        },
      },
    ]);
    s.register("playback", [
      { control: "heading", labelKey: "actions.settings.exportHeading" },
      { key: "actions.gifWidth", type: "enum", values: [320, 480, 640, 800], default: 480, control: "select", labelKey: "actions.settings.gifWidth",
        options: [320, 480, 640, 800].map((v) => ({ value: v, label: `${v} px` })) },
      { key: "actions.gifFps", type: "enum", values: [8, 10, 12, 15, 20], default: 12, control: "select", labelKey: "actions.settings.gifFps",
        options: [8, 10, 12, 15, 20].map((v) => ({ value: v, label: `${v} fps` })) },
    ]);
    s.register("audio", [
      { key: "actions.lyricsAuto", type: "boolean", default: false, control: "toggle", labelKey: "actions.settings.lyricsAuto", helpKey: "actions.settings.lyricsAutoHelp" },
    ]);
    s.register("photo", [
      { control: "heading", labelKey: "actions.settings.photoHeading" },
      {
        key: "actions.ocrLanguage", type: "string", maxLength: 24, default: "auto", control: "select", labelKey: "actions.settings.ocrLanguage",
        helpKey: langs.length ? undefined : "actions.settings.ocrNoLanguage",
        options: [{ value: "auto", labelKey: "actions.settings.ocrAuto" }, ...langs.map((l) => ({ value: l, label: l }))],
      },
      { key: "actions.printPaper", type: "enum", values: ["a4", "letter", "a5", "photo10x15"], default: "a4", control: "select", labelKey: "actions.print.paper",
        options: ["a4", "letter", "a5", "photo10x15"].map((p) => ({ value: p, labelKey: `actions.print.papers.${p}` })) },
      { key: "actions.printFit", type: "enum", values: ["fit", "fill"], default: "fit", control: "select", labelKey: "actions.print.scaling",
        options: [{ value: "fit", labelKey: "actions.print.fit" }, { value: "fill", labelKey: "actions.print.fill" }] },
      { key: "actions.printMargin", type: "enum", values: ["none", "narrow", "normal", "wide"], default: "normal", control: "select", labelKey: "actions.print.margin",
        options: ["none", "narrow", "normal", "wide"].map((m) => ({ value: m, labelKey: `actions.print.margins.${m}` })) },
    ]);
    s.register("advanced", [
      { control: "heading", labelKey: "actions.settings.toolsHeading" },
      {
        control: "custom", render: (row) => {
          const p = h("p", { class: "engine-info", id: "vho-tools-info", text: "…" });
          row.append(p);
          invoke?.("media_tools").then((m) => {
            p.textContent = m.available
              ? t("actions.settings.toolsInfo", { version: m.version ?? "", encoder: m.h264Available ? m.h264Encoder
                : m.videoEncoder?.fallback ? t("actions.settings.fallbackEncoder", { name: m.videoEncoder.encoder.name }) : t("actions.settings.none") })
              : t("actions.job.noFfmpeg");
          }).catch(() => { p.textContent = t("actions.job.noFfmpeg"); });
        },
      },
    ]);
    s.subscribe("actions.favorites", () => render());
    app.library?.favorites?.subscribe(() => render());
  }

  const api = {
    run, available, current, contextItems, moreItems, registerSettings, forPaths, withReleased,
    photo, music, exports, dialogs,
    get onTop() { return onTop; },
    get mini() { return !!mini; },
  };
  return api;
}
