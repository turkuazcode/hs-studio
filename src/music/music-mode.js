// ==========================================================================
// Music mode (Plan 13/L03): its own layout while an audio file plays (cover, title, artist,
// album, up next, shuffle / repeat); video and photo controls are hidden. Behind it:
//   - queue policy (shuffle / repeat) for next / previous / auto-advance,
//   - gapless switch to the next track (libmpv playlist + gapless-audio),
//   - ReplayGain (libmpv options; HTML5 engine: attenuation by the same formula),
//   - system media controls (Windows SMTC: media keys + now-playing card),
//   - pause when the output device disappears (headphones unplugged).
// Rare options live in Settings > Ses > Müzik.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { invoke, listen } from "../core/tauri.js";
import { h } from "../ui/action-dialogs.js";
import { isAudioOnlyName } from "../media/classify.js";
import {
  REPEAT_MODES, REPLAYGAIN_MODES, deviceRemoved, mpvReplayGainOptions, nextIndex, nowPlayingText, parseGain,
  replayGainFactor, shuffleOrder, upNext,
} from "./music-logic.js";

// 20 px stroke icons of the music HUD (approved layout 2026-10-28)
const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const ICONS = {
  shuffle: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  repeatOne: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/><path d="M11 10h1v4"/>'),
  prev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
  queue: '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 4h10v2H3zm0 4h10v2H3zm0 4h6v2H3zm11-2.5V4h3v1.5h-1.5V14a2 2 0 11-1.5-1.9z"/></svg>',
};

const NOTE_ICON = '<svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor" aria-hidden="true"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>';

export function registerMusicSettings(settings) {
  if (!settings?.register || settings.has("music.replayGain")) return;
  const hidden = { control: "custom", render: (row) => { row.hidden = true; } };
  settings.register("audio", [
    { control: "heading", labelKey: "music.settings.heading" },
    {
      key: "music.replayGain", type: "enum", values: REPLAYGAIN_MODES, default: "album", control: "select",
      labelKey: "music.settings.replayGain", options: REPLAYGAIN_MODES.map((v) => ({ value: v, labelKey: `music.settings.rg.${v}` })),
    },
    { key: "music.replayGainPreamp", type: "number", min: -15, max: 15, default: 0, control: "range", step: 0.5, unit: " dB", labelKey: "music.settings.preamp" },
    { key: "music.replayGainClip", type: "boolean", default: true, control: "toggle", labelKey: "music.settings.preventClip" },
    { key: "music.gapless", type: "boolean", default: true, control: "toggle", labelKey: "music.settings.gapless" },
    { key: "music.systemControls", type: "boolean", default: true, control: "toggle", labelKey: "music.settings.systemControls" },
    { key: "music.pauseOnDeviceRemoval", type: "boolean", default: true, control: "toggle", labelKey: "music.settings.pauseOnDeviceRemoval" },
    { key: "music.shuffle", type: "boolean", default: false, ...hidden },
    { key: "music.repeat", type: "enum", values: REPEAT_MODES, default: "off", ...hidden },
  ]);
}

const isMusicItem = (item) => {
  const name = item?.name || item?.path || item?.url || "";
  // wma: audio-only too, kept out of isAudioOnlyName (Chromium cannot play it)
  return !!item && !item.isImage && (isAudioOnlyName(name) || /\.wma$/i.test(name));
};

/**
 * app: { dom, state, bus, engine, engines, playlist, video, settings, toast, capabilities } (lazy)
 */
