// ==========================================================================
// Platform layer bootstrap: language, theme, persisted settings, recent files,
// Settings window, shortcut help, menus, files from the OS (second instance / Finder),
// accessibility live region. Runs after the player modules exist.
// ==========================================================================

import { i18n, resolveLanguage, switchLanguage, t } from "../core/i18n.js";
import { listen } from "../core/tauri.js";
import { initMenus } from "./menus.js";
import { initSettingsBindings } from "./settings-bindings.js";
import { createSettingsModal, registerBaseFields } from "./settings-modal.js";
import { createShortcutHelp } from "./shortcut-help.js";
import { createRecentFiles } from "./recent-files.js";
import { initTheme } from "./theme.js";

const READY_TIMEOUT_MS = 5000;

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: timeout`)), ms)),
]);

/** Language from the setting ("system" -> navigator.languages, Turkish fallback). */
export const languageFor = (setting) => resolveLanguage(setting, globalThis.navigator?.languages ?? [globalThis.navigator?.language]);

/**
 * app: the full app context (main.js). Resolves when the platform UI is ready.
 */
export async function initPlatform(app) {
  const { dom, settings, library } = app;

  // Toasts are announced by screen readers
  dom.snapshotToast?.setAttribute("role", "status");
  dom.snapshotToast?.setAttribute("aria-live", "polite");
  dom.snapshotToast?.setAttribute("aria-atomic", "true");

  try {
    await withTimeout(Promise.all([settings.ready, library.ready]), READY_TIMEOUT_MS, "settings");
  } catch (e) {
    console.error("[platform] settings not loaded, using defaults", e);
  }
  try {
    await switchLanguage(languageFor(settings.get("general.language")));
  } catch (e) {
    console.error("[platform] i18n", e);
  }
  settings.subscribe("general.language", (v) => switchLanguage(languageFor(v)).catch((e) => console.error(e)));

  initTheme(settings);
  app.shortcuts?.refresh();
  initSettingsBindings(app);

  app.recentFiles = createRecentFiles(app);
  registerBaseFields(app);
  app.settingsModal = createSettingsModal(app);
  app.shortcutHelp = createShortcutHelp(app);
  app.menus = initMenus(app);

  // Files from a second "vho.exe file" launch / macOS Finder while running
  listen("open-files", (e) => app.loader.openPaths(e.payload))?.catch?.((err) => console.warn("open-files", err));

  // Write pending changes when the window goes away
  window.addEventListener("pagehide", () => {
    settings.flush();
    library.flush();
  });

  i18n.applyTranslations(document);
  document.documentElement.dataset.platformReady = "1";
  return { t };
}
