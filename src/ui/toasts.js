// ==========================================================================
// Toast messages, snapshot flash and the play/pause ripple.
// ==========================================================================

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="36" height="36" fill="#00f2fe"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="36" height="36" fill="#00f2fe"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

export function createToasts({ snapshotToast, screenFlash, centerRipple }) {
  let toastTimer = 0;

  /** Shows a message for 2.8 s (each call restarts the timer). */
  function toast(msg) {
    if (msg) snapshotToast.querySelector("span").textContent = msg;
    snapshotToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => snapshotToast.classList.remove("show"), 2800);
  }

  function flashScreen() {
    screenFlash.classList.add("active");
    setTimeout(() => screenFlash.classList.remove("active"), 150);
  }

  function triggerRipple(type) {
    centerRipple.innerHTML = type === "play" ? PLAY_SVG : PAUSE_SVG;
    centerRipple.classList.add("animate");
    setTimeout(() => {
      centerRipple.classList.remove("animate");
    }, 400);
  }

  return { toast, flashScreen, triggerRipple };
}
