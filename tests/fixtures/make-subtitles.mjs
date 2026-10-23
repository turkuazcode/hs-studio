// Writes the subtitle fixtures (called by make-fixtures.ps1; runnable on its own):
//   sample.srt       UTF-8, CRLF, HTML + ASS tags, multi-line cue
//   sample.vtt       UTF-8 with BOM, LF, cue settings, short timestamps
//   sample-1254.srt  Windows-1254 (legacy Turkish), CRLF
// Cue times fit the 3 s test clips and leave gaps, so mid-cue seeks are unambiguous.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = (name) => fileURLToPath(new URL(name, import.meta.url));

const srt = [
  "1", "00:00:00,200 --> 00:00:00,900", "Merhaba dünya", "",
  "2", "00:00:01,000 --> 00:00:01,900", "Çalışkan öğrenci şiir okudu", "",
  "3", "00:00:02,000 --> 00:00:02,900", "<i>Işık</i> ve {\\an8}gölge", "İkinci satır", "",
].join("\r\n");
writeFileSync(out("sample.srt"), srt, "utf8");

const vtt = [
  "WEBVTT", "",
  "1", "00:00:00.200 --> 00:00:00.900 align:middle", "Günaydın İstanbul", "",
  "00:01.000 --> 00:01.900", "Ağaç gölgesi", "",
  "00:00:02.000 --> 00:00:02.900", "<b>Şimdi</b> ölçü", "",
].join("\n");
writeFileSync(out("sample.vtt"), "﻿" + vtt, "utf8");

// Windows-1254 differs from Latin-1 only in these Turkish letters (for our text)
const CP1254 = { "ğ": 0xF0, "Ğ": 0xD0, "ş": 0xFE, "Ş": 0xDE, "ı": 0xFD, "İ": 0xDD, "ü": 0xFC, "Ü": 0xDC, "ö": 0xF6, "Ö": 0xD6, "ç": 0xE7, "Ç": 0xC7 };
const encode1254 = (s) => Buffer.from([...s].map((ch) => {
  if (ch in CP1254) return CP1254[ch];
  const c = ch.charCodeAt(0);
  if (c > 0x7f) throw new Error(`no Windows-1254 mapping for ${ch}`);
  return c;
}));
const legacy = [
  "1", "00:00:00,200 --> 00:00:00,900", "Iğdır'da güneşli şafak", "",
  "2", "00:00:01,000 --> 00:00:01,900", "İşçi ÇÖĞÜŞ ığüşöç", "",
].join("\r\n");
writeFileSync(out("sample-1254.srt"), encode1254(legacy));

console.log("subtitle fixtures written");
