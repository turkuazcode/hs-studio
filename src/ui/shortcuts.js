// ==========================================================================
// Master keyboard shortcuts (adaptive for video & photo mode)
// ==========================================================================

/** Text inputs keep their keys; sliders, checkboxes and buttons do not. */
export function isTextField(t) {
  return !!(t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
    (t.tagName === "INPUT" && !["range", "checkbox", "button"].includes(t.type)));
}

/** Same action for several key codes. */
const alias = (codes, fn) => Object.fromEntries(codes.map((c) => [c, fn]));

/**
 * app: { dom, state, toast, fullscreen, video, audio, subtitles, photo, photoAi, panels, snapshot,
 *        playlist, hud }  (resolved lazily)
 */
export function initShortcuts(app) {
  const { dom, state } = app;
  const { btnPhotoRotateLeft, btnPhotoRotateRight, btnPhotoInfo, btnVolume } = dom;

  // Photo studio keys (code -> action(event))
  const photoKeys = {
    Space: () => app.photo.toggleSlideshow(),
    ArrowLeft: () => { app.playlist.navigate(-1); app.hud.poke(); },
    ArrowRight: () => { app.playlist.navigate(1); app.hud.poke(); },
    KeyR: (e) => (e.shiftKey ? btnPhotoRotateLeft : btnPhotoRotateRight)?.click(),
    KeyI: () => btnPhotoInfo?.click(),
    KeyE: () => app.photoAi.enhance(),
    ...alias(["Equal", "NumpadAdd"], () => app.photo.zoom(1.25)),
    ...alias(["Minus", "NumpadSubtract"], () => app.photo.zoom(0.8)),
    ...alias(["Digit0", "Numpad0"], () => app.photo.resetTransform()),
    KeyF: () => app.fullscreen.toggle(),
    KeyS: () => app.snapshot.capture(),
    KeyL: () => app.playlist.toggleDrawer(),
    KeyA: () => app.panels.toggleAiMaster("AI Restorasyon Devrede ✨", "AI Restorasyon Kapalı"),
    KeyB: () => app.panels.toggleSplitView(),
  };

  // Video player keys
  const videoKeys = {
    Space: () => app.video.togglePlay(),
    ArrowLeft: (e) => { app.video.seekBy(e.shiftKey ? -30 : -5); app.hud.poke(); },
    ArrowRight: (e) => { app.video.seekBy(e.shiftKey ? 30 : 5); app.hud.poke(); },
    ArrowUp: () => { app.audio.nudgeVolume(5); app.hud.poke(); },
    ArrowDown: () => { app.audio.nudgeVolume(-5); app.hud.poke(); },
    KeyF: () => app.fullscreen.toggle(),
    KeyM: () => { btnVolume.click(); app.hud.poke(); },
    ...alias(["KeyC", "KeyV"], () => app.subtitles.toggle()),
    KeyG: () => app.subtitles.nudgeDelay(-50),
    KeyH: () => app.subtitles.nudgeDelay(50),
    KeyS: () => app.snapshot.capture(),
    KeyL: () => app.playlist.toggleDrawer(),
    KeyP: () => app.video.clickPip(),
    ...alias(["KeyR", "KeyA"], () => app.panels.toggleAiMaster("AI Restorasyon & Netleştirici Açık ✨", "AI Restorasyon Kapalı")),
    KeyB: () => app.panels.toggleSplitView(),
  };

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (isTextField(t) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Release focus from sliders/buttons so shortcuts keep working and Space doesn't double-click
    if ((t.tagName === "INPUT" && t.type === "range") || (t.tagName === "BUTTON" && e.code === "Space")) t.blur();

    if (e.code === "Escape") {
      app.fullscreen.exit();
      return;
    }
    const keys = state.get("currentMediaType") === "image" ? photoKeys : videoKeys;
    const action = Object.hasOwn(keys, e.code) ? keys[e.code] : null;
    if (!action) return;
    e.preventDefault();
    action(e);
  });

  return { photoKeys, videoKeys };
}
