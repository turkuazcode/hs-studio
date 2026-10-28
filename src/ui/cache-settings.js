// ==========================================================================
// Settings > General > Cache (Plan 14 Q04): size of each regenerable cache and a separate
// "Clear" for each. Files in use (a converted video that is playing, a conversion still
// running) are kept by the backend. AI models are managed in Settings > AI models.
// ==========================================================================

import { t } from "../core/i18n.js";
import { invoke, isTauri } from "../core/tauri.js";
import { sizeText } from "../media/ai-status.js";

const KINDS = ["photo", "video", "transcode"];

export function registerCacheSettings(app) {
  if (!isTauri) return;
  app.settings.register("general", [
    {
      id: "cache", control: "custom", labelKey: "settings.fields.cache", helpKey: "settings.help.cache",
      render(container) {
        const list = document.createElement("div");
        list.className = "vho-cache-list";
        list.setAttribute("role", "list");
        container.append(list);
        refresh(list, app);
      },
    },
  ]);
}

async function refresh(list, app) {
  let usage = [];
  try {
    usage = await invoke("cache_usage");
  } catch (e) {
    console.warn("cache_usage", e);
  }
  list.replaceChildren(...KINDS.map((kind) => {
    const u = usage.find((x) => x.kind === kind) ?? { bytes: 0 };
    const row = document.createElement("div");
    row.className = "vho-cache-row";
    row.setAttribute("role", "listitem");
    const label = document.createElement("span");
    label.id = `cache-label-${kind}`;
    label.textContent = t("settings.cache.row", { what: t(`settings.cache.${kind}`), size: sizeText(u.bytes) });
    const b = document.createElement("button");
    b.type = "button";
    b.id = `setting-btn-cache-${kind}`;
    b.className = "btn-secondary btn-sm";
    b.textContent = t("settings.cache.clear");
    b.setAttribute("aria-describedby", label.id);
    b.disabled = !u.bytes;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const r = await invoke("cache_clear", { kind });
        app.toast(t(r.skipped ? "settings.cache.clearedSkipped" : "settings.cache.cleared", { size: sizeText(r.bytes), skipped: r.skipped }));
      } catch (e) {
        app.toast(`⚠️ ${e}`);
      }
      refresh(list, app);
    });
    row.append(label, b);
    return row;
  }));
}
