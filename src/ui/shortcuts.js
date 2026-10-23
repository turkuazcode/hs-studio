// ==========================================================================
// Keyboard shortcuts: one central action table (adaptive for video & photo mode).
// Keys are user-editable (Settings > Kısayollar, stored in "shortcuts.bindings");
// conflicts are detected with core/keymap.js. Other modules add actions with
//   app.shortcuts.register({ id, scope: "video" | "photo" | "global", keys: ["KeyX"],
//                            label: "Literal" | labelKey: "i18n.key", run: (e) => ... })
// ==========================================================================

import { comboFromEvent, effectiveBindings, findConflicts, resolveAction } from "../core/keymap.js";

/** Text inputs keep their keys; sliders, checkboxes and buttons do not. */
export function isTextField(t) {
  return !!(t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
    (t.tagName === "INPUT" && !["range", "checkbox", "button", "radio", "color"].includes(t.type)));
}

/**
 * Default action table. `run(app, e)`; ids are stable (they key the user's overrides and
 * the i18n labels "shortcuts.actions.<id>").
 */
export function defaultActions(app) {
  const { dom } = app;
  const poke = () => app.hud.poke();
  return [
    // Both modes
    { id: "fullscreen", scope: "global", keys: ["KeyF"], run: () => app.fullscreen.toggle() },
    { id: "snapshot", scope: "global", keys: ["KeyS"], run: () => app.snapshot.capture() },
    { id: "playlist", scope: "global", keys: ["KeyL"], run: () => app.playlist.toggleDrawer() },
    { id: "splitView", scope: "global", keys: ["KeyB"], run: () => app.panels.toggleSplitView() },
    { id: "openFile", scope: "global", keys: ["Ctrl+KeyO"], run: () => dom.btnBrowse.click() },
    { id: "settings", scope: "global", keys: ["Ctrl+Comma"], run: () => app.settingsModal?.open() },
    { id: "help", scope: "global", keys: ["F1"], run: () => app.shortcutHelp?.toggle() },

    // Video
    { id: "playPause", scope: "video", keys: ["Space"], run: () => app.video.togglePlay() },
    { id: "seekBack", scope: "video", keys: ["ArrowLeft"], run: () => { app.video.seekBy(-5); poke(); } },
    { id: "seekForward", scope: "video", keys: ["ArrowRight"], run: () => { app.video.seekBy(5); poke(); } },
    { id: "seekBackLong", scope: "video", keys: ["Shift+ArrowLeft"], run: () => { app.video.seekBy(-30); poke(); } },
    { id: "seekForwardLong", scope: "video", keys: ["Shift+ArrowRight"], run: () => { app.video.seekBy(30); poke(); } },
    { id: "volumeUp", scope: "video", keys: ["ArrowUp"], run: () => { app.audio.nudgeVolume(5); poke(); } },
    { id: "volumeDown", scope: "video", keys: ["ArrowDown"], run: () => { app.audio.nudgeVolume(-5); poke(); } },
    { id: "mute", scope: "video", keys: ["KeyM"], run: () => { dom.btnVolume.click(); poke(); } },
    { id: "subtitles", scope: "video", keys: ["KeyC", "KeyV"], run: () => app.subtitles.toggle() },
    { id: "subDelayMinus", scope: "video", keys: ["KeyG"], run: () => app.subtitles.nudgeDelay(-50) },
    { id: "subDelayPlus", scope: "video", keys: ["KeyH"], run: () => app.subtitles.nudgeDelay(50) },
    { id: "pip", scope: "video", keys: ["KeyP"], run: () => app.video.clickPip() },
    {
      id: "aiVideo", scope: "video", keys: ["KeyR", "KeyA"],
      run: () => app.panels.toggleAiMaster("AI Restorasyon & Netleştirici Açık ✨", "AI Restorasyon Kapalı"),
    },

    // Photo
    { id: "slideshow", scope: "photo", keys: ["Space"], run: () => app.photo.toggleSlideshow() },
    { id: "photoPrev", scope: "photo", keys: ["ArrowLeft"], run: () => { app.playlist.navigate(-1); poke(); } },
    { id: "photoNext", scope: "photo", keys: ["ArrowRight"], run: () => { app.playlist.navigate(1); poke(); } },
    { id: "rotateRight", scope: "photo", keys: ["KeyR"], run: () => dom.btnPhotoRotateRight?.click() },
    { id: "rotateLeft", scope: "photo", keys: ["Shift+KeyR"], run: () => dom.btnPhotoRotateLeft?.click() },
    { id: "photoInfo", scope: "photo", keys: ["KeyI"], run: () => dom.btnPhotoInfo?.click() },
    { id: "deepEnhance", scope: "photo", keys: ["KeyE"], run: () => app.photoAi.enhance() },
    { id: "zoomIn", scope: "photo", keys: ["Equal", "NumpadAdd"], run: () => app.photo.zoom(1.25) },
    { id: "zoomOut", scope: "photo", keys: ["Minus", "NumpadSubtract"], run: () => app.photo.zoom(0.8) },
    { id: "zoomReset", scope: "photo", keys: ["Digit0", "Numpad0"], run: () => app.photo.resetTransform() },
    {
      id: "aiPhoto", scope: "photo", keys: ["KeyA"],
      run: () => app.panels.toggleAiMaster("AI Restorasyon Devrede ✨", "AI Restorasyon Kapalı"),
    },
  ];
}

