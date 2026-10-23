// ==========================================================================
// Application event bus (EventTarget based, synchronous dispatch).
// Events used today:
//   "media:loading" { item, kind }   a new playlist item starts loading
//   "media:loaded"  { kind }         first frame / image decoded
//   "media:time"    { time }         video time advanced (timeupdate)
//   "playlist:changed" {}            playlist content or current index changed
// ==========================================================================

export function createEventBus() {
  const target = new EventTarget();
  const wrapped = new Map(); // type -> WeakMap(handler -> listener), so off() works

  return {
    on(type, handler) {
      const listener = (e) => handler(e.detail);
      if (!wrapped.has(type)) wrapped.set(type, new WeakMap());
      wrapped.get(type).set(handler, listener);
      target.addEventListener(type, listener);
      return () => this.off(type, handler);
    },
    off(type, handler) {
      const listener = wrapped.get(type)?.get(handler);
      if (listener) target.removeEventListener(type, listener);
      wrapped.get(type)?.delete(handler);
    },
    emit(type, detail = {}) {
      target.dispatchEvent(new CustomEvent(type, { detail }));
    },
  };
}
