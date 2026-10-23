// ==========================================================================
// VHO (Video H Oynatıcısı) - bootstrap only.
// Builds the modules and wires them together through one `app` context:
// every module receives `app` and resolves its collaborators lazily
// (app.video, app.photo, ...) at call time, so there are no import cycles.
// Shared state lives in core/state.js, notifications go over core/events.js.
// ==========================================================================

import { queryDom } from "./core/dom.js";
import { createEventBus } from "./core/events.js";
import { createAppState } from "./core/state.js";
import { invoke } from "./core/tauri.js";
import { createAudioEngine } from "./media/audio-engine.js";
import { createLoader } from "./media/loader.js";
import { createPhotoAi } from "./media/photo-ai.js";
import { createPhotoViewer } from "./media/photo-viewer.js";
import { createSnapshot } from "./media/snapshot.js";
import { createSubtitles } from "./media/subtitles.js";
import { createVideoPlayer } from "./media/video-player.js";
import { createVisualFilters } from "./media/visual-filters.js";
import { createPhotoStudio } from "./studio/studio.js";
import { createFullscreen } from "./ui/fullscreen.js";
import { createHud } from "./ui/hud.js";
import { createModals } from "./ui/modals.js";
import { createPanels } from "./ui/panels.js";
import { createPlaylist } from "./ui/playlist.js";
import { initShortcuts } from "./ui/shortcuts.js";
import { createSleepTimer } from "./ui/sleep-timer.js";
import { createTimeline } from "./ui/timeline.js";
import { createToasts } from "./ui/toasts.js";
import { initWindowControls } from "./ui/window-controls.js";

document.addEventListener("DOMContentLoaded", () => {
  const dom = queryDom();
  const app = { dom, state: createAppState(), bus: createEventBus() };

  // Leaf services first: everything below may toast / poke the HUD
  Object.assign(app, createToasts(dom));
  app.hud = createHud(app);
  app.fullscreen = createFullscreen(dom);

  // Media pipeline (registration order of shared element listeners matches the
  // original controller: audio "pause" before the player's play-state "pause")
  app.filters = createVisualFilters(app);
  app.audio = createAudioEngine({ dom, state: app.state, toast: app.toast });
  app.subtitles = createSubtitles({
    dom,
    bus: app.bus,
    toast: app.toast,
    openSearch: () => dom.btnSearchSubtitles.click(),
  });
  app.loader = createLoader(app);
  app.photo = createPhotoViewer(app);
  app.video = createVideoPlayer(app);
  app.timeline = createTimeline(app);
  app.snapshot = createSnapshot(app);
  app.photoAi = createPhotoAi(app);

  // UI
  app.playlist = createPlaylist(app);
  app.panels = createPanels(app);
  app.sleep = createSleepTimer(app);
  createModals(app);
  initShortcuts(app);
  initWindowControls(dom);
  app.studio = createPhotoStudio(app);

  // Files passed on the command line ("Open with VHO")
  invoke?.("initial_files")
    .then((paths) => app.loader.openPaths(paths))
    .catch((e) => console.warn("initial_files", e));

  // Release media resources when the app closes
  window.addEventListener("pagehide", () => {
    app.loader.releaseObjectUrl();
    app.audio.close();
    app.filters.destroy();
  });
});
