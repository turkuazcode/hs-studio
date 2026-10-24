// ==========================================================================
// HTML menus: right-click context menu on the viewport, the titlebar "Menü" button
// (open, recent files, settings, shortcuts), and mouse gestures (middle click =
// fullscreen, wheel = volume on video).
// ==========================================================================

import { i18n, t } from "../core/i18n.js";
import { formatCombo } from "../core/keymap.js";
import { keyNames } from "./shortcut-editor.js";
import { isTextField } from "./shortcuts.js";

/**
 * Popup menu. items: [{ id, labelKey | label, shortcut?: actionId, run(), disabled? } | { separator: true }
 *                     | { heading: labelKey }]
 */
export function createPopupMenu({ id, className = "" }) {
  const menu = document.createElement("div");
  menu.id = id;
  menu.className = `vho-menu ${className}`;
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  let onClose = null;
  let lastFocus = null;

  const itemsEls = () => [...menu.querySelectorAll("[role=menuitem]:not([disabled])")];

  function build(items, shortcutKeys) {
    menu.replaceChildren();
    for (const it of items) {
      if (it.separator) {
        menu.append(Object.assign(document.createElement("div"), { className: "vho-menu-sep", role: "separator" }));
        continue;
      }
      if (it.heading) {
        const h = document.createElement("div");
        h.className = "vho-menu-heading";
        h.textContent = t(it.heading);
        menu.append(h);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.className = "vho-menu-item";
      if (it.id) b.dataset.menuId = it.id;
      b.disabled = !!it.disabled;
      const label = document.createElement("span");
      label.className = "vho-menu-label";
      label.textContent = it.label ?? t(it.labelKey);
      if (it.title) b.title = it.title;
      b.append(label);
      const keys = it.shortcut ? shortcutKeys?.(it.shortcut) : it.keyHint ? [it.keyHint] : [];
      if (keys?.length) {
        const k = document.createElement("span");
        k.className = "vho-menu-key";
        k.textContent = it.keyHint ?? formatCombo(keys[0], keyNames());
        b.append(k);
      }
      if (it.extra) b.append(it.extra);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        it.run?.();
      });
      menu.append(b);
    }
  }

  function openAt(x, y, items, { shortcutKeys, focusFirst = false, onClosed } = {}) {
    lastFocus = document.activeElement;
    build(items, shortcutKeys);
    menu.hidden = false;
    // Keep inside the window
    const r = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    onClose = onClosed ?? null;
    if (focusFirst) itemsEls()[0]?.focus();
    else menu.focus?.();
  }

  function close(restoreFocus = false) {
    if (menu.hidden) return false;
    menu.hidden = true;
    onClose?.();
    onClose = null;
    if (restoreFocus) lastFocus?.focus?.();
    return true;
  }

  menu.tabIndex = -1;
  menu.addEventListener("keydown", (e) => {
    const list = itemsEls();
    const i = list.indexOf(document.activeElement);
    const go = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (go !== undefined && list.length) {
      e.preventDefault();
      e.stopPropagation();
      list[(go + list.length) % list.length].focus();
    } else if (e.key === "Tab") {
      close(true);
    }
  });
  document.addEventListener("mousedown", (e) => { if (!menu.contains(e.target)) close(); }, true);
  window.addEventListener("blur", () => close());
  window.addEventListener("resize", () => close());

  return { openAt, close, get isOpen() { return !menu.hidden; }, element: menu };
}

/**
 * app: { dom, state, settings, library, loader, video, photo, fullscreen, snapshot, playlist, audio,
 *        settingsModal, shortcutHelp, shortcuts, toast }
 */
