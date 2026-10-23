// ==========================================================================
// Thumbnail service on top of photo_thumbs / photo-thumb events.
// One listener for the whole app; callers ask per "channel" (grid, strip...)
// and a new request on a channel cancels the stale one (fast scrolling).
// ==========================================================================

export const THUMB_SIZE = 256;

/**
 * deps: { invoke, listen, convertFileSrc }
 * Returns { get(path), request(channel, paths), onThumb(fn) -> unsubscribe, forget(path) }.
 * Thumbnails are reported as fn(path, url|null, error).
 */
export function createThumbService({ invoke, listen, convertFileSrc }, size = THUMB_SIZE) {
  const cache = new Map();      // path -> url | null (failed)
  const errors = new Map();     // path -> error text
  const pending = new Map();    // path -> requestId
  const channels = new Map();   // channel -> requestId
  const subs = new Set();
  let seq = 0;

  const ready = Promise.resolve(listen?.("photo-thumb", (e) => {
    const { requestId, path, thumb, error } = e.payload;
    if (pending.get(path) !== requestId) return;
    pending.delete(path);
    const url = thumb ? convertFileSrc(thumb.path) : null;
    cache.set(path, url);
    if (!thumb) errors.set(path, error ?? "");
    for (const fn of subs) fn(path, url, error);
  })).catch((e) => console.warn("photo-thumb listen", e));

  async function request(channel, paths) {
    if (!invoke) return;
    const wanted = paths.filter((p) => !cache.has(p) && !pending.has(p));
    const previous = channels.get(channel);
    if (!wanted.length) return;
    if (previous) {
      invoke("photo_cancel", { id: previous }).catch(() => {});
      for (const [p, id] of pending) if (id === previous) pending.delete(p);
      // Paths the stale request still owed are asked again below if still visible
    }
    const requestId = `${channel}-${++seq}`;
    channels.set(channel, requestId);
    const again = paths.filter((p) => !cache.has(p) && !pending.has(p));
    for (const p of again) pending.set(p, requestId);
    await ready;
    try {
      await invoke("photo_thumbs", { requestId, paths: again, size });
    } catch (e) {
      console.warn("photo_thumbs", e);
    } finally {
      for (const [p, id] of pending) if (id === requestId) pending.delete(p);
      if (channels.get(channel) === requestId) channels.delete(channel);
    }
  }

  return {
    size,
    get: (path) => cache.get(path),
    has: (path) => cache.has(path),
    error: (path) => errors.get(path),
    request,
    onThumb(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Drops a cached thumbnail (file was edited). */
    forget(path) {
      cache.delete(path);
      errors.delete(path);
    },
  };
}
