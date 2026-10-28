// ==========================================================================
// VHO (Video H Oynatıcısı) - bootstrap only.
// Builds the modules and wires them together through one `app` context:
// every module receives `app` and resolves its collaborators lazily
// (app.video, app.photo, ...) at call time, so there are no import cycles.
// Shared state lives in core/state.js, notifications go over core/events.js.
// ==========================================================================

import { queryDom } from "./core/dom.js";
import { createCapabilities } from "./core/capabilities.js";
import { createEventBus } from "./core/events.js";
import { FALLBACK_LANGUAGE, loadDictionary } from "./core/i18n.js";
import { createJobs } from "./core/jobs.js";
import { createLibrary } from "./core/library.js";
import { announceStorageStatus, appLibraryAdapter } from "./core/library-db.js";
import { createSettings, defaultAdapter } from "./core/settings.js";
import { createAppState } from "./core/state.js";
import { convertFileSrc, invoke, listen } from "./core/tauri.js";
import { createAudioEngine } from "./media/audio-engine.js";
import { createAudioFx } from "./media/audio-fx.js";
import { registerEngineSettings } from "./media/engine-settings.js";
import { createEngineFacade } from "./media/engine/engine.js";
import { createHtml5Engine } from "./media/engine/html5-engine.js";
import { createMpvEngine } from "./media/engine/mpv-engine.js";
import { createLoader } from "./media/loader.js";
import { createAiJobRunner } from "./media/ai-jobs.js";
import { createPhotoAi } from "./media/photo-ai.js";
import { createPhotoViewer } from "./media/photo-viewer.js";
import { createSnapshot } from "./media/snapshot.js";
import { createSubtitles } from "./media/subtitles.js";
import { createVideoPlayer } from "./media/video-player.js";
import { createVisualFilters } from "./media/visual-filters.js";
import { createLibraryView } from "./library/library-view.js";
import { createMusicMode } from "./music/music-mode.js";
import { createCast } from "./ui/cast-dialog.js";
import { createPhotoStudio } from "./studio/studio.js";
import { createFullscreen } from "./ui/fullscreen.js";
import { createHud } from "./ui/hud.js";
import { createMediaActions } from "./ui/media-actions.js";
import { createModals } from "./ui/modals.js";
import { createPanels } from "./ui/panels.js";
import { createPlaybackMenus } from "./ui/playback-menus.js";
import { createPlaylist } from "./ui/playlist.js";
import { initShortcuts } from "./ui/shortcuts.js";
import { createSleepTimer } from "./ui/sleep-timer.js";
import { createTimeline } from "./ui/timeline.js";
import { createToasts } from "./ui/toasts.js";
import { initPlatform } from "./ui/platform.js";
import { registerAiModelSettings } from "./ui/ai-models.js";
import { registerCacheSettings } from "./ui/cache-settings.js";
import { initWindowControls } from "./ui/window-controls.js";
import { initDialogA11y } from "./ui/dialog-a11y.js";
import { createJobsPanel } from "./ui/jobs-panel.js";

/** libmpv status from the backend; { available: false } in a browser or without the DLLs. */
async function engineStatus() {
  if (!invoke) return { available: false, error: "no backend" };
  try {
    return await invoke("engine_status");
  } catch (e) {
    return { available: false, error: String(e) };
  }
}

/** localStorage, or null when blocked (private mode / tests). */
function safeLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}

