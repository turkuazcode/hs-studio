// ==========================================================================
// Music actions (Plan 06 §4): tag editor (title, artist, album, year, genre, track, disc,
// comment, embedded lyrics, cover art: change / remove / save) and the lyrics panel
// (.lrc side file or embedded lyrics; LRC lines follow the playback, click = seek).
// Tags are written by the backend (lofty); the playing file is released first.
// ==========================================================================

import { t } from "../core/i18n.js";
import { dialogOpen, invoke } from "../core/tauri.js";
import { errorText, splitName } from "../media/actions-logic.js";
import { lineIndexAt, parseLrc } from "../media/lyrics.js";
import { field, h } from "./action-dialogs.js";

const dialogSave = globalThis.window?.__TAURI__?.dialog?.save ? (o) => globalThis.window.__TAURI__.dialog.save(o) : undefined;

const TEXT_FIELDS = ["title", "artist", "album", "albumArtist", "genre", "year", "track", "trackTotal", "disc", "comment"];

/**
 * app: { dialogs, bus, engine, settings, toast }
 * current(): { item, kind }; withReleased(fn): runs fn while the file is not open in the player.
 */
export function createMusicTools(app, current, { withReleased }) {
  // ------------------------------------------------------------------------
  // Tag editor
  // ------------------------------------------------------------------------
  async function openTags() {
    const { item } = current();
    if (!item?.path) return;
    let data;
    try {
      data = await invoke("tags_read", { path: item.path });
    } catch (e) {
      app.toast(`⚠️ ${errorText(e)}`);
      return;
    }
    const inputs = {};
    const mk = (name, type = "text") => {
      const v = data[name];
      inputs[name] = h("input", { id: `vho-tag-${name}`, class: "modal-input", type, value: v === null || v === undefined ? "" : String(v) });
      return field(t(`actions.tags.${name}`), inputs[name]);
    };
    const lyrics = h("textarea", { id: "vho-tag-lyrics", class: "modal-input vho-act-textarea", rows: 5, spellcheck: "false" });
    lyrics.value = data.lyrics ?? "";
    let coverPath = null;
    let removeCover = false;
    const coverImg = h("img", { id: "vho-tag-cover-img", class: "vho-tag-cover-img", alt: "" });
    const coverNote = h("small", { class: "vho-act-hint" });
    const showCover = () => {
      const has = !removeCover && (coverPath || data.cover);
      coverImg.hidden = !(data.cover?.dataUrl && !coverPath && !removeCover);
      if (!coverImg.hidden) coverImg.src = data.cover.dataUrl;
      coverNote.textContent = coverPath ? t("actions.tags.coverNew", { name: coverPath.split(/[\\/]/).pop() })
        : removeCover ? t("actions.tags.coverRemoved") : has ? "" : t("actions.tags.noCover");
    };
    showCover();
    const coverBox = h("div", { class: "vho-tag-cover" }, coverImg, coverNote,
      h("div", { class: "vho-act-inline" },
        h("button", {
          type: "button", id: "vho-tag-cover-pick", class: "btn-secondary btn-sm", text: t("actions.tags.coverChange"),
          onclick: async () => {
            const p = await dialogOpen?.({ multiple: false, filters: [{ name: t("actions.tags.images"), extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "heic"] }] }).catch(() => null);
            const path = Array.isArray(p) ? p[0] : p;
            if (path) { coverPath = path; removeCover = false; showCover(); }
          },
        }),
        h("button", { type: "button", id: "vho-tag-cover-remove", class: "btn-ghost btn-sm", text: t("actions.tags.coverRemove"), onclick: () => { removeCover = true; coverPath = null; showCover(); } }),
        data.cover ? h("button", {
          type: "button", id: "vho-tag-cover-save", class: "btn-ghost btn-sm", text: t("actions.tags.coverSave"),
          onclick: async () => {
            const stem = splitName(item.name).stem;
            const out = await dialogSave?.({ defaultPath: `${stem}-kapak.jpg`, filters: [{ name: t("actions.tags.images"), extensions: ["jpg", "png"] }] }).catch(() => null);
            if (!out) return;
            invoke("tags_save_cover", { path: item.path, output: out })
              .then((p) => app.toast(t("actions.toast.saved", { name: p.split(/[\\/]/).pop() })))
              .catch((e) => app.toast(`⚠️ ${errorText(e)}`));
          },
        }) : null));

    const tech = [data.tagType, data.duration ? `${Math.round(data.duration)} sn` : "", data.bitrate ? `${data.bitrate} kb/s` : "",
      data.sampleRate ? `${data.sampleRate} Hz` : "", data.replaygainTrackGain ? `ReplayGain ${data.replaygainTrackGain}` : ""].filter(Boolean).join(" · ");
    app.dialogs.open({
      id: "vho-tags", title: t("actions.tags.dialogTitle"), wide: true, className: "vho-tags-dialog",
      body: h("div", { class: "vho-tags-layout" },
        h("div", { class: "vho-tags-fields" },
          mk("title"), mk("artist"), mk("album"), mk("albumArtist"),
          h("div", { class: "vho-act-row" }, mk("year"), mk("genre")),
          h("div", { class: "vho-act-row" }, mk("track"), mk("trackTotal"), mk("disc")),
          mk("comment"), field(t("actions.tags.lyrics"), lyrics)),
        h("div", { class: "vho-tags-side" }, coverBox, h("small", { class: "vho-act-hint", text: tech }))),
      actions: [
        { id: "cancel", label: t("actions.common.cancel"), cancel: true },
        {
          id: "ok", label: t("actions.tags.save"), primary: true,
          run: async (dlg) => {
            const update = {};
            for (const name of TEXT_FIELDS) {
              const before = data[name] === null || data[name] === undefined ? "" : String(data[name]);
              if (inputs[name].value.trim() !== before) update[name] = inputs[name].value.trim();
            }
            if (lyrics.value !== (data.lyrics ?? "")) update.lyrics = lyrics.value;
            if (coverPath) update.cover = coverPath;
            if (removeCover) update.removeCover = true;
            if (!Object.keys(update).length) return true;
            dlg.setBusy(true);
            dlg.setStatus(t("actions.tags.saving"));
            try {
              await withReleased(() => invoke("tags_write", { path: item.path, tags: update }));
              app.toast(t("actions.toast.tagsSaved"));
              app.bus?.emit?.("file:changed", { path: item.path });
              return true;
            } catch (e) {
              dlg.setBusy(false);
              dlg.setStatus(errorText(e), "error");
              return false;
            }
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------------
  // Lyrics panel
  // ------------------------------------------------------------------------
  let panel = null; // { el, lines, list, current, off }

  function closeLyrics() {
    if (!panel) return false;
    panel.off?.();
    panel.el.remove();
    panel = null;
    document.documentElement.classList.remove("lyrics-open");
    return true;
  }

  function highlight(index) {
    if (!panel || index === panel.current) return;
    panel.list.querySelector(".is-current")?.classList.remove("is-current");
    panel.current = index;
    panel.el.dataset.current = String(index);
    const li = panel.list.children[index];
    if (li) {
      li.classList.add("is-current");
      li.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function showLyrics({ quiet = false } = {}) {
    const { item } = current();
    if (!item?.path) return;
    let res = null;
    try {
      res = await invoke("lyrics_read", { path: item.path });
    } catch (e) {
      console.warn("lyrics", e);
    }
    closeLyrics();
    if (!res && quiet) return;
    const parsed = parseLrc(res?.text ?? "");
    const list = h("ol", { class: "vho-lyrics-list" });
    for (const l of parsed.lines) {
      const li = h("li", { class: "vho-lyric-line" });
      li.textContent = l.text || "♪";
      if (parsed.synced) {
        li.dataset.time = String(l.time);
        li.addEventListener("click", () => { app.engine.seek(l.time); app.hud?.poke?.(); });
      }
      list.append(li);
    }
    const el = h("aside", { id: "vho-lyrics", class: `vho-lyrics${parsed.synced ? " is-synced" : ""}`, "data-source": res?.source ?? "none", "aria-label": t("actions.lyrics.title") },
      h("header", {},
        h("strong", { text: parsed.meta.ti || t("actions.lyrics.title") }),
        h("small", { text: res ? t(`actions.lyrics.source.${res.source}`) : "" }),
        h("button", { type: "button", id: "vho-lyrics-close", class: "btn-icon-close", title: t("actions.common.close"), text: "✕", onclick: () => closeLyrics() })),
      parsed.lines.length ? list : h("p", { class: "vho-lyrics-empty", text: t("actions.lyrics.none") }));
    document.getElementById("viewport").append(el);
    document.documentElement.classList.add("lyrics-open");
    panel = { el, list, lines: parsed.lines, current: -1, path: item.path };
    if (parsed.synced) {
      const off = app.bus.on("media:time", ({ time }) => highlight(lineIndexAt(parsed.lines, time)));
      panel.off = off;
      highlight(lineIndexAt(parsed.lines, app.engine.time ?? 0));
    }
  }

  const toggleLyrics = () => (panel ? closeLyrics() : showLyrics());

  // Follow the playlist: reload for the next song, close for other media
  app.bus?.on?.("media:loading", ({ item }) => {
    const kind = current().kind;
    if (!item?.path || item.isImage) { closeLyrics(); return; }
    if (panel && panel.path !== item.path) setTimeout(() => (current().kind === "music" ? showLyrics({ quiet: false }) : closeLyrics()), 0);
    else if (!panel && kind !== "photo" && app.settings?.get?.("actions.lyricsAuto")) setTimeout(() => current().kind === "music" && showLyrics({ quiet: true }), 300);
  });

  return { openTags, toggleLyrics, showLyrics, closeLyrics, get lyricsOpen() { return !!panel; } };
}
