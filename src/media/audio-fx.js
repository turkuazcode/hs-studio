// ==========================================================================
// Audio panel (libmpv): 10-band equalizer with presets, loudness
// normalisation, audio delay (±50 ms steps). The AI audio-restoration switches
// join the same lavfi chain while libmpv plays (the Web Audio graph only exists
// for the HTML5 engine's <video> element).
// ==========================================================================

import { EQ_BANDS, EQ_PRESETS, audioFilterChain } from "./engine/engine.js";
import { loadJson, saveJson } from "../core/storage.js";

/** "+50 ms" / "0 ms" / "-100 ms" */
export const formatAudioDelay = (ms) => `${ms > 0 ? "+" : ""}${ms} ms`;

/** Band label: 1000 -> "1k", 16000 -> "16k". */
export const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

/**
 * app: { dom, engine, audio, toast, bus }
 */
export function createAudioFx(app) {
  const { dom, engine } = app;
  const {
    btnToggleAudioPanel, audioPanel, btnCloseAudioPanel, valAudioDelay, btnAudioMinus, btnAudioReset, btnAudioPlus,
    checkAudioNormalize, selectEqPreset, eqBands, effectsPanel, aiRestorePanel,
  } = dom;

  const saved = loadJson("vho_audio_fx", {});
  let gains = Array.isArray(saved.gains) && saved.gains.length === EQ_BANDS.length ? saved.gains : EQ_BANDS.map(() => 0);
  let preset = saved.preset ?? "flat";
  let normalize = !!saved.normalize;
  let delayMs = 0; // per file, not persisted
  let lastChain = null;

  const persist = () => saveJson("vho_audio_fx", { gains, preset, normalize });

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
    selectEqPreset.append(Object.assign(document.createElement("option"), { value: id, textContent: p.label }));
  }
  selectEqPreset.append(Object.assign(document.createElement("option"), { value: "custom", textContent: "Özel" }));

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
    app.toast(`Ekolayzır: ${selectEqPreset.selectedOptions[0]?.textContent ?? preset}`);
  });

  checkAudioNormalize.addEventListener("change", () => {
    normalize = checkAudioNormalize.checked;
    apply();
    persist();
    app.toast(normalize ? "Ses normalizasyonu açık" : "Ses normalizasyonu kapalı");
  });

  function setDelay(ms) {
    delayMs = ms;
    valAudioDelay.textContent = formatAudioDelay(ms);
    if (engine.kind === "mpv") engine.set("audio-delay", ms / 1000).catch(() => {});
  }
  const nudge = (d) => {
    setDelay(delayMs + d);
    app.toast(`Ses gecikmesi: ${formatAudioDelay(delayMs)}`);
  };
  btnAudioMinus.addEventListener("click", () => nudge(-50));
  btnAudioPlus.addEventListener("click", () => nudge(50));
  btnAudioReset.addEventListener("click", () => {
    setDelay(0);
    app.toast("Ses gecikmesi sıfırlandı");
  });

  // ------------------------------------------------------------------------
  // lavfi chain -> mpv `af`
  // ------------------------------------------------------------------------
  function apply(force = false) {
    if (engine.kind !== "mpv") return;
    const chain = audioFilterChain({ eq: gains, normalize, restore: app.audio.restoreSwitches });
    if (!force && chain === lastChain) return;
    lastChain = chain;
    engine.setAudioFilters(chain).catch((e) => {
      console.warn("af", e);
      app.toast("⚠️ Ses filtresi uygulanamadı");
    });
  }
  app.audio.onRestoreChange = () => apply();

  render();
  app.bus.on("engine:changed", () => apply(true));

  return {
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
