// Pure helpers extracted from the former main.js controller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeToGain, stepVolume } from "../../src/media/audio-engine.js";
import { nextZoom, rotateBy, zoomLabel } from "../../src/media/photo-viewer.js";
import { resumeKey, shouldOfferResume, clampSeek, MEDIA_ERR_TEXT } from "../../src/media/video-player.js";
import { enhancerLevels, cssFilterString } from "../../src/media/visual-filters.js";
import { rotatedCanvasSize } from "../../src/media/snapshot.js";
import { pointerFraction, percentOf } from "../../src/ui/timeline.js";
import { shouldAutoHide } from "../../src/ui/hud.js";
import { AI_PRESETS, sharpLabel } from "../../src/ui/panels.js";
import { cleanMovieName, buildSubtitleSearchUrl } from "../../src/ui/modals.js";
import { sleepBadgeText, fadeLevel, FADE_STEPS } from "../../src/ui/sleep-timer.js";
import { isTextField } from "../../src/ui/shortcuts.js";
import { isMacUserAgent } from "../../src/ui/window-controls.js";

test("volume booster curve", () => {
  assert.equal(volumeToGain(0), 1);
  assert.equal(volumeToGain(100), 1);
  assert.equal(volumeToGain(150), 1.75);
  assert.equal(volumeToGain(200), 2.5);
  assert.equal(stepVolume(198, 5), 200);
  assert.equal(stepVolume(3, -5), 0);
  assert.equal(stepVolume(100, 5), 105);
});

test("photo zoom clamps and snaps to fit", () => {
  assert.equal(nextZoom(1, 1.25), 1.25);
  assert.equal(nextZoom(9, 1.25), 10);
  assert.equal(nextZoom(0.11, 0.8), 0.1);
  assert.equal(nextZoom(0.8, 1.25), 1);   // 1.0 exactly
  assert.equal(nextZoom(1.03, 0.99), 1);  // within 0.04 of fit -> snap
  assert.equal(nextZoom(1.02, 1), 1.02);  // factor 1 never snaps
  assert.equal(zoomLabel(1), "Fit");
  assert.equal(zoomLabel(1.04), "Fit");
  assert.equal(zoomLabel(2.5), "250%");
});

test("photo rotation stays in [0, 360)", () => {
  assert.equal(rotateBy(0, 90), 90);
  assert.equal(rotateBy(270, 90), 0);
  assert.equal(rotateBy(0, -90), 270);
  assert.equal(rotateBy(90, -90), 0);
  assert.deepEqual(rotatedCanvasSize(40, 30, 90), { width: 30, height: 40 });
  assert.deepEqual(rotatedCanvasSize(40, 30, 180), { width: 40, height: 30 });
});

test("resume key and resume offer window", () => {
  assert.equal(resumeKey({ url: "https://x/a.mp4", name: "a.mp4" }), "vho_url_https://x/a.mp4");
  assert.equal(resumeKey({ path: "C:\\a.mp4", name: "a.mp4", size: 10 }), "vho_file_a.mp4_10");
  assert.equal(resumeKey({ file: { size: 5 }, name: "b.mkv" }), "vho_file_b.mkv_5");
  assert.equal(resumeKey({ file: { size: 5 } }), "vho_file_Online Video_5");
  assert.ok(!shouldOfferResume(8, 100));
  assert.ok(shouldOfferResume(8.1, 100));
  assert.ok(!shouldOfferResume(85, 100));
  assert.ok(shouldOfferResume(84.9, 100));
  assert.ok(!shouldOfferResume(50, Infinity));
  assert.ok(!shouldOfferResume(50, NaN));
});

test("seek clamping, live streams", () => {
  assert.equal(clampSeek(5, -10, 100), 0);
  assert.equal(clampSeek(95, 10, 100), 100);
  assert.equal(clampSeek(50, 10, 100), 60);
  assert.equal(clampSeek(50, 1000, Infinity), 1050);
  assert.equal(clampSeek(3, -5, NaN), 0);
});

test("media error texts are Turkish and cover codes 1-4", () => {
  for (const code of [1, 2, 3, 4]) assert.ok(MEDIA_ERR_TEXT[code].length > 10);
});

test("GPU enhancer levels and CSS fallback string", () => {
  assert.deepEqual(enhancerLevels(0), { sharp: 0, denoise: 0, detail: 0 });
  assert.deepEqual(enhancerLevels(3), { sharp: 1.0, denoise: 0.22, detail: 1.3 });
  assert.deepEqual(enhancerLevels(9), { sharp: 0.8, denoise: 0.18, detail: 0.9 });
  assert.equal(cssFilterString({ brightness: 100, contrast: 100, saturate: 100, aiEnabled: false, sharpLevel: 2, contrastBoost: 8 }),
    "brightness(100%) contrast(100%) saturate(100%)");
  assert.equal(cssFilterString({ brightness: 90, contrast: 100, saturate: 100, aiEnabled: true, sharpLevel: 2, contrastBoost: 8 }),
    "brightness(90%) contrast(120%) saturate(106%)");
  assert.equal(cssFilterString({ brightness: 100, contrast: 195, saturate: 248, aiEnabled: true, sharpLevel: 3, contrastBoost: 12 }),
    "brightness(100%) contrast(200%) saturate(250%)");
});

