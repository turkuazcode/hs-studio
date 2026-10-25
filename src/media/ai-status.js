// ==========================================================================
// AI component status helpers (pure: no Tauri / DOM, unit-tested).
// The backend (src-tauri/src/ai) reports components with a state and coded errors; the user
// text always comes from i18n (aiModels.*), never from the backend's technical detail.
// ==========================================================================

export const ERROR_CODES = Object.freeze([
  "unknown-component", "not-installed", "download-network", "checksum", "disk-full", "permission",
  "cancelled", "license-unavailable", "in-use", "busy", "archive-invalid", "io",
]);

/** Backend error ({ code, detail } or string) -> Error with .code/.detail and an i18n message. */
export function toAiError(e, t) {
  if (e instanceof Error) return e;
  const code = ERROR_CODES.includes(e?.code) ? e.code : "io";
  const err = new Error(t(`aiModels.errors.${code}`));
  err.code = code;
  err.detail = typeof e === "string" ? e : e?.detail ?? "";
  if (code === "cancelled") err.name = "AbortError";
  return err;
}

/** Whole megabytes, at least 1 (download sizes in dialogs). */
export const megabytes = (bytes) => Math.max(1, Math.round((bytes || 0) / 1048576));

/** Human size: "48.8 MB", "512 KB". */
export function sizeText(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * First-use consent text for the components that still need a download (null if none):
 * total size, then title / author / license / size of each, then where to manage them.
 */
export function consentText(statuses, t) {
  const missing = statuses.filter((st) => !st.installed);
  if (!missing.length) return null;
  const total = missing.reduce((sum, st) => sum + (st.downloadBytes || 0), 0);
  const lines = missing.map((st) => t("aiModels.consent.item", {
    title: st.title, author: st.author, license: st.license, mb: megabytes(st.downloadBytes),
  }));
  return [
    t("aiModels.consent.intro", { mb: megabytes(total) }), "", ...lines, "",
    t("aiModels.consent.manage"), "", t("aiModels.consent.question"),
  ].join("\n");
}

/**
 * What the Settings > AI models row offers for a status: the state label key and the
 * buttons (install / cancel / verify / repair / remove) in display order.
 */
export function componentActions(st, { busy = false } = {}) {
  if (busy || st.state === "downloading") return ["cancel"];
  switch (st.state) {
    case "missing": return ["install"];
    case "partial": return ["install", "remove"];
    case "corrupt": return ["repair", "remove"];
    case "installed":
    case "ready": return st.inUse ? ["verify"] : ["verify", "remove"];
    default: return [];
  }
}

/** Progress fraction (0..1) of a status/event, or null when unknown. */
export function progressFraction(p) {
  if (!p || !(p.total > 0)) return null;
  return Math.min(1, Math.max(0, p.done / p.total));
}
