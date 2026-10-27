// Accessibility helpers for the E2E layer (Q03): axe-core audits inside the app's webview
// and keyboard focus checks. axe-core (MPL-2.0) is a dev dependency only — injected through
// CDP into the test instance, never bundled with the app.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

/** WCAG 2.1 A/AA rule set; best-practice rules are reported separately (not gating). */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

export async function injectAxe(app) {
  if (await app.eval("typeof window.axe === 'object'")) return;
  await app.cdp.send("Runtime.evaluate", { expression: AXE_SOURCE, returnByValue: true });
  if (!(await app.eval("typeof window.axe === 'object'"))) throw new Error("axe-core did not load");
}

/**
 * Runs axe on `selector` (default: whole document) and returns a compact violation list
 * [{ id, impact, help, nodes: [selector...] }]. Hidden elements are not audited by axe.
 */
export async function audit(app, { selector = "document", tags = TAGS, disable = [] } = {}) {
  await injectAxe(app);
  const ctx = selector === "document" ? "document" : JSON.stringify(selector);
  return app.eval(`(async () => {
    const r = await axe.run(${ctx}, {
      runOnly: { type: "tag", values: ${JSON.stringify(tags)} },
      resultTypes: ["violations"],
      rules: Object.fromEntries(${JSON.stringify(disable)}.map((id) => [id, { enabled: false }])),
    });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 8).map((n) => n.target.join(" ") + (n.failureSummary ? " :: " + n.failureSummary.split("\\n").slice(1, 3).join(" ").trim() : "")) }));
  })()`, { timeoutMs: 60000 });
}

export const describeViolations = (v) => v.map((x) => `${x.impact} ${x.id} (${x.help}):\n    ${x.nodes.join("\n    ")}`).join("\n  ");

/** Presses Tab (or Shift+Tab) through CDP Input so the browser moves focus natively. */
export async function tab(app, { shift = false } = {}) {
  const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
  await app.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await app.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Native key press (Escape, Enter, Space...) through CDP Input. */
export async function press(app, key, { code = key, keyCode, modifiers = 0, text = { Enter: "\r", " ": " " }[key] } = {}) {
  // Enter / Space activate a focused button through the "char" (keypress) event, as a real key does
  const codes = { Escape: 27, Enter: 13, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const base = { key, code, windowsVirtualKeyCode: keyCode ?? codes[key] ?? 0, nativeVirtualKeyCode: keyCode ?? codes[key] ?? 0, modifiers };
  await app.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  if (text) await app.cdp.send("Input.dispatchKeyEvent", { type: "char", text, ...base });
  await app.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Description of the focused element: tag, id, name, whether a focus indicator is drawn. */
export const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== "none");
  const name = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent.trim().slice(0, 40) || el.getAttribute("placeholder") || "";
  return { tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0, 60), name, ring,
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden",
    inViewport: r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
    dialog: el.closest("[role=dialog], .modal-overlay, .vho-settings")?.id || null };
})()`;
