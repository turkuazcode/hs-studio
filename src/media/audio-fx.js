// ==========================================================================
// Audio panel (libmpv): 10-band equalizer with presets, loudness
// normalisation, audio delay (±50 ms steps). The AI audio-restoration switches
// join the same lavfi chain while libmpv plays (the Web Audio graph only exists
// for the HTML5 engine's <video> element).
// ==========================================================================

import { EQ_BANDS, EQ_PRESETS, audioFilterChain } from "./engine/engine.js";
import { t } from "../core/i18n.js";

/** "+50 ms" / "0 ms" / "-100 ms" */
export const formatAudioDelay = (ms) => `${ms > 0 ? "+" : ""}${ms} ms`;

/** Band label: 1000 -> "1k", 16000 -> "16k". */
export const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

/**
 * app: { dom, engine, audio, toast, bus, settings? }
 * Persisted in the settings store (audio.eqPreset, audio.eqGains, audio.normalize; registered by
 * media/engine-settings.js), so the Settings window and this panel stay in sync.
 */
export function createAudioFx(app) {
  const { dom, engine } = app;
  const {
    btnToggleAudioPanel, audioPanel, btnCloseAudioPanel, valAudioDelay, btnAudioMinus, btnAudioReset, btnAudioPlus,
    checkAudioNormalize, selectEqPreset, eqBands, effectsPanel, aiRestorePanel,
  } = dom;

  const settings = app.settings;
  let gains = EQ_BANDS.map(() => 0);
  let preset = "flat";
  let normalize = false;
  let delayMs = 0; // per file, not persisted
  let lastChain = null;
  let persisting = false;

  function persist() {
    if (!settings?.field?.("audio.eqGains")) return;
    persisting = true;
    try {
      settings.set("audio.eqGains", { gains: [...gains] });
      settings.set("audio.eqPreset", preset);
      settings.set("audio.normalize", normalize);
    } finally {
      persisting = false;
    }
  }

  /** Settings store -> panel + filter chain (startup and changes made in the Settings window). */
  function loadFromSettings() {
    if (!settings?.field?.("audio.eqGains")) return;
    const g = settings.get("audio.eqGains")?.gains;
    if (Array.isArray(g) && g.length === EQ_BANDS.length) gains = [...g];
    preset = settings.get("audio.eqPreset") ?? preset;
    if (EQ_PRESETS[preset]) gains = [...EQ_PRESETS[preset].gains];
    normalize = !!settings.get("audio.normalize");
    render();
    apply();
  }
  for (const k of ["audio.eqGains", "audio.eqPreset", "audio.normalize"]) {
    settings?.subscribe?.(k, () => { if (!persisting) loadFromSettings(); });
  }

  // ------------------------------------------------------------------------
  // Panel
  // ------------------------------------------------------------------------
  btnToggleAudioPanel.addEventListener("click", () => {
    audioPanel.classList.toggle("show");
    effectsPanel.classList.remove("show");
    aiRestorePanel?.classList.remove("show");
  });
  btnCloseAudioPanel.addEventListener("click", () => audioPanel.classList.remove("show"));

  for (const [id, p] of Object.entries(EQ_PRESETS)) {
    const o = Object.assign(document.createElement("option"), { value: id, textContent: t(p.labelKey) });
    o.dataset.i18n = p.labelKey; // re-translated with the rest of the page
    selectEqPreset.append(o);
  }
  const customOpt = Object.assign(document.createElement("option"), { value: "custom", textContent: t("audio.eq.custom") });
  customOpt.dataset.i18n = "audio.eq.custom";
  selectEqPreset.append(customOpt);

  const sliders = EQ_BANDS.map((f, i) => {
    const col = document.createElement("label");
    col.className = "eq-band";
    const val = document.createElement("span");
    val.className = "eq-val";
    const input = Object.assign(document.createElement("input"), {
      type: "range", min: -12, max: 12, step: 1, value: gains[i], className: "eq-slider",
    });
    input.setAttribute("orient", "vertical");
    input.dataset.band = f;
    input.setAttribute("aria-label", `${bandLabel(f)} Hz`);
    const name = document.createElement("span");
    name.className = "eq-freq";
    name.textContent = bandLabel(f);
    input.addEventListener("input", () => {
      gains[i] = Number(input.value);
      preset = "custom";
      selectEqPreset.value = "custom";
      render();
      apply();
      persist();
    });
    col.append(val, input, name);
    eqBands.append(col);
    return { input, val };
  });

  function render() {
    sliders.forEach(({ input, val }, i) => {
      input.value = gains[i];
      val.textContent = gains[i] > 0 ? `+${gains[i]}` : String(gains[i]);
    });
    selectEqPreset.value = preset;
    checkAudioNormalize.checked = normalize;
    valAudioDelay.textContent = formatAudioDelay(delayMs);
  }

  selectEqPreset.addEventListener("change", () => {
    preset = selectEqPreset.value;
    if (EQ_PRESETS[preset]) gains = [...EQ_PRESETS[preset].gains];
    render();
    apply();
    persist();
    app.toast(t("ui.audioFx.toastPreset", { name: selectEqPreset.selectedOptions[0]?.textContent ?? preset }));
  });

  checkAudioNormalize.addEventListener("change", () => {
    normalize = checkAudioNormalize.checked;
    apply();
    persist();
    app.toast(t(normalize ? "ui.audioFx.normalizeOn" : "ui.audioFx.normalizeOff"));
  });

  function setDelay(ms) {
    delayMs = ms;
    valAudioDelay.textContent = formatAudioDelay(ms);
    if (engine.kind === "mpv") engine.set("audio-delay", ms / 1000).catch(() => {});
  }
  const nudge = (d) => {
    setDelay(delayMs + d);
    app.toast(t("ui.audioFx.delay", { delay: formatAudioDelay(delayMs) }));
  };
  btnAudioMinus.addEventListener("click", () => nudge(-50));
  btnAudioPlus.addEventListener("click", () => nudge(50));
  btnAudioReset.addEventListener("click", () => {
    setDelay(0);
    app.toast(t("ui.audioFx.delayReset"));
  });

  // ------------------------------------------------------------------------
  // lavfi chain -> mpv `af`
  // ------------------------------------------------------------------------
  function apply(force = false) {
    if (engine.kind !== "mpv") return;
    const chain = audioFilterChain({ eq: gains, normalize, restore: app.audio.restoreSwitches, boost: app.audio.boostGain });
    if (!force && chain === lastChain) return;
    lastChain = chain;
    engine.setAudioFilters(chain).catch((e) => {
      console.warn("af", e);
      app.toast(t("ui.audioFx.failed"));

    });
  }
  app.audio.onRestoreChange = () => apply();

  render();
  app.bus.on("engine:changed", () => apply(true));

  return {
    loadFromSettings,
    /** New file: filters stay (mpv keeps `af`), the per-file audio delay starts at 0. */
    reapply() {
      setDelay(0);
      apply(true);
    },
    apply,
    setDelay,
    get chain() { return lastChain; },
    get gains() { return [...gains]; },
  };
}
