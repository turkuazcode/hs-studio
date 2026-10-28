// ==========================================================================
// Thin wrappers around window.__TAURI__ (withGlobalTauri). In a plain browser
// (vite dev server) every member is undefined / a no-op, exactly like the
// original optional-chaining checks in main.js.
// ==========================================================================

const tauri = globalThis.window?.__TAURI__;

/** True inside the desktop app. */
export const isTauri = !!tauri;

/** Backend command call; undefined in a browser (callers check before use). */
export const invoke = tauri?.core?.invoke;

/** The app window (fullscreen, minimize...); undefined in a browser. */
export const appWindow = tauri?.window?.getCurrentWindow?.();

/** Local path -> http://asset.localhost URL the webview can stream. */
export const convertFileSrc = (path) => tauri.core.convertFileSrc(path);

/** Backend event subscription; silently ignored in a browser. */
export function listen(event, handler) {
  return tauri?.event?.listen(event, handler);
}

// Native file dialogs, shown by the backend (Q04: only paths the user really picked there may
// later be written, renamed or deleted). Same options and results as the dialog plugin's
// open / save; undefined in a browser (callers fall back to <input type=file>).
export const dialogOpen = tauri?.core?.invoke ? (opts) => tauri.core.invoke("dialog_open", { options: opts ?? {} }) : undefined;
export const dialogSave = tauri?.core?.invoke ? (opts) => tauri.core.invoke("dialog_save", { options: opts ?? {} }) : undefined;

/** Opens a URL in the system browser (tauri-plugin-opener) or a new tab in a browser. */
export async function openUrl(url) {
  if (tauri?.opener?.openUrl) await tauri.opener.openUrl(url);
  else window.open(url, "_blank", "noopener");
}
