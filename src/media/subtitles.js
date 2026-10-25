// ==========================================================================
// Subtitle engine: SRT + VTT, UTF-8 / Windows-1254 (Turkish) decoding,
// O(log n) cue lookup, delay, CC button / menu.
// The parsing functions at the top are pure and unit tested.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { convertFileSrc } from "../core/tauri.js";

/** UTF-8 when valid, otherwise Windows-1254 (old Turkish subtitle files). */
export function decodeSubtitle(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1254").decode(buf);
  }
}

/** "00:01:02,500" / "01:02.5" -> seconds. */
export function timestampToSeconds(t) {
  const p = t.replace(",", ".").split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** SRT/VTT text -> [{ start, end, text }] sorted by start. Strips BOM, CRLF, HTML and ASS tags. */
export function parseCues(text) {
  const re = /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const cues = [];
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (const m of src.matchAll(re)) {
    const body = m[3].replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
    if (body) cues.push({ start: timestampToSeconds(m[1]), end: timestampToSeconds(m[2]), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Binary search for the cue showing at time t (start and end inclusive), or null. */
export function findCue(cues, t) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = cues[mid];
    if (t < c.start) hi = mid - 1;
    else if (t > c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

/** "+100 ms", "0 ms", "-50 ms" */
export const formatDelay = (ms) => `${ms > 0 ? "+" : ""}${ms} ms`;

/**
 * Subtitle controller.
 * deps: { dom, bus, toast(msg), openSearch(), engine() -> engine facade }
 *
 * Two renderers: the app's own overlay (SRT/VTT parsed here; any engine) and, with libmpv,
 * mpv/libass itself (embedded tracks, ASS styling, files added with `sub-add`).
 */
export function createSubtitles({ dom, bus, toast, openSearch, engine = () => null }) {
  const {
    subtitleText, subTrackList, btnToggleSubtitles, subStatusLabel, subtitlesMenu, subMenuToggle, subMenuToggleText,
    subMenuSearch, subMenuBrowse, subMenuClear, subFileInput, subtitleSearchModal, speedMenu, aspectMenu,
    valSubDelay, btnSubMinus, btnSubPlus, btnSubReset,
  } = dom;

  let subtitles = [];
  let subtitlesEnabled = true;
  let subtitleDelay = 0; // ms
  let lastTime = 0;
  let nativeTracks = []; // libmpv subtitle tracks
  let lastNativeSid = null;
  const mpv = () => engine()?.kind === "mpv";
  const nativeSelected = () => nativeTracks.find((t) => t.selected) ?? null;

  function updateSubtitleUi() {
    renderTrackList();
    if (!btnToggleSubtitles) return;
    if (!subtitles.length && nativeTracks.length) {
      const on = !!nativeSelected();
      btnToggleSubtitles.classList.toggle("sub-active", on);
      btnToggleSubtitles.classList.toggle("sub-disabled", !on);
      subStatusLabel.textContent = t(on ? "ui.subs.ccOn" : "ui.subs.ccOff");
      if (subMenuToggleText) subMenuToggleText.textContent = t(on ? "ui.subs.menuOff" : "ui.subs.menuOn");
      if (subMenuToggle) subMenuToggle.classList.toggle("active", on);
      subtitleText.textContent = "";
    } else if (subtitles.length > 0 && subtitlesEnabled) {
      btnToggleSubtitles.classList.add("sub-active");
      btnToggleSubtitles.classList.remove("sub-disabled");
      subStatusLabel.textContent = t("ui.subs.ccOn");
      if (subMenuToggleText) subMenuToggleText.textContent = t("ui.subs.menuOff");
      if (subMenuToggle) subMenuToggle.classList.add("active");
    } else if (subtitles.length > 0 && !subtitlesEnabled) {
      btnToggleSubtitles.classList.remove("sub-active");
      btnToggleSubtitles.classList.add("sub-disabled");
      subStatusLabel.textContent = t("ui.subs.ccOff");
      if (subMenuToggleText) subMenuToggleText.textContent = t("ui.subs.menuOn");
      if (subMenuToggle) subMenuToggle.classList.remove("active");
      subtitleText.textContent = "";
    } else {
      btnToggleSubtitles.classList.remove("sub-active", "sub-disabled");
      subStatusLabel.textContent = "CC";
      if (subMenuToggleText) subMenuToggleText.textContent = t("ui.subs.menuFind");
      if (subMenuToggle) subMenuToggle.classList.remove("active");
      subtitleText.textContent = "";
    }
  }

  /** Embedded / mpv-loaded tracks in the CC menu ("Kapalı" + one entry per track). */
  function renderTrackList() {
    if (!subTrackList) return;
    subTrackList.replaceChildren();
    subTrackList.hidden = !nativeTracks.length;
    if (!nativeTracks.length) return;
    const sel = nativeSelected();
    const item = (text, id, active) => {
      const el = document.createElement("div");
      el.className = "dropdown-item" + (active ? " active" : "");
      el.dataset.sid = id;
      el.textContent = text;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        subtitlesMenu.classList.remove("show");
        selectNative(id === "no" ? null : Number(id));
      });
      return el;
    };
    subTrackList.append(item(t("ui.subs.trackOff"), "no", !sel));
    for (const t of nativeTracks) subTrackList.append(item(t.label, t.id, t.selected));
  }

  function selectNative(id) {
    if (id !== null) lastNativeSid = id;
    engine().selectTrack("sub", id).catch((e) => console.warn("sid", e));
    const track = nativeTracks.find((x) => x.id === id);
    toast(track ? t("ui.subs.toastTrack", { label: track.label }) : t("ui.subs.toastTrackOff"));
  }

  function toggleSubtitles() {
    if (subtitles.length === 0 && nativeTracks.length && mpv()) {
      const sel = nativeSelected();
      if (sel) {
        lastNativeSid = sel.id;
        selectNative(null);
      } else {
        selectNative(lastNativeSid ?? nativeTracks[0].id);
      }
      return;
    }
    if (subtitles.length === 0) {
      // No subtitle loaded yet: open subtitle search directly
      openSearch();
      return;
    }
    subtitlesEnabled = !subtitlesEnabled;
    updateSubtitleUi();
    toast(t(subtitlesEnabled ? "ui.subs.toastShown" : "ui.subs.toastHidden"));
  }

  /** Accepts a File (input / HTML drop) or a filesystem path (dialog / native drop). */
  async function loadSubtitleFile(source) {
    // libmpv renders subtitle files itself (SRT, VTT, ASS/SSA with full styling, any encoding)
    if (typeof source === "string" && mpv()) {
      try {
        await engine().addSubtitle(source);
        subtitles = [];
        subtitleText.textContent = "";
        toast(t("ui.subs.toastLoadedFile", { name: source.split(/[\\/]/).pop() }));
        return;
      } catch (e) {
        console.warn("sub-add", e); // fall back to the app's own renderer below
      }
    }
    try {
      const buf = typeof source === "string"
        ? await (await fetch(convertFileSrc(source))).arrayBuffer()
        : await source.arrayBuffer();
      subtitles = parseCues(decodeSubtitle(buf));
      subtitlesEnabled = subtitles.length > 0;
      updateSubtitleUi();
      updateSubtitles();
      toast(subtitles.length
        ? t("ui.subs.toastLoadedLines", { n: subtitles.length })
        : t("ui.subs.noCues"));
    } catch (e) {
      console.warn(e);
      toast(t("ui.subs.readFailed"));
    }
  }

  function updateSubtitles() {
    if (!subtitles.length || !subtitlesEnabled) {
      subtitleText.textContent = "";
      return;
    }
    const cue = findCue(subtitles, lastTime + (subtitleDelay / 1000));
    subtitleText.textContent = cue ? cue.text : "";
  }

  function setSubtitleDelay(ms) {
    subtitleDelay = ms;
    // mpv: positive sub-delay shows subtitles later; the overlay's delay shifts the lookup time forward
    if (mpv()) engine().set("sub-delay", -ms / 1000).catch(() => {});
    valSubDelay.textContent = formatDelay(subtitleDelay);
    updateSubtitles();
  }

  /** Shifts the delay and confirms it in a toast (G/H keys, +/- buttons). */
  function nudgeDelay(deltaMs) {
    setSubtitleDelay(subtitleDelay + deltaMs);
    toast(t("ui.subs.toastSync", { delay: valSubDelay.textContent }));
  }

  /** A new video starts without subtitles. */
  function resetForNewMedia() {
    nativeTracks = [];
    lastNativeSid = null;
    lastTime = 0;
    subtitles = [];
    subtitlesEnabled = true;
    updateSubtitleUi();
    subtitleText.textContent = "";
  }

  bus.on("media:time", ({ time }) => {
    lastTime = time;
    updateSubtitles();
  });

  /** Track list from the engine (libmpv): keeps the CC menu and label in sync. */
  function setNativeTracks(list) {
    nativeTracks = list;
    const sel = nativeSelected();
    if (sel) lastNativeSid = sel.id;
    updateSubtitleUi();
  }

  // ------------------------------------------------------------------------
  // Style (size, colour, position) for both renderers; raised above the HUD
  // ------------------------------------------------------------------------
  const style = { size: 100, color: "#ffffff", pos: 100 };
  function setStyle(next) {
    Object.assign(style, next);
    const container = subtitleText.parentElement;
    container.style.setProperty("--sub-scale", style.size / 100);
    container.style.setProperty("--sub-color", style.color);
    container.style.setProperty("--sub-lift", `${100 - style.pos}vh`);
    if (mpv()) {
      const e = engine();
      e.set("sub-scale", style.size / 100).catch(() => {});
      e.set("sub-color", style.color).catch(() => {});
      e.set("sub-pos", style.pos).catch(() => {});
    }
  }

  // CC button: click toggles, right click opens the menu
  if (btnToggleSubtitles) {
    btnToggleSubtitles.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSubtitles();
    });

    btnToggleSubtitles.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      subtitlesMenu.classList.toggle("show");
      speedMenu.classList.remove("show");
      aspectMenu.classList.remove("show");
    });
  }

  subMenuToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSubtitles();
    subtitlesMenu.classList.remove("show");
  });

  subMenuSearch?.addEventListener("click", (e) => {
    e.stopPropagation();
    subtitlesMenu.classList.remove("show");
    openSearch();
  });

  subMenuBrowse?.addEventListener("click", (e) => {
    e.stopPropagation();
    subtitlesMenu.classList.remove("show");
    subFileInput.click();
  });

  subFileInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) {
      loadSubtitleFile(file);
      subtitleSearchModal.classList.remove("active");
    }
  });

  subMenuClear?.addEventListener("click", (e) => {
    e.stopPropagation();
    subtitles = [];
    subtitlesEnabled = false;
    updateSubtitleUi();
    subtitlesMenu.classList.remove("show");
    toast(t("ui.subs.toastRemoved"));
  });

  // Subtitle delay controls (+/- 100 ms) in the effects panel
  btnSubPlus.addEventListener("click", () => nudgeDelay(100));
  btnSubMinus.addEventListener("click", () => nudgeDelay(-100));
  btnSubReset.addEventListener("click", () => {
    setSubtitleDelay(0);
    toast(t("ui.subs.toastDelayReset"));
  });
  i18n.onChange(() => updateSubtitleUi());


  return {
    load: loadSubtitleFile,
    toggle: toggleSubtitles,
    setDelay: setSubtitleDelay,
    nudgeDelay,
    resetForNewMedia,
    setNativeTracks,
    setStyle,
    get style() { return { ...style }; },
    get nativeTracks() { return nativeTracks; },
    /** For tests / diagnostics. */
    get cues() { return subtitles; },
    get enabled() { return subtitlesEnabled; },
    get delay() { return subtitleDelay; },
  };
}
