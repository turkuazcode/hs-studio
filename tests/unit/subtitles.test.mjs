import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeSubtitle, parseCues, findCue, timestampToSeconds, formatDelay } from "../../src/media/subtitles.js";

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

/** Minimal Windows-1254 encoder for the Turkish letters used in the tests. */
const CP1254 = { "ğ": 0xF0, "ü": 0xFC, "ş": 0xFE, "ı": 0xFD, "ö": 0xF6, "ç": 0xE7, "Ğ": 0xD0, "Ü": 0xDC, "Ş": 0xDE, "İ": 0xDD, "Ö": 0xD6, "Ç": 0xC7 };
const encode1254 = (s) => Uint8Array.from([...s], (ch) => CP1254[ch] ?? ch.charCodeAt(0));

test("timestampToSeconds: SRT, VTT and short forms", () => {
  close(timestampToSeconds("00:00:01,500"), 1.5);
  close(timestampToSeconds("01:02:03.250"), 3723.25);
  close(timestampToSeconds("02:03.5"), 123.5);
  close(timestampToSeconds("1:02:03,000"), 3723);
});

test("parseCues: basic SRT", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:02,500\nMerhaba\n\n2\n00:00:03,000 --> 00:00:04,000\nDünya\n");
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: "Merhaba" },
    { start: 3, end: 4, text: "Dünya" },
  ]);
});

test("parseCues: CRLF and lone CR line endings", () => {
  const crlf = parseCues("1\r\n00:00:01,000 --> 00:00:02,000\r\nSatır bir\r\nSatır iki\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSon\r\n");
  assert.equal(crlf.length, 2);
  assert.equal(crlf[0].text, "Satır bir\nSatır iki");
  const cr = parseCues("1\r00:00:01,000 --> 00:00:02,000\rEski Mac\r\r");
  assert.deepEqual(cr, [{ start: 1, end: 2, text: "Eski Mac" }]);
});

test("parseCues: BOM, VTT header, cue ids, cue settings, short timestamps", () => {
  const vtt = "﻿WEBVTT\n\nNOTE yorum\n\nid-1\n00:01.000 --> 00:02.000 align:start position:10%\nKısa biçim\n\n00:00:03.000 --> 00:00:04.000\nUzun biçim\n";
  const cues = parseCues(vtt);
  assert.deepEqual(cues.map((c) => c.text), ["Kısa biçim", "Uzun biçim"]);
  close(cues[0].start, 1);
  close(cues[0].end, 2);
});

test("parseCues: strips HTML/VTT tags and ASS override tags", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:02,000\n<i>İtalik</i> <font color=\"#fff\">renk</font> {\\an8}üst {\\b1}kalın{\\b0}\n");
  assert.equal(cues[0].text, "İtalik renk üst kalın");
  // nested: one pass would leave a new tag behind
  assert.equal(parseCues("1\n00:00:01,000 --> 00:00:02,000\na {{\\b1}\\an8}b\n")[0].text, "a b");
});

test("parseCues: drops empty cues, sorts by start", () => {
  const cues = parseCues("2\n00:00:05,000 --> 00:00:06,000\nB\n\n1\n00:00:01,000 --> 00:00:02,000\nA\n\n3\n00:00:07,000 --> 00:00:08,000\n<i></i>\n");
  assert.deepEqual(cues.map((c) => c.text), ["A", "B"]);
});

test("parseCues: garbage gives no cues", () => {
  assert.deepEqual(parseCues(""), []);
  assert.deepEqual(parseCues("bu bir altyazı değil"), []);
});

test("decodeSubtitle: UTF-8 (with and without BOM)", () => {
  const text = "Iğdır şehri: ÇÖĞÜŞİ çöğüşı";
  assert.equal(decodeSubtitle(new TextEncoder().encode(text)), text);
  const bom = Uint8Array.from([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode(text)]);
  assert.equal(decodeSubtitle(bom), text); // TextDecoder drops the BOM
});

test("decodeSubtitle: falls back to Windows-1254 for invalid UTF-8", () => {
  const text = "Iğdır şehri: ÇÖĞÜŞİ çöğüşı";
  assert.equal(decodeSubtitle(encode1254(text)), text);
});

test("findCue: binary search with inclusive bounds and gaps", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n3\n00:00:05,000 --> 00:00:06,000\nC\n");
  assert.equal(findCue(cues, 0.5), null);
  assert.equal(findCue(cues, 1).text, "A");
  assert.equal(findCue(cues, 2).text, "A");
  assert.equal(findCue(cues, 2.5), null);
  assert.equal(findCue(cues, 3.5).text, "B");
  assert.equal(findCue(cues, 6).text, "C");
  assert.equal(findCue(cues, 99), null);
  assert.equal(findCue([], 1), null);
});

test("formatDelay", () => {
  assert.equal(formatDelay(0), "0 ms");
  assert.equal(formatDelay(100), "+100 ms");
  assert.equal(formatDelay(-50), "-50 ms");
});

test("fixtures: UTF-8 SRT (CRLF), VTT (BOM) and Windows-1254 SRT decode identically", () => {
  const srt = parseCues(decodeSubtitle(fixture("sample.srt")));
  assert.deepEqual(srt.map((c) => c.text), ["Merhaba dünya", "Çalışkan öğrenci şiir okudu", "Işık ve gölge\nİkinci satır"]);
  close(srt[0].start, 0.2);
  close(srt[2].end, 2.9);

  const vtt = parseCues(decodeSubtitle(fixture("sample.vtt")));
  assert.deepEqual(vtt.map((c) => c.text), ["Günaydın İstanbul", "Ağaç gölgesi", "Şimdi ölçü"]);

  const cp = fixture("sample-1254.srt");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(cp)); // really not UTF-8
  const legacy = parseCues(decodeSubtitle(cp));
  assert.deepEqual(legacy.map((c) => c.text), ["Iğdır'da güneşli şafak", "İşçi ÇÖĞÜŞ ığüşöç"]);
});
