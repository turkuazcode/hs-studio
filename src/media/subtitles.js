// ==========================================================================
// Subtitle engine: SRT + VTT, UTF-8 / Windows-1254 (Turkish) decoding,
// O(log n) cue lookup, delay, CC button / menu.
// The parsing functions at the top are pure and unit tested.
// ==========================================================================

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
 * deps: { dom, bus, toast(msg), openSearch() }
 */
export function createSubtitles({ dom, bus, toast, openSearch }) {
  const {
    video, subtitleText, btnToggleSubtitles, subStatusLabel, subtitlesMenu, subMenuToggle, subMenuToggleText,
    subMenuSearch, subMenuBrowse, subMenuClear, subFileInput, subtitleSearchModal, speedMenu, aspectMenu,
    valSubDelay, btnSubMinus, btnSubPlus, btnSubReset,
  } = dom;

  let subtitles = [];
  let subtitlesEnabled = true;
  let subtitleDelay = 0; // ms

  function updateSubtitleUi() {
    if (!btnToggleSubtitles) return;
    if (subtitles.length > 0 && subtitlesEnabled) {
      btnToggleSubtitles.classList.add("sub-active");
      btnToggleSubtitles.classList.remove("sub-disabled");
      subStatusLabel.textContent = "CC Açık";
      if (subMenuToggleText) subMenuToggleText.textContent = "● Altyazıyı Kapat (C)";
      if (subMenuToggle) subMenuToggle.classList.add("active");
    } else if (subtitles.length > 0 && !subtitlesEnabled) {
      btnToggleSubtitles.classList.remove("sub-active");
      btnToggleSubtitles.classList.add("sub-disabled");
      subStatusLabel.textContent = "CC Kapalı";
      if (subMenuToggleText) subMenuToggleText.textContent = "○ Altyazıyı Aç (C)";
      if (subMenuToggle) subMenuToggle.classList.remove("active");
      subtitleText.textContent = "";
    } else {
      btnToggleSubtitles.classList.remove("sub-active", "sub-disabled");
      subStatusLabel.textContent = "CC";
      if (subMenuToggleText) subMenuToggleText.textContent = "🌐 Altyazı Bul / Yükle";
      if (subMenuToggle) subMenuToggle.classList.remove("active");
      subtitleText.textContent = "";
    }
  }

  function toggleSubtitles() {
    if (subtitles.length === 0) {
      // No subtitle loaded yet: open subtitle search directly
      openSearch();
      return;
    }
    subtitlesEnabled = !subtitlesEnabled;
    updateSubtitleUi();
    toast(subtitlesEnabled ? "Altyazı Açıldı (Aktif)" : "Altyazı Kapatıldı (Gizli)");
  }

  /** Accepts a File (input / HTML drop) or a filesystem path (dialog / native drop). */
  async function loadSubtitleFile(source) {
    try {
      const buf = typeof source === "string"
        ? await (await fetch(convertFileSrc(source))).arrayBuffer()
        : await source.arrayBuffer();
      subtitles = parseCues(decodeSubtitle(buf));
      subtitlesEnabled = subtitles.length > 0;
      updateSubtitleUi();
      updateSubtitles();
      toast(subtitles.length
        ? `Altyazı yüklendi (${subtitles.length} satır)`
        : "⚠️ Altyazı dosyasında geçerli satır bulunamadı");
    } catch (e) {
      console.warn(e);
      toast("⚠️ Altyazı okunamadı");
    }
  }

  function updateSubtitles() {
    if (!subtitles.length || !subtitlesEnabled) {
      subtitleText.textContent = "";
      return;
    }
    const cue = findCue(subtitles, video.currentTime + (subtitleDelay / 1000));
    subtitleText.textContent = cue ? cue.text : "";
  }

  function setSubtitleDelay(ms) {
    subtitleDelay = ms;
    valSubDelay.textContent = formatDelay(subtitleDelay);
    updateSubtitles();
  }

  /** Shifts the delay and confirms it in a toast (G/H keys, +/- buttons). */
  function nudgeDelay(deltaMs) {
    setSubtitleDelay(subtitleDelay + deltaMs);
    toast(`Altyazı senkronu: ${valSubDelay.textContent}`);
  }

  /** A new video starts without subtitles. */
  function resetForNewMedia() {
    subtitles = [];
    subtitlesEnabled = true;
    updateSubtitleUi();
    subtitleText.textContent = "";
  }

  bus.on("media:time", updateSubtitles);

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
    toast("Altyazı kaldırıldı");
  });

  // Subtitle delay controls (+/- 100 ms) in the effects panel
  btnSubPlus.addEventListener("click", () => nudgeDelay(100));
  btnSubMinus.addEventListener("click", () => nudgeDelay(-100));
  btnSubReset.addEventListener("click", () => {
    setSubtitleDelay(0);
    toast("Altyazı gecikmesi sıfırlandı");
  });

  return {
    load: loadSubtitleFile,
    toggle: toggleSubtitles,
    setDelay: setSubtitleDelay,
    nudgeDelay,
    resetForNewMedia,
    /** For tests / diagnostics. */
    get cues() { return subtitles; },
    get enabled() { return subtitlesEnabled; },
    get delay() { return subtitleDelay; },
  };
}