export function initMenus(app) {
  const { dom, state, settings } = app;
  const keysOf = (id) => app.shortcuts?.keysOf(id) ?? [];

  // ------------------------------------------------------------------------
  // Context menu (right click on the media area)
  // ------------------------------------------------------------------------
  const ctx = createPopupMenu({ id: "context-menu" });
  app.shortcuts?.onEscape(() => ctx.close(true));

  function contextItems() {
    const mode = state.get("currentMediaType");
    const hasVideo = mode === "video" && !!dom.video.getAttribute("src");
    const items = [];
    if (mode === "image") {
      items.push({ id: "slideshow", labelKey: "menu.slideshow", shortcut: "slideshow", run: () => app.photo.toggleSlideshow() });
    } else {
      items.push({
        id: "play-pause", labelKey: dom.video.paused ? "menu.play" : "menu.pause", shortcut: "playPause",
        disabled: !hasVideo, run: () => app.video.togglePlay(),
      });
    }
    items.push(
      { id: "fullscreen", labelKey: "menu.fullscreen", shortcut: "fullscreen", run: () => app.fullscreen.toggle() },
      { id: "snapshot", labelKey: "menu.snapshot", shortcut: "snapshot", disabled: mode === "none", run: () => app.snapshot.capture() },
      { separator: true },
      { id: "open-file", labelKey: "menu.openFile", shortcut: "openFile", run: () => dom.btnBrowse.click() },
      { id: "open-url", labelKey: "menu.openUrl", run: () => dom.btnOpenUrl.click() },
    );
    if (mode !== "image") items.push({ id: "load-subtitle", labelKey: "menu.loadSubtitle", run: () => dom.subFileInput?.click() });
    items.push(
      { separator: true },
      { id: "playlist", labelKey: "menu.playlist", shortcut: "playlist", run: () => app.playlist.toggleDrawer() },
      { id: "filters", labelKey: "menu.filters", run: () => dom.btnToggleEffects?.click() },
      { separator: true },
      { id: "settings", labelKey: "menu.settings", shortcut: "settings", run: () => app.settingsModal.open() },
      { id: "shortcuts", labelKey: "menu.shortcuts", keyHint: "?", run: () => app.shortcutHelp.open() },
    );
    return items;
  }

  // The webview's own menu (Reload, Inspect...) never shows; text fields keep copy/paste
  window.addEventListener("contextmenu", (e) => {
    if (isTextField(e.target) || e.defaultPrevented) return;
    e.preventDefault();
    const viewport = document.getElementById("viewport");
    const inMenuArea = viewport?.contains(e.target) &&
      !e.target.closest(".modal-overlay, .effects-panel, .playlist-drawer, .controls-hud, .photo-hud, .drop-card, .vho-recent");
    if (!inMenuArea) return;
    ctx.openAt(e.clientX, e.clientY, contextItems(), { shortcutKeys: keysOf });
  });

  // ------------------------------------------------------------------------
  // Titlebar menu
  // ------------------------------------------------------------------------
  const actionsBar = document.querySelector(".titlebar-actions");
  const btnMenu = document.createElement("button");
  btnMenu.id = "btn-app-menu";
  btnMenu.type = "button";
  btnMenu.className = "titlebar-action-btn";
  btnMenu.setAttribute("aria-haspopup", "menu");
  btnMenu.setAttribute("aria-expanded", "false");
  btnMenu.setAttribute("aria-controls", "app-menu");
  btnMenu.dataset.i18nTitle = "menu.title";
  btnMenu.dataset.i18nAriaLabel = "menu.title";
  btnMenu.innerHTML = `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z"/></svg><span data-i18n="menu.title"></span>`;
  actionsBar?.prepend(btnMenu);
  i18n.applyTranslations(btnMenu);
  i18n.onChange(() => i18n.applyTranslations(btnMenu));

  const appMenu = createPopupMenu({ id: "app-menu", className: "vho-app-menu" });
  app.shortcuts?.onEscape(() => appMenu.close(true));

  function appMenuItems() {
    const items = [
      { id: "open-file", labelKey: "menu.openFile", shortcut: "openFile", run: () => dom.btnBrowse.click() },
      { id: "open-url", labelKey: "menu.openUrl", run: () => dom.btnOpenUrl.click() },
      { separator: true },
      { heading: "recent.title" },
    ];
    const recent = settings.get("general.rememberRecent") ? app.library.recent.list() : [];
    if (!recent.length) items.push({ id: "recent-empty", labelKey: "recent.empty", disabled: true });
    for (const e of recent.slice(0, 10)) {
      items.push({ id: "recent-item", label: e.name, title: e.path || e.url, run: () => app.recentFiles.open(e) });
    }
    if (recent.length) items.push({ id: "recent-clear", labelKey: "recent.clear", run: () => app.recentFiles.clear() });
    items.push(
      { separator: true },
      { id: "settings", labelKey: "menu.settings", shortcut: "settings", run: () => app.settingsModal.open() },
      { id: "shortcuts", labelKey: "menu.shortcuts", keyHint: "?", run: () => app.shortcutHelp.open() },
      { id: "licenses", labelKey: "menu.licenses", run: () => dom.btnOpenLicenses?.click() },
    );
    return items;
  }

  btnMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    if (appMenu.isOpen) { appMenu.close(); return; }
    const r = btnMenu.getBoundingClientRect();
    btnMenu.setAttribute("aria-expanded", "true");
    appMenu.openAt(r.left, r.bottom + 6, appMenuItems(), {
      shortcutKeys: keysOf,
      focusFirst: e.detail === 0, // keyboard activation
      onClosed: () => btnMenu.setAttribute("aria-expanded", "false"),
    });
  });
  btnMenu.addEventListener("mousedown", (e) => e.stopPropagation());

  // ------------------------------------------------------------------------
  // Mouse: middle click = fullscreen, wheel = volume (video)
  // ------------------------------------------------------------------------
  const viewport = document.getElementById("viewport");
  const onMedia = (target) => target === dom.video || target === dom.gpuCanvas || target === viewport ||
    target?.id === "subtitles-container" || target?.id === "subtitle-text" || target?.closest?.("#image-container");

  viewport?.addEventListener("mousedown", (e) => {
    if (e.button === 1 && onMedia(e.target)) e.preventDefault(); // no autoscroll cursor
  });
  viewport?.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || !onMedia(e.target) || !settings.get("general.middleClickFullscreen")) return;
    e.preventDefault();
    app.fullscreen.toggle();
  });
  viewport?.addEventListener("wheel", (e) => {
    if (!settings.get("general.wheelVolume") || state.get("currentMediaType") !== "video") return;
    if (!(e.target === dom.video || e.target === dom.gpuCanvas || e.target === viewport ||
      e.target?.id === "subtitles-container" || e.target?.id === "subtitle-text")) return;
    e.preventDefault();
    app.audio.nudgeVolume(e.deltaY < 0 ? 5 : -5);
    app.hud.poke();
  }, { passive: false });

  return { context: ctx, appMenu };
}
