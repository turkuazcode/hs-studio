// ==========================================================================
// Cross-platform window controls (macOS traffic lights & Windows/Linux)
// ==========================================================================

import { appWindow } from "../core/tauri.js";

export const isMacUserAgent = (ua = "", platform = "") =>
  ua.toLowerCase().includes("mac") || platform.toLowerCase().includes("mac");

export function initWindowControls({ macLights, winControls }) {
  const isMac = isMacUserAgent(navigator.userAgent ?? "", navigator.platform ?? "");

  if (isMac && macLights) {
    document.body.classList.add("platform-macos");
    macLights.style.display = "flex";
    if (winControls) winControls.style.display = "none";
  }

  const runWindow = (fn) => (e) => {
    e.stopPropagation();
    if (!appWindow) return;
    fn(appWindow).catch((err) => console.error("[window]", err));
  };

  const bindWindow = (id, fn) => document.getElementById(id)?.addEventListener("click", runWindow(fn));
  bindWindow("btn-minimize", (w) => w.minimize());
  bindWindow("btn-maximize", (w) => w.toggleMaximize());
  bindWindow("btn-close", (w) => w.close());
  bindWindow("mac-btn-minimize", (w) => w.minimize());
  bindWindow("mac-btn-maximize", (w) => w.toggleMaximize());
  bindWindow("mac-btn-close", (w) => w.close());
  // No titlebar dblclick handler: Tauri's data-tauri-drag-region already maximizes on double-click.
}
