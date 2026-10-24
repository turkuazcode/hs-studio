// ==========================================================================
// Settings window: tabbed modal rendered from the settings registry
// (core/settings.js register / fieldsOf). Built entirely here (no index.html markup),
// translated with data-i18n attributes, re-rendered when the language changes or a
// module registers more fields.
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { invoke, isTauri } from "../core/tauri.js";
import { DEFAULT_ACCENT } from "./theme.js";
import { renderShortcutEditor } from "./shortcut-editor.js";

const controlId = (key) => `setting-${key.replace(/[^a-z0-9]+/gi, "-")}`;

/** Text of a descriptor property: i18n key (xxxKey) or literal string. */
const textOf = (f, prop) => (f[`${prop}Key`] ? t(f[`${prop}Key`]) : f[prop] ?? "");

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "for") e.setAttribute(k, v);
    else e[k] = v;
  }
  e.append(...children.filter(Boolean));
  return e;
}

/** Base fields of the built-in tabs (B1/B3 add theirs with settings.register). */
export function registerBaseFields(app) {
  const { settings } = app;
  const isWindows = /windows/i.test(globalThis.navigator?.userAgent ?? "");
  const opt = (value, labelKey) => ({ value, labelKey });

  settings.register("general", [
    {
      key: "general.language", control: "select", labelKey: "settings.fields.language",
      options: [opt("system", "settings.options.languageSystem"), { value: "tr", label: "Türkçe" }, { value: "en", label: "English" }],
    },
    { key: "general.rememberRecent", control: "toggle", labelKey: "settings.fields.rememberRecent" },
    {
      control: "button", labelKey: "settings.fields.clearRecent", buttonKey: "recent.clear",
      onClick: () => { app.library.recent.clear(); app.toast(t("recent.cleared")); },
    },
    { key: "general.wheelVolume", control: "toggle", labelKey: "settings.fields.wheelVolume" },
    { key: "general.middleClickFullscreen", control: "toggle", labelKey: "settings.fields.middleClickFullscreen" },
    isWindows && isTauri && {
      id: "default-apps", control: "button", labelKey: "settings.fields.defaultApps", helpKey: "settings.help.defaultApps",
      buttonKey: "settings.buttons.defaultApps",
      onClick: () => invoke("open_default_apps_settings").catch((e) => {
        console.warn("open_default_apps_settings", e);
        app.toast(t("settings.toasts.defaultAppsFailed"));
      }),
    },
  ].filter(Boolean));

  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => ({ value: v, label: `${v}x` }));
  settings.register("playback", [
    { key: "playback.resume", control: "toggle", labelKey: "settings.fields.resume" },
    { key: "playback.rememberSpeed", control: "toggle", labelKey: "settings.fields.rememberSpeed" },
    { key: "playback.speed", control: "select", labelKey: "settings.fields.speed", options: speeds },
    {
      key: "playback.aspect", control: "select", labelKey: "settings.fields.aspect",
      options: [
        opt("contain", "settings.options.aspectContain"), { value: "16-9", label: "16:9" }, { value: "21-9", label: "21:9" },
        { value: "4-3", label: "4:3" }, opt("fill", "settings.options.aspectFill"),
      ],
    },
    { key: "playback.rememberFilters", control: "toggle", labelKey: "settings.fields.rememberFilters" },
    { key: "sleep.pcSleep", control: "toggle", labelKey: "settings.fields.pcSleep", helpKey: "settings.help.pcSleep" },
    { control: "heading", labelKey: "settings.headings.enhance" },
    { key: "ai.sharpLevel", control: "range", labelKey: "settings.fields.sharpLevel", min: 0, max: 3, step: 1 },
    { key: "ai.contrastBoost", control: "range", labelKey: "settings.fields.contrastBoost", min: 0, max: 40, step: 1, unit: "%" },
  ]);

  settings.register("subtitle", [
    { key: "subtitle.delay", control: "number", labelKey: "settings.fields.subDelay", min: -600000, max: 600000, step: 50, unit: "ms" },
    { key: "subtitle.fontScale", control: "range", labelKey: "settings.fields.subSize", min: 50, max: 250, step: 5, unit: "%" },
    { key: "subtitle.color", control: "color", labelKey: "settings.fields.subColor" },
    { key: "subtitle.background", control: "range", labelKey: "settings.fields.subBackground", min: 0, max: 100, step: 5, unit: "%" },
  ]);

  settings.register("audio", [
    { key: "playback.volume", control: "range", labelKey: "settings.fields.volume", min: 0, max: 200, step: 5, unit: "%" },
    { key: "playback.muted", control: "toggle", labelKey: "settings.fields.muted" },
    { control: "heading", labelKey: "settings.headings.audioRestore" },
    { key: "ai.voiceClarity", control: "toggle", labelKey: "settings.fields.voiceClarity" },
    { key: "ai.denoise", control: "toggle", labelKey: "settings.fields.denoise" },
    { key: "ai.compressor", control: "toggle", labelKey: "settings.fields.compressor" },
  ]);

  settings.register("photo", [
    { key: "ai.deepFaces", control: "toggle", labelKey: "settings.fields.deepFaces" },
  ]);

  settings.register("appearance", [
    {
      key: "appearance.theme", control: "select", labelKey: "settings.fields.theme",
      options: [opt("dark", "settings.options.themeDark"), opt("light", "settings.options.themeLight"), opt("contrast", "settings.options.themeContrast")],
    },
    { key: "appearance.accent", control: "color", labelKey: "settings.fields.accent" },
    {
      control: "button", labelKey: "settings.fields.accentReset", buttonKey: "settings.buttons.reset",
      onClick: () => settings.set("appearance.accent", DEFAULT_ACCENT),
    },
  ]);

  settings.register("shortcuts", [
    { control: "custom", render: (container) => renderShortcutEditor(container, app) },
  ]);

  settings.register("advanced", [
    isTauri && app.dom.checkCompatMode && {
      id: "compat", control: "button", labelKey: "settings.fields.compat", helpKey: "settings.help.compat",
      buttonKey: "settings.buttons.toggle",
      onClick: () => app.dom.checkCompatMode.click(), // existing confirm + restart flow
    },
    isTauri && {
      id: "data-dir", control: "custom",
      render(container) {
        const out = el("code", { class: "vho-settings-path", text: "…" });
        container.append(el("div", { class: "vho-field-label" }, el("span", { "data-i18n": "settings.fields.dataDir", text: t("settings.fields.dataDir") })), out);
        invoke("settings_dir").then((d) => { out.textContent = d; }).catch(() => { out.textContent = "-"; });
      },
    },
    {
      id: "reset-all", control: "button", labelKey: "settings.fields.resetAll", buttonKey: "settings.buttons.resetAll", danger: true,
      onClick: () => {
        if (!window.confirm(t("settings.confirmReset"))) return;
        settings.reset();
        app.toast(t("settings.toasts.reset"));
      },
    },
  ].filter(Boolean));

  settings.register("about", [
    {
      control: "custom",
      render(container) {
        const version = el("span", { text: "" });
        globalThis.window?.__TAURI__?.app?.getVersion?.().then((v) => { version.textContent = ` ${v}`; }).catch(() => {});
        container.append(
          el("div", { class: "vho-about" },
            el("img", { src: "assets/icon-192.png", alt: "", class: "vho-about-logo" }),
            el("div", {},
              el("strong", { text: "VHO" }, version),
              el("p", { "data-i18n": "settings.about.description", text: t("settings.about.description") }),
              el("p", { "data-i18n": "settings.about.license", text: t("settings.about.license") }))),
        );
      },
    },
    {
      id: "licenses", control: "button", labelKey: "settings.fields.licenses", buttonKey: "settings.buttons.showLicenses",
      onClick: () => app.dom.btnOpenLicenses?.click(), // the existing licenses window
    },
  ]);
}

