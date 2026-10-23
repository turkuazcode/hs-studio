// ==========================================================================
// VHO (Video H Oynatıcısı) - Master Modern Interactive Controller
// Complete Suite: Audio Boost, Subtitles, Resume, PiP, Playlist, Filters,
// Thumbnail Preview, Sleep Timer, Subtitle Search, WebGL2 GPU Enhancer
// ==========================================================================

import { createGpuEnhancer } from "./media/gpu-enhancer.js";
import { upscaleImage, restoreFacesInImage, pendingDownloadBytes, describeHardware, releaseAi, MODELS, FACE_MODEL } from "./media/ai-engine.js";

document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements
  const video = document.getElementById("video-element");
  const thumbVideo = document.getElementById("thumbnail-video");
  const gpuCanvas = document.getElementById("gpu-canvas");
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const playlistFileInput = document.getElementById("playlist-file-input");
  const btnBrowse = document.getElementById("btn-browse-file");
  const btnOpenUrl = document.getElementById("btn-open-url");
  const currentFilename = document.getElementById("current-filename");

  // Controls HUD
  const controlsHud = document.getElementById("controls-hud");
  const titlebar = document.getElementById("titlebar");
  const btnPlayPause = document.getElementById("btn-play-pause");
  const iconPlay = document.getElementById("icon-play");
  const iconPause = document.getElementById("icon-pause");
  const btnSkipBack = document.getElementById("btn-skip-backward");
  const btnSkipFwd = document.getElementById("btn-skip-forward");

  // Timeline & YouTube Style Live Thumbnail Tooltip
  const timelineContainer = document.getElementById("timeline-container");
  const timelineProgress = document.getElementById("timeline-progress");
  const timelineBuffer = document.getElementById("timeline-buffer");
  const timelineTooltip = document.getElementById("timeline-tooltip");
  const timelineThumbCanvas = document.getElementById("timeline-thumb-canvas");
  const timelineTooltipTime = document.getElementById("timeline-tooltip-time");
  const thumbCtx = timelineThumbCanvas.getContext("2d");
  const timeCurrent = document.getElementById("time-current");
  const timeTotal = document.getElementById("time-total");
  const abMarkerA = document.getElementById("ab-marker-a");
  const abMarkerB = document.getElementById("ab-marker-b");
  const abRange = document.getElementById("ab-range");
  const btnAbLoop = document.getElementById("btn-ab-loop");
  const abLoopLabel = document.getElementById("ab-loop-label");

  // Volume & 200% Booster
  const volumeContainer = document.querySelector(".volume-container");
  const btnVolume = document.getElementById("btn-volume");
  const iconVolHigh = document.getElementById("icon-volume-high");
  const iconVolBoost = document.getElementById("icon-volume-boost");
  const iconVolMute = document.getElementById("icon-volume-mute");
  const volumeSlider = document.getElementById("volume-slider");
  const volumeBadge = document.getElementById("volume-badge");

  // Secondary Tools (PiP, Snapshot, Aspect Ratio, Speed, Fullscreen)
  const btnSnapshot = document.getElementById("btn-snapshot");
  const btnPip = document.getElementById("btn-pip");
  const btnFullscreen = document.getElementById("btn-fullscreen");
  const iconFsEnter = document.getElementById("icon-fs-enter");
  const iconFsExit = document.getElementById("icon-fs-exit");
  const btnSpeed = document.getElementById("btn-speed");
  const speedLabel = document.getElementById("speed-label");
  const speedMenu = document.getElementById("speed-menu");
  const btnAspectRatio = document.getElementById("btn-aspect-ratio");
  const aspectLabel = document.getElementById("aspect-label");
  const aspectMenu = document.getElementById("aspect-menu");

  // Subtitles Elements
  const subtitleText = document.getElementById("subtitle-text");
  const btnToggleSubtitles = document.getElementById("btn-toggle-subtitles");
  const subStatusLabel = document.getElementById("sub-status-label");
  const subtitlesMenu = document.getElementById("subtitles-menu");
  const subMenuToggle = document.getElementById("sub-menu-toggle");
  const subMenuToggleText = document.getElementById("sub-menu-toggle-text");
  const subMenuSearch = document.getElementById("sub-menu-search");
  const subMenuBrowse = document.getElementById("sub-menu-browse");
  const subMenuClear = document.getElementById("sub-menu-clear");
  const subFileInput = document.getElementById("sub-file-input");

  // Playlist Drawer
  const playlistDrawer = document.getElementById("playlist-drawer");
  const btnTogglePlaylist = document.getElementById("btn-toggle-playlist");
  const btnClosePlaylist = document.getElementById("btn-close-playlist");
  const playlistItemsList = document.getElementById("playlist-items");
  const playlistCountBadge = document.getElementById("playlist-count-badge");
  const playlistTotalText = document.getElementById("playlist-total-text");
  const btnPlaylistAdd = document.getElementById("btn-playlist-add");
  const btnPlaylistClear = document.getElementById("btn-playlist-clear");

  // Effects / Video Filters Panel
  const effectsPanel = document.getElementById("effects-panel");
  const btnToggleEffects = document.getElementById("btn-toggle-effects");
  const btnCloseEffects = document.getElementById("btn-close-effects");
  const sliderBrightness = document.getElementById("slider-brightness");
  const sliderContrast = document.getElementById("slider-contrast");
  const sliderSaturate = document.getElementById("slider-saturate");
  const valBrightness = document.getElementById("val-brightness");
  const valContrast = document.getElementById("val-contrast");
  const valSaturate = document.getElementById("val-saturate");
  const btnResetFilters = document.getElementById("btn-reset-filters");
  const valSubDelay = document.getElementById("val-sub-delay");
  const btnSubMinus = document.getElementById("btn-sub-minus");
  const btnSubPlus = document.getElementById("btn-sub-plus");
  const btnSubReset = document.getElementById("btn-sub-reset");
  const checkCompatMode = document.getElementById("check-compat-mode");

  // AI Video & Audio Restoration Elements
  const btnToggleAiRestore = document.getElementById("btn-toggle-ai-restore");
  const aiRestorePanel = document.getElementById("ai-restore-panel");
  const btnCloseAiRestore = document.getElementById("btn-close-ai-restore");
  const checkAiMaster = document.getElementById("check-ai-master");
  const aiMasterStatus = document.getElementById("ai-master-status");
  const aiRestoreBadge = document.getElementById("ai-restore-badge");
  const sliderAiSharp = document.getElementById("slider-ai-sharp");
  const valAiSharp = document.getElementById("val-ai-sharp");
  const sliderAiContrast = document.getElementById("slider-ai-contrast");
  const valAiContrast = document.getElementById("val-ai-contrast");
  const checkAiVoiceClarity = document.getElementById("check-ai-voice-clarity");
  const checkAiDenoise = document.getElementById("check-ai-denoise");
  const checkAiCompressor = document.getElementById("check-ai-compressor");
  const btnToggleSplitView = document.getElementById("btn-toggle-split-view");
  const splitViewStatus = document.getElementById("split-view-status");
  const splitScreenBanner = document.getElementById("split-screen-banner");
  const splitScreenLine = document.getElementById("split-screen-line");

  // Sleep Timer Elements
  const btnSleepTimer = document.getElementById("btn-sleep-timer");
  const sleepTimerModal = document.getElementById("sleep-timer-modal");
  const btnCancelSleep = document.getElementById("btn-cancel-sleep-timer");
  const btnDisableSleep = document.getElementById("btn-disable-sleep-timer");
  const inputCustomSleep = document.getElementById("input-custom-sleep");
  const btnCustomSleep = document.getElementById("btn-custom-sleep");
  const checkPcSleep = document.getElementById("check-pc-sleep");
  const sleepBadge = document.getElementById("sleep-badge");
  const sleepOverlay = document.getElementById("sleep-overlay");
  const btnWakeUp = document.getElementById("btn-wake-up");

  // Subtitle Search Elements
  const btnSearchSubtitles = document.getElementById("btn-search-subtitles");
  const subtitleSearchModal = document.getElementById("subtitle-search-modal");
  const btnCloseSubModal = document.getElementById("btn-close-sub-modal");
  const inputSubQuery = document.getElementById("input-sub-query");
  const selectSubLang = document.getElementById("select-sub-lang");
  const btnDoSubSearch = document.getElementById("btn-do-sub-search");
  const subSearchResults = document.getElementById("sub-search-results");

  // Toasts & Ripple
  const centerRipple = document.getElementById("center-ripple");
  const resumeToast = document.getElementById("resume-toast");
  const resumeTimeText = document.getElementById("resume-time-text");
  const btnResumeYes = document.getElementById("btn-resume-yes");
  const btnResumeNo = document.getElementById("btn-resume-no");
  const screenFlash = document.getElementById("screen-flash");
  const snapshotToast = document.getElementById("snapshot-toast");

  // Photo Studio Elements
  const imageContainer = document.getElementById("image-container");
  const imageElement = document.getElementById("image-element");
  const photoHud = document.getElementById("photo-hud");
  const btnPhotoPrev = document.getElementById("btn-photo-prev");
  const btnPhotoNext = document.getElementById("btn-photo-next");
  const btnFloatingPrev = document.getElementById("btn-floating-prev");
  const btnFloatingNext = document.getElementById("btn-floating-next");
  const btnPhotoSlideshow = document.getElementById("btn-photo-slideshow");
  const iconSlideshowPlay = document.getElementById("icon-slideshow-play");
  const iconSlideshowPause = document.getElementById("icon-slideshow-pause");
  const photoCounterBadge = document.getElementById("photo-counter-badge");
  const btnPhotoZoomIn = document.getElementById("btn-photo-zoom-in");
  const btnPhotoZoomOut = document.getElementById("btn-photo-zoom-out");
  const btnPhotoZoomReset = document.getElementById("btn-photo-zoom-reset");
  const photoZoomLevel = document.getElementById("photo-zoom-level");
  const btnPhotoRotateLeft = document.getElementById("btn-photo-rotate-left");
  const btnPhotoRotateRight = document.getElementById("btn-photo-rotate-right");
  const btnPhotoInfo = document.getElementById("btn-photo-info");
  const photoInfoCard = document.getElementById("photo-info-card");
  const infoRes = document.getElementById("info-res");
  const infoSize = document.getElementById("info-size");
  const infoFormat = document.getElementById("info-format");
  const infoRatio = document.getElementById("info-ratio");

  // URL Modal
  const urlModal = document.getElementById("url-modal");
  const inputUrl = document.getElementById("input-video-url");
  const btnCancelUrl = document.getElementById("btn-cancel-url");
  const btnConfirmUrl = document.getElementById("btn-confirm-url");

  // Tauri bridge (undefined in a plain browser)
  const tauri = window.__TAURI__;
  const appWindow = tauri?.window?.getCurrentWindow?.();
  const invoke = tauri?.core?.invoke;
  const transcodeOverlay = document.getElementById("transcode-overlay");
  const transcodeText = document.getElementById("transcode-text");
  const transcodeBar = document.getElementById("transcode-bar");

  // State Variables
  let isPlaying = false;
  let hudHideTimeout = null;
  let isSeeking = false;
  let currentFileKey = "";
  let resumePendingTime = 0;
  let resumeToastTimer = 0;
  let toastTimer = 0;

  // Photo Studio State
  let currentMediaType = "none"; // "video" | "image" | "none"
  let photoZoom = 1.0;
  let photoPanX = 0;
  let photoPanY = 0;
  let photoRotation = 0;
  let isPanningPhoto = false;
  let panStartX = 0;
  let panStartY = 0;
  let isSlideshowActive = false;
  let slideshowTimer = null;
  const SLIDESHOW_INTERVAL_MS = 3500;

  // Media Resource Manager
  let activeObjectUrl = null;
  let loadGen = 0;            // bumps on every media load; async work from older loads is ignored
  let transcodingPath = null; // file currently being converted by the backend
  let isTaintedSource = false; // cross-origin source without CORS: no Web Audio / WebGL access

  // Web Audio graph (created lazily, only when boost or DSP is actually needed)
  let audioCtx = null;
  let gainNode = null;
  let audioSourceNode = null;
  let highpassNode = null;
  let speechPeakingNode = null;
  let lowpassNode = null;
  let compressorNode = null;
  let limiterNode = null;
  let lastNonZeroVolume = 100;

  // AI Restoration State
  let isAiRestoreEnabled = false;
  let isSplitViewActive = false;
  let aiSharpLevel = 2;
  let aiContrastBoost = 8;
  let enhancerBlocked = false;

  // Subtitles State
  let subtitles = [];
  let subtitlesEnabled = true;
  let subtitleDelay = 0; // ms

  // A-B Loop State
  let loopPointA = null;
  let loopPointB = null;
  let abLoopGen = 0;

  // Playlist State
  let playlist = [];
  let currentPlaylistIndex = -1;

  // Sleep Timer State
  let sleepTimerInterval = null;
  let sleepFadeInterval = null;
  let sleepSecondsRemaining = 0;
  let isSleepTimerVideoEnd = false;

  // Thumbnail seeking
  let lastThumbSeek = 0;
  let thumbPendingTime = null;

  // ==========================================================================
  // WebGL2 GPU Enhancer (real CAS sharpening + upscale + A/B split)
  // ==========================================================================
  let enhancer = null;
  try {
    enhancer = createGpuEnhancer(gpuCanvas);
  } catch (e) {
    console.warn("WebGL2 enhancer unavailable:", e);
  }

  gpuCanvas.addEventListener("enhancer-error", () => {
    enhancerBlocked = true;
    disableEnhancerVisuals();
    applyVideoFilters();
    showSnapshotToast("⚠️ Bu kaynakta GPU netleştirme kullanılamıyor (CORS). CSS moduna geçildi.");
  });

  // ==========================================================================
  // Media Resource Manager
  // ==========================================================================
  function acquireObjectUrl(file) {
    releaseObjectUrl();
    activeObjectUrl = URL.createObjectURL(file);
    return activeObjectUrl;
  }

  function releaseObjectUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  /** Releases the video + thumbnail decoders without triggering error handlers. */
  function unloadVideoElements() {
    video.onerror = null;
    video.onloadeddata = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    thumbVideo.removeAttribute("src");
    thumbVideo.load();
    thumbPendingTime = null;
    thumbCtx.clearRect(0, 0, timelineThumbCanvas.width, timelineThumbCanvas.height);
  }

  function unloadImageElement() {
    imageElement.onload = imageElement.onerror = null;
    imageElement.removeAttribute("src");
  }

  const isRemoteUrl = (src) => /^https?:/i.test(src) && !src.startsWith(location.origin);

  // ==========================================================================
  // Web Audio Booster & DSP Restoration Pipeline
  // ==========================================================================

  /** Builds the audio graph on first need. Returns false if the source can't be routed. */
  function ensureAudioGraph() {
    if (isTaintedSource && !audioSourceNode) return false;
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;
      audioCtx = new AudioContextClass();
      gainNode = audioCtx.createGain();
      audioSourceNode = audioCtx.createMediaElementSource(video);

      // DSP Filter: Highpass (Eliminates <90Hz rumble & wind noise)
      highpassNode = audioCtx.createBiquadFilter();
      highpassNode.type = "highpass";
      highpassNode.frequency.value = 90;

      // DSP Filter: Speech Peaking (Boosts 2.4kHz vocal resonance by +5.5dB)
      speechPeakingNode = audioCtx.createBiquadFilter();
      speechPeakingNode.type = "peaking";
      speechPeakingNode.frequency.value = 2400;
      speechPeakingNode.Q.value = 1.1;
      speechPeakingNode.gain.value = 5.5;

      // DSP Filter: Lowpass (Cuts >7.5kHz tape hiss & mic screech)
      lowpassNode = audioCtx.createBiquadFilter();
      lowpassNode.type = "lowpass";
      lowpassNode.frequency.value = 7500;

      // DSP Dynamic Compressor (Levels whispers & limits harsh peaks)
      compressorNode = audioCtx.createDynamicsCompressor();
      compressorNode.threshold.value = -24;
      compressorNode.knee.value = 12;
      compressorNode.ratio.value = 4;
      compressorNode.attack.value = 0.003;
      compressorNode.release.value = 0.25;

      // Brickwall limiter: always last, prevents clipping in 200% boost mode
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.threshold.value = -1.5;
      limiterNode.knee.value = 0;
      limiterNode.ratio.value = 20;
      limiterNode.attack.value = 0.001;
      limiterNode.release.value = 0.08;
      limiterNode.connect(audioCtx.destination);

      reconnectAudioPipeline();
      setGain(volumeToGain(parseInt(volumeSlider.value, 10) || 0));
    }
    if (audioCtx.state === "suspended" && !video.paused) {
      audioCtx.resume();
    }
    return true;
  }

  function reconnectAudioPipeline() {
    if (!audioSourceNode || !gainNode || !audioCtx) return;
    try {
      audioSourceNode.disconnect();
      highpassNode.disconnect();
      speechPeakingNode.disconnect();
      lowpassNode.disconnect();
      compressorNode.disconnect();
      gainNode.disconnect();

      let currentNode = audioSourceNode;
      if (isAiRestoreEnabled) {
        if (checkAiDenoise?.checked) {
          currentNode.connect(highpassNode);
          highpassNode.connect(lowpassNode);
          currentNode = lowpassNode;
        }
        if (checkAiVoiceClarity?.checked) {
          currentNode.connect(speechPeakingNode);
          currentNode = speechPeakingNode;
        }
        if (checkAiCompressor?.checked) {
          currentNode.connect(compressorNode);
          currentNode = compressorNode;
        }
      }
      currentNode.connect(gainNode);
      gainNode.connect(limiterNode);
    } catch (e) {
      console.warn("Audio pipeline reconnect:", e);
    }
  }

  const aiAudioWanted = () => isAiRestoreEnabled &&
    (checkAiDenoise?.checked || checkAiVoiceClarity?.checked || checkAiCompressor?.checked);

  function setGain(v) {
    if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(v, audioCtx.currentTime, 0.015);
  }

  const volumeToGain = (val) => (val <= 100 ? 1.0 : 1.0 + ((val - 100) / 100) * 1.5);

  // Pause the AudioContext with playback to save battery
  video.addEventListener("pause", () => {
    if (audioCtx?.state === "running") audioCtx.suspend();
  });
  video.addEventListener("play", () => {
    if (audioCtx?.state === "suspended") audioCtx.resume();
  });

  // ==========================================================================
  // Format & Subtitle Engine (SRT + VTT + Turkish encodings)
  // ==========================================================================
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return seconds === Infinity ? "CANLI" : "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function decodeSubtitle(buf) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder("windows-1254").decode(buf);
    }
  }

  function parseCues(text) {
    const toSec = (t) => {
      const p = t.replace(",", ".").split(":").map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const re = /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
    const cues = [];
    const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    for (const m of src.matchAll(re)) {
      const body = m[3].replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim();
      if (body) cues.push({ start: toSec(m[1]), end: toSec(m[2]), text: body });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  // O(log n) lookup instead of find() on every timeupdate
  function findCue(t) {
    let lo = 0, hi = subtitles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, c = subtitles[mid];
      if (t < c.start) hi = mid - 1;
      else if (t > c.end) lo = mid + 1;
      else return c;
    }
    return null;
  }

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
      btnSearchSubtitles.click();
      return;
    }
    subtitlesEnabled = !subtitlesEnabled;
    updateSubtitleUi();
    showSnapshotToast(subtitlesEnabled ? "Altyazı Açıldı (Aktif)" : "Altyazı Kapatıldı (Gizli)");
  }

  /** Accepts a File (input / HTML drop) or a filesystem path (dialog / native drop). */
  async function loadSubtitleFile(source) {
    try {
      const buf = typeof source === "string"
        ? await (await fetch(tauri.core.convertFileSrc(source))).arrayBuffer()
        : await source.arrayBuffer();
      subtitles = parseCues(decodeSubtitle(buf));
      subtitlesEnabled = subtitles.length > 0;
      updateSubtitleUi();
      updateSubtitles();
      showSnapshotToast(subtitles.length
        ? `Altyazı yüklendi (${subtitles.length} satır)`
        : "⚠️ Altyazı dosyasında geçerli satır bulunamadı");
    } catch (e) {
      console.warn(e);
      showSnapshotToast("⚠️ Altyazı okunamadı");
    }
  }

  function updateSubtitles() {
    if (!subtitles.length || !subtitlesEnabled) {
      subtitleText.textContent = "";
      return;
    }
    const cue = findCue(video.currentTime + (subtitleDelay / 1000));
    subtitleText.textContent = cue ? cue.text : "";
  }

  function setSubtitleDelay(ms) {
    subtitleDelay = ms;
    valSubDelay.textContent = `${subtitleDelay > 0 ? "+" : ""}${subtitleDelay} ms`;
    updateSubtitles();
  }

  // ==========================================================================
  // File Classification
  // ==========================================================================
  const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "ogv", "ts", "avi", "wmv", "flv", "3gp", "3g2", "asf", "mpg", "mpeg", "vob", "mts", "m2ts", "divx",
    "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "amr", "wma"]);
  const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"]);
  const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "avif", "ico"]);
  const SUB_EXT = new Set(["srt", "vtt"]);
  const extOf = (n = "") => n.split(/[?#]/)[0].split(".").pop().toLowerCase();

  /** Works for File objects and for { name } entries coming from the backend. */
  function classify({ name, type = "" }) {
    const ext = extOf(name);
    if (SUB_EXT.has(ext)) return "sub";
    if (IMAGE_EXT.has(ext) || type.startsWith("image/")) return "image";
    if (VIDEO_EXT.has(ext) || type.startsWith("video/") || type.startsWith("audio/")) return "video";
    return "unknown";
  }

  const isImageFile = (url) => IMAGE_EXT.has(extOf(url));

  /**
   * Playlist items are { name, isImage } plus exactly one of:
   *   file (browser File), path (local file via Tauri asset protocol), url (network).
   */
  function resolveSource(item) {
    if (item.file) return acquireObjectUrl(item.file);
    releaseObjectUrl();
    if (item.path) return tauri.core.convertFileSrc(item.playPath || item.path);
    return item.url;
  }

  const itemSize = (item) => item.file?.size ?? item.size ?? 0;

  // ==========================================================================
  // Legacy codec conversion (MPEG-4 Part 2, H.263, WMV, AVI...) via the backend
  // ==========================================================================
  function showTranscode(text, progress) {
    transcodeOverlay.classList.add("active");
    transcodeText.textContent = text;
    transcodeBar.style.width = `${Math.round(progress * 100)}%`;
  }

  function hideTranscode() {
    transcodeOverlay.classList.remove("active");
  }

  function cancelTranscode() {
    if (!transcodingPath) return;
    transcodingPath = null;
    hideTranscode();
    invoke?.("cancel_transcode").catch(() => {});
  }

  tauri?.event?.listen("transcode-progress", (e) => {
    if (e.payload.path === transcodingPath) {
      transcodeBar.style.width = `${Math.round(e.payload.progress * 100)}%`;
    }
  });

  function transcodeAndPlay(item, gen, codec) {
    unloadVideoElements();
    transcodingPath = item.path;
    showTranscode(`Eski codec${codec ? ` (${codec})` : ""} uyumlu formata dönüştürülüyor… İlk açılışta bir kez yapılır.`, 0);
    invoke("transcode_media", { path: item.path })
      .then((out) => {
        if (gen !== loadGen) return;
        transcodingPath = null;
        hideTranscode();
        item.playPath = out;
        playVideoItem(item, gen);
      })
      .catch((err) => {
        if (gen !== loadGen || err === "cancelled") return;
        transcodingPath = null;
        hideTranscode();
        console.warn("transcode_media", err);
        showSnapshotToast(`⚠️ Video dönüştürülemedi: ${err}`);
      });
    return true;
  }

  // ==========================================================================
  // Photo Studio & Hybrid Media Engine
  // ==========================================================================

  /** Scale that keeps a 90°/270° rotated image inside the container. */
  function getRotationFitScale() {
    if (photoRotation % 180 === 0 || !imageElement.naturalWidth) return 1;
    const c = imageContainer.getBoundingClientRect();
    const w = imageElement.offsetWidth, h = imageElement.offsetHeight; // pre-rotation render size
    if (!w || !h) return 1;
    return Math.min(c.width / h, c.height / w, 1);
  }

  function updateImageTransform(withTransition = false) {
    if (!imageElement) return;
    const fit = getRotationFitScale();
    const transition = withTransition ? "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)" : "none";
    const transform = `translate(${photoPanX}px, ${photoPanY}px) scale(${photoZoom * fit}) rotate(${photoRotation}deg)`;
    imageElement.style.transition = transition;
    imageElement.style.transform = transform;
    // The GPU canvas mirrors the image so zoom/pan/rotate keep working while enhanced
    if (enhancer?.active && enhancer.source === imageElement) {
      gpuCanvas.style.transition = transition;
      gpuCanvas.style.transform = transform;
    }
    if (photoZoomLevel) {
      photoZoomLevel.textContent = Math.abs(photoZoom - 1) < 0.05 ? "Fit" : `${Math.round(photoZoom * 100)}%`;
    }
  }

  function resetPhotoTransform() {
    photoZoom = 1.0;
    photoPanX = 0;
    photoPanY = 0;
    photoRotation = 0;
    updateImageTransform(true);
  }

  function zoomPhoto(factor, clientX, clientY) {
    const prevZoom = photoZoom;
    let nextZoom = photoZoom * factor;
    nextZoom = Math.max(0.1, Math.min(10.0, nextZoom));
    if (Math.abs(nextZoom - 1.0) < 0.04 && factor !== 1.0) {
      nextZoom = 1.0;
    }

    if (clientX !== undefined && clientY !== undefined && imageContainer) {
      const rect = imageContainer.getBoundingClientRect();
      const originX = clientX - (rect.left + rect.width / 2);
      const originY = clientY - (rect.top + rect.height / 2);
      photoPanX = originX - (originX - photoPanX) * (nextZoom / prevZoom);
      photoPanY = originY - (originY - photoPanY) * (nextZoom / prevZoom);
    }

    photoZoom = nextZoom;
    if (photoZoom <= 1.0) {
      photoPanX = 0;
      photoPanY = 0;
    }
    updateImageTransform(false);
  }

  // Slideshow: a setTimeout chain that only counts once the current image has loaded
  function scheduleNextSlide() {
    clearTimeout(slideshowTimer);
    if (!isSlideshowActive || playlist.length < 2) return;
    slideshowTimer = setTimeout(() => navigatePlaylist(1), SLIDESHOW_INTERVAL_MS);
  }

  function toggleSlideshow(forceState, { silent = false } = {}) {
    const next = typeof forceState === "boolean" ? forceState : !isSlideshowActive;
    if (next && playlist.length < 2) {
      if (!silent) showSnapshotToast("Slayt gösterisi için listede en az 2 medya olmalı");
      return;
    }
    isSlideshowActive = next;
    if (iconSlideshowPlay) iconSlideshowPlay.style.display = isSlideshowActive ? "none" : "inline-block";
    if (iconSlideshowPause) iconSlideshowPause.style.display = isSlideshowActive ? "inline-block" : "none";
    if (isSlideshowActive) {
      scheduleNextSlide();
      if (!silent) showSnapshotToast("Slayt Gösterisi Başlatıldı (3.5 sn)");
    } else {
      clearTimeout(slideshowTimer);
      slideshowTimer = null;
      if (!silent) showSnapshotToast("Slayt Gösterisi Duraklatıldı");
    }
  }

  function updatePhotoCounter() {
    if (!photoCounterBadge) return;
    const showNav = currentMediaType === "image" && playlist.length > 1;
    if (playlist.length > 0 && currentPlaylistIndex >= 0) {
      photoCounterBadge.textContent = `${currentPlaylistIndex + 1} / ${playlist.length}`;
    } else {
      photoCounterBadge.textContent = "1 / 1";
    }
    if (btnFloatingPrev) btnFloatingPrev.style.display = showNav ? "flex" : "none";
    if (btnFloatingNext) btnFloatingNext.style.display = showNav ? "flex" : "none";
  }

  // Load Image File / Source
  function loadImageSource(item) {
    ++loadGen;
    currentMediaType = "image";
    unloadVideoElements();
    disableEnhancerVisuals();
    enhancerBlocked = false;
    isTaintedSource = false;
    currentFileKey = "";
    video.style.display = "none";
    controlsHud.style.display = "none";
    timelineContainer.style.display = "none";
    subtitleText.textContent = "";

    imageContainer.style.display = "flex";
    photoHud.style.display = "flex";
    dropZone.classList.remove("visible");

    const src = resolveSource(item);
    const name = item.name || "Fotoğraf";
    const size = itemSize(item);
    const sizeMB = size / (1024 * 1024);
    const fileSizeStr = !size ? "-" : sizeMB >= 1 ? `${sizeMB.toFixed(2)} MB` : `${Math.round(size / 1024)} KB`;

    currentFilename.textContent = name;

    // Remote images: ask for CORS so the GPU enhancer and snapshots keep working
    if (isRemoteUrl(src)) imageElement.crossOrigin = "anonymous";
    else imageElement.removeAttribute("crossorigin");
    let retriedWithoutCors = false;

    imageElement.onload = () => {
      const w = imageElement.naturalWidth;
      const h = imageElement.naturalHeight;
      if (infoRes) infoRes.textContent = `${w} × ${h}`;
      if (infoSize) infoSize.textContent = fileSizeStr;
      if (infoFormat) infoFormat.textContent = extOf(name).toUpperCase() || "IMG";
      if (infoRatio) {
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const d = gcd(w, h);
        infoRatio.textContent = d > 0 ? `${Math.round(w / d)}:${Math.round(h / d)}` : "-";
      }
      updateImageTransform();
      if (isAiRestoreEnabled) {
        enhancer?.stop();
        applyVideoFilters();
      }
      scheduleNextSlide();
    };

    imageElement.onerror = () => {
      if (imageElement.crossOrigin && !retriedWithoutCors) {
        // Server does not send CORS headers: show the image anyway, without GPU access
        retriedWithoutCors = true;
        isTaintedSource = true;
        imageElement.removeAttribute("crossorigin");
        imageElement.src = src;
        return;
      }
      showSnapshotToast(`⚠️ "${name}" açılamadı. Bu görsel formatı (TIFF/HEIC vb.) desteklenmiyor veya dosya bozuk.`);
      scheduleNextSlide();
    };

    imageElement.src = src;
    resetPhotoTransform();
    applyVideoFilters();
    updatePhotoCounter();
    resetHudTimeout();
  }

  // Master Unified Media Source Loader (Video or Image)
  function loadMediaSource(item) {
    cancelTranscode();
    resetDeepEnhance();
    if (item.isImage) {
      loadImageSource(item);
    } else {
      loadVideoSource(item);
    }
  }

  // ==========================================================================
  // Codec & Format Diagnostics
  // ==========================================================================
  const MEDIA_ERR_TEXT = {
    1: "Yükleme iptal edildi.",
    2: "Ağ hatası: kaynak indirilemedi.",
    3: "Çözme hatası: dosya bozuk ya da codec (HEVC/AV1) donanımca desteklenmiyor.",
    4: "Format desteklenmiyor (konteyner/codec). MP4 (H.264/AAC) veya WebM (VP9/Opus) önerilir.",
  };

  /** True when audio is advancing but not a single video frame was decoded. */
  function noVideoFramesDecoded() {
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
    const bytes = video.webkitVideoDecodedByteCount;
    return (frames === undefined || frames === 0) && (bytes === undefined || bytes === 0);
  }

  /**
   * onUnsupported(): called when the webview can't show the picture (unsupported
   * codec/container). Returns true if it handled it (e.g. started a conversion).
   */
  function attachVideoDiagnostics(name, gen, { retryWithoutCors, onUnsupported } = {}) {
    const ext = extOf(name);
    const audioOnly = AUDIO_EXT.has(ext);
    let handled = false;
    const unsupported = () => {
      if (handled) return true;
      handled = !!onUnsupported?.();
      return handled;
    };

    video.onerror = () => {
      const code = video.error?.code ?? 0;
      console.warn("MediaError", code, video.error?.message);
      if (retryWithoutCors?.()) return;
      if ((code === 3 || code === 4) && unsupported()) return;
      showSnapshotToast(`⚠️ ${MEDIA_ERR_TEXT[code] || "Bilinmeyen medya hatası."}`);
      setPlayState(false);
    };

    video.onloadeddata = () => {
      if (isAiRestoreEnabled) {
        enhancer?.stop();
        applyVideoFilters();
      }
      // 1) No picture: unsupported video codec (MPEG-4 Part 2, H.263...) or missing HEVC extension
      if (video.videoWidth === 0 && !audioOnly) {
        if (!unsupported()) {
          showSnapshotToast("⚠️ Video akışı çözülemedi (yalnızca ses). HEVC için Microsoft 'HEVC Video Extensions' gerekebilir.");
        }
        return;
      }
      // Some codecs report a frame size yet never produce frames: verify after playback starts
      setTimeout(() => {
        if (gen === loadGen && !audioOnly && video.currentTime > 0.5 && noVideoFramesDecoded()) {
          if (!unsupported()) showSnapshotToast("⚠️ Video karesi çözülemedi; yalnızca ses oynatılıyor.");
        }
      }, 1500);
      // 2) No sound: unsupported audio codec such as AC3/DTS (Chromium-only counters)
      setTimeout(() => {
        if (gen === loadGen && !video.paused && video.currentTime > 1.5 &&
            "webkitAudioDecodedByteCount" in video &&
            video.webkitAudioDecodedByteCount === 0 &&
            video.webkitVideoDecodedByteCount > 0) {
          showSnapshotToast("🔇 Ses izi çözülemedi (AC3/DTS/E-AC3 desteklenmiyor olabilir).");
        }
      }, 2500);
    };
  }

  function startPlayback() {
    video.play().then(() => checkResumePlayback()).catch((err) => {
      if (err.name !== "AbortError") console.warn("play()", err);
      setPlayState(false);
    });
  }

  // Load Video File / Source
  function loadVideoSource(item) {
    const gen = ++loadGen;
    currentMediaType = "video";
    if (isSlideshowActive) toggleSlideshow(false, { silent: true });
    unloadImageElement();
    unloadVideoElements();
    disableEnhancerVisuals();
    enhancerBlocked = false;
    imageContainer.style.display = "none";
    photoHud.style.display = "none";
    if (btnFloatingPrev) btnFloatingPrev.style.display = "none";
    if (btnFloatingNext) btnFloatingNext.style.display = "none";
    if (photoInfoCard) photoInfoCard.style.display = "none";

    video.style.display = "block";
    controlsHud.style.display = "flex";
    timelineContainer.style.display = "flex";

    const name = item.name || "Online Video";
    currentFileKey = item.url ? "vho_url_" + item.url : `vho_file_${name}_${itemSize(item)}`;

    resumePendingTime = 0;
    clearTimeout(resumeToastTimer);
    resumeToast.classList.remove("show");

    currentFilename.textContent = name;
    dropZone.classList.remove("visible");
    subtitles = [];
    subtitlesEnabled = true;
    updateSubtitleUi();
    subtitleText.textContent = "";
    clearAbLoop();
    timelineProgress.style.width = "0%";
    timelineBuffer.style.width = "0%";
    timeCurrent.textContent = timeTotal.textContent = "00:00";
    updatePhotoCounter();

    // Local files: ask the backend whether the webview can decode the codecs at all.
    // Legacy codecs (e.g. MPEG-4 Part 2 from old phones) would otherwise play sound only.
    if (item.path && invoke && !item.playPath && !item.probed) {
      invoke("probe_media", { path: item.path })
        .then((info) => {
          if (gen !== loadGen) return;
          item.probed = true;
          if (info.needsTranscode) transcodeAndPlay(item, gen, info.videoCodec);
          else playVideoItem(item, gen);
        })
        .catch((err) => {
          console.warn("probe_media", err);
          if (gen !== loadGen) return;
          item.probed = true;
          playVideoItem(item, gen);
        });
      return;
    }
    playVideoItem(item, gen);
  }

  function playVideoItem(item, gen) {
    const name = item.name || "Online Video";
    const src = resolveSource(item);

    // Remote media: request CORS so Web Audio / WebGL can read it. If the server
    // refuses, retry once without CORS and run without boost/enhancer.
    // (Local files come from http://asset.localhost, which sends CORS headers.)
    let retryWithoutCors = null;
    isTaintedSource = false;
    if (isRemoteUrl(src)) {
      video.crossOrigin = "anonymous";
      let retried = false;
      retryWithoutCors = () => {
        if (retried) return false;
        retried = true;
        isTaintedSource = true;
        video.removeAttribute("crossorigin");
        video.src = src;
        video.load();
        startPlayback();
        if (audioSourceNode) {
          showSnapshotToast("⚠️ Sunucu CORS izni vermiyor: ses işleme açık olduğundan ses gelmeyebilir. Uygulamayı yeniden başlatıp bu linki ses güçlendirici kullanmadan açın.");
        }
        return true;
      };
    } else {
      video.removeAttribute("crossorigin");
    }

    const canConvert = !!(item.path && invoke && !item.playPath);
    attachVideoDiagnostics(name, gen, {
      retryWithoutCors,
      onUnsupported: () => canConvert && transcodeAndPlay(item, gen),
    });
    video.src = src;
    video.load();
    applyVideoFilters();
    startPlayback();
  }

  // Check LocalStorage for Resume Playback
  function checkResumePlayback() {
    const saved = localStorage.getItem(currentFileKey);
    if (!saved) return;
    const savedTime = parseFloat(saved);
    if (savedTime > 8 && Number.isFinite(video.duration) && savedTime < (video.duration - 15)) {
      resumePendingTime = savedTime;
      resumeTimeText.textContent = `${formatTime(savedTime)} süresinde kalmıştınız`;
      resumeToast.classList.add("show");
      clearTimeout(resumeToastTimer);
      resumeToastTimer = setTimeout(() => resumeToast.classList.remove("show"), 8000);
    }
  }

  btnResumeYes.addEventListener("click", () => {
    if (resumePendingTime) {
      video.currentTime = resumePendingTime;
      resumePendingTime = 0;
    }
    resumeToast.classList.remove("show");
  });

  btnResumeNo.addEventListener("click", () => {
    localStorage.removeItem(currentFileKey);
    resumePendingTime = 0;
    resumeToast.classList.remove("show");
  });

  // Save Progress Regularly
  setInterval(() => {
    if (currentFileKey && currentMediaType === "video" && video.currentTime > 5 && !video.paused) {
      localStorage.setItem(currentFileKey, video.currentTime);
    }
  }, 3000);

  // Play / Pause Toggle (UI state follows the media element's own events)
  function togglePlay() {
    if (currentMediaType !== "video" || !video.src || dropZone.classList.contains("visible")) return;
    if (video.paused) {
      video.play().catch((err) => {
        if (err.name !== "AbortError") console.warn("play()", err);
      });
      triggerRipple("play");
    } else {
      video.pause();
      triggerRipple("pause");
    }
  }

  function setPlayState(playing) {
    isPlaying = playing;
    document.body.classList.toggle("is-playing", playing);
    if (playing) {
      iconPlay.style.display = "none";
      iconPause.style.display = "block";
      resetHudTimeout();
    } else {
      iconPlay.style.display = "block";
      iconPause.style.display = "none";
      showHud();
    }
  }

  video.addEventListener("playing", () => setPlayState(true));
  video.addEventListener("pause", () => setPlayState(false));
  video.addEventListener("emptied", () => setPlayState(false));

  function triggerRipple(type) {
    centerRipple.innerHTML = type === "play"
      ? '<svg viewBox="0 0 24 24" width="36" height="36" fill="#00f2fe"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="36" height="36" fill="#00f2fe"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    centerRipple.classList.add("animate");
    setTimeout(() => {
      centerRipple.classList.remove("animate");
    }, 400);
  }

  // Frame-accurate A-B loop (timeupdate only fires ~4 Hz and overshoots B by up to 250 ms)
  function checkAbLoop() {
    if (loopPointA !== null && loopPointB !== null && video.currentTime >= loopPointB) {
      video.currentTime = loopPointA;
    }
  }

  function armAbLoop() {
    if (!video.requestVideoFrameCallback || loopPointB === null) return;
    const gen = ++abLoopGen;
    const tick = () => {
      if (gen !== abLoopGen || loopPointB === null) return;
      checkAbLoop();
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  }

  // Time & Seek Updates
  video.addEventListener("timeupdate", () => {
    checkAbLoop();
    if (!isSeeking) {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        timelineProgress.style.width = `${(video.currentTime / video.duration) * 100}%`;
      }
      timeCurrent.textContent = formatTime(video.currentTime);
    }
    updateSubtitles();
  });

  video.addEventListener("loadedmetadata", () => {
    timeTotal.textContent = formatTime(video.duration);
    timeCurrent.textContent = formatTime(video.currentTime);
  });

  video.addEventListener("progress", () => {
    if (video.buffered.length > 0 && Number.isFinite(video.duration) && video.duration > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      timelineBuffer.style.width = `${(bufferedEnd / video.duration) * 100}%`;
    }
  });

  // Video End -> Sleep Timer Check or Playlist Auto Advance
  video.addEventListener("ended", () => {
    localStorage.removeItem(currentFileKey);
    if (isSleepTimerVideoEnd) {
      triggerSleepMode();
      return;
    }
    if (playlist.length > 0 && currentPlaylistIndex >= 0 && currentPlaylistIndex < playlist.length - 1) {
      playPlaylistItem(currentPlaylistIndex + 1);
    } else {
      setPlayState(false);
      showHud();
    }
  });

  // YouTube Style Live Thumbnail Preview on Timeline Hover (one seek in flight at a time)
  function requestThumb(t) {
    if (thumbVideo.seeking) {
      thumbPendingTime = t;
      return;
    }
    if (typeof thumbVideo.fastSeek === "function") thumbVideo.fastSeek(t);
    else thumbVideo.currentTime = t;
  }

  thumbVideo.addEventListener("seeked", () => {
    if (thumbVideo.videoWidth) {
      thumbCtx.drawImage(thumbVideo, 0, 0, timelineThumbCanvas.width, timelineThumbCanvas.height);
    }
    if (thumbPendingTime !== null) {
      const t = thumbPendingTime;
      thumbPendingTime = null;
      requestThumb(t);
    }
  });

  timelineContainer.addEventListener("mousemove", (e) => {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    const rect = timelineContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = pos * video.duration;
    timelineTooltipTime.textContent = formatTime(targetTime);
    timelineTooltip.style.left = `${pos * 100}%`;

    // Throttle thumbnail seeking to every 100ms
    const now = Date.now();
    if (now - lastThumbSeek > 100) {
      lastThumbSeek = now;
      if (video.currentSrc && thumbVideo.src !== video.currentSrc) {
        thumbVideo.src = video.currentSrc;
      }
      try {
        requestThumb(targetTime);
      } catch (_) {}
    }
  });

  timelineContainer.addEventListener("click", (e) => {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    const rect = timelineContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pos * video.duration;
    timelineProgress.style.width = `${pos * 100}%`;
  });

  // Seek helper that respects live streams / unknown duration
  function seekBy(delta) {
    const t = video.currentTime + delta;
    video.currentTime = Number.isFinite(video.duration)
      ? Math.max(0, Math.min(video.duration, t))
      : Math.max(0, t);
  }

  // Skip Buttons
  btnSkipBack.addEventListener("click", () => seekBy(-10));
  btnSkipFwd.addEventListener("click", () => seekBy(10));

  // Volume & 200% BOOSTER Controller
  volumeSlider.addEventListener("input", (e) => {
    setVolume(parseInt(e.target.value, 10));
  });

  function setVolume(val) {
    if (val > 100 && !ensureAudioGraph()) {
      val = 100;
      showSnapshotToast("⚠️ Bu kaynakta ses güçlendirici kullanılamıyor (CORS)");
    }
    volumeSlider.value = val;
    volumeBadge.textContent = `${val}%`;
    if (val > 0) lastNonZeroVolume = val;

    video.volume = Math.min(val, 100) / 100;
    setGain(volumeToGain(val));

    iconVolMute.style.display = val === 0 ? "block" : "none";
    iconVolHigh.style.display = val > 0 && val <= 100 ? "block" : "none";
    iconVolBoost.style.display = val > 100 ? "block" : "none";
    volumeContainer.classList.toggle("boosted", val > 100);
  }

  btnVolume.addEventListener("click", () => {
    setVolume(parseInt(volumeSlider.value, 10) > 0 ? 0 : lastNonZeroVolume);
  });

  // A-B Loop Logic
  btnAbLoop.addEventListener("click", () => {
    if (!Number.isFinite(video.duration) || !video.duration) return;
    if (loopPointA === null) {
      loopPointA = video.currentTime;
      abMarkerA.style.left = `${(loopPointA / video.duration) * 100}%`;
      abMarkerA.style.display = "block";
      abLoopLabel.textContent = "A: " + formatTime(loopPointA) + " -> B?";
      btnAbLoop.classList.add("active");
    } else if (loopPointB === null) {
      if (video.currentTime <= loopPointA) return;
      loopPointB = video.currentTime;
      abMarkerB.style.left = `${(loopPointB / video.duration) * 100}%`;
      abMarkerB.style.display = "block";

      const leftPct = (loopPointA / video.duration) * 100;
      const widthPct = ((loopPointB - loopPointA) / video.duration) * 100;
      abRange.style.left = `${leftPct}%`;
      abRange.style.width = `${widthPct}%`;
      abRange.style.display = "block";

      abLoopLabel.textContent = "A-B Döngüde";
      video.currentTime = loopPointA;
      armAbLoop();
    } else {
      clearAbLoop();
    }
  });

  function clearAbLoop() {
    loopPointA = null;
    loopPointB = null;
    abLoopGen++;
    abMarkerA.style.display = "none";
    abMarkerB.style.display = "none";
    abRange.style.display = "none";
    abLoopLabel.textContent = "A-B Döngü";
    btnAbLoop.classList.remove("active");
  }

  // ==========================================================================
  // Snapshot / Screenshot Capture
  // ==========================================================================
  btnSnapshot.addEventListener("click", captureSnapshot);

  function downloadBlob(blob, filename) {
    if (!blob) {
      showSnapshotToast("⚠️ Görüntü oluşturulamadı");
      return false;
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function downloadCanvas(canvas, filename, successMsg) {
    try {
      canvas.toBlob((blob) => {
        if (downloadBlob(blob, filename)) showSnapshotToast(successMsg);
      }, "image/png");
    } catch (e) {
      console.warn("Snapshot:", e);
      showSnapshotToast("⚠️ Uzak kaynaktan ekran görüntüsü alınamıyor (CORS)");
    }
  }

  function flashScreen() {
    screenFlash.classList.add("active");
    setTimeout(() => screenFlash.classList.remove("active"), 150);
  }

  async function captureSnapshot() {
    const safeName = (currentFilename.textContent || "VHO").replace(/[^a-zA-Z0-9_\-]/g, "_");

    // What you see is what you save: grab the enhanced GPU frame when it's active
    if (enhancer?.active) {
      flashScreen();
      const suffix = currentMediaType === "video" ? formatTime(video.currentTime).replaceAll(":", "-") : "enhanced";
      if (downloadBlob(await enhancer.snapshot(), `${safeName}_${suffix}.png`)) {
        showSnapshotToast("Geliştirilmiş kare kaydedildi!");
      }
      return;
    }

    if (currentMediaType === "image" && imageElement.naturalWidth) {
      flashScreen();
      const w = imageElement.naturalWidth;
      const h = imageElement.naturalHeight;
      const rotated = photoRotation % 180 !== 0;
      const canvas = document.createElement("canvas");
      canvas.width = rotated ? h : w;
      canvas.height = rotated ? w : h;
      const ctx = canvas.getContext("2d");
      if (imageElement.style.filter) ctx.filter = imageElement.style.filter;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((photoRotation * Math.PI) / 180);
      ctx.drawImage(imageElement, -w / 2, -h / 2, w, h);
      downloadCanvas(canvas, `${safeName}_enhanced.png`, "Geliştirilmiş fotoğraf kaydedildi!");
      return;
    }

    if (currentMediaType !== "video" || !video.videoWidth || !video.videoHeight) return;
    flashScreen();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (video.style.filter) ctx.filter = video.style.filter;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    downloadCanvas(canvas, `${safeName}_${formatTime(video.currentTime).replaceAll(":", "-")}.png`, "Ekran görüntüsü kaydedildi!");
  }

  function showSnapshotToast(msg) {
    if (msg) snapshotToast.querySelector("span").textContent = msg;
    snapshotToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => snapshotToast.classList.remove("show"), 2800);
  }

  // Picture in Picture (PiP)
  btnPip.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && currentMediaType === "video") {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.warn("PiP not supported or failed", err);
    }
  });

  // Aspect Ratio Menu
  btnAspectRatio.addEventListener("click", (e) => {
    e.stopPropagation();
    aspectMenu.classList.toggle("show");
    speedMenu.classList.remove("show");
  });

  const ASPECT_CLASSES = ["aspect-16-9", "aspect-21-9", "aspect-4-3", "aspect-fill"];
  let currentAspect = "contain";

  document.querySelectorAll("#aspect-menu .dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      currentAspect = item.dataset.aspect;
      video.classList.remove(...ASPECT_CLASSES);
      if (currentAspect !== "contain") {
        video.classList.add(`aspect-${currentAspect}`);
      }
      aspectLabel.textContent = item.textContent.split(" ")[0];
      document.querySelectorAll("#aspect-menu .dropdown-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      aspectMenu.classList.remove("show");
      applyVideoFilters(); // the GPU enhancer follows the forced aspect box
    });
  });

  // Speed Selector
  btnSpeed.addEventListener("click", (e) => {
    e.stopPropagation();
    speedMenu.classList.toggle("show");
    aspectMenu.classList.remove("show");
  });

  document.querySelectorAll("#speed-menu .dropdown-item").forEach((item) => {
    item.addEventListener("click", () => {
      const spd = parseFloat(item.dataset.speed);
      video.playbackRate = spd;
      speedLabel.textContent = `${spd}x`;
      document.querySelectorAll("#speed-menu .dropdown-item").forEach(i => i.classList.remove("active"));
      item.classList.add("active");
      speedMenu.classList.remove("show");
    });
  });

  // Subtitles (CC) Toggle & Menu Controller
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
    btnSearchSubtitles.click();
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
    showSnapshotToast("Altyazı kaldırıldı");
  });

  document.addEventListener("click", () => {
    speedMenu.classList.remove("show");
    aspectMenu.classList.remove("show");
    if (subtitlesMenu) subtitlesMenu.classList.remove("show");
  });

  // ==========================================================================
  // Fullscreen (Tauri window API; DOM Fullscreen API in a plain browser)
  // ==========================================================================
  btnFullscreen.addEventListener("click", toggleFullscreen);

  function syncFsIcons(isFs) {
    iconFsEnter.style.display = isFs ? "none" : "block";
    iconFsExit.style.display = isFs ? "block" : "none";
  }

  async function setFullscreen(on) {
    if (appWindow) {
      try {
        await appWindow.setFullscreen(on);
        document.documentElement.classList.toggle("is-fullscreen", on);
        syncFsIcons(on);
      } catch (err) {
        console.error("[window] setFullscreen", err);
      }
    } else if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  async function isFullscreen() {
    if (appWindow) return appWindow.isFullscreen().catch(() => false);
    return !!document.fullscreenElement;
  }

  async function toggleFullscreen() {
    setFullscreen(!(await isFullscreen()));
  }

  document.addEventListener("fullscreenchange", () => syncFsIcons(!!document.fullscreenElement));

  // ==========================================================================
  // Playlist Management
  // ==========================================================================
  btnTogglePlaylist.addEventListener("click", () => {
    playlistDrawer.classList.toggle("open");
  });

  btnClosePlaylist.addEventListener("click", () => {
    playlistDrawer.classList.remove("open");
  });

  btnPlaylistAdd.addEventListener("click", () => {
    pickFiles(playlistFileInput, { playFirstNew: false });
  });

  btnPlaylistClear.addEventListener("click", () => {
    toggleSlideshow(false, { silent: true });
    playlist = [];
    currentPlaylistIndex = -1;
    renderPlaylist();
  });

  /**
   * All entry points (dialog, drop, file input, playlist add) go through here.
   * entries: File objects (browser) or { path, name, size } from the backend.
   */
  async function openEntries(entries, { playFirstNew = true } = {}) {
    const subs = entries.filter(f => classify(f) === "sub");
    const media = entries.filter(f => ["video", "image"].includes(classify(f)));
    const rejected = entries.length - subs.length - media.length;
    if (rejected > 0) showSnapshotToast(`${rejected} desteklenmeyen öğe atlandı`);

    if (media.length) {
      const firstNewIndex = playlist.length;
      for (const f of media) {
        const isImage = classify(f) === "image";
        playlist.push(f instanceof File
          ? { file: f, name: f.name, isImage }
          : { path: f.path, name: f.name, size: f.size, isImage });
      }
      if (playFirstNew || currentPlaylistIndex === -1) playPlaylistItem(firstNewIndex);
      else renderPlaylist();
      if (media.length > 1) playlistDrawer.classList.add("open");
    }
    // Apply the subtitle AFTER the media load reset subtitles (guaranteed order)
    if (subs.length) await loadSubtitleFile(subs[0].path ?? subs[0]);
  }

  const openFiles = (fileList, opts) => openEntries(Array.from(fileList ?? []), opts);

  /** Local paths (Tauri): register them with the asset protocol, then open. */
  async function openPaths(paths, opts) {
    if (!paths?.length) return;
    try {
      openEntries(await invoke("prepare_media", { paths }), opts);
    } catch (e) {
      console.error("prepare_media", e);
      showSnapshotToast("⚠️ Dosyalar açılamadı");
    }
  }

  const DIALOG_FILTERS = [
    { name: "Medya ve Altyazı", extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...SUB_EXT] },
    { name: "Tüm Dosyalar", extensions: ["*"] },
  ];

  /** Native file picker in the app (gives real paths), <input type=file> in a browser. */
  async function pickFiles(fallbackInput, opts) {
    if (!tauri?.dialog?.open) {
      fallbackInput.click();
      return;
    }
    try {
      const picked = await tauri.dialog.open({ multiple: true, filters: DIALOG_FILTERS });
      openPaths(Array.isArray(picked) ? picked : picked ? [picked] : [], opts);
    } catch (e) {
      console.error("dialog.open", e);
      fallbackInput.click();
    }
  }

  playlistItemsList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-idx]");
    if (li) playPlaylistItem(Number(li.dataset.idx));
  });

  function renderPlaylist() {
    playlistCountBadge.textContent = playlist.length;
    playlistTotalText.textContent = `${playlist.length} Medya`;

    if (!playlist.length) {
      const empty = document.createElement("li");
      empty.className = "playlist-empty";
      empty.append("Listeniz boş.", document.createElement("br"), "Video veya fotoğraf dosyalarını buraya sürükleyin.");
      playlistItemsList.replaceChildren(empty);
      updatePhotoCounter();
      return;
    }

    const frag = document.createDocumentFragment();
    playlist.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "playlist-item" + (idx === currentPlaylistIndex ? " active" : "");
      li.dataset.idx = idx;

      const badge = document.createElement("span");
      badge.className = `type-badge ${item.isImage ? "is-photo" : "is-video"}`;
      badge.textContent = item.isImage ? "FOTO" : "VİDEO";

      const name = document.createElement("div");
      name.className = "item-name";
      name.title = item.name;
      name.append(badge, `${idx + 1}. ${item.name}`); // text node: no HTML injection

      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = item.file ? `${(item.file.size / 1048576).toFixed(1)} MB` : "Ağ Akışı";

      const info = document.createElement("div");
      info.className = "item-info";
      info.append(name, meta);
      li.append(info);
      frag.append(li);
    });
    playlistItemsList.replaceChildren(frag);
    updatePhotoCounter();
  }

  function playPlaylistItem(index) {
    if (index < 0 || index >= playlist.length) return;
    currentPlaylistIndex = index;
    loadMediaSource(playlist[index]);
    renderPlaylist();
  }

  function navigatePlaylist(step) {
    if (!playlist.length) return;
    let nextIdx = currentPlaylistIndex + step;
    if (nextIdx < 0) nextIdx = playlist.length - 1;
    if (nextIdx >= playlist.length) nextIdx = 0;
    playPlaylistItem(nextIdx);
  }

  // ==========================================================================
  // Effects / Video Filters Panel Logic (GPU enhancer or CSS fallback)
  // ==========================================================================
  btnToggleEffects.addEventListener("click", () => {
    effectsPanel.classList.toggle("show");
  });

  btnCloseEffects.addEventListener("click", () => {
    effectsPanel.classList.remove("show");
  });

  function currentVisualSource() {
    if (currentMediaType === "image" && imageElement.getAttribute("src")) return imageElement;
    if (currentMediaType === "video" && video.getAttribute("src")) return video;
    return null;
  }

  /** With the enhancer on, small photos are upscaled to fill the screen (that's the point of super-resolution). */
  function fitImageForEnhancer(on) {
    const nw = imageElement.naturalWidth, nh = imageElement.naturalHeight;
    const s = on && nw && nh ? Math.min(imageContainer.clientWidth / nw, imageContainer.clientHeight / nh) : 0;
    if (s > 1) {
      imageElement.style.width = `${Math.floor(nw * s)}px`;
      imageElement.style.height = `${Math.floor(nh * s)}px`;
    } else {
      imageElement.style.width = imageElement.style.height = "";
    }
  }

  function disableEnhancerVisuals() {
    fitImageForEnhancer(false);
    enhancer?.stop();
    gpuCanvas.style.transform = "none";
    gpuCanvas.style.transition = "none";
    video.classList.remove("enhancer-source-hidden");
    imageElement.classList.remove("enhancer-source-hidden");
  }

  function applyVideoFilters() {
    const b = parseInt(sliderBrightness.value, 10);
    const c = parseInt(sliderContrast.value, 10);
    const s = parseInt(sliderSaturate.value, 10);
    valBrightness.textContent = `${b}%`;
    valContrast.textContent = `${c}%`;
    valSaturate.textContent = `${s}%`;

    const src = currentVisualSource();
    const useGpu = isAiRestoreEnabled && enhancer && src && !enhancerBlocked && !isTaintedSource;

    if (useGpu) {
      video.style.filter = imageElement.style.filter = "none"; // drop the CSS filter cost
      if (src === imageElement) fitImageForEnhancer(true);
      src.classList.add("enhancer-source-hidden");
      (src === video ? imageElement : video).classList.remove("enhancer-source-hidden");
      enhancer.set({
        sharp: [0, 0.55, 0.8, 1.0][aiSharpLevel] ?? 0.8,
        denoise: [0, 0.1, 0.18, 0.22][aiSharpLevel] ?? 0.18,
        detail: [0, 0.5, 0.9, 1.3][aiSharpLevel] ?? 0.9,
        split: isSplitViewActive ? 0.5 : 0,
        bcs: [b / 100, (c + aiContrastBoost) / 100, s / 100],
        base: [b / 100, c / 100, s / 100],
        box: src === imageElement
          ? () => [imageElement.offsetWidth, imageElement.offsetHeight]
          : currentAspect === "contain" ? null : () => [video.offsetWidth, video.offsetHeight],
      });
      if (!enhancer.active || enhancer.source !== src) enhancer.start(src);
      if (src === imageElement) {
        updateImageTransform();
      } else {
        gpuCanvas.style.transform = "none";
      }
      return;
    }

    disableEnhancerVisuals();
    let filterStr = `brightness(${b}%)`;
    if (isAiRestoreEnabled) {
      // CSS fallback (no WebGL2 / CORS-tainted source): contrast & saturation boost only
      const effectiveC = Math.min(200, c + aiContrastBoost + (aiSharpLevel * 6));
      const effectiveS = Math.min(250, s + (aiSharpLevel * 3));
      filterStr += ` contrast(${effectiveC}%) saturate(${effectiveS}%)`;
    } else {
      filterStr += ` contrast(${c}%) saturate(${s}%)`;
    }
    video.style.filter = filterStr;
    imageElement.style.filter = filterStr;
  }

  sliderBrightness.addEventListener("input", applyVideoFilters);
  sliderContrast.addEventListener("input", applyVideoFilters);
  sliderSaturate.addEventListener("input", applyVideoFilters);

  btnResetFilters.addEventListener("click", () => {
    sliderBrightness.value = 100;
    sliderContrast.value = 100;
    sliderSaturate.value = 100;
    applyVideoFilters();
    setSubtitleDelay(0);
  });

  // Subtitle Delay Controls (+/- 100ms)
  btnSubPlus.addEventListener("click", () => {
    setSubtitleDelay(subtitleDelay + 100);
    showSnapshotToast(`Altyazı senkronu: ${valSubDelay.textContent}`);
  });

  btnSubMinus.addEventListener("click", () => {
    setSubtitleDelay(subtitleDelay - 100);
    showSnapshotToast(`Altyazı senkronu: ${valSubDelay.textContent}`);
  });

  btnSubReset.addEventListener("click", () => {
    setSubtitleDelay(0);
    showSnapshotToast("Altyazı gecikmesi sıfırlandı");
  });

  // GPU Compatibility Mode (adds --disable-gpu-compositing; requires restart)
  if (checkCompatMode) {
    if (tauri?.core?.invoke) {
      tauri.core.invoke("get_compat_mode")
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
        tauri.core.invoke("set_compat_mode", { enabled: on }).catch((e) => {
          console.error("set_compat_mode", e);
          checkCompatMode.checked = !on;
          showSnapshotToast("⚠️ Uyumluluk modu değiştirilemedi");
        });
      });
    } else {
      checkCompatMode.closest("label")?.remove();
    }
  }

  // ==========================================================================
  // AI Video & Audio Restoration Controller (144p / Vintage Video & Audio)
  // WebGL2 CAS shader + Web Audio DSP pipeline, 100% local
  // ==========================================================================
  btnToggleAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.toggle("show");
    effectsPanel?.classList.remove("show");
    playlistDrawer?.classList.remove("open");
  });

  btnCloseAiRestore?.addEventListener("click", () => {
    aiRestorePanel.classList.remove("show");
  });

  function syncAudioRestore() {
    if (aiAudioWanted() && !ensureAudioGraph()) {
      showSnapshotToast("⚠️ Bu kaynakta ses iyileştirme kullanılamıyor (CORS)");
    }
    reconnectAudioPipeline();
  }

  function updateAiMasterState(enabled) {
    isAiRestoreEnabled = enabled;
    if (checkAiMaster) checkAiMaster.checked = enabled;
    syncAudioRestore();
    applyVideoFilters();

    if (enabled) {
      if (aiMasterStatus) {
        aiMasterStatus.textContent = enhancer ? "Aktif (GPU & DSP Açık)" : "Aktif (CSS & DSP, WebGL2 yok)";
        aiMasterStatus.style.color = "var(--accent-ruby-bright)";
      }
      if (aiRestoreBadge) aiRestoreBadge.style.display = "inline-block";
    } else {
      if (aiMasterStatus) {
        aiMasterStatus.textContent = "Kapalı (Orijinal)";
        aiMasterStatus.style.color = "var(--text-muted)";
      }
      if (aiRestoreBadge) aiRestoreBadge.style.display = "none";
      if (isSplitViewActive) {
        toggleSplitView(false);
      }
    }
  }

  checkAiMaster?.addEventListener("change", () => {
    updateAiMasterState(checkAiMaster.checked);
    showSnapshotToast(isAiRestoreEnabled ? "AI Restorasyon & Netleştirici Devrede ✨" : "AI Restorasyon kapatıldı");
  });

  // Presets (data-driven)
  const AI_PRESETS = {
    "144p":   { sharp: 2, contrast: 8,  voice: true,  denoise: true,  comp: true, label: "Seviye 2 (Keskin)" },
    "voice":  { sharp: 1, contrast: 5,  voice: true,  denoise: true,  comp: true, label: "Seviye 1 (Doğal)" },
    "cinema": { sharp: 3, contrast: 12, voice: false, denoise: false, comp: true, label: "Seviye 3 (Ultra Detay)" },
  };

  const presetButtons = document.querySelectorAll(".btn-restore-preset");
  presetButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      presetButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const p = AI_PRESETS[btn.dataset.preset];

      if (p) {
        aiSharpLevel = p.sharp;
        if (sliderAiSharp) sliderAiSharp.value = p.sharp;
        if (valAiSharp) valAiSharp.textContent = p.label;
        aiContrastBoost = p.contrast;
        if (sliderAiContrast) sliderAiContrast.value = p.contrast;
        if (valAiContrast) valAiContrast.textContent = `+${p.contrast}%`;
        if (checkAiVoiceClarity) checkAiVoiceClarity.checked = p.voice;
        if (checkAiDenoise) checkAiDenoise.checked = p.denoise;
        if (checkAiCompressor) checkAiCompressor.checked = p.comp;
      }

      if (!isAiRestoreEnabled) {
        updateAiMasterState(true);
      } else {
        syncAudioRestore();
        applyVideoFilters();
      }
      showSnapshotToast(`Restorasyon Modu: ${btn.textContent.trim()}`);
    });
  });

  function markCustomPreset() {
    presetButtons.forEach(b => b.classList.remove("active"));
    document.querySelector('.btn-restore-preset[data-preset="custom"]')?.classList.add("active");
  }

  sliderAiSharp?.addEventListener("input", () => {
    aiSharpLevel = parseInt(sliderAiSharp.value, 10);
    valAiSharp.textContent = aiSharpLevel === 0 ? "Kapalı" : (aiSharpLevel === 3 ? "Seviye 3 (Ultra)" : `Seviye ${aiSharpLevel}`);
    markCustomPreset();
    if (!isAiRestoreEnabled) updateAiMasterState(true);
    else applyVideoFilters();
  });

  sliderAiContrast?.addEventListener("input", () => {
    aiContrastBoost = parseInt(sliderAiContrast.value, 10);
    valAiContrast.textContent = `+${aiContrastBoost}%`;
    markCustomPreset();
    if (!isAiRestoreEnabled) updateAiMasterState(true);
    else applyVideoFilters();
  });

  [checkAiVoiceClarity, checkAiDenoise, checkAiCompressor].forEach((check) => {
    check?.addEventListener("change", () => {
      if (!isAiRestoreEnabled) updateAiMasterState(true);
      else syncAudioRestore();
    });
  });

  // Split-Screen A/B Comparison (left half original, right half processed by the shader)
  function toggleSplitView(forceState) {
    const next = typeof forceState === "boolean" ? forceState : !isSplitViewActive;
    if (next && !enhancer) {
      showSnapshotToast("⚠️ A/B karşılaştırma için WebGL2 desteği gerekli");
      return;
    }
    isSplitViewActive = next;
    if (isSplitViewActive && !isAiRestoreEnabled) {
      updateAiMasterState(true);
    }
    if (splitViewStatus) {
      splitViewStatus.textContent = isSplitViewActive ? "Açık" : "Kapalı";
      splitViewStatus.style.color = isSplitViewActive ? "var(--accent-ruby-bright)" : "";
    }
    if (splitScreenBanner) {
      splitScreenBanner.style.display = isSplitViewActive ? "flex" : "none";
    }
    if (splitScreenLine) {
      splitScreenLine.style.display = isSplitViewActive ? "block" : "none";
    }
    applyVideoFilters();
    showSnapshotToast(isSplitViewActive ? "A/B Karşılaştırma Modu Açık" : "A/B Karşılaştırma Kapatıldı");
  }

  btnToggleSplitView?.addEventListener("click", () => toggleSplitView());

  // ==========================================================================
  // Deep AI Restoration (neural network, downloaded on first use)
  // ==========================================================================
  const btnDeepEnhance = document.getElementById("btn-deep-enhance");
  const deepProgress = document.getElementById("deep-progress");
  const deepProgressBar = document.getElementById("deep-progress-bar");
  const deepStatus = document.getElementById("deep-status");
  const deepResultActions = document.getElementById("deep-result-actions");
  const btnDeepCompare = document.getElementById("btn-deep-compare");
  const btnDeepSave = document.getElementById("btn-deep-save");
  const checkDeepFaces = document.getElementById("check-deep-faces");
  const DEEP_IDLE_TEXT = deepStatus.textContent;
  const DEEP_MAX_OUTPUT_PIXELS = 40e6; // keeps memory sane for already-large photos

  let deepJob = null;    // AbortController of the running job
  let deepResult = null; // { url, blob, originalSrc, showingEnhanced }

  function resetDeepEnhance() {
    deepJob?.abort();
    deepJob = null;
    if (deepResult) URL.revokeObjectURL(deepResult.url);
    deepResult = null;
    deepProgress.hidden = true;
    deepResultActions.hidden = true;
    deepStatus.textContent = DEEP_IDLE_TEXT;
    btnDeepEnhance.textContent = "✨ Fotoğrafı İyileştir (4x, E)";
  }

  function setDeepProgress(text, fraction) {
    deepProgress.hidden = false;
    deepProgressBar.style.width = `${Math.round(fraction * 100)}%`;
    deepStatus.textContent = text;
  }

  /** Reads the original photo pixels, shrinking huge photos so the 4x output stays reasonable. */
  function readOriginalPixels() {
    let w = imageElement.naturalWidth, h = imageElement.naturalHeight;
    const k = Math.min(1, Math.sqrt(DEEP_MAX_OUTPUT_PIXELS / (w * h * 16)));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(imageElement, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  async function deepEnhancePhoto() {
    if (deepJob) { // the button doubles as "cancel" while running
      deepJob.abort();
      return;
    }
    if (!invoke) {
      showSnapshotToast("Yapay zeka iyileştirme yalnızca masaüstü uygulamasında kullanılabilir");
      return;
    }
    if (currentMediaType !== "image" || !imageElement.naturalWidth) {
      showSnapshotToast("Önce bir fotoğraf açın");
      return;
    }
    if (isTaintedSource) {
      showSnapshotToast("⚠️ Bu uzak görsel CORS izni vermediği için işlenemiyor");
      return;
    }
    if (deepResult) { // already done for this photo: just show it
      showDeepVariant(true);
      return;
    }

    const withFaces = checkDeepFaces.checked;
    const components = withFaces ? ["photo-x4", FACE_MODEL.component] : ["photo-x4"];
    const pending = await pendingDownloadBytes(...components);
    if (pending > 0) {
      const mb = Math.round(pending / 1048576);
      const ok = window.confirm(
        `İlk kullanım: yaklaşık ${mb} MB yapay zeka bileşeni indirilecek ve bilgisayarınızda saklanacak.\n\n` +
        `• ONNX Runtime Web — Microsoft, MIT Lisansı\n` +
        `• ${MODELS["photo-x4"].title} — ${MODELS["photo-x4"].credit}\n` +
        (withFaces ? `• ${FACE_MODEL.title} — ${FACE_MODEL.credit}\n` : "") +
        `\nDevam edilsin mi?`);
      if (!ok) return;
    }

    const gen = loadGen;
    const job = new AbortController();
    deepJob = job;
    btnDeepEnhance.textContent = "■ İptal Et";
    deepResultActions.hidden = true;
    const hw = await describeHardware();
    const originalSrc = imageElement.currentSrc;
    const startedAt = performance.now();

    try {
      const pixels = readOriginalPixels();
      const res = await upscaleImage("photo-x4", pixels, {
        signal: job.signal,
        onProgress: (phase, f) => {
          if (phase === "download") setDeepProgress(`Bileşen indiriliyor… %${Math.round(f * 100)}`, f);
          else if (phase === "load") setDeepProgress(`Model hazırlanıyor… (${hw})`, 0);
          else setDeepProgress(`İyileştiriliyor… %${Math.round(f * 100)} — ${hw}`, f);
        },
      });
      if (gen !== loadGen) return;

      let finalImage = res.imageData;
      let faceNote = "";
      if (withFaces) {
        try {
          const fr = await restoreFacesInImage(res.imageData, {
            strength: 1,
            srcScale: res.imageData.width / pixels.width,
          }, {
            signal: job.signal,
            original: pixels, // faces are cropped from the original, see face-restore.js
            onProgress: (phase, f) => {
              if (phase === "download") setDeepProgress(`Yüz modeli indiriliyor… %${Math.round(f * 100)}`, f);
              else if (phase === "load") setDeepProgress("Yüzler aranıyor…", 0);
              else setDeepProgress(`Yüzler iyileştiriliyor… %${Math.round(f * 100)}`, f);
            },
          });
          if (gen !== loadGen) return;
          finalImage = fr.imageData;
          faceNote = fr.stats.found ? ` ${fr.stats.restored}/${fr.stats.found} yüz iyileştirildi.` : " Yüz bulunamadı.";
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          console.error("[AI] faces", e);
          faceNote = " (Yüz iyileştirme başarısız oldu, yalnızca büyütme uygulandı.)";
        }
      }

      const c = document.createElement("canvas");
      c.width = finalImage.width;
      c.height = finalImage.height;
      c.getContext("2d").putImageData(finalImage, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      if (gen !== loadGen) return;

      deepResult = { url: URL.createObjectURL(blob), blob, originalSrc, showingEnhanced: false };
      const where = res.backend === "webgpu" ? "ekran kartı" : "işlemci";
      deepStatus.textContent = `Tamamlandı: ${pixels.width}×${pixels.height} → ${c.width}×${c.height}, ` +
        `${Math.round((performance.now() - startedAt) / 1000)} sn (${where}).${faceNote} ` +
        `Model: ${MODELS["photo-x4"].title}, ${MODELS["photo-x4"].credit}` +
        (withFaces ? `; ${FACE_MODEL.title}, ${FACE_MODEL.credit}.` : ".");
      deepProgress.hidden = true;
      deepResultActions.hidden = false;
      showDeepVariant(true);
      showSnapshotToast("✨ Fotoğraf yapay zeka ile iyileştirildi");
    } catch (e) {
      if (gen !== loadGen) return;
      deepProgress.hidden = true;
      if (e?.name === "AbortError") {
        deepStatus.textContent = "İptal edildi.";
      } else {
        console.error("[AI] deep enhance", e);
        deepStatus.textContent = `⚠️ İyileştirme başarısız: ${e?.message || e}`;
      }
    } finally {
      releaseAi(); // give the GPU memory back to the player
      if (deepJob === job) deepJob = null;
      if (gen === loadGen) btnDeepEnhance.textContent = "✨ Fotoğrafı İyileştir (4x, E)";
    }
  }

  function showDeepVariant(enhanced) {
    if (!deepResult) return;
    deepResult.showingEnhanced = enhanced;
    imageElement.src = enhanced ? deepResult.url : deepResult.originalSrc;
    btnDeepCompare.textContent = enhanced ? "Orijinali Göster" : "İyileştirileni Göster";
  }

  btnDeepEnhance?.addEventListener("click", deepEnhancePhoto);
  btnDeepCompare?.addEventListener("click", () => showDeepVariant(!deepResult?.showingEnhanced));
  btnDeepSave?.addEventListener("click", () => {
    if (!deepResult) return;
    const base = (currentFilename.textContent || "VHO").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_\-]/g, "_");
    if (downloadBlob(deepResult.blob, `${base}_AI_4x.png`)) showSnapshotToast("İyileştirilmiş fotoğraf kaydedildi");
  });

  // Licenses & credits
  const licensesModal = document.getElementById("licenses-modal");
  const licensesText = document.getElementById("licenses-text");
  document.getElementById("btn-open-licenses")?.addEventListener("click", async () => {
    licensesModal.classList.add("active");
    try {
      licensesText.textContent = await (await fetch("legal/THIRD_PARTY_NOTICES.txt")).text();
    } catch (e) {
      licensesText.textContent = "Lisans dosyası okunamadı.";
    }
  });
  document.getElementById("btn-close-licenses")?.addEventListener("click", () => licensesModal.classList.remove("active"));

  // ==========================================================================
  // Sleep Timer Controller
  // ==========================================================================
  btnSleepTimer.addEventListener("click", () => {
    sleepTimerModal.classList.add("active");
  });

  btnCancelSleep.addEventListener("click", () => {
    sleepTimerModal.classList.remove("active");
  });

  document.querySelectorAll(".btn-sleep-preset").forEach(btn => {
    btn.addEventListener("click", () => {
      const minVal = btn.dataset.minutes;
      if (minVal === "video-end") {
        clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;
        isSleepTimerVideoEnd = true;
        sleepBadge.style.display = "inline-block";
        sleepBadge.textContent = "Bitince";
        showSnapshotToast("Uyku modu: Video bitince kapanacak");
      } else {
        startSleepTimer(parseInt(minVal, 10) * 60);
      }
      btnDisableSleep.style.display = "inline-block";
      sleepTimerModal.classList.remove("active");
    });
  });

  btnCustomSleep?.addEventListener("click", () => {
    const mins = parseInt(inputCustomSleep.value, 10);
    if (!isNaN(mins) && mins > 0) {
      startSleepTimer(mins * 60);
      btnDisableSleep.style.display = "inline-block";
      sleepTimerModal.classList.remove("active");
    } else {
      showSnapshotToast("Lütfen geçerli bir dakika girin");
    }
  });

  function resetSleepTimerUi() {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
    isSleepTimerVideoEnd = false;
    sleepBadge.style.display = "none";
    btnDisableSleep.style.display = "none";
  }

  btnDisableSleep.addEventListener("click", () => {
    resetSleepTimerUi();
    sleepTimerModal.classList.remove("active");
    showSnapshotToast("Uyku zamanlayıcısı kapatıldı");
  });

  function startSleepTimer(seconds) {
    clearInterval(sleepTimerInterval);
    sleepSecondsRemaining = seconds;
    isSleepTimerVideoEnd = false;
    sleepBadge.style.display = "inline-block";

    sleepTimerInterval = setInterval(() => {
      sleepSecondsRemaining--;
      if (sleepSecondsRemaining <= 0) {
        triggerSleepMode();
      } else {
        const m = Math.floor(sleepSecondsRemaining / 60);
        const s = sleepSecondsRemaining % 60;
        sleepBadge.textContent = `${m}:${String(s).padStart(2, "0")}`;
      }
    }, 1000);

    const pcSleepMsg = checkPcSleep && checkPcSleep.checked ? " (+PC Uyku)" : "";
    showSnapshotToast(`Uyku zamanlayıcısı: ${Math.floor(seconds / 60)} dk${pcSleepMsg}`);
  }

  // Cancellable ~3 s fade-out, then pause (and optionally suspend the PC)
  function triggerSleepMode() {
    clearInterval(sleepFadeInterval);
    resetSleepTimerUi();
    const useGain = !!gainNode;
    const startLevel = useGain ? gainNode.gain.value : video.volume;
    let step = 0;
    sleepFadeInterval = setInterval(() => {
      step++;
      const k = Math.max(0, 1 - step / 12);
      if (useGain) gainNode.gain.value = startLevel * k;
      else video.volume = startLevel * k;
      if (k <= 0) {
        clearInterval(sleepFadeInterval);
        sleepFadeInterval = null;
        video.pause();
        sleepOverlay.classList.add("active");

        if (checkPcSleep?.checked && tauri?.core?.invoke) {
          tauri.core.invoke("suspend_system").catch((e) => {
            console.warn("suspend_system", e);
            showSnapshotToast("⚠️ Bilgisayar uyku moduna alınamadı");
          });
        }
      }
    }, 250);
  }

  btnWakeUp.addEventListener("click", () => {
    clearInterval(sleepFadeInterval);
    sleepFadeInterval = null;
    sleepOverlay.classList.remove("active");
    setVolume(parseInt(volumeSlider.value, 10) || 100); // back to the user's own level
    if (currentMediaType === "video") startPlayback();
  });

  // ==========================================================================
  // Subtitle Search (opens OpenSubtitles.org; user loads the downloaded file)
  // ==========================================================================
  const OPENSUBS_LANG = { tr: "tur", en: "eng", de: "ger", fr: "fre" };

  btnSearchSubtitles.addEventListener("click", () => {
    // Clean current film name
    const cleanName = (currentFilename.textContent || "")
      .replace(/\.(mp4|mkv|avi|mov|webm|m4v)$/i, "")
      .replace(/(\b(1080p|720p|2160p|4k|bluray|web-dl|webrip|x264|x265|hevc|aac)\b)/gi, "")
      .replace(/[\._\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    inputSubQuery.value = cleanName === "Video Bekleniyor" ? "" : cleanName;
    subtitleSearchModal.classList.add("active");
    renderSubtitleSearch();
    inputSubQuery.focus();
  });

  btnCloseSubModal.addEventListener("click", () => {
    subtitleSearchModal.classList.remove("active");
  });

  btnDoSubSearch.addEventListener("click", openOnlineSubtitleSearch);
  inputSubQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openOnlineSubtitleSearch();
  });

  function buildSubtitleSearchUrl(query, lang) {
    const langId = OPENSUBS_LANG[lang] || "all";
    return `https://www.opensubtitles.org/tr/search2/sublanguageid-${langId}/moviename-${encodeURIComponent(query)}`;
  }

  async function openExternalUrl(url) {
    try {
      if (tauri?.opener?.openUrl) await tauri.opener.openUrl(url);
      else window.open(url, "_blank", "noopener");
      return true;
    } catch (e) {
      console.warn("openUrl", e);
      showSnapshotToast("⚠️ Tarayıcı açılamadı");
      return false;
    }
  }

  async function openOnlineSubtitleSearch() {
    const query = inputSubQuery.value.trim();
    if (!query) {
      showSnapshotToast("Lütfen bir film veya dizi adı girin");
      inputSubQuery.focus();
      return;
    }
    if (await openExternalUrl(buildSubtitleSearchUrl(query, selectSubLang.value))) {
      showSnapshotToast("Arama tarayıcıda açıldı. İndirdiğiniz altyazıyı yükleyin.");
    }
  }

  function renderSubtitleSearch() {
    const card = document.createElement("div");
    card.className = "sub-result-card";

    const info = document.createElement("div");
    const title = document.createElement("div");
    title.className = "sub-card-title";
    title.textContent = "İndirdiğiniz altyazıyı uygulayın";
    const meta = document.createElement("div");
    meta.className = "sub-card-meta";
    meta.textContent = ".srt / .vtt • UTF-8 veya Windows-1254 (Türkçe) kodlama desteklenir";
    info.append(title, meta);

    const btnLoad = document.createElement("button");
    btnLoad.className = "btn-primary btn-sm";
    btnLoad.textContent = "Dosyadan Yükle";
    btnLoad.addEventListener("click", () => subFileInput.click());

    card.append(info, btnLoad);
    subSearchResults.replaceChildren(card);
  }

  // ==========================================================================
  // HUD Auto-Hide on Inactivity
  // ==========================================================================
  function resetHudTimeout() {
    showHud();
    clearTimeout(hudHideTimeout);
    const shouldHide = (isPlaying || isSlideshowActive || currentMediaType === "image") &&
        !dropZone.classList.contains("visible") &&
        !playlistDrawer.classList.contains("open") &&
        !effectsPanel.classList.contains("show") &&
        !aiRestorePanel?.classList.contains("show") &&
        !sleepTimerModal.classList.contains("active") &&
        !subtitleSearchModal.classList.contains("active");

    if (shouldHide) {
      hudHideTimeout = setTimeout(() => {
        if (currentMediaType === "video") {
          controlsHud.classList.add("hidden");
        } else if (currentMediaType === "image") {
          if (photoHud) photoHud.style.opacity = "0";
          if (btnFloatingPrev) btnFloatingPrev.style.opacity = "0";
          if (btnFloatingNext) btnFloatingNext.style.opacity = "0";
        }
        titlebar.style.opacity = "0";
      }, 2500);
    }
  }

  function showHud() {
    controlsHud.classList.remove("hidden");
    if (photoHud) photoHud.style.opacity = "1";
    if (btnFloatingPrev) btnFloatingPrev.style.opacity = "0.7";
    if (btnFloatingNext) btnFloatingNext.style.opacity = "0.7";
    titlebar.style.opacity = "1";
  }

  // Throttle to one HUD update per frame
  let hudRaf = 0;
  document.addEventListener("mousemove", () => {
    if (hudRaf) return;
    hudRaf = requestAnimationFrame(() => {
      hudRaf = 0;
      resetHudTimeout();
    });
  }, { passive: true });

  // ==========================================================================
  // Drag and Drop (Multiple files + Photos + Subtitles)
  // ==========================================================================
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add("is-dragging");
  });

  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove("is-dragging");
    }
  });

  window.addEventListener("dragover", (e) => e.preventDefault());

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("is-dragging");
    openFiles(e.dataTransfer?.files);
  });

  // In the app, the OS file drop is handled natively by Tauri (gives real paths)
  appWindow?.onDragDropEvent?.((e) => {
    const { type, paths } = e.payload;
    if (type === "enter" || type === "over") {
      document.body.classList.add("is-dragging");
    } else {
      document.body.classList.remove("is-dragging");
      if (type === "drop") openPaths(paths);
    }
  }).catch?.((err) => console.warn("onDragDropEvent", err));

  // File Browse
  btnBrowse.addEventListener("click", () => pickFiles(fileInput));
  fileInput.addEventListener("change", (e) => {
    openFiles(e.target.files);
    e.target.value = "";
  });

  playlistFileInput.addEventListener("change", (e) => {
    openFiles(e.target.files, { playFirstNew: false });
    e.target.value = "";
  });

  // URL Modal
  btnOpenUrl.addEventListener("click", () => {
    urlModal.classList.add("active");
    inputUrl.focus();
  });

  btnCancelUrl.addEventListener("click", () => {
    urlModal.classList.remove("active");
  });

  function confirmUrl() {
    const url = inputUrl.value.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      showSnapshotToast("Geçerli bir http(s) URL girin");
      return;
    }
    if (/\.m3u8(\?|#|$)/i.test(url) && !video.canPlayType("application/vnd.apple.mpegurl")) {
      showSnapshotToast("⚠️ HLS (.m3u8) akışları bu sürümde desteklenmiyor");
      return;
    }
    let name = "Ağ Akışı";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop()) || name;
    } catch (_) {}
    // Add to the playlist so index/auto-advance stay consistent
    playlist.push({ url, name, isImage: isImageFile(url) });
    playPlaylistItem(playlist.length - 1);
    urlModal.classList.remove("active");
    inputUrl.value = "";
  }

  btnConfirmUrl.addEventListener("click", confirmUrl);
  inputUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmUrl();
  });

  // Click / Double Click on Video
  video.addEventListener("click", togglePlay);
  video.addEventListener("dblclick", toggleFullscreen);
  btnPlayPause.addEventListener("click", togglePlay);

  // Photo HUD Controls
  btnPhotoZoomIn?.addEventListener("click", () => zoomPhoto(1.25));
  btnPhotoZoomOut?.addEventListener("click", () => zoomPhoto(0.8));
  btnPhotoZoomReset?.addEventListener("click", () => resetPhotoTransform());

  btnPhotoRotateLeft?.addEventListener("click", () => {
    photoRotation = (photoRotation - 90 + 360) % 360;
    updateImageTransform(true);
    showSnapshotToast(`Sola Döndürüldü (${photoRotation}°)`);
  });

  btnPhotoRotateRight?.addEventListener("click", () => {
    photoRotation = (photoRotation + 90) % 360;
    updateImageTransform(true);
    showSnapshotToast(`Sağa Döndürüldü (${photoRotation}°)`);
  });

  btnPhotoInfo?.addEventListener("click", () => {
    if (!photoInfoCard) return;
    const isShowing = photoInfoCard.style.display !== "none";
    photoInfoCard.style.display = isShowing ? "none" : "flex";
  });

  btnPhotoSlideshow?.addEventListener("click", () => toggleSlideshow());
  btnPhotoPrev?.addEventListener("click", () => navigatePlaylist(-1));
  btnPhotoNext?.addEventListener("click", () => navigatePlaylist(1));
  btnFloatingPrev?.addEventListener("click", () => navigatePlaylist(-1));
  btnFloatingNext?.addEventListener("click", () => navigatePlaylist(1));

  // Keep rotated photos fitted when the window is resized
  window.addEventListener("resize", () => {
    if (currentMediaType !== "image") return;
    if (enhancer?.active) applyVideoFilters(); // re-fit the upscaled photo
    updateImageTransform();
  });

  // Photo Wheel Zoom & Drag-Pan Interactions
  imageContainer?.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    zoomPhoto(factor, e.clientX, e.clientY);
  }, { passive: false });

  imageContainer?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (photoZoom > 1.01) {
      isPanningPhoto = true;
      panStartX = e.clientX - photoPanX;
      panStartY = e.clientY - photoPanY;
      imageContainer.classList.add("panning");
    }
  });

  window.addEventListener("mousemove", (e) => {
    if (!isPanningPhoto) return;
    photoPanX = e.clientX - panStartX;
    photoPanY = e.clientY - panStartY;
    updateImageTransform(false);
  });

  window.addEventListener("mouseup", () => {
    if (isPanningPhoto) {
      isPanningPhoto = false;
      imageContainer.classList.remove("panning");
    }
  });

  imageContainer?.addEventListener("dblclick", (e) => {
    if (photoZoom > 1.05) {
      resetPhotoTransform();
    } else {
      zoomPhoto(2.5, e.clientX, e.clientY);
    }
  });

  // ==========================================================================
  // Master Keyboard Shortcuts (Adaptive for Video & Photo Mode)
  // ==========================================================================
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    const isTextField = t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
      (t.tagName === "INPUT" && !["range", "checkbox", "button"].includes(t.type));
    if (isTextField || e.ctrlKey || e.metaKey || e.altKey) return;
    // Release focus from sliders/buttons so shortcuts keep working and Space doesn't double-click
    if ((t.tagName === "INPUT" && t.type === "range") || (t.tagName === "BUTTON" && e.code === "Space")) t.blur();

    if (e.code === "Escape") {
      isFullscreen().then((fs) => fs && setFullscreen(false));
      return;
    }

    // Photo Studio Specific Shortcuts
    if (currentMediaType === "image") {
      switch (e.code) {
        case "Space":
          e.preventDefault();
          toggleSlideshow();
          break;
        case "ArrowLeft":
          e.preventDefault();
          navigatePlaylist(-1);
          resetHudTimeout();
          break;
        case "ArrowRight":
          e.preventDefault();
          navigatePlaylist(1);
          resetHudTimeout();
          break;
        case "KeyR":
          e.preventDefault();
          if (e.shiftKey) {
            btnPhotoRotateLeft?.click();
          } else {
            btnPhotoRotateRight?.click();
          }
          break;
        case "KeyI":
          e.preventDefault();
          btnPhotoInfo?.click();
          break;
        case "KeyE":
          e.preventDefault();
          deepEnhancePhoto();
          break;
        case "Equal":
        case "NumpadAdd":
          e.preventDefault();
          zoomPhoto(1.25);
          break;
        case "Minus":
        case "NumpadSubtract":
          e.preventDefault();
          zoomPhoto(0.8);
          break;
        case "Digit0":
        case "Numpad0":
          e.preventDefault();
          resetPhotoTransform();
          break;
        case "KeyF":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "KeyS":
          e.preventDefault();
          captureSnapshot();
          break;
        case "KeyL":
          e.preventDefault();
          playlistDrawer.classList.toggle("open");
          break;
        case "KeyA":
          e.preventDefault();
          updateAiMasterState(!isAiRestoreEnabled);
          showSnapshotToast(isAiRestoreEnabled ? "AI Restorasyon Devrede ✨" : "AI Restorasyon Kapalı");
          break;
        case "KeyB":
          e.preventDefault();
          toggleSplitView();
          break;
      }
      return;
    }

    // Video Player Shortcuts
    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        seekBy(e.shiftKey ? -30 : -5);
        resetHudTimeout();
        break;
      case "ArrowRight":
        e.preventDefault();
        seekBy(e.shiftKey ? 30 : 5);
        resetHudTimeout();
        break;
      case "ArrowUp":
        e.preventDefault();
        setVolume(Math.min(200, parseInt(volumeSlider.value, 10) + 5));
        resetHudTimeout();
        break;
      case "ArrowDown":
        e.preventDefault();
        setVolume(Math.max(0, parseInt(volumeSlider.value, 10) - 5));
        resetHudTimeout();
        break;
      case "KeyF":
        e.preventDefault();
        toggleFullscreen();
        break;
      case "KeyM":
        e.preventDefault();
        btnVolume.click();
        resetHudTimeout();
        break;
      case "KeyC":
      case "KeyV":
        e.preventDefault();
        toggleSubtitles();
        break;
      case "KeyG":
        e.preventDefault();
        setSubtitleDelay(subtitleDelay - 50);
        showSnapshotToast(`Altyazı senkronu: ${valSubDelay.textContent}`);
        break;
      case "KeyH":
        e.preventDefault();
        setSubtitleDelay(subtitleDelay + 50);
        showSnapshotToast(`Altyazı senkronu: ${valSubDelay.textContent}`);
        break;
      case "KeyS":
        e.preventDefault();
        captureSnapshot();
        break;
      case "KeyL":
        e.preventDefault();
        playlistDrawer.classList.toggle("open");
        break;
      case "KeyP":
        e.preventDefault();
        btnPip.click();
        break;
      case "KeyR":
      case "KeyA":
        e.preventDefault();
        updateAiMasterState(!isAiRestoreEnabled);
        showSnapshotToast(isAiRestoreEnabled ? "AI Restorasyon & Netleştirici Açık ✨" : "AI Restorasyon Kapalı");
        break;
      case "KeyB":
        e.preventDefault();
        toggleSplitView();
        break;
    }
  });

  // ==========================================================================
  // Cross-Platform Window Controls (macOS Traffic Lights & Windows/Linux)
  // ==========================================================================
  const isMac = navigator.userAgent?.toLowerCase().includes("mac") || navigator.platform?.toLowerCase().includes("mac");
  const macLights = document.getElementById("macos-traffic-lights");
  const winControls = document.getElementById("win-linux-controls");

  if (isMac && macLights) {
    document.body.classList.add("platform-macos");
    macLights.style.display = "flex";
    if (winControls) winControls.style.display = "none";
  }

  const runWindow = (fn) => (e) => {
    e.stopPropagation();
    if (!appWindow) return;
    fn(appWindow).catch((err) => console.error("[window]", err));
  };

  const bindWindow = (id, fn) => document.getElementById(id)?.addEventListener("click", runWindow(fn));
  bindWindow("btn-minimize", (w) => w.minimize());
  bindWindow("btn-maximize", (w) => w.toggleMaximize());
  bindWindow("btn-close", (w) => w.close());
  bindWindow("mac-btn-minimize", (w) => w.minimize());
  bindWindow("mac-btn-maximize", (w) => w.toggleMaximize());
  bindWindow("mac-btn-close", (w) => w.close());
  // No titlebar dblclick handler: Tauri's data-tauri-drag-region already maximizes on double-click.

  // Files passed on the command line ("Open with VHO")
  invoke?.("initial_files")
    .then((paths) => openPaths(paths))
    .catch((e) => console.warn("initial_files", e));

  // Release media resources when the app closes
  window.addEventListener("pagehide", () => {
    releaseObjectUrl();
    audioCtx?.close();
    enhancer?.destroy();
  });
});
