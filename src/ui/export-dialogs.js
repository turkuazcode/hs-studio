// ==========================================================================
// Video / music export dialogs (Plan 06 §3-§4): cut (lossless / frame accurate), GIF, short
// clip, convert presets, extract audio, permanent rotate, subtitles, contact sheet, audio
// convert, ringtone / excerpt, ReplayGain. All exports run in the backend's LGPL ffmpeg
// (src-tauri/src/actions/ffmpeg.rs) through dialogs.runJob (progress + cancel).
// ==========================================================================

import { t } from "../core/i18n.js";
import { dialogOpen, invoke } from "../core/tauri.js";
import {
  AUDIO_FORMATS, CONVERT_PRESETS, SEGMENT_FORMATS, checkRange, defaultRange, errorText, formatTimePrecise, parseTime,
} from "../media/actions-logic.js";
import { field, h, select } from "./action-dialogs.js";

/**
 * app: { dialogs, engine, timeline, settings, toast, loader }
 * current(): { item, kind } of the shown media (item.path is a local file).
 */
export function createExportDialogs(app, current) {
  const { dialogs } = app;
  const setting = (k, d) => app.settings?.get?.(k) ?? d;

  /** Export folder: next to the source (default) or Videos|Music\VHO (Settings). */
  async function outputDir(kind) {
    if (setting("actions.outputLocation", "source") !== "library") return undefined;
    try { return await invoke("export_dir", { kind }); } catch { return undefined; }
  }

  async function run(title, request, kind = "video") {
    const { item } = current();
    if (!item?.path) return null;
    const dir = await outputDir(kind);
    return dialogs.runJob({ title, request: { input: item.path, ...(dir ? { outputDir: dir } : {}), ...request } });
  }

  // ------------------------------------------------------------------------
  // Range based exports
  // ------------------------------------------------------------------------
  const RANGE = {
    cut: { titleKey: "actions.export.cutTitle", length: 30 },
    gif: { titleKey: "actions.export.gifTitle", length: 5 },
    clip: { titleKey: "actions.export.clipTitle", length: 30 },
    segment: { titleKey: "actions.export.segmentTitle", length: 30 },
  };

  /** mode: "cut" | "gif" | "clip" | "segment" */
  function openRange(mode) {
    const cfg = RANGE[mode];
    const duration = app.engine.duration;
    const r = defaultRange({ loop: app.timeline?.loop, time: app.engine.time, duration }, cfg.length);
    const startIn = h("input", { id: "vho-range-start", class: "modal-input vho-time", type: "text", value: formatTimePrecise(r.start) });
    const endIn = h("input", { id: "vho-range-end", class: "modal-input vho-time", type: "text", value: formatTimePrecise(r.end) });
    const now = (input) => h("button", {
      type: "button", class: "btn-ghost btn-sm", text: t("actions.export.now"), title: t("actions.export.nowHint"),
      onclick: () => { input.value = formatTimePrecise(app.engine.time); update(); },
    });
    const lengthOut = h("span", { class: "vho-act-hint" });
    const extra = [];
    let precise, gifWidth, gifFps, format;
    if (mode === "cut") {
      precise = h("input", { id: "vho-range-precise", type: "checkbox" });
      extra.push(h("label", { class: "vho-act-check" }, precise, h("span", { text: t("actions.export.precise") })));
      extra.push(h("small", { class: "vho-act-hint", text: t("actions.export.losslessHint") }));
    } else if (mode === "gif") {
      gifWidth = select("vho-gif-width", [320, 480, 640, 800].map((v) => ({ value: v, label: `${v} px` })), setting("actions.gifWidth", 480));
      gifFps = select("vho-gif-fps", [8, 10, 12, 15, 20].map((v) => ({ value: v, label: `${v} fps` })), setting("actions.gifFps", 12));
      extra.push(h("div", { class: "vho-act-row" }, field(t("actions.export.width"), gifWidth), field(t("actions.export.fps"), gifFps)));
    } else if (mode === "segment") {
      format = select("vho-seg-format", SEGMENT_FORMATS.map((f) => ({ value: f, label: t(`actions.formats.${f}`) })), "aac");
      extra.push(field(t("actions.export.format"), format));
    }
    if (r.fromLoop) extra.unshift(h("small", { class: "vho-act-hint", text: t("actions.export.fromLoop") }));

    function update() {
      const s = parseTime(startIn.value), e = parseTime(endIn.value);
      const err = checkRange(s, e, duration);
      lengthOut.textContent = err ? "" : t("actions.export.length", { t: formatTimePrecise(e - s) });
      return err ? { err } : { s, e };
    }
    startIn.addEventListener("input", update);
    endIn.addEventListener("input", update);
    update();

    dialogs.open({
      id: "vho-range", title: t(cfg.titleKey), enterAction: "ok",
      body: [
        h("div", { class: "vho-act-row" },
          field(t("actions.export.start"), h("span", { class: "vho-act-inline" }, startIn, now(startIn))),
          field(t("actions.export.end"), h("span", { class: "vho-act-inline" }, endIn, now(endIn)))),
        lengthOut, ...extra,
      ],
      actions: [
        { id: "cancel", label: t("actions.common.cancel"), cancel: true },
        {
          id: "ok", label: t("actions.export.save"), primary: true,
          run: (dlg) => {
            const v = update();
            if (v.err) {
              dlg.setStatus(t(`actions.export.rangeError.${v.err}`), "error");
              return false;
            }
            const range = { start: v.s, end: v.e };
            let req;
            if (mode === "cut") req = { kind: "cut", ...range, precise: precise.checked };
            else if (mode === "gif") {
              req = { kind: "gif", ...range, width: Number(gifWidth.value), fps: Number(gifFps.value) };
              app.settings?.set?.("actions.gifWidth", Number(gifWidth.value));
              app.settings?.set?.("actions.gifFps", Number(gifFps.value));
            } else if (mode === "clip") req = { kind: "clip", ...range };
            else req = { kind: "segment", ...range, format: format.value };
            dlg.close("ok");
            run(t(cfg.titleKey), req, mode === "segment" ? "music" : "video");
            return true;
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------
  // Choice based exports
  // ------------------------------------------------------------------------
  /** Radio list dialog: resolves the chosen value or null. */
  function choose({ id, title, options, value, note, extra = [] }) {
    return new Promise((resolve) => {
      let picked = null;
      const name = `${id}-opt`;
      const list = h("div", { class: "vho-act-choices", role: "radiogroup" }, options.map((o) => h("label", { class: "vho-act-choice" },
        h("input", { type: "radio", name, value: String(o.value), checked: String(o.value) === String(value), id: `${id}-${o.value}` }),
        h("span", { class: "vho-act-choice-text" }, h("strong", { text: o.label }), o.hint ? h("small", { text: o.hint }) : null))));
      dialogs.open({
        id, title, body: [list, ...extra, note ? h("small", { class: "vho-act-hint", text: note }) : null],
        onClose: () => resolve(picked),
        actions: [
          { id: "cancel", label: t("actions.common.cancel"), cancel: true },
          {
            id: "ok", label: t("actions.export.save"), primary: true,
            run: () => { picked = list.querySelector("input:checked")?.value ?? null; return true; },
          },
        ],
      });
    });
  }

  async function openConvert() {
    const preset = await choose({
      id: "vho-convert", title: t("actions.export.convertTitle"), value: "720p",
      options: CONVERT_PRESETS.map((p) => ({ value: p, label: t(`actions.presets.${p}`), hint: t(`actions.presets.${p}Hint`) })),
    });
    if (preset) run(t("actions.export.convertTitle"), { kind: "convert", preset });
  }

  async function openExtractAudio() {
    const format = await choose({
      id: "vho-extract-audio", title: t("actions.export.extractAudioTitle"), value: "copy",
      options: AUDIO_FORMATS.map((f) => ({ value: f, label: t(`actions.formats.${f}`) })),
    });
    if (format) run(t("actions.export.extractAudioTitle"), { kind: "extractAudio", format }, "music");
  }

  async function openAudioConvert() {
    const format = await choose({
      id: "vho-audio-convert", title: t("actions.export.audioConvertTitle"), value: "aac",
      options: AUDIO_FORMATS.filter((f) => f !== "copy").map((f) => ({ value: f, label: t(`actions.formats.${f}`) })),
    });
    if (format) run(t("actions.export.audioConvertTitle"), { kind: "extractAudio", format }, "music");
  }

  async function openRotate() {
    const reencode = h("input", { id: "vho-rotate-reencode", type: "checkbox" });
    const degrees = await choose({
      id: "vho-rotate", title: t("actions.export.rotateTitle"), value: 90,
      options: [90, 180, 270].map((d) => ({ value: d, label: t(`actions.export.rotate${d}`) })),
      extra: [h("label", { class: "vho-act-check" }, reencode, h("span", { text: t("actions.export.rotateReencode") }))],
      note: t("actions.export.rotateHint"),
    });
    if (degrees) run(t("actions.export.rotateTitle"), { kind: "rotate", degrees: Number(degrees), reencode: reencode.checked });
  }

  async function embedSubtitle() {
    if (!dialogOpen) return;
    const picked = await dialogOpen({ multiple: false, filters: [{ name: t("actions.export.subtitleFiles"), extensions: ["srt", "ass", "ssa", "vtt"] }] }).catch(() => null);
    const subtitle = Array.isArray(picked) ? picked[0] : picked;
    if (subtitle) run(t("actions.export.embedSubTitle"), { kind: "embedSubtitle", subtitle });
  }

  async function openExtractSubtitle() {
    const { item } = current();
    let info;
    try {
      info = await invoke("media_probe", { path: item.path });
    } catch (e) {
      app.toast(`⚠️ ${errorText(e)}`);
      return;
    }
    const subs = info.subtitles ?? [];
    if (!subs.length) {
      app.toast(t("actions.export.noSubtitles"));
      return;
    }
    const fmt = select("vho-sub-format", ["srt", "ass", "vtt"].map((f) => ({ value: f, label: f.toUpperCase() })), "srt");
    const stream = await choose({
      id: "vho-extract-sub", title: t("actions.export.extractSubTitle"), value: subs.find((s) => s.text)?.index ?? 0,
      options: subs.map((s) => ({
        value: s.index,
        label: [s.title, s.language?.toUpperCase(), s.codec].filter(Boolean).join(" · ") || t("actions.export.track", { n: s.index + 1 }),
        hint: s.text ? "" : t("actions.export.bitmapSub"),
      })),
      extra: [field(t("actions.export.format"), fmt)],
    });
    if (stream !== null) run(t("actions.export.extractSubTitle"), { kind: "extractSubtitle", stream: Number(stream), format: fmt.value });
  }

  async function contactSheet() {
    const grid = await choose({
      id: "vho-sheet", title: t("actions.export.sheetTitle"), value: "4x4",
      options: ["3x3", "4x4", "5x5", "4x6"].map((g) => ({ value: g, label: t("actions.export.sheetGrid", { g: g.replace("x", " × ") }) })),
    });
    if (!grid) return;
    const [columns, rows] = grid.split("x").map(Number);
    run(t("actions.export.sheetTitle"), { kind: "contactSheet", columns, rows, width: 320 }, "photo");
  }

  /** ReplayGain: measure (ebur128) and write the track gain into the tags. */
  async function replayGain({ write = true } = {}) {
    const { item } = current();
    if (!item?.path) return null;
    const d = dialogs.open({ id: "vho-replaygain", title: t("actions.music.replayGainTitle"), body: h("p", { text: item.name }), actions: [] });
    d.setBusy(true);
    d.setProgress(0.5);
    d.setStatus(t("actions.music.measuring"));
    d.onCancel(() => {});
    try {
      const res = await invoke("replaygain_analyze", { path: item.path, write });
      d.el.dataset.gain = String(res.trackGainDb);
      d.setStatus(t("actions.music.replayGainResult", {
        lufs: res.integratedLufs.toFixed(1), gain: `${res.trackGainDb > 0 ? "+" : ""}${res.trackGainDb.toFixed(2)}`, peak: res.truePeakDbfs.toFixed(1),
      }), "ok");
      return res;
    } catch (e) {
      d.setStatus(errorText(e), "error");
      return null;
    } finally {
      d.setBusy(false);
      d.setProgress(null);
      d.onCancel(null);
      d.setActions([{ id: "close", label: t("actions.common.close"), primary: true }]);
    }
  }

  return { openRange, openConvert, openExtractAudio, openAudioConvert, openRotate, embedSubtitle, openExtractSubtitle, contactSheet, replayGain };
}
