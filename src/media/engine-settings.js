// ==========================================================================
// libmpv engine options in the Settings window (core/settings.js registration API)
// and their wiring to the engine:
//   subtitle.position (+ B2's subtitle.fontScale / subtitle.color) -> sub-pos / sub-scale / sub-color
//   audio.eqPreset, audio.eqGains, audio.normalize                 -> media/audio-fx.js (af chain)
//   engine.hwdec, engine.fastProfile                               -> hwdec, profile=fast
// ==========================================================================

import { EQ_BANDS, EQ_PRESETS } from "./engine/engine.js";
import { t } from "../core/i18n.js";

/** mpv option values of profile=fast and the gpu-next defaults it replaces. */
export const FAST_PROFILE_DEFAULTS = Object.freeze({
  scale: "lanczos", dscale: "hermite", cscale: "lanczos", dither: "fruit",
  "correct-downscaling": true, "linear-downscaling": true, "sigmoid-upscaling": true, "hdr-compute-peak": "auto",
});

/** "auto" follows the GPU: profile=fast on integrated GPUs (little dedicated VRAM). */
export const wantFastProfile = (setting, gpu) => (setting === "auto" ? !!gpu?.integrated : setting === "on");

const validGains = (v) => Array.isArray(v?.gains) && v.gains.length === EQ_BANDS.length &&
  v.gains.every((g) => typeof g === "number" && g >= -12 && g <= 12);

/**
 * app: { settings, engine, engineStatus, subtitles, audioFx, toast, bus, dom }
 */
export function registerEngineSettings(app) {
  const { settings } = app;
  if (!settings?.register) return;
  const status = app.engineStatus ?? {};
  const presetOptions = [
    ...Object.entries(EQ_PRESETS).map(([value, p]) => ({ value, labelKey: p.labelKey })),
    { value: "custom", labelKey: "audio.eq.custom" },
  ];

  settings.register("subtitle", [
    {
      key: "subtitle.position", type: "number", min: 50, max: 100, integer: true, default: 100,
      control: "range", step: 1, labelKey: "settings.fields.subPosition",
      helpKey: "settings.help.subPosition",
    },
  ]);

  settings.register("audio", [
    { control: "heading", labelKey: "settings.headings.eq" },
    { key: "audio.eqPreset", type: "enum", values: presetOptions.map((o) => o.value), default: "flat",
      control: "select", labelKey: "settings.fields.eqPreset", options: presetOptions },
    { key: "audio.normalize", type: "boolean", default: false, control: "toggle",
      labelKey: "ui.audio.normalize", helpKey: "settings.help.normalize" },
    { key: "audio.eqGains", type: "object", default: { gains: EQ_BANDS.map(() => 0) }, validate: validGains,
      control: "custom", render: (row) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-secondary btn-sm";
        b.dataset.i18n = "settings.buttons.openEq";
        b.textContent = t("settings.buttons.openEq");
        b.addEventListener("click", () => {
          app.settingsModal?.close?.();
          app.dom.audioPanel.classList.add("show");
        });
        row.append(b);
      } },
  ]);

  settings.register("advanced", [
    { control: "heading", labelKey: "ui.effects.engine" },
    { control: "custom", render: (row) => {
      const p = document.createElement("p");
      p.className = "engine-info";
      p.textContent = app.dom.engineInfo?.textContent ?? "";
      row.append(p);
    } },
    { key: "engine.hwdec", type: "enum", values: ["auto-safe", "no"], default: "auto-safe", control: "select",
      labelKey: "settings.fields.hwdec",
      options: [{ value: "auto-safe", labelKey: "settings.options.hwdecAuto" }, { value: "no", labelKey: "settings.options.hwdecOff" }] },
    { key: "engine.fastProfile", type: "enum", values: ["auto", "on", "off"], default: "auto", control: "select",
      labelKey: "settings.fields.fastProfile",
      helpKey: status.gpu?.name ? (status.gpu.integrated ? "settings.help.fastProfileGpuIntegrated" : "settings.help.fastProfileGpu") : "settings.help.fastProfile",
      helpVars: status.gpu?.name ? { gpu: status.gpu.name } : undefined,
      options: [{ value: "auto", labelKey: "settings.options.fastAuto" }, { value: "on", labelKey: "settings.options.on" }, { value: "off", labelKey: "settings.options.off" }] },
  ]);

  // ------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------
  const mpv = () => app.engine.kind === "mpv";
  const set = (k, v) => app.engine.set(k, v).catch(() => {});

  function applySubtitleStyle() {
    app.subtitles.setStyle({
      size: settings.get("subtitle.fontScale") ?? 100,
      color: settings.get("subtitle.color") ?? "#ffffff",
      pos: settings.get("subtitle.position") ?? 100,
    });
  }

  // The backend starts mpv with profile=fast on integrated GPUs
  let fastOn = !!status.gpu?.integrated;
  function applyEngineOptions() {
    if (!mpv()) return;
    set("hwdec", settings.get("engine.hwdec"));
    const want = wantFastProfile(settings.get("engine.fastProfile"), status.gpu);
    if (want === fastOn) return;
    fastOn = want;
    if (want) app.engine.impl.command(["apply-profile", "fast"]).catch(() => {});
    else for (const [k, v] of Object.entries(FAST_PROFILE_DEFAULTS)) set(k, v);
  }

  for (const k of ["subtitle.fontScale", "subtitle.color", "subtitle.position"]) settings.subscribe(k, applySubtitleStyle);
  settings.subscribe("engine.hwdec", (v) => {
    applyEngineOptions();
    app.toast(t(v === "no" ? "settings.toasts.hwdecOff" : "settings.toasts.hwdecAuto"));

  });
  settings.subscribe("engine.fastProfile", applyEngineOptions);
  app.bus.on("engine:changed", () => {
    applySubtitleStyle();
    applyEngineOptions();
  });
  Promise.resolve(settings.ready).then(() => {
    applySubtitleStyle();
    applyEngineOptions();
    app.audioFx?.loadFromSettings();
  }).catch(() => {});
}