test("timeline geometry", () => {
  const rect = { left: 100, width: 200 };
  assert.equal(pointerFraction(50, rect), 0);
  assert.equal(pointerFraction(200, rect), 0.5);
  assert.equal(pointerFraction(999, rect), 1);
  assert.equal(percentOf(25, 100), "25%");
});

test("HUD auto-hide decision", () => {
  assert.ok(shouldAutoHide({ isPlaying: true, isSlideshowActive: false, mediaType: "video", overlayOpen: false }));
  assert.ok(!shouldAutoHide({ isPlaying: true, isSlideshowActive: false, mediaType: "video", overlayOpen: true }));
  assert.ok(!shouldAutoHide({ isPlaying: false, isSlideshowActive: false, mediaType: "video", overlayOpen: false }));
  assert.ok(shouldAutoHide({ isPlaying: false, isSlideshowActive: false, mediaType: "image", overlayOpen: false }));
  assert.ok(shouldAutoHide({ isPlaying: false, isSlideshowActive: true, mediaType: "none", overlayOpen: false }));
});

test("AI presets and sharpness labels", () => {
  assert.deepEqual(Object.keys(AI_PRESETS), ["144p", "voice", "cinema"]);
  assert.equal(sharpLabel(0), "Kapalı");
  assert.equal(sharpLabel(2), "Seviye 2");
  assert.equal(sharpLabel(3), "Seviye 3 (Ultra)");
});

test("subtitle search query and URL", () => {
  assert.equal(cleanMovieName("The.Movie.Name.2010.1080p.BluRay.x264.mkv"), "The Movie Name 2010");
  // Existing behaviour: "_" is a word character, so "_720p" is not a whole word and stays
  assert.equal(cleanMovieName("Dizi_S01E02_720p-WEB-DL.mp4"), "Dizi S01E02 720p");
  assert.equal(cleanMovieName(""), "");
  assert.equal(buildSubtitleSearchUrl("Kış Uykusu", "tr"),
    "https://www.opensubtitles.org/tr/search2/sublanguageid-tur/moviename-K%C4%B1%C5%9F%20Uykusu");
  assert.match(buildSubtitleSearchUrl("x", "xx"), /sublanguageid-all\//);
});

test("sleep timer helpers", () => {
  assert.equal(sleepBadgeText(125), "2:05");
  assert.equal(sleepBadgeText(59), "0:59");
  assert.equal(fadeLevel(0), 1);
  assert.equal(fadeLevel(FADE_STEPS), 0);
  assert.equal(fadeLevel(FADE_STEPS + 3), 0);
});

test("keyboard focus rules", () => {
  assert.ok(isTextField({ tagName: "INPUT", type: "text" }));
  assert.ok(isTextField({ tagName: "INPUT", type: "number" }));
  assert.ok(isTextField({ tagName: "TEXTAREA" }));
  assert.ok(isTextField({ tagName: "SELECT" }));
  assert.ok(isTextField({ tagName: "DIV", isContentEditable: true }));
  assert.ok(!isTextField({ tagName: "INPUT", type: "range" }));
  assert.ok(!isTextField({ tagName: "INPUT", type: "checkbox" }));
  assert.ok(!isTextField({ tagName: "BUTTON" }));
  assert.ok(!isTextField({ tagName: "BODY" }));
});

test("platform detection", () => {
  assert.ok(isMacUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", ""));
  assert.ok(isMacUserAgent("", "MacIntel"));
  assert.ok(!isMacUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32"));
});

test("deep enhance input size keeps the 4x output under the pixel budget", async () => {
  globalThis.window ??= {}; // ai-engine.js reads window.__TAURI__ at import time
  const { deepInputSize, DEEP_MAX_OUTPUT_PIXELS } = await import("../../src/media/photo-ai.js");
  assert.deepEqual(deepInputSize(640, 480), { width: 640, height: 480 }); // small: unchanged
  const big = deepInputSize(6000, 4000);
  assert.ok(big.width * big.height * 16 <= DEEP_MAX_OUTPUT_PIXELS * 1.01);
  assert.ok(Math.abs(big.width / big.height - 1.5) < 0.01);
  assert.deepEqual(deepInputSize(1, 1), { width: 1, height: 1 });
});
