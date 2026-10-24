// ==========================================================================
// Themes (Koyu / Açık / Yüksek kontrast) and the accent colour.
// The theme is a data-theme attribute on <html> (blocks in platform.css); the accent
// colour overrides the --accent-* CSS variables from styles.css.
// ==========================================================================

export const THEMES = ["dark", "light", "contrast"];
export const DEFAULT_ACCENT = "#e11d48";

/** "#e11d48" -> [225, 29, 72] (null when invalid). */
export function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (rgb, target, k) => rgb.map((v, i) => v + (target[i] - v) * k);

/** CSS variable values derived from one accent colour. */
export function accentVariables(hex) {
  const rgb = hexToRgb(hex) ?? hexToRgb(DEFAULT_ACCENT);
  const [r, g, b] = rgb;
  const bright = toHex(mix(rgb, [255, 255, 255], 0.22));
  const dark = toHex(mix(rgb, [0, 0, 0], 0.18));
  return {
    "--accent-ruby": toHex(rgb),
    "--accent-ruby-bright": bright,
    "--accent-ruby-dim": `rgba(${r}, ${g}, ${b}, 0.16)`,
    "--accent-gradient": `linear-gradient(135deg, ${toHex(rgb)} 0%, ${dark} 100%)`,
    "--ruby-glow": `0 4px 20px rgba(${r}, ${g}, ${b}, 0.35)`,
    "--border-glow-ruby": `rgba(${r}, ${g}, ${b}, 0.4)`,
    "--focus-ring": bright,
  };
}

export function applyTheme(theme, root = document.documentElement) {
  const t = THEMES.includes(theme) ? theme : "dark";
  if (t === "dark") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

export function applyAccent(hex, root = document.documentElement) {
  const vars = accentVariables(hex);
  // The default accent keeps the hand-tuned values of styles.css
  const isDefault = (hex || "").toLowerCase() === DEFAULT_ACCENT;
  for (const [k, v] of Object.entries(vars)) {
    if (isDefault && k !== "--focus-ring") root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
}

/** Applies the stored theme/accent now and on every change. */
export function initTheme(settings) {
  applyTheme(settings.get("appearance.theme"));
  applyAccent(settings.get("appearance.accent"));
  settings.subscribe("appearance.theme", (v) => applyTheme(v));
  settings.subscribe("appearance.accent", (v) => applyAccent(v));
}
