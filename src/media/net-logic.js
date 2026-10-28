// ==========================================================================
// Network streams and casting (Plan 13/L04): pure helpers, unit tested
// (tests/unit/net-logic.test.mjs). No DOM, no Tauri.
// Same rules as the backend (src-tauri/src/net.rs): http/https only; user:password@ and
// token-like query values are secrets and never shown, logged or stored in recent files.
// ==========================================================================

export const STREAM_SCHEMES = ["http:", "https:"];

const SECRET_EXACT = new Set(["key", "sig", "auth", "code", "pwd", "pass", "jwt", "session", "sessionid", "sid", "hash", "hdnts", "hdnea", "policy"]);
const SECRET_PART = ["token", "secret", "password", "signature", "credential", "apikey", "api_key", "auth"];

export const isSecretParam = (name) => {
  const n = String(name).toLowerCase();
  return SECRET_EXACT.has(n) || SECRET_PART.some((p) => n.includes(p));
};

/** Parsed URL when it is an allowed stream URL, else null. */
export function parseStreamUrl(url) {
  const s = String(url ?? "").trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(s);
    return STREAM_SCHEMES.includes(u.protocol) && u.hostname ? u : null;
  } catch (_) {
    return null;
  }
}

/** The URL carries a password or a token (it is then not kept in recent files). */
export function hasSecret(url) {
  const u = parseStreamUrl(url);
  if (!u) return false;
  if (u.username || u.password) return true;
  return [...u.searchParams.keys()].some(isSecretParam);
}

/** Display / log form: user:password@ and secret query values replaced by ***. */
export function redactUrl(url) {
  const u = parseStreamUrl(url);
  if (!u) return String(url ?? "");
  const auth = u.username || u.password ? "***@" : "";
  const query = [...u.searchParams.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${isSecretParam(k) ? "***" : encodeURIComponent(v)}`).join("&");
  return `${u.protocol}//${auth}${u.host}${u.pathname}${query ? `?${query}` : ""}${u.hash}`;
}

/** Title shown for a stream: the radio's ICY title ("Artist - Song") after the stream name. */
export function streamTitle(name, icyTitle) {
  const icy = String(icyTitle ?? "").trim();
  return icy ? `${name} — ${icy}` : name;
}

/** i18n key for a coded cast error (`[cast-format] …`), null for unknown codes. */
export function castErrorKey(code) {
  return {
    "cast-format": "cast.error.format",
    "cast-unreachable": "cast.error.unreachable",
    "cast-timeout": "cast.error.unreachable",
    "cast-device-gone": "cast.error.gone",
    "cast-rejected": "cast.error.rejected",
    "cast-network": "cast.error.network",
    "cast-file": "cast.error.file",
    "cast-inactive": "cast.error.inactive",
  }[code] ?? null;
}

/** UPnP transport state -> i18n key. */
export function castStateKey(state) {
  return {
    PLAYING: "cast.state.playing",
    PAUSED_PLAYBACK: "cast.state.paused",
    STOPPED: "cast.state.stopped",
    TRANSITIONING: "cast.state.loading",
    NO_MEDIA_PRESENT: "cast.state.stopped",
  }[state] ?? "cast.state.loading";
}

/**
 * The renderer has not fetched the file a while after the start: most often the firewall
 * blocks the inbound connection (the app never changes the firewall itself).
 */
export const castLooksBlocked = (status, sinceMs) =>
  !!status?.active && status.requests === 0 && sinceMs >= 10000 && status.state !== "PLAYING";