document.addEventListener("DOMContentLoaded", async () => {
  const dom = queryDom();

  const app = { dom, state: createAppState(), bus: createEventBus() };

  // Persistent settings + library (recent files, resume positions, bookmarks, favorites in
  // library.db; JSON store as fallback); loaded asynchronously, initPlatform() waits for them.
  app.settings = createSettings({ adapter: defaultAdapter("settings.json", "settings") });
  app.library = createLibrary({
    adapter: appLibraryAdapter(invoke, defaultAdapter("library.json", "library")),
    legacyStorage: safeLocalStorage(),
  });
  // Fallback dictionary (local file) before the modules are built: they render their texts with
  // t(). Awaited after the settings/library loads started, so it does not delay their first write.
  await loadDictionary(FALLBACK_LANGUAGE).catch((e) => console.error("[i18n]", e));
  app.resume = {
    get: (key) => (app.settings.get("playback.resume") ? app.library.resume.get(key) : null),
    set: (key, seconds) => app.library.resume.set(key, seconds),
    remove: (key) => app.library.resume.remove(key),
  };

  // Playback engine: libmpv when the backend loaded it, the <video> element otherwise
  app.engineStatus = await engineStatus();
  app.engines = {
    html5: createHtml5Engine({ app, invoke, listen }),
    mpv: app.engineStatus.available
      ? createMpvEngine({ invoke, listen, convertFileSrc, status: app.engineStatus })
      : null,
  };
  app.engine = createEngineFacade(app.engines);
  // One capability source for the UI (Plan 10 / P01): what works with this engine / WebView
  app.capabilities = createCapabilities({ engineKind: () => app.engine.kind, webgl2: () => !!app.filters?.enhancer });
  // Backend part (engine, photo codecs, OS actions); the AVIF probe must not delay the first paint
  invoke?.("platform_capabilities")
    .then((report) => { app.capabilities.setBackend(report); app.bus.emit("capabilities:changed", report); })
    .catch((e) => console.warn("platform_capabilities", e));
  // Persistent job queue (Plan 11/A02): exports and photo batches survive a restart
  app.jobs = createJobs({ invoke, listen });
  // AI jobs of the queue run in this page (Web Worker inference, A03)
  app.aiJobs = createAiJobRunner(app, { invoke, listen, convertFileSrc });

  // Leaf services first: everything below may toast / poke the HUD
  Object.assign(app, createToasts(dom));
  app.hud = createHud(app);
  app.fullscreen = createFullscreen(dom);

  // Media pipeline (registration order of shared element listeners matches the
  // original controller: audio "pause" before the player's play-state "pause")
  app.filters = createVisualFilters(app);
  app.audio = createAudioEngine({ dom, state: app.state, toast: app.toast, engine: () => app.engine });
  app.subtitles = createSubtitles({
    dom,
    bus: app.bus,
    toast: app.toast,
    openSearch: () => dom.btnSearchSubtitles.click(),
    engine: () => app.engine,
  });
  app.loader = createLoader(app);
  app.photo = createPhotoViewer(app);
  app.video = createVideoPlayer(app);
  app.timeline = createTimeline(app);
  app.snapshot = createSnapshot(app);
  app.photoAi = createPhotoAi(app);
  app.audioFx = createAudioFx(app);

  // UI
  app.playlist = createPlaylist(app);
  app.panels = createPanels(app);
  app.playbackMenus = createPlaybackMenus(app);
  app.view = app.playbackMenus;
  app.sleep = createSleepTimer(app);
  createModals(app);
  const dialogs = initDialogA11y(); // every .modal-overlay: dialog role, focus in / trapped / restored (Q03)
  app.shortcuts = initShortcuts(app);
  app.shortcuts.onEscape(dialogs.closeTopmost); // registered first = asked last
  initWindowControls(dom);
  app.video.syncEngineUi();
  // Diagnostics / E2E: which engine is active (read-only view)
  window.__vhoEngine = {
    get kind() { return app.engine.kind; },
    get status() { return app.engineStatus; },
    get time() { return app.engine.time; },
    get duration() { return app.engine.duration; },
    get paused() { return app.engine.paused; },
    get tracks() { return app.engine.tracks(); },
    get chapters() { return app.engine.chapters(); },
    get audioFilters() { return app.audioFx.chain; },
    get bookmarks() { return app.playbackMenus.bookmarks; },
    /** Capability matrix as the UI sees it (P01). */
    get capabilities() { return app.capabilities.all(); },
    /** Same path as the native file drop / open dialog (tests cannot synthesize an OS drop). */
    openPaths: (paths) => app.loader.openPaths(paths),
    /** Same as the HUD controls (seek bar / play button) without pixel clicks. */
    seek: (t) => app.engine.seek(t),
    pause: () => app.engine.pause(),
  };
  app.studio = createPhotoStudio(app);
  // File / photo / video / music actions (Plan 06): toolbar, "⋯" + right-click menus, dialogs
  app.mediaActions = createMediaActions(app);
  window.__vhoActions = app.mediaActions;
  app.jobsPanel = createJobsPanel(app);
  // Persistent library (Plan 13/L02): video / music views, saved lists, Settings > Library
  app.libraryView = createLibraryView(app);
  window.__vhoLibrary = app.libraryView;
  // Music mode (Plan 13/L03): own layout, queue policy, gapless, ReplayGain, system media controls
  app.music = createMusicMode(app);
  window.__vhoMusic = app.music;
  // Cast to a UPnP/DLNA device (Plan 13/L04), opened from the "⋯" menu
  app.cast = createCast(app);
  window.__vhoCast = app.cast;

  // Settings window, recent files, menus, themes, language... then the files passed on
  // the command line ("Open with VHO"), so they open with the restored settings.
  initPlatform(app)
    .catch((e) => console.error("[platform]", e))
    .finally(() => {
      // engine options after the base fields (tab order), once the stored values are loaded
      registerEngineSettings(app);
      announceStorageStatus(app);
      registerCacheSettings(app);
      registerAiModelSettings(app);
      app.mediaActions.registerSettings().catch((e) => console.error("[actions] settings", e));
      app.jobsPanel?.init();
      app.aiJobs.start().catch((e) => console.error("[ai-jobs]", e));
      invoke?.("initial_files")
        .then((paths) => app.loader.openPaths(paths))
        .catch((e) => console.warn("initial_files", e));
    });

  // Release media resources when the app closes
  window.addEventListener("pagehide", () => {
    app.loader.releaseObjectUrl();
    app.audio.close();
    app.filters.destroy();
    app.engine.destroy();
  });
});
