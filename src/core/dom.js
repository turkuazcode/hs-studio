// ==========================================================================
// DOM helpers and every element reference the app uses, in one place.
// queryDom() is called once after DOMContentLoaded; modules receive the result.
// ==========================================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Property name -> element id. */
const IDS = {
  // Media surfaces & opening
  video: "video-element",
  thumbVideo: "thumbnail-video",
  gpuCanvas: "gpu-canvas",
  dropZone: "drop-zone",
  fileInput: "file-input",
  playlistFileInput: "playlist-file-input",
  btnBrowse: "btn-browse-file",
  btnOpenUrl: "btn-open-url",
  currentFilename: "current-filename",

  // Controls HUD
  controlsHud: "controls-hud",
  titlebar: "titlebar",
  btnPlayPause: "btn-play-pause",
  iconPlay: "icon-play",
  iconPause: "icon-pause",
  btnSkipBack: "btn-skip-backward",
  btnSkipFwd: "btn-skip-forward",

  // Timeline, live thumbnail, A-B loop
  timelineContainer: "timeline-container",
  timelineProgress: "timeline-progress",
  timelineBuffer: "timeline-buffer",
  timelineTooltip: "timeline-tooltip",
  timelineThumbCanvas: "timeline-thumb-canvas",
  timelineTooltipTime: "timeline-tooltip-time",
  timeCurrent: "time-current",
  timeTotal: "time-total",
  abMarkerA: "ab-marker-a",
  abMarkerB: "ab-marker-b",
  abRange: "ab-range",
  btnAbLoop: "btn-ab-loop",
  abLoopLabel: "ab-loop-label",

  // Volume & booster
  btnVolume: "btn-volume",
  iconVolHigh: "icon-volume-high",
  iconVolBoost: "icon-volume-boost",
  iconVolMute: "icon-volume-mute",
  volumeSlider: "volume-slider",
  volumeBadge: "volume-badge",

  // Secondary tools
  btnSnapshot: "btn-snapshot",
  btnPip: "btn-pip",
  btnFullscreen: "btn-fullscreen",
  iconFsEnter: "icon-fs-enter",
  iconFsExit: "icon-fs-exit",
  btnSpeed: "btn-speed",
  speedLabel: "speed-label",
  speedMenu: "speed-menu",
  btnAspectRatio: "btn-aspect-ratio",
  aspectLabel: "aspect-label",
  aspectMenu: "aspect-menu",

  // Subtitles
  subtitleText: "subtitle-text",
  btnToggleSubtitles: "btn-toggle-subtitles",
  subStatusLabel: "sub-status-label",
  subtitlesMenu: "subtitles-menu",
  subMenuToggle: "sub-menu-toggle",
  subMenuToggleText: "sub-menu-toggle-text",
  subMenuSearch: "sub-menu-search",
  subMenuBrowse: "sub-menu-browse",
  subMenuClear: "sub-menu-clear",
  subFileInput: "sub-file-input",

  // Playlist drawer
  playlistDrawer: "playlist-drawer",
  btnTogglePlaylist: "btn-toggle-playlist",
  btnClosePlaylist: "btn-close-playlist",
  playlistItemsList: "playlist-items",
  playlistCountBadge: "playlist-count-badge",
  playlistTotalText: "playlist-total-text",
  btnPlaylistAdd: "btn-playlist-add",
  btnPlaylistClear: "btn-playlist-clear",

  // Effects panel
  effectsPanel: "effects-panel",
  btnToggleEffects: "btn-toggle-effects",
  btnCloseEffects: "btn-close-effects",
  sliderBrightness: "slider-brightness",
  sliderContrast: "slider-contrast",
  sliderSaturate: "slider-saturate",
  valBrightness: "val-brightness",
  valContrast: "val-contrast",
  valSaturate: "val-saturate",
  btnResetFilters: "btn-reset-filters",
  valSubDelay: "val-sub-delay",
  btnSubMinus: "btn-sub-minus",
  btnSubPlus: "btn-sub-plus",
  btnSubReset: "btn-sub-reset",
  checkCompatMode: "check-compat-mode",

  // AI video & audio restoration panel
  btnToggleAiRestore: "btn-toggle-ai-restore",
  aiRestorePanel: "ai-restore-panel",
  btnCloseAiRestore: "btn-close-ai-restore",
  checkAiMaster: "check-ai-master",
  aiMasterStatus: "ai-master-status",
  aiRestoreBadge: "ai-restore-badge",
  sliderAiSharp: "slider-ai-sharp",
  valAiSharp: "val-ai-sharp",
  sliderAiContrast: "slider-ai-contrast",
  valAiContrast: "val-ai-contrast",
  checkAiVoiceClarity: "check-ai-voice-clarity",
  checkAiDenoise: "check-ai-denoise",
  checkAiCompressor: "check-ai-compressor",
  btnToggleSplitView: "btn-toggle-split-view",
  splitViewStatus: "split-view-status",
  splitScreenBanner: "split-screen-banner",
  splitScreenLine: "split-screen-line",

  // Deep AI photo restoration
  btnDeepEnhance: "btn-deep-enhance",
  deepProgress: "deep-progress",
  deepProgressBar: "deep-progress-bar",
  deepStatus: "deep-status",
  deepResultActions: "deep-result-actions",
  btnDeepCompare: "btn-deep-compare",
  btnDeepSave: "btn-deep-save",
  checkDeepFaces: "check-deep-faces",

  // Sleep timer
  btnSleepTimer: "btn-sleep-timer",
  sleepTimerModal: "sleep-timer-modal",
  btnCancelSleep: "btn-cancel-sleep-timer",
  btnDisableSleep: "btn-disable-sleep-timer",
  inputCustomSleep: "input-custom-sleep",
  btnCustomSleep: "btn-custom-sleep",
  checkPcSleep: "check-pc-sleep",
  sleepBadge: "sleep-badge",
  sleepOverlay: "sleep-overlay",
  btnWakeUp: "btn-wake-up",

  // Subtitle search
  btnSearchSubtitles: "btn-search-subtitles",
  subtitleSearchModal: "subtitle-search-modal",
  btnCloseSubModal: "btn-close-sub-modal",
  inputSubQuery: "input-sub-query",
  selectSubLang: "select-sub-lang",
  btnDoSubSearch: "btn-do-sub-search",
  subSearchResults: "sub-search-results",

  // Toasts & ripple
  centerRipple: "center-ripple",
  resumeToast: "resume-toast",
  resumeTimeText: "resume-time-text",
  btnResumeYes: "btn-resume-yes",
  btnResumeNo: "btn-resume-no",
  screenFlash: "screen-flash",
  snapshotToast: "snapshot-toast",

  // Photo studio
  imageContainer: "image-container",
  imageElement: "image-element",
  photoHud: "photo-hud",
  btnPhotoPrev: "btn-photo-prev",
  btnPhotoNext: "btn-photo-next",
  btnFloatingPrev: "btn-floating-prev",
  btnFloatingNext: "btn-floating-next",
  btnPhotoSlideshow: "btn-photo-slideshow",
  iconSlideshowPlay: "icon-slideshow-play",
  iconSlideshowPause: "icon-slideshow-pause",
  photoCounterBadge: "photo-counter-badge",
  btnPhotoZoomIn: "btn-photo-zoom-in",
  btnPhotoZoomOut: "btn-photo-zoom-out",
  btnPhotoZoomReset: "btn-photo-zoom-reset",
  photoZoomLevel: "photo-zoom-level",
  btnPhotoRotateLeft: "btn-photo-rotate-left",
  btnPhotoRotateRight: "btn-photo-rotate-right",
  btnPhotoInfo: "btn-photo-info",
  photoInfoCard: "photo-info-card",
  infoRes: "info-res",
  infoSize: "info-size",
  infoFormat: "info-format",
  infoRatio: "info-ratio",

  // URL modal
  urlModal: "url-modal",
  inputUrl: "input-video-url",
  btnCancelUrl: "btn-cancel-url",
  btnConfirmUrl: "btn-confirm-url",

  // Legacy codec conversion overlay
  transcodeOverlay: "transcode-overlay",
  transcodeText: "transcode-text",
  transcodeBar: "transcode-bar",

  // Licenses
  licensesModal: "licenses-modal",
  licensesText: "licenses-text",
  btnOpenLicenses: "btn-open-licenses",
  btnCloseLicenses: "btn-close-licenses",

  // Playback engine (libmpv) features
  mpvSurface: "mpv-surface",
  viewport: "viewport",
  timelineTrack: "timeline-track",
  subTrackList: "sub-track-list",
  btnHudMore: "btn-hud-more",
  btnSubMenu: "btn-sub-menu",
  sliderGamma: "slider-gamma",
  valGamma: "val-gamma",
  sliderHue: "slider-hue",
  valHue: "val-hue",
  engineInfo: "engine-info",
  btnToggleAudioPanel: "btn-toggle-audio-panel",
  audioPanel: "audio-panel",
  btnCloseAudioPanel: "btn-close-audio-panel",
  valAudioDelay: "val-audio-delay",
  btnAudioMinus: "btn-audio-minus",
  btnAudioReset: "btn-audio-reset",
  btnAudioPlus: "btn-audio-plus",
  checkAudioNormalize: "check-audio-normalize",
  selectEqPreset: "select-eq-preset",
  eqBands: "eq-bands",

  // Window controls
  macLights: "macos-traffic-lights",
  winControls: "win-linux-controls",
};

/** Resolves every element once. Missing optional elements are null, as before. */
export function queryDom(doc = document) {
  const dom = {};
  for (const [key, id] of Object.entries(IDS)) dom[key] = doc.getElementById(id);
  dom.volumeContainer = doc.querySelector(".volume-container");
  dom.thumbCtx = dom.timelineThumbCanvas.getContext("2d");
  return dom;
}
