// ==========================================================================
// Sleep timer: countdown or "when the video ends", ~3 s fade-out, pause,
// optional PC suspend.
// ==========================================================================

import { invoke } from "../core/tauri.js";

export const FADE_STEPS = 12;
export const FADE_INTERVAL_MS = 250;

/** Badge text for the remaining seconds: 125 -> "2:05". */
export const sleepBadgeText = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Fade multiplier after `step` ticks (1 -> 0 over FADE_STEPS). */
export const fadeLevel = (step) => Math.max(0, 1 - step / FADE_STEPS);

/**
 * app: { dom, state, toast, audio, video, engine }  (resolved lazily)
 */
export function createSleepTimer(app) {
  const { dom, state } = app;
  const {
    btnSleepTimer, sleepTimerModal, btnCancelSleep, btnDisableSleep, inputCustomSleep, btnCustomSleep,
    checkPcSleep, sleepBadge, sleepOverlay, btnWakeUp,
  } = dom;

  let sleepTimerInterval = null;
  let sleepFadeInterval = null;
  let sleepSecondsRemaining = 0;
  let isSleepTimerVideoEnd = false;

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
        app.toast("Uyku modu: Video bitince kapanacak");
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
      app.toast("Lütfen geçerli bir dakika girin");
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
    app.toast("Uyku zamanlayıcısı kapatıldı");
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
        sleepBadge.textContent = sleepBadgeText(sleepSecondsRemaining);
      }
    }, 1000);

    const pcSleepMsg = checkPcSleep && checkPcSleep.checked ? " (+PC Uyku)" : "";
    app.toast(`Uyku zamanlayıcısı: ${Math.floor(seconds / 60)} dk${pcSleepMsg}`);
  }

  // Cancellable ~3 s fade-out, then pause (and optionally suspend the PC)
  function triggerSleepMode() {
    clearInterval(sleepFadeInterval);
    resetSleepTimerUi();
    // Fade the engine's own level (0-200 %); the slider keeps the user's level for wake-up
    const startLevel = app.engine.volume;
    let step = 0;
    sleepFadeInterval = setInterval(() => {
      step++;
      const k = fadeLevel(step);
      app.engine.setVolume(startLevel * k);
      if (k <= 0) {
        clearInterval(sleepFadeInterval);
        sleepFadeInterval = null;
        app.engine.pause();
        sleepOverlay.classList.add("active");

        if (checkPcSleep?.checked && invoke) {
          invoke("suspend_system").catch((e) => {
            console.warn("suspend_system", e);
            app.toast("⚠️ Bilgisayar uyku moduna alınamadı");
          });
        }
      }
    }, FADE_INTERVAL_MS);
  }

  btnWakeUp.addEventListener("click", () => {
    clearInterval(sleepFadeInterval);
    sleepFadeInterval = null;
    sleepOverlay.classList.remove("active");
    app.audio.restoreUserVolume(); // back to the user's own level
    if (state.get("currentMediaType") === "video") app.video.startPlayback();
  });

  return {
    trigger: triggerSleepMode,
    get isVideoEndArmed() { return isSleepTimerVideoEnd; },
  };
}
