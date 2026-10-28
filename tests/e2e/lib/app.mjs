// Starts / stops vho.exe for E2E tests and wraps the CDP session with app helpers.
//
// Isolation: every launch gets its own WebView2 profile (WEBVIEW2_USER_DATA_FOLDER) and its
// own data folder (VHO_DATA_DIR: settings.json, library.json, window state), so tests never
// see or change the user's settings / resume positions. VHO_DATA_DIR also scopes the
// single-instance lock, so a test VHO never forwards files to the user's own VHO (or
// another agent's). Only the process started here is ever stopped.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, sleep } from "./cdp.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
export const fixture = (name) => join(FIXTURES, name);

/** CDP ports reserved for VHO tests (override: VHO_E2E_PORT_MIN / VHO_E2E_PORT_MAX). */
const PORT_MIN = Number(process.env.VHO_E2E_PORT_MIN) || 9500;
const PORT_MAX = Number(process.env.VHO_E2E_PORT_MAX) || 9599;

/** Name of the built app binary: tauri.conf.json `mainBinaryName` ("HS Studio"), else the crate name. */
export function appBinaryName() {
  const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const base = conf.mainBinaryName || "vho";
  return process.platform === "win32" ? `${base}.exe` : base;
}

export function defaultExe() {
  return process.env.VHO_EXE || join(REPO_ROOT, "src-tauri", "target", "release", appBinaryName());
}

function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => res(true)));
  });
}

/** A free port in the reserved range, starting at a random offset (parallel runs by other agents). */
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

// The app's default language setting ("system") follows navigator.languages. The tests assert
// the Turkish UI, so the system languages are Turkish whatever the machine's language is (the
// GitHub runner is en-US). Explicit language settings (i18n test) still win.
const TURKISH_SYSTEM = `
  Object.defineProperty(Navigator.prototype, "languages", { configurable: true, get: () => Object.freeze(["tr-TR", "tr"]) });
  Object.defineProperty(Navigator.prototype, "language", { configurable: true, get: () => "tr-TR" });
`;

/**
 * SAFETY: commands that must never reach the backend from a test. suspend_system would put
 * the real PC to sleep (the sleep timer's "PC Uyku" box is checked by default);
 * set_compat_mode would restart the app.
 *
 * Layer 1 (backend): vho.exe gets VHO_DISABLE_SYSTEM_SUSPEND=1, suspend_system is a no-op.
 * Layer 2 (page): before any page script runs, window.__TAURI__.core is replaced by a copy
 * whose invoke() answers the blocked commands itself (core is a frozen namespace, but the
 * property holding it is writable). The app captures invoke at import time, so the guard is
 * verified after boot by the app's own initial_files call showing up in the guard's log.
 */
const BLOCKED_COMMANDS = ["suspend_system", "set_compat_mode"];

const INVOKE_GUARD = `
  (() => {
    const BLOCKED = ${JSON.stringify(BLOCKED_COMMANDS)};
    window.__invokeLog = [];
    window.__blockedCalls = [];
    const wrap = (t) => {
      if (!t || !t.core || !t.core.invoke || t.core.invoke.__vhoGuard) return t;
      const real = t.core.invoke;
      const guarded = function (cmd, ...rest) {
        __invokeLog.push(cmd);
        if (BLOCKED.includes(cmd)) {
          __blockedCalls.push(cmd);
          return Promise.resolve(null);
        }
        return real.call(this, cmd, ...rest);
      };
      guarded.__vhoGuard = true;
      t.core = Object.freeze({ ...t.core, invoke: guarded });
      return t;
    };
    if (window.__TAURI__) {
      wrap(window.__TAURI__);
    } else {
      let value;
      Object.defineProperty(window, "__TAURI__", {
        configurable: true, enumerable: true,
        get: () => value,
        set: (v) => { value = wrap(v); },
      });
    }
  })();
`;

/** Throws unless every backend call of the app goes through the guard. */
async function verifyGuard(cdp) {
  const ok = await cdp.evaluate(`window.__TAURI__.core.invoke.__vhoGuard === true &&
    Array.isArray(window.__invokeLog) && window.__invokeLog.includes("initial_files")`);
  if (!ok) throw new Error("SAFETY: invoke guard not effective; refusing to run tests that could suspend the PC");
}

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
/** Environment that hides the libmpv DLLs from the app: HTML5 fallback engine. */
export const HTML5_ENGINE = Object.freeze({ VHO_DISABLE_MPV: "1" });

/** True when the libmpv DLL set is staged next to the test executable (npm run stage:mpv). */
/** Same lookup locations as the backend (engine/mod.rs): next to the exe, exe\mpv\, resources\mpv\. */
export const mpvStaged = (exe = defaultExe()) =>
  ["", "mpv", join("resources", "mpv")].some((sub) => existsSync(join(dirname(exe), sub, "libmpv-2.dll")));

/**
 * Identifier of a test instance: platform.rs `test_identifier` appends
 * `.test<fnv1a-64(lowercase VHO_DATA_DIR)>` to the app identifier. Tauri derives the app's
 * own folders (%APPDATA%\<id>, %LOCALAPPDATA%\<id>) from it, so every test data dir leaves
 * its own pair behind unless the harness removes them (see removeIdentityDirs).
 */
export function testIdentity(dataDir) {
  const base = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8")).identifier;
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(String(dataDir).toLowerCase(), "utf8")) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `${base}.test${h.toString(16).padStart(16, "0")}`;
}

