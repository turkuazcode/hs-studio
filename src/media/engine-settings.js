// ==========================================================================
// libmpv engine options in the Settings window (core/settings.js registration API)
// and their wiring to the engine:
//   subtitle.position (+ B2's subtitle.fontScale / subtitle.color) -> sub-pos / sub-scale / sub-color
//   audio.eqPreset, audio.eqGains, audio.normalize                 -> media/audio-fx.js (af chain)
//   engine.hwdec, engine.fastProfile                               -> hwdec, profile=fast
// ==========================================================================

import { EQ_BANDS, EQ_PRESETS } from "./engine/engine.js";

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
    ...Object.entries(EQ_PRESETS).map(([value, p]) => ({ value, label: p.label })),
    { value: "custom", label: "Özel" },
  ];

  settings.register("subtitle", [
    {
      key: "subtitle.position", type: "number", min: 50, max: 100, integer: true, default: 100,
      control: "range", step: 1, label: "Altyazı konumu (100 = en alt)",
      help: "libmpv: sub-pos. Kontrol çubuğu görünürken altyazı otomatik yükselir.",
    },
  ]);

  settings.register("audio", [
    { control: "heading", label: "Ekolayzır ve normalizasyon (libmpv)" },
    { key: "audio.eqPreset", type: "enum", values: presetOptions.map((o) => o.value), default: "flat",
      control: "select", label: "Ekolayzır hazır ayarı", options: presetOptions },
    { key: "audio.normalize", type: "boolean", default: false, control: "toggle",
      label: "Ses normalizasyonu", help: "Sessiz ve gürültülü sahneleri dengeler (dynaudnorm)." },
    { key: "audio.eqGains", type: "object", default: { gains: EQ_BANDS.map(() => 0) }, validate: validGains,
      control: "custom", render: (row) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn-secondary btn-sm";
        b.textContent = "10 bantlı ekolayzırı aç (Ses paneli)";
        b.addEventListener("click", () => {
          app.settingsModal?.close?.();
          app.dom.audioPanel.classList.add("show");
        });
        row.append(b);
      } },
  ]);

  settings.register("advanced", [
    { control: "heading", label: "Oynatma motoru" },
    { control: "custom", render: (row) => {
      const p = document.createElement("p");
      p.className = "engine-info";
      p.textContent = app.dom.engineInfo?.textContent ?? "";
      row.append(p);
    } },
    { key: "engine.hwdec", type: "enum", values: ["auto-safe", "no"], default: "auto-safe", control: "select",
      label: "Donanım ile video çözme",
      options: [{ value: "auto-safe", label: "Otomatik (önerilen)" }, { value: "no", label: "Kapalı (yazılım)" }] },
    { key: "engine.fastProfile", type: "enum", values: ["auto", "on", "off"], default: "auto", control: "select",
      label: "Hızlı görüntü profili (profile=fast)",
      help: `Dahili ekran kartlarında GPU yükünü azaltır.${status.gpu?.name ? ` Bu bilgisayar: ${status.gpu.name}${status.gpu.integrated ? " (dahili)" : ""}.` : ""}`,
      options: [{ value: "auto", label: "Otomatik (dahili GPU'da açık)" }, { value: "on", label: "Açık" }, { value: "off", label: "Kapalı" }] },
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
    app.toast(v === "no" ? "Donanım ile çözme kapalı" : "Donanım ile çözme otomatik");
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
