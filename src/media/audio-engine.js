// ==========================================================================
// Web Audio booster (up to 200%) & DSP filter pipeline (plain filters, not a neural network):
//   source -> [highpass -> lowpass] -> [speech peaking] -> [compressor] -> gain -> limiter
// The graph is created lazily, only when boost or DSP is actually needed. Boosting is not
// lossless: loud parts are held under the limiter ceiling (tests/e2e/audio-limiter.e2e.mjs).
// ==========================================================================

import { t } from "../core/i18n.js";

/** Slider value (0-200) -> gain: 1.0 up to 100%, then up to 2.5 at 200%. */
export const volumeToGain = (val) => (val <= 100 ? 1.0 : 1.0 + ((val - 100) / 100) * 1.5);

/** Final limiter stage (DynamicsCompressor as a near-brickwall limiter). */
export const LIMITER_PARAMS = Object.freeze({ threshold: -1.5, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });

/** Creates the limiter on any BaseAudioContext (realtime or offline: the E2E clipping test). */
export function createLimiter(ctx) {
  const node = ctx.createDynamicsCompressor();
  for (const [k, v] of Object.entries(LIMITER_PARAMS)) node[k].value = v;
  return node;
}

/** Clamped volume step for the arrow keys. */
export const stepVolume = (current, delta) => Math.max(0, Math.min(200, current + delta));

/**
 * deps: { dom, state, toast(msg), engine() -> the engine facade }
 * The Web Audio graph belongs to the HTML5 engine's <video> element; with libmpv the
 * volume (0-200 %) goes straight to mpv and the DSP switches become lavfi filters.
 */
export function createAudioEngine({ dom, state, toast, engine = () => null }) {
  const {
    video, volumeSlider, volumeBadge, iconVolMute, iconVolHigh, iconVolBoost, volumeContainer, btnVolume,
    checkAiDenoise, checkAiVoiceClarity, checkAiCompressor,
  } = dom;

  let audioCtx = null;
  let gainNode = null;
  let audioSourceNode = null;
  let highpassNode = null;
  let speechPeakingNode = null;
  let lowpassNode = null;
  let compressorNode = null;
  let limiterNode = null;
  let lastNonZeroVolume = 100;
  let onRestoreChange = null;
  let mpvBoost = 1; // boost last pushed to the libmpv af chain

  /** Builds the audio graph on first need. Returns false if the source can't be routed. */
  function ensureAudioGraph() {
    if (state.get("isTaintedSource") && !audioSourceNode) return false;
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

      // Limiter: always last, keeps the 200% boost from hard-clipping
      limiterNode = createLimiter(audioCtx);
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
      if (state.get("isAiRestoreEnabled")) {
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

  const aiAudioWanted = () => state.get("isAiRestoreEnabled") &&
    (checkAiDenoise?.checked || checkAiVoiceClarity?.checked || checkAiCompressor?.checked);

  function setGain(v) {
    if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(v, audioCtx.currentTime, 0.015);
  }

  /** Applies the AI audio switches to the graph (creating it when DSP is wanted). */
  function syncAudioRestore() {
    if (isMpv()) {
      onRestoreChange?.();
      return;
    }
    if (aiAudioWanted() && !ensureAudioGraph()) {
      toast(t("enhance.audioCors"));
    }
    reconnectAudioPipeline();
  }

  const isMpv = () => engine()?.kind === "mpv";

  /** HTML5 engine: the booster gain for a 0-200 level (graph created on first need). */
  function applyGain(val) {
    if (val > 100) ensureAudioGraph();
    setGain(volumeToGain(val));
  }

  function setVolume(val) {
    if (!isMpv() && val > 100 && !ensureAudioGraph()) {
      val = 100;
      toast(t("enhance.boostCors"));
    }
    volumeSlider.value = val;
    volumeBadge.textContent = `${val}%`;
    if (val > 0) lastNonZeroVolume = val;

    const e = engine();
    if (e) e.setVolume(val);
    else {
      video.volume = Math.min(val, 100) / 100;
      setGain(volumeToGain(val));
    }

    iconVolMute.style.display = val === 0 ? "block" : "none";
    iconVolHigh.style.display = val > 0 && val <= 100 ? "block" : "none";
    iconVolBoost.style.display = val > 100 ? "block" : "none";
    volumeContainer.classList.toggle("boosted", val > 100);
    // libmpv: the boost above 100 % is part of the af chain (gain + limiter)
    if (isMpv() && boostOf(val) !== mpvBoost) {
      mpvBoost = boostOf(val);
      onRestoreChange?.();
    }
  }

  function sliderVolume() { return parseInt(volumeSlider.value, 10); }
  const boostOf = (v) => (v > 100 ? volumeToGain(v) : 1);

  // Pause the AudioContext with playback to save battery
  video.addEventListener("pause", () => {
    if (audioCtx?.state === "running") audioCtx.suspend();
  });
  video.addEventListener("play", () => {
    if (audioCtx?.state === "suspended") audioCtx.resume();
  });

  volumeSlider.addEventListener("input", (e) => {
    setVolume(parseInt(e.target.value, 10));
  });

  btnVolume.addEventListener("click", () => {
    setVolume(sliderVolume() > 0 ? 0 : lastNonZeroVolume);
  });

  return {
    setVolume,
    applyGain,
    /** New media: push the slider level to the active engine again. */
    reapply: () => setVolume(sliderVolume()),
    /** The AI audio switches for the libmpv filter chain ({ denoise, voice, compressor } or null). */
    get restoreSwitches() {
      return aiAudioWanted()
        ? { denoise: !!checkAiDenoise?.checked, voice: !!checkAiVoiceClarity?.checked, compressor: !!checkAiCompressor?.checked }
        : null;
    },
    /** Linear gain above 100 % for the libmpv af chain (1 = no boost). */
    get boostGain() { return boostOf(sliderVolume()); },
    /** Called when the filter switches or the boost change while libmpv plays (media/audio-fx.js). */
    set onRestoreChange(fn) { onRestoreChange = fn; },
    /** Arrow keys: +/- 5 %. */
    nudgeVolume: (delta) => setVolume(stepVolume(sliderVolume(), delta)),
    /** Wake-up after the sleep timer: back to the user's own level. */
    restoreUserVolume: () => setVolume(sliderVolume() || 100),
    syncRestore: syncAudioRestore,
    /** Sleep timer fades this when the graph exists, video.volume otherwise. */
    get gainNode() { return gainNode; },
    /** True once the video element is routed through Web Audio (cannot be undone). */
    get isRouted() { return !!audioSourceNode; },
    close: () => audioCtx?.close(),
  };
}
