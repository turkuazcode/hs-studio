// ==========================================================================
// Side panels: effects (colour sliders, subtitle delay, compatibility mode)
// and the enhance panel (S04): live picture/sound FILTERS (WebGL2 CAS/FSR shader or
// libmpv colour properties + DSP; not a neural network), A/B split view where the
// shader really draws the frame, "Enhance photo with AI" (media/photo-ai.js) and the
// video-restoration status (not ready). 100% local.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { invoke } from "../core/tauri.js";

/** Presets (data-driven); the button labels come from i18n (enhance.preset.*). */
export const AI_PRESETS = {
  "144p":   { sharp: 2, contrast: 8,  voice: true,  denoise: true,  comp: true },
  "voice":  { sharp: 1, contrast: 5,  voice: true,  denoise: true,  comp: true },
  "cinema": { sharp: 3, contrast: 12, voice: false, denoise: false, comp: true },
};

/** Sharpness slider label ("Off" / "Level n"). */
export const sharpLabel = (level) => (level === 0 ? t("enhance.sharpOff") : t("enhance.sharpLevel", { n: level }));

/** i18n key of the master-switch status line. */
export function masterStatusKey(enabled, engineKind, gpuFilter) {
  if (!enabled) return "enhance.statusOff";
  if (engineKind === "mpv") return "enhance.statusMpv";
  return gpuFilter ? "enhance.statusGpu" : "enhance.statusCss";
}

/** i18n key explaining why A/B is unavailable (capability entry), or null when it works. */
export const compareReasonKey = (entry) =>
  entry?.available ? null : entry?.reasonCode === "engine-mpv" ? "enhance.compareMpv" : "enhance.compareNoWebgl";

/**
 * app: { dom, state, toast, filters, audio, subtitles, playlist, engine, capabilities, bus }  (resolved lazily)
 */
