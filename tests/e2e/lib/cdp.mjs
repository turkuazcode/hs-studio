// Minimal Chrome DevTools Protocol client (Node 24 built-in WebSocket + fetch).
// Drives the WebView2 page of vho.exe started with --remote-debugging-port.
import { writeFile } from "node:fs/promises";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a "page" target on the debug port and opens a session to it. */
export async function connectCdp(port, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  let lastError = null;
  while (!page) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
      const targets = await res.json();
      page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? null;
    } catch (e) {
      lastError = e;
    }
    if (!page) {
      if (Date.now() > deadline) throw new Error(`no CDP page on port ${port}: ${lastError?.message ?? "none"}`);
      await sleep(250);
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
  });
  return new CdpSession(ws);
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, method }
    this.listeners = new Map(); // event -> Set<fn>
    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`CDP connection closed during ${p.method}`));
      }
      this.pending.clear();
    });
  }

  #onMessage(ev) {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    }
  }

  /** Sends a CDP command; rejects after timeoutMs. */
  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout (${timeoutMs} ms) waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  /**
   * Evaluates an expression in the page (promises are awaited) and returns its JSON value.
   * Keep it short: start long work, store the result in a window variable and poll it.
   */
  async evaluate(expression, { timeoutMs = 15000 } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      // A rejected Tauri invoke carries a plain string (no description): show it, not just
      // "Uncaught (in promise)", so a failing backend call names its error in the test log
      const reason = d.exception?.description ?? (d.exception && "value" in d.exception ? JSON.stringify(d.exception.value) : null);
      throw new Error(`page exception: ${reason ? `${d.text} ${reason}` : d.text}`);
    }
    return r.result.value;
  }

  /**
   * Polls `expression` until it returns a truthy value (returned) or the timeout expires.
   * Evaluation errors (e.g. during a reload) count as "not yet".
   */
  async waitFor(expression, { timeoutMs = 10000, intervalMs = 100, message = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await this.evaluate(expression, { timeoutMs: Math.max(1000, Math.min(5000, deadline - Date.now())) });
        if (last) return last;
      } catch (e) {
        last = `error: ${e.message}`;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeoutMs} ms: ${message} (last value: ${JSON.stringify(last)})`);
      }
      await sleep(intervalMs);
    }
  }

  /** PNG screenshot (diagnostics only: a background window may not repaint). */
  async screenshot(path) {
    const r = await this.send("Page.captureScreenshot", { format: "png" }, 20000);
    await writeFile(path, Buffer.from(r.data, "base64"));
    return path;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
