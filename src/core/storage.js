// ==========================================================================
// localStorage helpers that never throw (private mode, blocked or full storage).
// ==========================================================================

export function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