/**
 * app: { dom, settings, library, toast, shortcuts }
 * Returns { open(section?), close(), isOpen, element }.
 */
export function createSettingsModal(app) {
  const { settings } = app;
  let current = "general";
  let lastFocus = null;
  const controls = new Map(); // key -> { input, output?, fmt }

  const overlay = el("div", {
    id: "settings-modal", class: "modal-overlay vho-settings-overlay", role: "dialog",
    "aria-modal": "true", "aria-labelledby": "settings-title",
  });
  const card = el("div", { class: "modal-card vho-settings-card" });
  const title = el("h3", { id: "settings-title", "data-i18n": "settings.title" });
  const btnClose = el("button", {
    id: "btn-close-settings", class: "btn-icon-close", type: "button",
    "data-i18n-aria-label": "common.close", "data-i18n-title": "common.close", text: "✕",
  });
  const tabs = el("div", { class: "vho-settings-tabs", role: "tablist", "aria-orientation": "vertical" });
  const panels = el("div", { class: "vho-settings-panels" });
  card.append(el("div", { class: "modal-header-row" }, title, btnClose), el("div", { class: "vho-settings-body" }, tabs, panels));
  overlay.append(card);
  (document.getElementById("viewport") ?? document.body).append(overlay);

  function renderTabs() {
    tabs.replaceChildren(...settings.sections().map((s) => {
      const b = el("button", {
        type: "button", role: "tab", id: `settings-tab-${s}`, class: "vho-settings-tab",
        "aria-controls": `settings-panel-${s}`, "aria-selected": String(s === current),
        tabIndex: s === current ? 0 : -1, "data-section": s, "data-i18n": `settings.tabs.${s}`,
      });
      b.addEventListener("click", () => select(s));
      return b;
    }));
  }

  tabs.addEventListener("keydown", (e) => {
    const list = settings.sections();
    const i = list.indexOf(current);
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    select(list[(next + list.length) % list.length], true);
  });

  function formatValue(f, v) {
    return f.unit ? `${v}${f.unit === "%" ? "" : " "}${f.unit}` : String(v);
  }

  /** Writes a control value into the store; reverts the control when it is rejected. */
  function commit(key, value) {
    if (!settings.set(key, value)) syncControl(key);
  }

  function syncControl(key) {
    const c = controls.get(key);
    if (!c) return;
    const v = settings.get(key);
    if (c.input.type === "checkbox") c.input.checked = !!v;
    else c.input.value = String(v);
    if (c.output) c.output.textContent = c.fmt(v);
  }

  function renderField(f) {
    const row = el("div", { class: `vho-field vho-field-${f.control}`, "data-setting": f.key ?? f.id ?? "" });
    const ctx = { app, settings, t, toast: app.toast };
    const label = (forId) => {
      const l = el(forId ? "label" : "span", { class: "vho-field-label", for: forId });
      l.append(el("span", { ...(f.labelKey ? { "data-i18n": f.labelKey } : {}), text: textOf(f, "label") }));
      if (f.helpKey || f.help) l.append(el("small", { ...(f.helpKey ? { "data-i18n": f.helpKey } : {}), text: textOf(f, "help") }));
      return l;
    };

    switch (f.control) {
      case "heading":
        return el("h4", { class: "vho-settings-heading", ...(f.labelKey ? { "data-i18n": f.labelKey } : {}), text: textOf(f, "label") });
      case "custom":
        f.render?.(row, ctx);
        return row;
      case "button": {
        const b = el("button", {
          type: "button", class: f.danger ? "btn-ghost btn-sm vho-danger" : "btn-secondary btn-sm",
          id: f.id ? `setting-btn-${f.id}` : undefined,
          ...(f.buttonKey ? { "data-i18n": f.buttonKey } : {}), text: f.buttonKey ? t(f.buttonKey) : textOf(f, "button"),
        });
        b.addEventListener("click", () => f.onClick?.(ctx));
        row.append(label(null), b);
        return row;
      }
    }

    const key = f.key;
    const field = settings.field(key);
    if (!field) return row;
    const id = controlId(key);
    let input, output = null;
    const fmt = (v) => formatValue(f, v);

    if (f.control === "toggle") {
      input = el("input", { type: "checkbox", id, class: "vho-switch-input", role: "switch" });
      input.addEventListener("change", () => commit(key, input.checked));
      row.append(label(id), el("span", { class: "vho-switch" }, input, el("span", { class: "vho-switch-track", "aria-hidden": "true" })));
    } else if (f.control === "select") {
      input = el("select", { id, class: "modal-select vho-select" });
      for (const o of f.options ?? (field.values ?? []).map((v) => ({ value: v, label: String(v) }))) {
        input.append(el("option", { value: String(o.value), ...(o.labelKey ? { "data-i18n": o.labelKey } : {}), text: o.labelKey ? t(o.labelKey) : o.label }));
      }
      input.addEventListener("change", () => commit(key, input.value));
      row.append(label(id), input);
    } else if (f.control === "range") {
      input = el("input", { type: "range", id, class: "filter-slider vho-range", min: f.min ?? field.min, max: f.max ?? field.max, step: f.step ?? 1 });
      output = el("output", { for: id, class: "vho-range-value" });
      input.addEventListener("input", () => { output.textContent = fmt(Number(input.value)); commit(key, Number(input.value)); });
      row.append(label(id), el("span", { class: "vho-range-wrap" }, input, output));
    } else if (f.control === "number") {
      input = el("input", { type: "number", id, class: "modal-input vho-number", min: f.min ?? field.min, max: f.max ?? field.max, step: f.step ?? 1 });
      input.addEventListener("change", () => commit(key, Number(input.value)));
      row.append(label(id), el("span", { class: "vho-number-wrap" }, input, f.unit ? el("span", { class: "vho-unit", text: f.unit }) : null));
    } else if (f.control === "color") {
      input = el("input", { type: "color", id, class: "vho-color" });
      input.addEventListener("input", () => commit(key, input.value));
      row.append(label(id), input);
    } else {
      input = el("input", { type: "text", id, class: "modal-input" });
      input.addEventListener("change", () => commit(key, input.value));
      row.append(label(id), input);
    }
    controls.set(key, { input, output, fmt });
    syncControl(key);
    return row;
  }

  function renderPanel(section) {
    const panel = el("section", {
      id: `settings-panel-${section}`, class: "vho-settings-panel", role: "tabpanel",
      "aria-labelledby": `settings-tab-${section}`, hidden: section !== current, tabIndex: 0,
    });
    const fields = settings.fieldsOf(section);
    if (!fields.length) panel.append(el("p", { class: "vho-settings-empty", "data-i18n": "settings.empty" }));
    for (const f of fields) panel.append(renderField(f));
    return panel;
  }

  function render() {
    controls.clear();
    renderTabs();
    panels.replaceChildren(...settings.sections().map(renderPanel));
    i18n.applyTranslations(overlay);
  }

  function select(section, focusTab = false) {
    current = section;
    for (const b of tabs.querySelectorAll("[role=tab]")) {
      const on = b.dataset.section === section;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focusTab) b.focus();
    }
    for (const p of panels.querySelectorAll("[role=tabpanel]")) p.hidden = p.id !== `settings-panel-${section}`;
  }

  function open(section) {
    if (!overlay.classList.contains("active")) lastFocus = document.activeElement;
    if (section && settings.sections().includes(section)) current = section;
    render();
    overlay.classList.add("active");
    tabs.querySelector(`[data-section="${current}"]`)?.focus();
  }

  function close() {
    if (!overlay.classList.contains("active")) return false;
    overlay.classList.remove("active");
    settings.flush();
    lastFocus?.focus?.();
    return true;
  }

  btnClose.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  settings.subscribe("*", (key) => syncControl(key));
  settings.onRegister(() => { if (overlay.classList.contains("active")) render(); });
  i18n.onChange(() => { if (overlay.classList.contains("active")) render(); else i18n.applyTranslations(overlay); });
  app.shortcuts?.onEscape(() => close());

  render();
  return {
    open,
    close,
    select,
    get isOpen() { return overlay.classList.contains("active"); },
    element: overlay,
  };
}