/** The per-identity app folders of a test data dir (only those that exist). */
export function identityDirs(dataDir) {
  const id = testIdentity(dataDir);
  if (!/^[a-z0-9.]+\.test[0-9a-f]{16}$/.test(id)) throw new Error(`unexpected test identity ${id}`);
  return [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map((root) => join(root, id)).filter((p) => existsSync(p));
}

/** Removes the %APPDATA% / %LOCALAPPDATA% folders this test data dir caused (never others). */
export async function removeIdentityDirs(dataDir) {
  for (const dir of identityDirs(dataDir)) await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 }).catch(() => {});
}

/** A temporary data folder for VHO_DATA_DIR that outlives one launch (restart tests). */
export const makeDataDir = () => mkdtemp(join(tmpdir(), "vho-e2e-data-"));
export const removeDir = (dir) => rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 400 }).catch(() => {});

/** Environment of a test vho.exe (also used for second-instance launches). */
export function appEnv({ port, userData, dataDir }) {
  return {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: userData,
    // Settings / library / window state / single-instance lock isolated from the user's VHO
    VHO_DATA_DIR: dataDir,
    // Backend guard: suspend_system becomes a no-op (never sleep the test machine)
    VHO_DISABLE_SYSTEM_SUSPEND: "1",
    // Backend guard (Plan 06): wallpaper / lock screen / share / print / open with / reveal in
    // folder are only logged (actions_system_log), never applied to the test machine
    VHO_DISABLE_SYSTEM_CHANGES: "1",
    // libmpv screenshots go to the throw-away profile, never to the user's Pictures folder
    VHO_SCREENSHOT_DIR: join(userData, "screenshots"),
    // Q04 path grants: tests open their temp copies through test hooks (not a real dialog / OS
    // drop), so the native "allow changes in this folder?" question is answered yes; the
    // security test runs with "deny"
    VHO_GRANT_PROMPT: "allow",
  };
}

/**
 * dataDir: reuse a data folder (e.g. to restart with the same settings); the caller removes
 * it. Without it a fresh folder inside the temporary WebView2 profile is used.
 * env: extra environment variables (e.g. HTML5_ENGINE).
 */
export async function launchApp({ args = [], exe = defaultExe(), dataDir, env: extraEnv = {} } = {}) {
  if (!existsSync(exe)) {
    throw new Error(`${exe} not found. Build it first: npm run build:release (or set VHO_EXE)`);
  }
  const port = await findFreePort();
  const userData = await mkdtemp(join(tmpdir(), "vho-e2e-"));
  const ownData = !dataDir;
  if (ownData) {
    dataDir = join(userData, "vho-data");
    await mkdir(dataDir, { recursive: true });
  }
  const env = { ...appEnv({ port, userData, dataDir }), ...extraEnv };
  const spawnedAt = performance.now();
  const proc = spawn(exe, args, { env, stdio: "ignore", windowsHide: false });
  // Milliseconds since spawn (bench:media startup budget): CDP reachable, first app document
  // complete (cold start, before the test reload), booted again after the reload
  const timings = {};
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
    timings.cdpMs = performance.now() - spawnedAt;
    debug("launch: CDP connected");
    await cdp.waitFor(appLoaded, { timeoutMs: 30000, intervalMs: 20, message: "app page loaded" });
    timings.loadedMs = performance.now() - spawnedAt;
    debug("launch: app page loaded");
    await cdp.send("Page.enable");
    // Turkish number / date formats (Intl, toLocaleString) like on the developer machines
    await cdp.send("Emulation.setLocaleOverride", { locale: "tr-TR" }).catch((e) => debug("launch: no locale override:", e.message));
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INVOKE_GUARD + ERROR_COLLECTOR + TEST_STUBS + TURKISH_SYSTEM });
    // Reload so the collector also sees module loading / boot. initial_files is re-read
    // from the command line, so a media argument is opened again.
    await cdp.evaluate("window.__beforeReload = true");
    await cdp.send("Page.reload", { ignoreCache: true });
    // Module scripts and the DOMContentLoaded bootstrap have run once readyState is "complete"
    await cdp.waitFor(`!window.__beforeReload && Array.isArray(window.__errs) && ${appLoaded}`, {
      timeoutMs: 20000, message: "app boot after reload",
    });
    timings.rebootedMs = performance.now() - spawnedAt;
    debug("launch: booted after reload");
    // initial_files is the app's own boot call: wait for it, then prove it went through the guard
    await cdp.waitFor(`Array.isArray(window.__invokeLog) && window.__invokeLog.includes("initial_files")`, {
      timeoutMs: 10000, message: "app boot IPC (initial_files)",
    }).catch(() => {});
    await verifyGuard(cdp);
    debug("launch: system guard verified");
  } catch (e) {
    cdp?.close();
    proc.kill();
    await waitExit(proc, 5000);
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
    await removeIdentityDirs(dataDir);
    throw e;
  }

  const app = {
    proc,
    port,
    cdp,
    userData,
    dataDir,
    env,
    exe,
    timings,
    /** Backend commands the guard answered instead of the app (e.g. ["suspend_system"]). */
    blockedCalls: () => cdp.evaluate("window.__blockedCalls"),
    /** Re-checks the invoke guard (throws if a call could reach the backend unseen). */
    verifyGuard: () => verifyGuard(cdp),
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
      // %APPDATA% / %LOCALAPPDATA%\<identifier>.test<hash> of this data dir (recreated if the
      // same data dir is launched again, e.g. restart tests)
      await removeIdentityDirs(dataDir);
      debug("close: done");
    },
  };
  return app;
}
