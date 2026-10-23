// ==========================================================================
// Fullscreen (Tauri window API; DOM Fullscreen API in a plain browser)
// ==========================================================================

import { appWindow } from "../core/tauri.js";

export function createFullscreen({ btnFullscreen, iconFsEnter, iconFsExit }) {
  function syncFsIcons(isFs) {
    iconFsEnter.style.display = isFs ? "none" : "block";
    iconFsExit.style.display = isFs ? "block" : "none";
  }

  async function setFullscreen(on) {
    if (appWindow) {
      try {
        await appWindow.setFullscreen(on);
        document.documentElement.classList.toggle("is-fullscreen", on);
        syncFsIcons(on);
      } catch (err) {
        console.error("[window] setFullscreen", err);
      }
    } else if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  async function isFullscreen() {
    if (appWindow) return appWindow.isFullscreen().catch(() => false);
    return !!document.fullscreenElement;
  }

  async function toggleFullscreen() {
    setFullscreen(!(await isFullscreen()));
  }

  btnFullscreen.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => syncFsIcons(!!document.fullscreenElement));

  /** Escape key: leave fullscreen if active. */
  const exitFullscreen = () => isFullscreen().then((fs) => fs && setFullscreen(false));

  return { toggle: toggleFullscreen, set: setFullscreen, isFullscreen, exit: exitFullscreen };
}
