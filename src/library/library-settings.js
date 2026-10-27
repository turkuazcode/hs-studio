// ==========================================================================
// Settings > Library (Plan 13/L02): library folders (add / rescan / remove) and the rare
// options (file watcher, periodic reconciliation). Kept out of the main screens.
// ==========================================================================

import { t } from "../core/i18n.js";
import { dialogOpen, listen } from "../core/tauri.js";
import { h } from "../ui/action-dialogs.js";

export const RECONCILE_MINUTES = [0, 15, 30, 60, 240];

const errText = (e) => String(e?.message ?? e).replace(/^\[[a-z-]+\]\s*/i, "");

export function registerLibrarySettings(app, api) {
  const s = app.settings;
  if (!s?.register || s.has("library.watch")) return;
  let listEl = null;

  async function renderFolders() {
    if (!listEl) return;
    let folders = [];
    try { folders = await api.folders(); } catch (e) { listEl.replaceChildren(h("p", { class: "vho-settings-hint", text: errText(e) })); return; }
    const rows = folders.map((f) => h("div", { class: "lib-set-folder", role: "listitem", "data-id": f.id, "data-status": f.status },
      h("div", { class: "lib-set-path" },
        h("span", { class: "lib-set-name", text: f.path, title: f.path }),
        h("small", { text: [t(`library.folderStatus.${f.status}`), t("library.count", { n: f.fileCount })].join(" · ") })),
      h("button", { type: "button", class: "btn-ghost btn-sm lib-set-rescan", text: t("library.rescan"), onclick: () => api.rescan(f.id).catch(() => {}) }),
      h("button", {
        type: "button", class: "btn-ghost btn-sm lib-set-remove", text: t("library.removeFolder"),
        onclick: async () => {
          const ok = app.dialogs?.confirm ? await app.dialogs.confirm({
            id: "vho-library-remove", title: t("library.removeFolder"), message: t("library.removeConfirm", { name: f.path }),
            confirmLabel: t("library.removeFolder"),
          }) : true;
          if (!ok) return;
          await api.removeFolder(f.id).catch((e) => app.toast?.(`⚠️ ${errText(e)}`));
          renderFolders();
          app.libraryView?.refreshFolders?.();
        },
      })));
    listEl.replaceChildren(...(rows.length ? rows : [h("p", { class: "vho-settings-hint", text: t("library.empty.noFolders") })]));
  }

  s.register("library", [
    {
      id: "library-folders", control: "custom",
      render(container) {
        listEl = h("div", { id: "library-folder-list", class: "lib-set-list", role: "list" });
        const add = h("button", {
          type: "button", id: "library-add-folder", class: "btn-secondary btn-sm", text: t("library.addFolder"), disabled: !dialogOpen,
          onclick: async () => {
            const picked = await dialogOpen?.({ directory: true, multiple: false }).catch(() => null);
            const p = Array.isArray(picked) ? picked[0] : picked;
            if (!p) return;
            try {
              const r = await api.addFolder(p);
              app.toast?.(t(`library.toast.folder.${r.status}`, { name: r.folder.path }));
            } catch (e) { app.toast?.(`⚠️ ${errText(e)}`); }
            renderFolders();
          },
        });
        container.append(h("p", { class: "vho-settings-hint", text: t("library.settingsIntro") }), listEl, add);
        renderFolders();
      },
    },
    { key: "library.watch", type: "boolean", default: true, control: "toggle", labelKey: "library.fields.watch" },
    {
      key: "library.reconcileMinutes", type: "enum", values: RECONCILE_MINUTES, default: 30, control: "select",
      labelKey: "library.fields.reconcile",
      options: RECONCILE_MINUTES.map((v) => ({ value: v, labelKey: v ? `library.reconcile.m${v}` : "library.reconcile.off" })),
    },
  ]);
  listen?.("library-scan", (e) => { if (e.payload?.state !== "running") renderFolders(); });
  listen?.("library-changed", (e) => { if (e.payload?.folders) renderFolders(); });
}
