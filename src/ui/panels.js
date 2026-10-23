// ==========================================================================
// Side panels: effects (colour sliders, subtitle delay, compatibility mode)
// and AI video & audio restoration (master switch, presets, A/B split view).
// WebGL2 CAS shader + Web Audio DSP pipeline, 100% local.
// ==========================================================================

import { invoke } from "../core/tauri.js";

/** Presets (data-driven). */
export const AI_PRESETS = {
  "144p":   { sharp: 2, contrast: 8,  voice: true,  denoise: true,  comp: true, label: "Seviye 2 (Keskin)" },
  "voice":  { sharp: 1, contrast: 5,  voice: true,  denoise: true,  comp: true, label: "Seviye 1 (Doğal)" },
  "cinema": { sharp: 3, contrast: 12, voice: false, denoise: false, comp: true, label: "Seviye 3 (Ultra Detay)" },
};

/** Sharpness slider label. */
export const sharpLabel = (level) => level === 0 ? "Kapalı" : (level === 3 ? "Seviye 3 (Ultra)" : `Seviye ${level}`);

/**
 * app: { dom, state, toast, filters, audio, subtitles, playlist }  (resolved lazily)
 */
export function createPanels(app) {
  const { dom, state } = app;
  const {
    effectsPanel, btnToggleEffects, btnCloseEffects, sliderBrightness, sliderContrast, sliderSaturate,
    btnResetFilters, checkCompatMode, btnToggleAiRestore, aiRestorePanel, btnCloseAiRestore, checkAiMaster,
    aiMasterStatus, aiRestoreBadge, sliderAiSharp, valAiSharp, sliderAiContrast, valAiContrast,
    checkAiVoiceClarity, checkAiDenoise, checkAiCompressor, btnToggleSplitView, splitViewStatus,
    splitScreenBanner, splitScreenLine, playlistDrawer,
  } = dom;
  const applyFilters = () => app.filters.apply();

  // ------------------------------------------------------------------------
  // Effects panel
  // ------------------------------------------------------------------------
  btnToggleEffects.addEventListener("click", () => {
    effectsPanel.classList.toggle("show");
  });

  btnCloseEffects.addEventListener("click", () => {
    effectsPanel.classList.remove("show");
  });

  sliderBrightness.addEventListener("input", applyFilters);
  sliderContrast.addEventListener("input", applyFilters);
  sliderSaturate.addEventListener("input", applyFilters);

  btnResetFilters.addEventListener("click", () => {
    sliderBrightness.value = 100;
    sliderContrast.value = 100;
    sliderSaturate.value = 100;
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
        const msg = on
          ? "Uyumluluk Modu açılacak ve uygulama yeniden başlayacak. Devam edilsin mi?"
          : "Uyumluluk Modu kapatılacak ve uygulama yeniden başlayacak. Devam edilsin mi?";
        if (!window.confirm(msg)) {
          checkCompatMode.checked = !on;
          return;
        }
        invoke("set_compat_mode", { enabled: on }).catch((e) => {
          console.error("set_compat_mode", e);
          checkCompatMode.checked = !on;
          app.toast("⚠️ Uyumluluk modu değiştirilemedi");
        });
      });
    } else {
      checkCompatMode.closest("label")?.remove();
    }
  }

  // ------------------------------------------------------------------------
  // AI restoration panel
  // ------------------------------------------------------------------------
  btnToggleAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.toggle("show");
    effectsPanel?.classList.remove("show");
    playlistDrawer?.classList.remove("open");
  });

  btnCloseAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.remove("show");
  });

  function updateAiMasterState(enabled) {
    state.set("isAiRestoreEnabled", enabled);
    if (checkAiMaster) checkAiMaster.checked = enabled;
    app.audio.syncRestore();
    applyFilters();

    if (enabled) {
      if (aiMasterStatus) {
        aiMasterStatus.textContent = app.filters.enhancer ? "Aktif (GPU & DSP Açık)" : "Aktif (CSS & DSP, WebGL2 yok)";
        aiMasterStatus.style.color = "var(--accent-ruby-bright)";
      }
      if (aiRestoreBadge) aiRestoreBadge.style.display = "inline-block";
    } else {
      if (aiMasterStatus) {
        aiMasterStatus.textContent = "Kapalı (Orijinal)";
        aiMasterStatus.style.color = "var(--text-muted)";
      }
      if (aiRestoreBadge) aiRestoreBadge.style.display = "none";
      if (state.get("isSplitViewActive")) {
        toggleSplitView(false);
      }
    }
  }

  /** A / R keys: flip the master switch and confirm with the given texts. */
  function toggleAiMaster(onText, offText) {
    updateAiMasterState(!state.get("isAiRestoreEnabled"));
    app.toast(state.get("isAiRestoreEnabled") ? onText : offText);
  }

  checkAiMaster?.addEventListener("change", () => {
    updateAiMasterState(checkAiMaster.checked);
    app.toast(state.get("isAiRestoreEnabled") ? "AI Restorasyon & Netleştirici Devrede ✨" : "AI Restorasyon kapatıldı");
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
        if (valAiSharp) valAiSharp.textContent = p.label;
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
      app.toast(`Restorasyon Modu: ${btn.textContent.trim()}`);
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

  // Split-screen A/B comparison (left half original, right half processed by the shader)
  function toggleSplitView(forceState) {
    const next = typeof forceState === "boolean" ? forceState : !state.get("isSplitViewActive");
    if (next && !app.filters.enhancer) {
      app.toast("⚠️ A/B karşılaştırma için WebGL2 desteği gerekli");
      return;
    }
    state.set("isSplitViewActive", next);
    if (next && !state.get("isAiRestoreEnabled")) {
      updateAiMasterState(true);
    }
    if (splitViewStatus) {
      splitViewStatus.textContent = next ? "Açık" : "Kapalı";
      splitViewStatus.style.color = next ? "var(--accent-ruby-bright)" : "";
    }
    if (splitScreenBanner) {
      splitScreenBanner.style.display = next ? "flex" : "none";
    }
    if (splitScreenLine) {
      splitScreenLine.style.display = next ? "block" : "none";
    }
    applyFilters();
    app.toast(next ? "A/B Karşılaştırma Modu Açık" : "A/B Karşılaştırma Kapatıldı");
  }

  btnToggleSplitView?.addEventListener("click", () => toggleSplitView());

  return { setAiMaster: updateAiMasterState, toggleAiMaster, toggleSplitView };
}
