// ==========================================================================
// HUD auto-hide on inactivity (video controls, photo HUD, titlebar)
// ==========================================================================

export const HUD_HIDE_DELAY_MS = 2500;

/**
 * Pure decision: hide the HUD after a while only while something is being watched
 * and no panel / modal / drop zone needs the pointer.
 */
export function shouldAutoHide({ isPlaying, isSlideshowActive, mediaType, overlayOpen }) {
  return (isPlaying || isSlideshowActive || mediaType === "image") && !overlayOpen;
}

export function createHud({ dom, state, bus }) {
  const {
    controlsHud, photoHud, btnFloatingPrev, btnFloatingNext, titlebar, dropZone, playlistDrawer,
    effectsPanel, aiRestorePanel, sleepTimerModal, subtitleSearchModal,
  } = dom;
  let hudHideTimeout = null;
  let hudVisible = true;
  /** "hud:visibility" lets libmpv lift its subtitles above the HUD. */
  function setVisible(v) {
    if (v === hudVisible) return;
    hudVisible = v;
    bus?.emit("hud:visibility", { visible: v });
  }

  function showHud() {
    controlsHud.classList.remove("hidden");
    setVisible(true);
    if (photoHud) photoHud.style.opacity = "1";
    if (btnFloatingPrev) btnFloatingPrev.style.opacity = "0.7";
    if (btnFloatingNext) btnFloatingNext.style.opacity = "0.7";
    titlebar.style.opacity = "1";
  }

  function resetHudTimeout() {
    showHud();
    clearTimeout(hudHideTimeout);
    const overlayOpen = dropZone.classList.contains("visible") ||
      playlistDrawer.classList.contains("open") ||
      effectsPanel.classList.contains("show") ||
      !!aiRestorePanel?.classList.contains("show") ||
      sleepTimerModal.classList.contains("active") ||
      subtitleSearchModal.classList.contains("active");
    const shouldHide = shouldAutoHide({
      isPlaying: state.get("isPlaying"),
      isSlideshowActive: state.get("isSlideshowActive"),
      mediaType: state.get("currentMediaType"),
      overlayOpen,
    });

    if (shouldHide) {
      hudHideTimeout = setTimeout(() => {
        const mediaType = state.get("currentMediaType");
        if (mediaType === "video") {
          controlsHud.classList.add("hidden");
          setVisible(false);
        } else if (mediaType === "image") {
          if (photoHud) photoHud.style.opacity = "0";
          if (btnFloatingPrev) btnFloatingPrev.style.opacity = "0";
          if (btnFloatingNext) btnFloatingNext.style.opacity = "0";
        }
        titlebar.style.opacity = "0";
      }, HUD_HIDE_DELAY_MS);
    }
  }

  // Throttle to one HUD update per frame
  let hudRaf = 0;
  document.addEventListener("mousemove", () => {
    if (hudRaf) return;
    hudRaf = requestAnimationFrame(() => {
      hudRaf = 0;
      resetHudTimeout();
    });
  }, { passive: true });

  return { show: showHud, poke: resetHudTimeout };
}
