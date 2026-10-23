// Starts / stops vho.exe for E2E tests and wraps the CDP session with app helpers.
//
// Isolation: every launch gets its own WebView2 profile (WEBVIEW2_USER_DATA_FOLDER), so
// tests never see the user's localStorage (resume positions) and never join a VHO the
// user or another agent is running. Only the process started here is ever stopped.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, sleep } from "./cdp.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
export const fixture = (name) => join(FIXTURES, name);

/** CDP ports reserved for VHO tests. */
const PORT_MIN = 9500;
const PORT_MAX = 9599;

export function defaultExe() {
  return process.env.VHO_EXE || join(REPO_ROOT, "src-tauri", "target", "release", process.platform === "win32" ? "vho.exe" : "vho");
}

function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

/** A free port in 9500-9599, starting at a random offset (parallel runs by other agents). */
export async function findFreePort() {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start + i) % span);
    if (await portFree(port)) return port;
  }
  throw new Error(`no free CDP port in ${PORT_MIN}-${PORT_MAX}`);
}

// Installed before any page script runs: collects uncaught errors and rejections.
const ERROR_COLLECTOR = `
  window.__errs = [];
  addEventListener("error", (e) => {
    if (e instanceof ErrorEvent) __errs.push(String(e.message) + " @ " + e.filename + ":" + e.lineno);
  });
  addEventListener("unhandledrejection", (e) => __errs.push("unhandled rejection: " + String(e.reason && (e.reason.stack || e.reason))));
`;

// Test-side stubs: no real downloads (snapshots) and no blocking confirm() dialogs.
const TEST_STUBS = `
  window.__downloads = [];
  // The app CSP has no blob: in connect-src, so remember the Blob behind each object URL
  const blobs = new Map();
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = realCreate.call(URL, obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      const b = blobs.get(this.href);
      __downloads.push({ name: this.download, size: b ? b.size : 0, type: b ? b.type : "" });
      return;
    }
    return realClick.call(this);
  };
  window.__confirms = [];
  window.confirm = (msg) => { __confirms.push(String(msg)); return false; };
`;

const debug = (...a) => { if (process.env.VHO_E2E_DEBUG) console.error(`[e2e ${new Date().toISOString().slice(11, 23)}]`, ...a); };

const waitExit = (proc, ms) => new Promise((res) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return res(true);
  const t = setTimeout(() => res(false), ms);
  proc.once("exit", () => { clearTimeout(t); res(true); });
});

/**
 * Launches vho.exe (optionally with media paths as arguments, like "Open with VHO"),
 * connects CDP, installs the error collector + stubs (via one reload) and waits until
 * the app has booted (window.__vho).
 */
export async function launchApp({ args = [], exe = defaultExe() } = {}) {
  if (!existsSync(exe)) {
    throw new Error(`${exe} not found. Build it first: npm run build:release (or set VHO_EXE)`);
  }
  const port = await findFreePort();
  const userData = await mkdtemp(join(tmpdir(), "vho-e2e-"));
  const proc = spawn(exe, args, {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: userData,
    },
    stdio: "ignore",
    windowsHide: false,
  });
  const exited = new Promise((res) => proc.once("exit", (code) => res(code)));
  debug("launch: pid", proc.pid, "port", port, "args", args);

  let cdp;
  try {
    cdp = await Promise.race([
      connectCdp(port, { timeoutMs: 45000 }),
      exited.then((code) => { throw new Error(`vho.exe exited early (code ${code})`); }),
    ]);
    // The page target exists while it is still about:blank: wait for the app document first
    const appLoaded = "location.protocol.startsWith('http') && typeof window.__TAURI__ === 'object' && document.readyState === 'complete'";
    debug("launch: CDP connected");
    await cdp.waitFor(appLoaded, { timeoutMs: 30000, message: "app page loaded" });
    debug("launch: app page loaded");
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: ERROR_COLLECTOR + TEST_STUBS });
    // Reload so the collector also sees module loading / boot. initial_files is re-read
    // from the command line, so a media argument is opened again.
    await cdp.evaluate("window.__beforeReload = true");
    await cdp.send("Page.reload", { ignoreCache: true });
    // Module scripts and the DOMContentLoaded bootstrap have run once readyState is "complete"
    await cdp.waitFor(`!window.__beforeReload && Array.isArray(window.__errs) && ${appLoaded}`, {
      timeoutMs: 20000, message: "app boot after reload",
    });
    debug("launch: booted after reload");
  } catch (e) {
    cdp?.close();
    proc.kill();
    await waitExit(proc, 5000);
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    throw e;
  }

  const app = {
    proc,
    port,
    cdp,
    userData,
    eval: (expr, opts) => cdp.evaluate(expr, opts),
    waitFor: (expr, opts) => cdp.waitFor(expr, opts),
    /** Keyboard shortcut as the app sees it (keydown bubbling from <body> to window). */
    key: (code, { key = "", shiftKey = false } = {}) => cdp.evaluate(
      `document.body.dispatchEvent(new KeyboardEvent("keydown", { code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, shiftKey: ${shiftKey}, bubbles: true, cancelable: true })), true`),
    click: (selector) => cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no element ${selector}`)}); el.click(); return true; })()`),
    text: (selector) => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
    /** Uncaught page errors since the reload. */
    errors: () => cdp.evaluate("window.__errs"),
    /**
     * HTML5 drop of local files as browser File objects (the drag & drop path that does
     * not go through the asset protocol). Black-box: only __TAURI__ and DOM events.
     */
    dropFiles: (paths) => cdp.evaluate(`(async () => {
      const entries = await __TAURI__.core.invoke("prepare_media", { paths: ${JSON.stringify(paths)} });
      const dt = new DataTransfer();
      for (const e of entries) {
        const blob = await (await fetch(__TAURI__.core.convertFileSrc(e.path))).blob();
        dt.items.add(new File([blob], e.name));
      }
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return entries.length;
    })()`),
    /** Media element state for assertions (never screenshots: background windows don't repaint). */
    videoState: () => cdp.evaluate(`(() => {
      const v = document.getElementById("video-element");
      const q = v.getVideoPlaybackQuality?.();
      return { src: v.currentSrc, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, d: v.duration,
        paused: v.paused, ended: v.ended, frames: q ? q.totalVideoFrames : -1, err: v.error ? v.error.code : null,
        volume: v.volume, rate: v.playbackRate, filter: v.style.filter };
    })()`),
    toast: () => cdp.evaluate(`document.querySelector("#snapshot-toast span").textContent`),
    screenshot: (path) => cdp.screenshot(path),
    async close() {
      debug("close: start", proc.pid);
      // Graceful: close the window (the app exits with its last window), then make sure.
      try {
        await cdp.evaluate("__TAURI__.window.getCurrentWindow().close().then(() => true)", { timeoutMs: 3000 });
      } catch (e) {
        debug("close: window.close failed:", e.message);
      }
      cdp.close();
      if (!(await waitExit(proc, 5000))) {
        debug("close: still running, killing", proc.pid);
        proc.kill(); // our own child only
        await waitExit(proc, 5000);
      }
      debug("close: exited");
      // WebView2 helper processes may hold the profile for a moment after exit
      await sleep(300);
      await rm(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 })
        .catch((e) => debug("close: profile not removed:", e.message));
      debug("close: done");
    },
  };
  return app;
}
