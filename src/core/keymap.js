// ==========================================================================
// Keyboard shortcut table logic (pure): combos, user overrides, conflict detection.
// A combo is "Ctrl+Alt+Shift+<KeyboardEvent.code>" with modifiers in that fixed order,
// e.g. "Space", "Shift+ArrowLeft", "Ctrl+KeyO". Meta (Cmd) counts as Ctrl.
// Scopes: "global" (always), "video" (video/none mode), "photo" (photo mode).
// ==========================================================================

export const SCOPES = ["global", "video", "photo"];
const MODIFIERS = ["Ctrl", "Alt", "Shift"];
const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

/** Canonical form of a combo string (modifier order, aliases). Null when empty/invalid. */
export function normalizeCombo(combo) {
  if (typeof combo !== "string" || !combo.trim()) return null;
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const mods = new Set();
  let code = null;
  for (const p of parts) {
    const m = { ctrl: "Ctrl", control: "Ctrl", meta: "Ctrl", cmd: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" }[p.toLowerCase()];
    if (m) mods.add(m);
    else if (code === null) code = p;
    else return null; // two non-modifier keys
  }
  if (!code || MODIFIER_CODES.test(code)) return null;
  return [...MODIFIERS.filter((m) => mods.has(m)), code].join("+");
}

/** KeyboardEvent -> combo, or null for a lone modifier key. */
export function comboFromEvent(e) {
  if (!e?.code || MODIFIER_CODES.test(e.code)) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, e.code].join("+");
}

export const scopesOverlap = (a, b) => a === b || a === "global" || b === "global";

/** Valid user override for an action: array of unique normalized combos (may be empty = unbound). */
export function sanitizeKeys(keys) {
  if (!Array.isArray(keys)) return null;
  const out = [];
  for (const k of keys) {
    const c = normalizeCombo(k);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** actions: [{ id, scope, keys }], overrides: { id: [combo] } -> Map(id -> [combo]). */
export function effectiveBindings(actions, overrides = {}) {
  const map = new Map();
  for (const a of actions) {
    const o = Object.hasOwn(overrides ?? {}, a.id) ? sanitizeKeys(overrides[a.id]) : null;
    map.set(a.id, o ?? (a.keys ?? []).map(normalizeCombo).filter(Boolean));
  }
  return map;
}

/**
 * Same combo bound to two actions whose scopes overlap.
 * Returns [{ combo, ids: [idA, idB] }] (each pair once).
 */
export function findConflicts(actions, overrides = {}) {
  const bindings = effectiveBindings(actions, overrides);
  const out = [];
  for (let i = 0; i < actions.length; i++) {
    for (let j = i + 1; j < actions.length; j++) {
      const a = actions[i], b = actions[j];
      if (!scopesOverlap(a.scope, b.scope)) continue;
      const bk = bindings.get(b.id);
      for (const combo of bindings.get(a.id)) {
        if (bk.includes(combo)) out.push({ combo, ids: [a.id, b.id] });
      }
    }
  }
  return out;
}

/** Conflicts that assigning `keys` to `actionId` would create (ids of the other actions). */
export function conflictsFor(actions, overrides, actionId, keys) {
  const next = { ...(overrides ?? {}), [actionId]: keys };
  return findConflicts(actions, next)
    .filter((c) => c.ids.includes(actionId))
    .map((c) => ({ combo: c.combo, id: c.ids[0] === actionId ? c.ids[1] : c.ids[0] }));
}

/**
 * Action for a combo in a mode ("video" | "photo"). Without an exact match a Shift
 * combo falls back to the unshifted key (Shift+F = F, as before the table existed).
 */
export function resolveAction(actions, bindings, combo, mode) {
  const find = (c) => actions.find((a) => (a.scope === "global" || a.scope === mode) && bindings.get(a.id)?.includes(c));
  let hit = find(combo);
  if (!hit && combo?.includes("Shift+")) hit = find(combo.replace("Shift+", ""));
  return hit ?? null;
}

const KEY_NAMES = {
  Space: "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Equal: "=", Minus: "-", NumpadAdd: "Num +", NumpadSubtract: "Num -", Escape: "Esc",
  Slash: "/", Comma: ",", Period: ".", Backquote: "`", Enter: "Enter", Backspace: "⌫",
  PageUp: "PgUp", PageDown: "PgDn", Delete: "Del",
};

/** "Shift+KeyR" -> "Shift + R" (names: { Space: "Boşluk", Ctrl: "Ctrl", ... } overrides). */
export function formatCombo(combo, names = {}) {
  if (!combo) return "";
  return combo.split("+").map((p) => {
    if (names[p]) return names[p];
    if (/^Key[A-Z]$/.test(p)) return p.slice(3);
    if (/^Digit\d$/.test(p)) return p.slice(5);
    if (/^Numpad\d$/.test(p)) return `Num ${p.slice(6)}`;
    return KEY_NAMES[p] ?? p;
  }).join(" + ");
}