/**
 * app: { dom, state, settings?, toast, fullscreen, video, audio, subtitles, photo, photoAi, panels,
 *        snapshot, playlist, hud, settingsModal?, shortcutHelp? }  (resolved lazily)
 */
export function initShortcuts(app) {
  const { state } = app;
  const actions = defaultActions(app);
  const subs = new Set();
  let bindings = new Map();

  const overrides = () => app.settings?.get("shortcuts.bindings") ?? {};
  function rebuild() {
    bindings = effectiveBindings(actions, overrides());
    for (const fn of subs) fn();
  }
  rebuild();
  app.settings?.subscribe("shortcuts.bindings", rebuild);

  /** Escape handlers (topmost first): return true when they closed something. */
  const escapeHandlers = [];

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (isTextField(t)) return;

    if (e.code === "Escape") {
      if (escapeHandlers.some((h) => h())) { e.preventDefault(); return; }
      app.fullscreen.exit();
      return;
    }
    // "?" opens the shortcut help on every layout (Shift+/ on US, Shift+- on TR Q)
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      app.shortcutHelp?.toggle();
      return;
    }

    const combo = comboFromEvent(e);
    if (!combo) return;
    const mode = state.get("currentMediaType") === "image" ? "photo" : "video";
    const action = resolveAction(actions, bindings, combo, mode);
    if (!action) return;
    // Release focus from sliders/buttons so shortcuts keep working and Space doesn't double-click
    if ((t.tagName === "INPUT" && t.type === "range") || (t.tagName === "BUTTON" && e.code === "Space")) t.blur();
    e.preventDefault();
    action.run(e);
  });

  return {
    /** Action list (id, scope, keys = defaults, label/labelKey). */
    actions: () => actions.slice(),
    /** Current keys of an action (defaults or the user's override). */
    keysOf: (id) => (bindings.get(id) ?? []).slice(),
    bindings: () => new Map(bindings),
    conflicts: () => findConflicts(actions, overrides()),
    register(action) {
      if (!action?.id || actions.some((a) => a.id === action.id)) throw new Error(`shortcut id taken: ${action?.id}`);
      actions.push({ scope: "global", keys: [], ...action });
      rebuild();
    },
    onChange: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    /** Escape priority for overlays: fn() returns true when it closed something. */
    onEscape: (fn) => escapeHandlers.unshift(fn),
    run: (id, e) => actions.find((a) => a.id === id)?.run(e),
  };
}
