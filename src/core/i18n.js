// ==========================================================================
// UI language (TR / EN).
//   t("settings.title")                     -> "Ayarlar"
//   t("recent.removed", { name: "a.mp4" })  -> "a.mp4 listeden kaldırıldı"
//   applyTranslations(root): fills elements marked with
//     data-i18n="key"              -> textContent
//     data-i18n-title="key"        -> title
//     data-i18n-aria-label="key"   -> aria-label
//     data-i18n-placeholder="key"  -> placeholder
//     data-i18n-alt="key"          -> alt
// Dictionaries: src/i18n/<lang>.json (nested objects, dotted keys). Missing keys fall back
// to Turkish, then to the key itself. Switching language re-applies without a reload.
// ==========================================================================

export const SUPPORTED_LANGUAGES = ["tr", "en"];
export const FALLBACK_LANGUAGE = "tr";

/** Setting ("system" | "tr" | "en") + navigator.languages -> a supported language. */
export function resolveLanguage(setting, systemLanguages = []) {
  if (SUPPORTED_LANGUAGES.includes(setting)) return setting;
  for (const l of systemLanguages ?? []) {
    const base = String(l || "").toLowerCase().split(/[-_]/)[0];
    if (SUPPORTED_LANGUAGES.includes(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

/** Nested lookup of a dotted key; strings only. */
export function lookup(dict, key) {
  let cur = dict;
  for (const part of String(key).split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** "{name} açıldı" + { name: "a" } -> "a açıldı" (unknown placeholders stay). */
export const interpolate = (str, vars) =>
  vars ? str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : str;

/** All dotted leaf keys of a dictionary (for the key parity test). */
export function flattenKeys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") out.push(...flattenKeys(v, key));
    else out.push(key);
  }
  return out;
}

const ATTRS = [
  ["i18n", null],
  ["i18nTitle", "title"],
  ["i18nAriaLabel", "aria-label"],
  ["i18nPlaceholder", "placeholder"],
  ["i18nAlt", "alt"],
];

export function createI18n({ dicts = {}, lang = FALLBACK_LANGUAGE } = {}) {
  const dictionaries = { ...dicts };
  let current = lang;
  const subs = new Set();

  function t(key, vars) {
    const s = lookup(dictionaries[current], key) ?? lookup(dictionaries[FALLBACK_LANGUAGE], key);
    return s === undefined ? key : interpolate(s, vars);
  }

  /** Vars for an element: data-i18n-vars='{"n":3}'. */
  function varsOf(el) {
    const raw = el.dataset?.i18nVars;
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  function applyTranslations(root = globalThis.document) {
    if (!root?.querySelectorAll) return;
    const sel = "[data-i18n],[data-i18n-title],[data-i18n-aria-label],[data-i18n-placeholder],[data-i18n-alt]";

    const els = [...(root.matches?.(sel) ? [root] : []), ...root.querySelectorAll(sel)];
    for (const el of els) {
      const vars = varsOf(el);
      for (const [prop, attr] of ATTRS) {
        const key = el.dataset[prop];
        if (!key) continue;
        if (attr) el.setAttribute(attr, t(key, vars));
        else el.textContent = t(key, vars);
      }
    }
  }

  return {
    t,
    applyTranslations,
    get language() { return current; },
    hasDictionary: (l) => !!dictionaries[l],
    addDictionary(l, dict) { dictionaries[l] = dict; },
    /** Switches language (dictionary must be loaded) and notifies subscribers. */
    setLanguage(l) {
      if (!SUPPORTED_LANGUAGES.includes(l)) l = FALLBACK_LANGUAGE;
      if (l === current) return;
      current = l;
      if (globalThis.document?.documentElement) document.documentElement.lang = l;
      for (const fn of subs) {
        try { fn(l); } catch (e) { console.error("[i18n] subscriber", e); }
      }
    },
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** App-wide instance (modules import { i18n, t }). */
export const i18n = createI18n();
export const t = (key, vars) => i18n.t(key, vars);

/** Fetches src/i18n/<lang>.json once. */
export async function loadDictionary(lang) {
  if (i18n.hasDictionary(lang)) return;
  const url = new URL(`../i18n/${lang}.json`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`i18n ${lang}: HTTP ${res.status}`);
  i18n.addDictionary(lang, await res.json());
}

/** Loads the fallback + the wanted dictionary, then switches (re-applied by subscribers). */
export async function switchLanguage(lang) {
  await loadDictionary(FALLBACK_LANGUAGE);
  if (lang !== FALLBACK_LANGUAGE) {
    try { await loadDictionary(lang); } catch (e) { console.warn(e); lang = FALLBACK_LANGUAGE; }
  }
  i18n.setLanguage(lang);
  i18n.applyTranslations(document);
}