export function createMusicMode(app) {
  const { state } = app;
  const s = app.settings;
  registerMusicSettings(s);
  const get = (k, d) => (s?.has?.(k) ? s.get(k) : d);

  // ------------------------------------------------------------ layout
  const cover = h("div", { id: "music-cover", class: "music-cover" });
  const title = h("div", { id: "music-title", class: "music-title" });
  const meta = h("div", { id: "music-meta", class: "music-meta" });
  // music HUD buttons: shuffle · previous · [play] · next · repeat (shown only in music mode)
  const shuffleBtn = h("button", { id: "music-shuffle", type: "button", class: "hud-btn music-hud-btn", "aria-pressed": "false" });
  const repeatBtn = h("button", { id: "music-repeat", type: "button", class: "hud-btn music-hud-btn" });
  const prevBtn = h("button", { id: "music-prev", type: "button", class: "hud-btn music-hud-btn" });
  const nextBtn = h("button", { id: "music-next", type: "button", class: "hud-btn music-hud-btn" });
  prevBtn.innerHTML = ICONS.prev;
  nextBtn.innerHTML = ICONS.next;
  prevBtn.addEventListener("click", () => app.playlist.navigate(-1));
  nextBtn.addEventListener("click", () => app.playlist.navigate(1));
  const play = document.getElementById("btn-play-pause");
  play?.before(shuffleBtn, prevBtn);
  play?.after(nextBtn, repeatBtn);
  // titlebar: "Artist — Title" and the up-next panel toggle (ui/mode-layout.js places / shows them)
  const titlebarText = h("span", { id: "music-titlebar-title", class: "music-titlebar-title" });
  document.getElementById("current-filename")?.after(titlebarText);
  const queueBtn = h("button", { id: "btn-music-queue", type: "button", class: "titlebar-action-btn", "aria-pressed": "true", "data-tauri-drag-region": "false" });
  queueBtn.innerHTML = ICONS.queue;
  const queueLabel = h("span", { "data-i18n": "music.upNext", text: t("music.upNext") });
  queueBtn.append(queueLabel);
  queueBtn.addEventListener("click", () => {
    const hide = !document.documentElement.classList.contains("music-queue-hidden");
    document.documentElement.classList.toggle("music-queue-hidden", hide);
    queueBtn.setAttribute("aria-pressed", String(!hide));
  });
  document.querySelector(".titlebar-actions")?.append(queueBtn);
  const nextList = h("ol", { id: "music-upnext", class: "music-upnext" });
  const nextHead = h("div", { class: "music-upnext-title", "data-i18n": "music.upNext", text: t("music.upNext") });
  const root = h("section", { id: "music-mode", class: "music-mode", hidden: true, "aria-label": t("music.title") },
    h("div", { class: "music-now" }, cover,
      h("div", { class: "music-text" }, title, meta)),
    h("div", { class: "music-queue" }, nextHead, nextList));
  (document.getElementById("viewport") ?? document.body).append(root);

  let order = null; // shuffle order (playlist indexes)
  let orderFor = null; // the playlist array the order belongs to
  let tagsOf = { path: null, tags: null };
  let queuedIndex = -1;

  const list = () => state.get("playlist") ?? [];
  const current = () => list()[state.get("currentPlaylistIndex")];
  const repeat = () => get("music.repeat", "off");
  const shuffle = () => !!get("music.shuffle", false);
  const active = () => isMusicItem(current()) && state.get("currentMediaType") === "video";

  function ensureOrder() {
    const pl = list();
    if (!shuffle()) { order = null; orderFor = null; return null; }
    if (orderFor !== pl || order?.length !== pl.length) {
      order = shuffleOrder(pl.length, Math.max(0, state.get("currentPlaylistIndex")));
      orderFor = pl;
    }
    return order;
  }

  // queue policy used by the playlist (next / previous / end of track): music items only
  app.queuePolicy = (index, step, pl, { auto = false } = {}) => {
    if (!isMusicItem(pl[index])) return undefined;
    return nextIndex(index, step, pl.length, { repeat: repeat(), order: ensureOrder(), auto });
  };

  function renderButtons() {
    shuffleBtn.innerHTML = ICONS.shuffle;
    shuffleBtn.title = t("music.shuffle");
    shuffleBtn.setAttribute("aria-label", t("music.shuffle"));
    shuffleBtn.setAttribute("aria-pressed", String(shuffle()));
    shuffleBtn.classList.toggle("active", shuffle());
    const r = repeat();
    repeatBtn.innerHTML = r === "one" ? ICONS.repeatOne : ICONS.repeat;
    repeatBtn.title = t(`music.repeat.${r}`);
    repeatBtn.setAttribute("aria-label", t(`music.repeat.${r}`));
    repeatBtn.dataset.mode = r;
    repeatBtn.classList.toggle("active", r !== "off");
    for (const [b, k] of [[prevBtn, "music.prevTrack"], [nextBtn, "music.nextTrack"]]) {
      b.title = t(k);
      b.setAttribute("aria-label", t(k));
    }
    queueBtn.title = t("music.upNext");
    queueLabel.textContent = t("music.upNext");
  }
  shuffleBtn.addEventListener("click", () => { s?.set("music.shuffle", !shuffle()); order = null; renderButtons(); renderQueue(); syncGapless(); });
  repeatBtn.addEventListener("click", () => {
    s?.set("music.repeat", REPEAT_MODES[(REPEAT_MODES.indexOf(repeat()) + 1) % REPEAT_MODES.length]);
    renderButtons(); renderQueue(); syncGapless();
  });

  function renderQueue() {
    const pl = list();
    const idx = upNext(state.get("currentPlaylistIndex"), pl.length, { order: ensureOrder(), repeat: repeat() });
    nextList.replaceChildren(...idx.map((i) => {
      const li = h("li", { class: "music-upnext-item", "data-idx": i, text: pl[i]?.name ?? "" });
      li.addEventListener("click", () => app.playlist.play(i));
      return li;
    }));
    nextHead.hidden = !idx.length;
  }

  async function readTags(item) {
    if (!item?.path || !invoke) return null;
    if (tagsOf.path === item.path) return tagsOf.tags;
    const tags = await invoke("tags_read", { path: item.path }).catch(() => null);
    tagsOf = { path: item.path, tags };
    return tags;
  }

  async function renderNow() {
    const item = current();
    const on = active();
    root.hidden = !on;
    document.documentElement.classList.toggle("music-mode", on);
    if (!on) return;
    const tags = await readTags(item);
    if (item !== current()) return;
    const text = nowPlayingText(item, tags);
    title.textContent = text.title;
    titlebarText.textContent = [text.artist, text.title].filter(Boolean).join(" — ");
    meta.textContent = [text.artist, text.album].filter(Boolean).join(" · ");
    const url = tags?.cover?.dataUrl;
    cover.replaceChildren();
    if (url) cover.append(h("img", { src: url, alt: "" }));
    else cover.innerHTML = NOTE_ICON;
    cover.dataset.hasCover = url ? "1" : "0";
    renderButtons();
    renderQueue();
  }

  // ------------------------------------------------------------ ReplayGain
  const rgSettings = () => ({
    mode: get("music.replayGain", "album"),
    preampDb: Number(get("music.replayGainPreamp", 0)),
    preventClip: get("music.replayGainClip", true) !== false,
  });
  function applyMpvReplayGain() {
    const mpv = app.engines?.mpv;
    if (!mpv) return;
    for (const [k, v] of Object.entries(mpvReplayGainOptions(rgSettings()))) mpv.set(k, v)?.catch?.(() => {});
  }
  async function applyHtml5ReplayGain() {
    const html5 = app.engines?.html5;
    if (!html5?.setReplayGain) return;
    const item = current();
    if (app.engine.kind !== "html5" || !isMusicItem(item)) { html5.setReplayGain(1); return; }
    const tags = await readTags(item);
    const f = replayGainFactor({
      ...rgSettings(),
      trackGain: parseGain(tags?.replaygainTrackGain), trackPeak: parseGain(tags?.replaygainTrackPeak),
      albumGain: parseGain(tags?.replaygainAlbumGain), albumPeak: parseGain(tags?.replaygainAlbumPeak),
    });
    html5.setReplayGain(f);
    document.documentElement.dataset.replayGain = f.toFixed(4);
  }
  for (const k of ["music.replayGain", "music.replayGainPreamp", "music.replayGainClip"]) {
    s?.subscribe?.(k, () => { applyMpvReplayGain(); applyHtml5ReplayGain(); });
  }

  // ------------------------------------------------------------ gapless
  function applyMpvGapless() {
    const mpv = app.engines?.mpv;
    if (!mpv) return;
    const on = get("music.gapless", true) !== false;
    mpv.set("gapless-audio", on ? "yes" : "no")?.catch?.(() => {});
    mpv.set("prefetch-playlist", on ? "yes" : "no")?.catch?.(() => {});
  }
  s?.subscribe?.("music.gapless", () => { applyMpvGapless(); syncGapless(); });

  /** Puts the next music track into mpv's playlist (or clears it). */
  function syncGapless() {
    if (app.engine.kind !== "mpv" || !app.engine.queueNext) return;
    const pl = list();
    const index = state.get("currentPlaylistIndex");
    const want = get("music.gapless", true) !== false && active();
    const next = want ? nextIndex(index, 1, pl.length, { repeat: repeat(), order: ensureOrder(), auto: true }) : -1;
    const item = next >= 0 && isMusicItem(pl[next]) && pl[next].path ? pl[next] : null;
    queuedIndex = item ? next : -1;
    app.engine.queueNext(item);
  }
  app.engine.on("advanced", (item) => {
    const pl = list();
    const idx = queuedIndex >= 0 && pl[queuedIndex]?.path === item?.path ? queuedIndex : pl.findIndex((i) => i.path === item?.path);
    if (idx < 0) return;
    document.documentElement.dataset.gaplessSwitches = String(Number(document.documentElement.dataset.gaplessSwitches || 0) + 1);
    app.playlist.adopt(idx);
  });

  // ------------------------------------------------------------ system media controls
  let lastSent = "";
  async function updateControls(status) {
    if (!invoke || get("music.systemControls", true) === false) return;
    const cap = app.capabilities?.get?.("system.mediaControls");
    if (cap && !cap.available && cap.reasonCode !== "unknown") return; // unknown = backend report not here yet
    const item = current();
    const kind = state.get("currentMediaType");
    let now;
    if (!item || kind !== "video") {
      now = { title: "", artist: "", album: "", path: null, status: "closed", canNext: false, canPrevious: false };
    } else {
      const tags = isMusicItem(item) ? await readTags(item) : null;
      const pl = list();
      const i = state.get("currentPlaylistIndex");
      now = {
        ...nowPlayingText(item, tags), path: item.path ?? null,
        status: status ?? (app.engine.paused ? "paused" : "playing"),
        canNext: pl.length > 1 || repeat() !== "off", canPrevious: pl.length > 1 || i > 0,
      };
    }
    const key = JSON.stringify(now);
    if (key === lastSent) return; // only real changes reach the OS
    lastSent = key;
    invoke("media_controls_update", { now }).catch((e) => console.warn("media_controls_update", e));
  }
  listen?.("media-control", (e) => {
    const b = e.payload?.button;
    const has = state.get("currentMediaType") === "video";
    if (b === "play" && has) app.engine.play();
    else if (b === "pause" && has) app.engine.pause();
    else if (b === "stop" && has) app.engine.pause();
    else if (b === "next") app.playlist.navigate(1);
    else if (b === "previous") app.playlist.navigate(-1);
    document.documentElement.dataset.lastMediaControl = b ?? "";
  });

  // ------------------------------------------------------------ output device removal
  let devices = null;
  app.engine.on("audio-device-list", (list) => {
    const prev = devices;
    devices = list;
    if (prev && get("music.pauseOnDeviceRemoval", true) !== false && deviceRemoved(prev, list) && !app.engine.paused) {
      app.engine.pause();
      app.toast?.(t("music.deviceRemoved"));
    }
  });
  if (globalThis.navigator?.mediaDevices?.addEventListener) {
    let outs = null;
    const read = () => navigator.mediaDevices.enumerateDevices().then((d) => d.filter((x) => x.kind === "audiooutput").map((x) => x.deviceId)).catch(() => null);
    read().then((d) => { outs = d; });
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      const next = await read();
      if (app.engine.kind === "html5" && outs && next && get("music.pauseOnDeviceRemoval", true) !== false && deviceRemoved(outs, next) && !app.engine.paused) {
        app.engine.pause();
        app.toast?.(t("music.deviceRemoved"));
      }
      outs = next;
    });
  }

  // ------------------------------------------------------------ wiring
  app.bus.on("media:loading", () => { queueMicrotask(renderNow); });
  app.bus.on("media:loaded", () => {
    renderNow();
    applyHtml5ReplayGain();
    syncGapless();
    updateControls();
  });
  app.engine.on("playstate", (playing) => updateControls(playing ? "playing" : "paused"));
  app.engine.on("tracks", () => queueMicrotask(renderNow));
  app.bus.on("engine:changed", () => { applyMpvReplayGain(); applyMpvGapless(); });
  (s?.ready ?? Promise.resolve()).then(() => { applyMpvReplayGain(); applyMpvGapless(); renderButtons(); });
  i18n.onChange?.(() => renderButtons());

  return {
    get active() { return active(); },
    get shuffle() { return shuffle(); },
    get repeat() { return repeat(); },
    get queuedIndex() { return queuedIndex; },
    syncGapless,
    updateControls,
    render: renderNow,
  };
}
