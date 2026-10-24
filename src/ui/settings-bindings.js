// ==========================================================================
// Persisted settings <-> existing player controls.
// Restores the stored values into the controls at startup, writes user changes back,
// and applies changes made in the Settings window. The player modules stay unaware of
// persistence: this module only drives their public API / DOM controls and observes them.
// ==========================================================================

import { sharpLabel } from "./panels.js";

/**
 * app: { dom, state, bus, settings, audio, subtitles, filters }
 */
export function initSettingsBindings(app) {
  const { dom, state, settings } = app;
  const {
    video, volumeSlider, volumeBadge, valSubDelay, sliderBrightness, sliderContrast, sliderSaturate,
    btnResetFilters, checkPcSleep, checkAiVoiceClarity, checkAiDenoise, checkAiCompressor, checkDeepFaces,
    sliderAiSharp, valAiSharp, sliderAiContrast, valAiContrast,
  } = dom;
  let applying = false; // true while we drive controls ourselves (no write-back)
  const observers = [];
  const quietly = (fn) => {
    applying = true;
    try { fn(); } finally {
      applying = false;
      for (const o of observers) o.takeRecords(); // drop the mutations we caused ourselves
    }
  };
  const watchText = (el, fn) => {
    const o = new MutationObserver(fn);
    o.observe(el, { childList: true, characterData: true, subtree: true });
    observers.push(o);
  };
  const save = (key, value) => { if (!applying) settings.set(key, value); };

  // ------------------------------------------------------------------------
  // Volume & mute. Boost (>100 %) needs the Web Audio graph, which is only built once
  // media plays: restore it on the first video load.
  // ------------------------------------------------------------------------
  function applyVolume() {
    const v = settings.get("playback.volume");
    quietly(() => {
      app.audio.setVolume(Math.min(v, 100));
      if (settings.get("playback.muted")) app.audio.setVolume(0);
    });
    return v;
  }
  // setVolume always rewrites the badge (slider, M key, arrow keys, mute button)
  watchText(volumeBadge, () => {
    if (applying) return;
    const v = parseInt(volumeSlider.value, 10);
    if (!Number.isFinite(v)) return;
    if (v === 0) save("playback.muted", true);
    else {
      save("playback.volume", v);
      save("playback.muted", false);
    }
  });
  watchText(valSubDelay, () => save("subtitle.delay", app.subtitles.delay));

  const initialVolume = applyVolume();
  if (initialVolume > 100) {
    const off = app.bus.on("media:loaded", ({ kind }) => {
      if (kind !== "video") return;
      off();
      if (!settings.get("playback.muted") && parseInt(volumeSlider.value, 10) === 100) {
        quietly(() => app.audio.setVolume(settings.get("playback.volume")));
      }
    });
  }
  // ------------------------------------------------------------------------
  // Speed & aspect (menu items in the HUD)
  // ------------------------------------------------------------------------
  const speedItems = () => [...document.querySelectorAll("#speed-menu .dropdown-item[data-speed]")];
  const aspectItems = () => [...document.querySelectorAll("#aspect-menu .dropdown-item[data-aspect]")];

  function applySpeed(speed) {
    const item = speedItems().find((i) => parseFloat(i.dataset.speed) === speed);
    if (item) quietly(() => item.click());
    video.defaultPlaybackRate = speed; // a new source keeps the chosen rate
  }
  function applyAspect(aspect) {
    const item = aspectItems().find((i) => i.dataset.aspect === aspect);
    if (item) quietly(() => item.click());
  }
  speedItems().forEach((i) => i.addEventListener("click", () => {
    const spd = parseFloat(i.dataset.speed);
    video.defaultPlaybackRate = spd;
    if (settings.get("playback.rememberSpeed")) save("playback.speed", spd);
  }));
  aspectItems().forEach((i) => i.addEventListener("click", () => save("playback.aspect", i.dataset.aspect)));

  if (settings.get("playback.rememberSpeed")) applySpeed(settings.get("playback.speed"));
  applyAspect(settings.get("playback.aspect"));
  settings.subscribe("playback.speed", applySpeed);
  settings.subscribe("playback.aspect", applyAspect);

  // ------------------------------------------------------------------------
  // Colour filters + subtitle delay (effects panel)
  // ------------------------------------------------------------------------
  const filterSliders = { "filters.brightness": sliderBrightness, "filters.contrast": sliderContrast, "filters.saturate": sliderSaturate };
  function applyFilters() {
    for (const [key, el] of Object.entries(filterSliders)) el.value = settings.get(key);
    app.filters.apply();
  }
  if (settings.get("playback.rememberFilters")) applyFilters();
  for (const [key, el] of Object.entries(filterSliders)) {
    el.addEventListener("input", () => save(key, parseInt(el.value, 10)));
    settings.subscribe(key, applyFilters);
  }
  btnResetFilters.addEventListener("click", () => {
    for (const [key, el] of Object.entries(filterSliders)) save(key, parseInt(el.value, 10));
  });

  quietly(() => app.subtitles.setDelay(settings.get("subtitle.delay")));
  settings.subscribe("subtitle.delay", (ms) => {
    if (app.subtitles.delay !== ms) quietly(() => app.subtitles.setDelay(ms));
  });

  // ------------------------------------------------------------------------
  // Subtitle style (CSS variables used by platform.css)
  // ------------------------------------------------------------------------
  function applySubtitleStyle() {
    const root = document.documentElement.style;
    root.setProperty("--sub-scale", String(settings.get("subtitle.fontScale") / 100));
    root.setProperty("--sub-color", settings.get("subtitle.color"));
    root.setProperty("--sub-bg-alpha", String(settings.get("subtitle.background") / 100));
  }
  applySubtitleStyle();
  ["subtitle.fontScale", "subtitle.color", "subtitle.background"].forEach((k) => settings.subscribe(k, applySubtitleStyle));

  // ------------------------------------------------------------------------
  // Sleep timer "PC Uyku" box (default OFF)
  // ------------------------------------------------------------------------
  if (checkPcSleep) {
    checkPcSleep.checked = settings.get("sleep.pcSleep") === true;
    checkPcSleep.addEventListener("change", () => save("sleep.pcSleep", checkPcSleep.checked));
    settings.subscribe("sleep.pcSleep", (v) => { checkPcSleep.checked = v; });
  }

  // ------------------------------------------------------------------------
  // AI panel switches (restored without turning the master switch on)
  // ------------------------------------------------------------------------
  const aiChecks = {
    "ai.voiceClarity": checkAiVoiceClarity,
    "ai.denoise": checkAiDenoise,
    "ai.compressor": checkAiCompressor,
    "ai.deepFaces": checkDeepFaces,
  };
  for (const [key, el] of Object.entries(aiChecks)) {
    if (!el) continue;
    el.checked = settings.get(key);
    el.addEventListener("change", () => save(key, el.checked));
    settings.subscribe(key, (v) => {
      if (el.checked === v) return;
      el.checked = v;
      if (state.get("isAiRestoreEnabled")) app.audio.syncRestore();
    });
  }
  function applyAiLevels() {
    const level = settings.get("ai.sharpLevel");
    const boost = settings.get("ai.contrastBoost");
    state.set("aiSharpLevel", level);
    state.set("aiContrastBoost", boost);
    if (sliderAiSharp) sliderAiSharp.value = level;
    if (valAiSharp) valAiSharp.textContent = sharpLabel(level);
    if (sliderAiContrast) sliderAiContrast.value = boost;
    if (valAiContrast) valAiContrast.textContent = `+${boost}%`;
    if (state.get("isAiRestoreEnabled")) app.filters.apply();
  }
  applyAiLevels();
  settings.subscribe("ai.sharpLevel", applyAiLevels);
  settings.subscribe("ai.contrastBoost", applyAiLevels);
  state.subscribe("aiSharpLevel", (v) => save("ai.sharpLevel", v));
  state.subscribe("aiContrastBoost", (v) => save("ai.contrastBoost", v));
  // Presets flip the checkboxes programmatically (no change event)
  document.querySelectorAll(".btn-restore-preset").forEach((btn) => btn.addEventListener("click", () => {
    for (const [key, el] of Object.entries(aiChecks)) if (el) save(key, el.checked);
  }));
}
