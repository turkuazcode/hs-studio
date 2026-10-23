// ==========================================================================
// Web Audio booster (up to 200%) & DSP restoration pipeline:
//   source -> [highpass -> lowpass] -> [speech peaking] -> [compressor] -> gain -> limiter
// The graph is created lazily, only when boost or DSP is actually needed.
// ==========================================================================

/** Slider value (0-200) -> gain: 1.0 up to 100%, then up to 2.5 at 200%. */
export const volumeToGain = (val) => (val <= 100 ? 1.0 : 1.0 + ((val - 100) / 100) * 1.5);

/** Clamped volume step for the arrow keys. */
export const stepVolume = (current, delta) => Math.max(0, Math.min(200, current + delta));

/**
 * deps: { dom, state, toast(msg) }
 */
export function createAudioEngine({ dom, state, toast }) {
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
    if (aiAudioWanted() && !ensureAudioGraph()) {
      toast("⚠️ Bu kaynakta ses iyileştirme kullanılamıyor (CORS)");
    }
    reconnectAudioPipeline();
  }

  function setVolume(val) {
    if (val > 100 && !ensureAudioGraph()) {
      val = 100;
      toast("⚠️ Bu kaynakta ses güçlendirici kullanılamıyor (CORS)");
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

  const sliderVolume = () => parseInt(volumeSlider.value, 10);

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
