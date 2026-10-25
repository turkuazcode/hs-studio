// S05: user-visible texts come from the TR/EN dictionaries.
//  - index.html: every text / title / aria-label / placeholder / alt carries a data-i18n* key
//    (except brand names, numbers, endonyms and elements whose text the JS renders);
//  - src/**/*.js: no string literal with Turkish-only letters outside the documented exceptions;
//  - every key used in src (t("..."), data-i18n*, labelKey/helpKey/...) exists in both languages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "../../src/core/i18n.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const read = (p) => readFileSync(join(SRC, p), "utf8");
const dict = (lang) => JSON.parse(read(`i18n/${lang}.json`));
const LETTER = /[A-Za-zÇĞİÖŞÜçğıöşü]/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "vendor") walk(p, out); }
    else if (n.endsWith(".js")) out.push(p);
  }
  return out;
}

// Elements whose text the JS renders (filled with t() at runtime) or that are not language
const DYNAMIC_IDS = new Set([
  "app-title", "app-edition-tag", "sleep-badge", "transcode-text", "resume-time-text", "sub-status-label",
  "sub-menu-toggle-text", "ab-loop-label", "speed-label", "photo-zoom-level", "playlist-total-text",
  "ai-master-status", "val-ai-sharp", "split-view-status", "btn-deep-enhance", "deep-status", "btn-deep-compare",
  "licenses-text", "drop-title", "val-sub-delay", "val-audio-delay", "btn-sub-minus", "btn-sub-plus",
  "btn-audio-minus", "btn-audio-plus",
]);
const NEUTRAL_TEXT = /^(VHO.*|STUDIO|[\d.,:x%+\-−×]+\s*(ms|x)?|[A-Z]|CC|RAW|JPEG \/ PNG \/ WebP…|HEIC \/ HEIF|Histogram|Format:|Türkçe 🇹🇷|English 🇬🇧|Deutsch 🇩🇪|Français 🇫🇷|← \/ →)$/;

test("i18n coverage: index.html texts and attributes carry keys", () => {
  const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");
  const stack = [];
  const missing = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[2]) {
      const [, close, tag, attrs, selfClose] = m;
      if (close) {
        while (stack.length && stack.pop().tag !== tag.toLowerCase());
        continue;
      }
      for (const a of ["title", "aria-label", "placeholder", "alt"]) {
        const v = attrs.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];
        if (v && LETTER.test(v) && !attrs.includes(`data-i18n-${a}=`) && !NEUTRAL_TEXT.test(v) && !/^https?:/.test(v)) {
          missing.push(`<${tag}> @${a}="${v}"`);
        }
      }
      if (!selfClose && !["input", "img", "br", "link", "meta", "path", "rect", "source"].includes(tag.toLowerCase())) {
        stack.push({ tag: tag.toLowerCase(), attrs });
      }
    } else {
      const text = m[5].trim();
      const top = stack[stack.length - 1];
      if (!text || !LETTER.test(text) || !top || ["script", "style", "title"].includes(top.tag) && top.attrs.includes("data-i18n")) continue;
      const id = top.attrs.match(/\sid="([^"]+)"/)?.[1];
      const cls = top.attrs.match(/\sclass="([^"]+)"/)?.[1] ?? "";
      // JS-rendered placeholders: playlist empty state (ui/playlist.js), info title (studio/info-panel.js)
      if (/\b(playlist-empty|ps-info-title)\b/.test(cls)) continue;
      if (top.attrs.includes("data-i18n=") || DYNAMIC_IDS.has(id) || NEUTRAL_TEXT.test(text)) continue;
      missing.push(`<${top.tag}${id ? `#${id}` : ""}> "${text}"`);
    }
  }
  assert.deepEqual(missing, []);
});

// String literals with Turkish-only letters that stay on purpose
const ALLOWED_TR_LITERALS = [
  // language endonyms (a language is named in its own language)
  { file: "media/engine/engine.js", re: /Türkçe|Français/ },
  { file: "ui/settings-modal.js", re: /Türkçe/ },
];

test("i18n coverage: no Turkish UI literals left in the JS modules", () => {
  const lit = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  const found = [];
  for (const p of walk(SRC)) {
    const file = relative(SRC, p).replace(/\\/g, "/");
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      const s = line.trim();
      if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
      const code = line.replace(/\s\/\/\s.*$/, "");
      for (const m of code.matchAll(lit)) {
        if (!/[çğıöşüÇĞİÖŞÜ]/.test(m[1])) continue;
        if (ALLOWED_TR_LITERALS.some((a) => a.file === file && a.re.test(m[1]))) continue;
        found.push(`${file}:${i + 1} ${m[1].slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test("i18n coverage: every key used in src exists in tr.json and en.json", () => {
  const tr = dict("tr");
  const en = dict("en");
  const used = new Set();
  const patterns = [
    /\bt\(\s*"([\w.]+)"/g, /\btr\(\s*"([\w.]+)"/g, /\bt\(\s*(?:\w+\s*\?\s*)?"([\w.]+)"\s*:\s*"([\w.]+)"/g,
    /\b(?:labelKey|helpKey|buttonKey|titleKey)\s*:\s*"([\w.]+)"/g,
    /data-i18n(?:-[a-z-]+)?="([\w.]+)"/g, /dataset\.i18n\w*\s*=\s*"([\w.]+)"/g,
    /\b(?:tx|ti|ta)\(\s*"([\w.]+)"\)/g, /"((?:ui|enhance|studio|effects|audio|settings)\.[\w.]+)"/g,
  ];
  const files = [...walk(SRC), join(SRC, "index.html")];
  for (const p of files) {
    const src = readFileSync(p, "utf8");
    for (const re of patterns) for (const m of src.matchAll(re)) for (const k of m.slice(1)) if (k) used.add(k);
  }
  // only dotted names under a dictionary namespace count as keys (not file names / setting ids)
  const namespaces = new Set(Object.keys(tr));
  const keys = [...used].filter((k) => k.includes(".") && namespaces.has(k.split(".")[0]) && !/\.(js|json|css|html|png|txt)$/.test(k));
  const settingIds = /^(audio|playback|general|subtitle|photo|engine|ai|filters|appearance|sleep|shortcuts)\.[a-z]\w*$/;
  const missingTr = keys.filter((k) => lookup(tr, k) === undefined && !settingIds.test(k));
  const missingEn = keys.filter((k) => lookup(tr, k) !== undefined && lookup(en, k) === undefined);
  assert.ok(keys.length > 300, `found ${keys.length} keys`);
  assert.deepEqual(missingTr.sort(), []);
  assert.deepEqual(missingEn, []);
});