export function createPanels(app) {
  const { dom, state } = app;
  const {
    effectsPanel, btnToggleEffects, btnCloseEffects, sliderBrightness, sliderContrast, sliderSaturate,
    btnResetFilters, checkCompatMode, btnToggleAiRestore, aiRestorePanel, btnCloseAiRestore, checkAiMaster,
    aiMasterStatus, aiRestoreBadge, sliderAiSharp, valAiSharp, sliderAiContrast, valAiContrast,
    checkAiVoiceClarity, checkAiDenoise, checkAiCompressor, btnToggleSplitView, splitViewStatus,
    splitScreenBanner, splitScreenLine, playlistDrawer, sliderGamma, sliderHue, audioPanel,
  } = dom;
  const splitViewReason = document.getElementById("split-view-reason");
  const applyFilters = () => app.filters.apply();

  // ------------------------------------------------------------------------
  // Effects panel
  // ------------------------------------------------------------------------
  btnToggleEffects.addEventListener("click", () => {
    effectsPanel.classList.toggle("show");
    audioPanel?.classList.remove("show");
  });

  btnCloseEffects.addEventListener("click", () => {
    effectsPanel.classList.remove("show");
  });

  sliderBrightness.addEventListener("input", applyFilters);
  sliderContrast.addEventListener("input", applyFilters);
  sliderSaturate.addEventListener("input", applyFilters);
  sliderGamma?.addEventListener("input", applyFilters);
  sliderHue?.addEventListener("input", applyFilters);


  btnResetFilters.addEventListener("click", () => {
    sliderBrightness.value = 100;
    sliderContrast.value = 100;
    sliderSaturate.value = 100;
    if (sliderGamma) sliderGamma.value = 0;
    if (sliderHue) sliderHue.value = 0;
    applyFilters();
    app.subtitles.setDelay(0);
  });

  // GPU Compatibility Mode (adds --disable-gpu-compositing; requires restart)
  if (checkCompatMode) {
    if (invoke) {
      invoke("get_compat_mode")
        .then((on) => { checkCompatMode.checked = !!on; })
        .catch((e) => console.warn("get_compat_mode", e));
      checkCompatMode.addEventListener("change", () => {
        const on = checkCompatMode.checked;
        if (!window.confirm(t(on ? "effects.compatOnConfirm" : "effects.compatOffConfirm"))) {
          checkCompatMode.checked = !on;
          return;
        }
        invoke("set_compat_mode", { enabled: on }).catch((e) => {
          console.error("set_compat_mode", e);
          checkCompatMode.checked = !on;
          app.toast(t("effects.compatFailed"));
        });
      });
    } else {
      checkCompatMode.closest("label")?.remove();
    }
  }

  // ------------------------------------------------------------------------
  // Enhance panel
  // ------------------------------------------------------------------------
  // Media-type layout: photo controls only with a photo, sound/video controls otherwise
  const syncMedia = (type) => { document.documentElement.dataset.media = type || "none"; };
  syncMedia(state.get("currentMediaType"));

  btnToggleAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.toggle("show");
    effectsPanel?.classList.remove("show");
    playlistDrawer?.classList.remove("open");
  });

  btnCloseAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.remove("show");
  });

  function renderMasterStatus() {
    if (!aiMasterStatus) return;
    const enabled = !!state.get("isAiRestoreEnabled");
    const gpu = !!app.capabilities?.isAvailable("video.gpuFilter");
    aiMasterStatus.textContent = t(masterStatusKey(enabled, app.engine?.kind, gpu));
    aiMasterStatus.style.color = enabled ? "var(--accent-ruby-bright)" : "var(--text-muted)";
  }

  function updateAiMasterState(enabled) {
    state.set("isAiRestoreEnabled", enabled);
    if (checkAiMaster) checkAiMaster.checked = enabled;
    app.audio.syncRestore();
    applyFilters();
    renderMasterStatus();

    if (enabled) {
      if (aiRestoreBadge) aiRestoreBadge.style.display = "inline-block";
    } else {
      if (aiRestoreBadge) aiRestoreBadge.style.display = "none";
      if (state.get("isSplitViewActive")) {
        toggleSplitView(false);
      }
    }
  }

  const filtersToast = () => app.toast(t(state.get("isAiRestoreEnabled") ? "enhance.toastOn" : "enhance.toastOff"));

  /** A key (video and photo): flip the master switch and confirm. */
  function toggleAiMaster() {
    updateAiMasterState(!state.get("isAiRestoreEnabled"));
    filtersToast();
  }

  checkAiMaster?.addEventListener("change", () => {
    updateAiMasterState(checkAiMaster.checked);
    filtersToast();
  });

  const presetButtons = document.querySelectorAll(".btn-restore-preset");
  presetButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      presetButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const p = AI_PRESETS[btn.dataset.preset];

      if (p) {
        state.set("aiSharpLevel", p.sharp);
        if (sliderAiSharp) sliderAiSharp.value = p.sharp;
        if (valAiSharp) valAiSharp.textContent = sharpLabel(p.sharp);
        state.set("aiContrastBoost", p.contrast);
        if (sliderAiContrast) sliderAiContrast.value = p.contrast;
        if (valAiContrast) valAiContrast.textContent = `+${p.contrast}%`;
        if (checkAiVoiceClarity) checkAiVoiceClarity.checked = p.voice;
        if (checkAiDenoise) checkAiDenoise.checked = p.denoise;
        if (checkAiCompressor) checkAiCompressor.checked = p.comp;
      }

      if (!state.get("isAiRestoreEnabled")) {
        updateAiMasterState(true);
      } else {
        app.audio.syncRestore();
        applyFilters();
      }
      app.toast(t("enhance.presetToast", { name: btn.textContent.trim() }));
    });
  });

  function markCustomPreset() {
    presetButtons.forEach(b => b.classList.remove("active"));
    document.querySelector('.btn-restore-preset[data-preset="custom"]')?.classList.add("active");
  }

  sliderAiSharp?.addEventListener("input", () => {
    const level = state.set("aiSharpLevel", parseInt(sliderAiSharp.value, 10));
    valAiSharp.textContent = sharpLabel(level);
    markCustomPreset();
    if (!state.get("isAiRestoreEnabled")) updateAiMasterState(true);
    else applyFilters();
  });

  sliderAiContrast?.addEventListener("input", () => {
    const boost = state.set("aiContrastBoost", parseInt(sliderAiContrast.value, 10));
    valAiContrast.textContent = `+${boost}%`;
    markCustomPreset();
    if (!state.get("isAiRestoreEnabled")) updateAiMasterState(true);
    else applyFilters();
  });

  [checkAiVoiceClarity, checkAiDenoise, checkAiCompressor].forEach((check) => {
    check?.addEventListener("change", () => {
      if (!state.get("isAiRestoreEnabled")) updateAiMasterState(true);
      else app.audio.syncRestore();
    });
  });

  // Split-screen A/B comparison (left half original, right half processed by the shader).
  // Offered only where the capability says the WebGL2 shader draws the frame: with libmpv
  // (mpv draws natively) or without WebGL2 the button is disabled and the reason is shown.
  function renderCompare() {
    const reason = compareReasonKey(app.capabilities?.get("video.compare"));
    if (btnToggleSplitView) {
      btnToggleSplitView.disabled = !!reason;
      btnToggleSplitView.setAttribute("aria-disabled", reason ? "true" : "false");
      btnToggleSplitView.title = reason ? t(reason) : "";
    }
    if (splitViewReason) {
      splitViewReason.hidden = !reason;
      splitViewReason.textContent = reason ? t(reason) : "";
    }
    const on = !reason && !!state.get("isSplitViewActive");
    if (splitViewStatus) {
      splitViewStatus.textContent = t(reason ? "enhance.compareUnavailable" : on ? "enhance.on" : "enhance.off");
      splitViewStatus.style.color = on ? "var(--accent-ruby-bright)" : "";
    }
    return reason;
  }

  function toggleSplitView(forceState) {
    const next = typeof forceState === "boolean" ? forceState : !state.get("isSplitViewActive");
    const reason = compareReasonKey(app.capabilities?.get("video.compare"));
    if (next && reason) {
      app.toast(`⚠️ ${t(reason)}`);
      return;
    }
    state.set("isSplitViewActive", next);
    if (next && !state.get("isAiRestoreEnabled")) {
      updateAiMasterState(true);
    }
    renderCompare();
    if (splitScreenBanner) {
      splitScreenBanner.style.display = next ? "flex" : "none";
    }
    if (splitScreenLine) {
      splitScreenLine.style.display = next ? "block" : "none";
    }
    applyFilters();
    app.toast(t(next ? "enhance.compareOnToast" : "enhance.compareOffToast"));
  }

  btnToggleSplitView?.addEventListener("click", () => toggleSplitView());

  /** Engine switched (per item), media type or language changed: refresh the dynamic parts. */
  function refresh() {
    renderMasterStatus();
    // a running A/B view ends when the new engine cannot draw it (e.g. switch to libmpv)
    if (renderCompare() && state.get("isSplitViewActive")) {
      state.set("isSplitViewActive", false);
      if (splitScreenBanner) splitScreenBanner.style.display = "none";
      if (splitScreenLine) splitScreenLine.style.display = "none";
    }
    if (valAiSharp) valAiSharp.textContent = sharpLabel(state.get("aiSharpLevel"));
  }
  state.subscribe?.("currentMediaType", (type) => { syncMedia(type); refresh(); });
  app.bus?.on?.("engine:changed", refresh);
  app.bus?.on?.("capabilities:changed", refresh);
  i18n.onChange(refresh);
  refresh();

  return { setAiMaster: updateAiMasterState, toggleAiMaster, toggleSplitView, refresh };
}
