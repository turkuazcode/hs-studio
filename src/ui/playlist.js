// ==========================================================================
// Playlist drawer: rendering, selection, prev/next (wrapping) and auto-advance.
// Items are { name, isImage } plus exactly one of:
//   file (browser File), path (local file via Tauri asset protocol), url (network).
// ==========================================================================

import { itemSize } from "../media/classify.js";

/** Index after moving by step, wrapping at both ends; -1 for an empty list. */
export function wrapIndex(current, step, length) {
  if (!length) return -1;
  let next = current + step;
  if (next < 0) next = length - 1;
  if (next >= length) next = 0;
  return next;
}

/** Auto-advance at the end of a video: only when a later item exists. */
export const hasNextItem = (index, length) => length > 0 && index >= 0 && index < length - 1;

/** Meta text under a playlist entry. */
export function itemMetaText(item) {
  if (item.url) return "Ağ Akışı";
  // Browser File or local file from the backend (dialog / native drop / command line)
  return `${(itemSize(item) / 1048576).toFixed(1)} MB`;
}

/**
 * app: { dom, state, loader, photo }  (resolved lazily)
 */
export function createPlaylist(app) {
  const { dom, state } = app;
  const {
    playlistDrawer, btnTogglePlaylist, btnClosePlaylist, btnPlaylistAdd, btnPlaylistClear, playlistItemsList,
    playlistCountBadge, playlistTotalText, playlistFileInput,
  } = dom;
  const items = () => state.get("playlist");
  // What the drawer currently shows: lets navigation only move the "active" mark
  // instead of rebuilding thousands of entries (photo studio folder sessions)
  let rendered = { list: null, length: -1 };

  function markActive() {
    const playlist = items();
    if (rendered.list !== playlist || rendered.length !== playlist.length) return renderPlaylist();
    playlistItemsList.querySelector("li.active")?.classList.remove("active");
    playlistItemsList.querySelector(`li[data-idx="${state.get("currentPlaylistIndex")}"]`)?.classList.add("active");
    app.photo.updateCounter();
  }

  function renderPlaylist() {
    const playlist = items();
    rendered = { list: playlist, length: playlist.length };
    const currentIndex = state.get("currentPlaylistIndex");
    playlistCountBadge.textContent = playlist.length;
    playlistTotalText.textContent = `${playlist.length} Medya`;

    if (!playlist.length) {
      const empty = document.createElement("li");
      empty.className = "playlist-empty";
      empty.append("Listeniz boş.", document.createElement("br"), "Video veya fotoğraf dosyalarını buraya sürükleyin.");
      playlistItemsList.replaceChildren(empty);
      app.photo.updateCounter();
      return;
    }

    const frag = document.createDocumentFragment();
    playlist.forEach((item, idx) => {
      const li = document.createElement("li");
      li.className = "playlist-item" + (idx === currentIndex ? " active" : "");
      li.dataset.idx = idx;

      const badge = document.createElement("span");
      badge.className = `type-badge ${item.isImage ? "is-photo" : "is-video"}`;
      badge.textContent = item.isImage ? "FOTO" : "VİDEO";

      const name = document.createElement("div");
      name.className = "item-name";
      name.title = item.name;
      name.append(badge, `${idx + 1}. ${item.name}`); // text node: no HTML injection

      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = itemMetaText(item);

      const info = document.createElement("div");
      info.className = "item-info";
      info.append(name, meta);
      li.append(info);
      frag.append(li);
    });
    playlistItemsList.replaceChildren(frag);
    app.photo.updateCounter();
  }

  function playPlaylistItem(index) {
    const playlist = items();
    if (index < 0 || index >= playlist.length) return;
    state.set("currentPlaylistIndex", index);
    app.loader.loadMediaSource(playlist[index]);
    markActive();
  }

  function navigatePlaylist(step) {
    const playlist = items();
    if (!playlist.length) return;
    playPlaylistItem(wrapIndex(state.get("currentPlaylistIndex"), step, playlist.length));
  }

  /** Appends items; returns the index of the first new one. */
  function append(newItems) {
    const playlist = items();
    const firstNewIndex = playlist.length;
    playlist.push(...newItems);
    return firstNewIndex;
  }

  btnTogglePlaylist.addEventListener("click", () => {
    playlistDrawer.classList.toggle("open");
  });

  btnClosePlaylist.addEventListener("click", () => {
    playlistDrawer.classList.remove("open");
  });

  btnPlaylistAdd.addEventListener("click", () => {
    app.loader.pickFiles(playlistFileInput, { playFirstNew: false });
  });

  btnPlaylistClear.addEventListener("click", () => {
    app.photo.toggleSlideshow(false, { silent: true });
    state.set("playlist", []);
    state.set("currentPlaylistIndex", -1);
    renderPlaylist();
  });

  playlistItemsList.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-idx]");
    if (li) playPlaylistItem(Number(li.dataset.idx));
  });

  return {
    render: renderPlaylist,
    play: playPlaylistItem,
    navigate: navigatePlaylist,
    append,
    /** Called when a video ends; returns true if the next item started. */
    playNextOnEnd() {
      const index = state.get("currentPlaylistIndex");
      if (!hasNextItem(index, items().length)) return false;
      playPlaylistItem(index + 1);
      return true;
    },
    toggleDrawer: () => playlistDrawer.classList.toggle("open"),
    openDrawer: () => playlistDrawer.classList.add("open"),
  };
}
