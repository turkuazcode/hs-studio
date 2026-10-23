import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTime, formatFileSize, aspectRatioText, safeFileName, timeForFileName } from "../../src/core/format.js";

test("formatTime: mm:ss below an hour", () => {
  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(0.99), "00:00");
  assert.equal(formatTime(59.9), "00:59");
  assert.equal(formatTime(60), "01:00");
  assert.equal(formatTime(75.4), "01:15");
  assert.equal(formatTime(3599), "59:59");
});

test("formatTime: hh:mm:ss from an hour", () => {
  assert.equal(formatTime(3600), "01:00:00");
  assert.equal(formatTime(3725), "01:02:05");
  assert.equal(formatTime(100 * 3600), "100:00:00");
});

test("formatTime: invalid and live values", () => {
  assert.equal(formatTime(-1), "00:00");
  assert.equal(formatTime(NaN), "00:00");
  assert.equal(formatTime(undefined), "00:00");
  assert.equal(formatTime(-Infinity), "00:00");
  assert.equal(formatTime(Infinity), "CANLI");
});

test("formatFileSize", () => {
  assert.equal(formatFileSize(0), "-");
  assert.equal(formatFileSize(undefined), "-");
  assert.equal(formatFileSize(512), "1 KB");
  assert.equal(formatFileSize(300 * 1024), "300 KB");
  assert.equal(formatFileSize(1024 * 1024), "1.00 MB");
  assert.equal(formatFileSize(2.5 * 1024 * 1024), "2.50 MB");
});

test("aspectRatioText", () => {
  assert.equal(aspectRatioText(1920, 1080), "16:9");
  assert.equal(aspectRatioText(640, 480), "4:3");
  assert.equal(aspectRatioText(1000, 1000), "1:1");
  assert.equal(aspectRatioText(0, 0), "-");
});

test("file name helpers", () => {
  assert.equal(safeFileName("Güzel film (2010).mp4"), "G_zel_film__2010__mp4");
  assert.equal(safeFileName("a-b_c"), "a-b_c");
  assert.equal(timeForFileName(3725), "01-02-05");
  assert.equal(timeForFileName(5), "00-05");
});
