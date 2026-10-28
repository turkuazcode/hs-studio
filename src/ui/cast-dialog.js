// ==========================================================================
// "Cast to device…" (Plan 13/L04): UPnP/DLNA renderers on the local network.
// Opened from the "⋯" menu only; the search runs when the dialog opens (no background
// discovery). The renderer fetches the file from a short-lived, token-protected URL that
// closes on Stop. Backend: src-tauri/src/cast/*.
// ==========================================================================

import { t } from "../core/i18n.js";
import { invoke } from "../core/tauri.js";
import { errorCode, errorText } from "../media/actions-logic.js";
import { castErrorKey, castLooksBlocked, castStateKey } from "../media/net-logic.js";
import { h } from "./action-dialogs.js";

const POLL_MS = 2000;

export function createCast(app) {
  let session = null; // { id, name, item, startedAt }
  let lastStatus = null;

  const message = (e) => {
    const key = castErrorKey(errorCode(e));
    return key ? t(key, { detail: errorText(e) }) : errorText(e);
  };

  function open(item) {
    const list = h("ul", { id: "vho-cast-devices", class: "vho-cast-devices", role: "listbox", "aria-label": t("cast.devices") });
    const now = h("div", { id: "vho-cast-now", class: "vho-cast-now", hidden: true });
    const intro = h("p", { class: "vho-cast-intro", text: t("cast.intro") });
    const dlg = app.dialogs.open({ id: "vho-cast", title: t("cast.title"), body: [intro, list, now] });
    let timer = null;
    const stopPolling = () => { clearInterval(timer); timer = null; };
    const prevClose = dlg.close;
    dlg.close = (reason) => { stopPolling(); prevClose(reason); };

    async function search() {
      list.replaceChildren();
      list.dataset.state = "searching";
      dlg.setBusy(true);
      dlg.setStatus(t("cast.searching"));
      try {
        const devices = await invoke("cast_discover");
        if (dlg.closed) return;
        list.replaceChildren(...devices.map((d) => {
          const li = h("li", { role: "option", tabindex: "0", "data-id": d.id, class: "vho-cast-device" },
            h("strong", { text: d.name }), d.model ? h("small", { text: d.model }) : null);
          const go = () => start(d, item);
          li.addEventListener("click", go);
          li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
          return li;
        }));
        list.dataset.state = devices.length ? "found" : "empty";
        dlg.setStatus(devices.length ? t("cast.pick") : t("cast.none"), devices.length ? "" : "warn");
        list.querySelector("li")?.focus();
      } catch (e) {
        list.dataset.state = "error";
        dlg.setStatus(message(e), "error");
      } finally {
        dlg.setBusy(false);
      }
    }

    async function start(device, it) {
      dlg.setBusy(true);
      dlg.setStatus(t("cast.starting", { name: device.name }));
      try {
        const at = app.engine.time > 1 ? app.engine.time : 0;
        await invoke("cast_start", { id: device.id, path: it.path, title: it.name, start: at });
        app.engine.pause?.();
        session = { id: device.id, name: device.name, item: it, startedAt: Date.now() };
        document.documentElement.dataset.casting = "1";
        showControls();
      } catch (e) {
        dlg.setStatus(message(e), "error");
      } finally {
        dlg.setBusy(false);
      }
    }

    async function control(action) {
      try {
        await invoke("cast_control", { action });
        if (action === "stop") {
          session = null;
          lastStatus = null;
          delete document.documentElement.dataset.casting;
          stopPolling();
          now.hidden = true;
          list.hidden = false;
          intro.hidden = false;
          showSearchActions();
          dlg.setStatus(t("cast.stopped"));
          return;
        }
        poll();
      } catch (e) {
        dlg.setStatus(message(e), "error");
      }
    }

    async function poll() {
      if (!session) return;
      try {
        lastStatus = await invoke("cast_status");
        if (dlg.closed) return;
        now.dataset.state = lastStatus.state ?? "";
        const parts = [t(castStateKey(lastStatus.state))];
        if (lastStatus.position != null && lastStatus.duration) parts.push(`${fmt(lastStatus.position)} / ${fmt(lastStatus.duration)}`);
        const blocked = castLooksBlocked(lastStatus, Date.now() - session.startedAt);
        dlg.setStatus(blocked ? t("cast.blocked") : parts.join(" · "), blocked ? "warn" : "");
      } catch (e) {
        dlg.setStatus(message(e), "error");
      }
    }

    function showControls() {
      list.hidden = true;
      intro.hidden = true;
      now.hidden = false;
      now.replaceChildren(h("p", { text: t("cast.now", { name: session.name, title: session.item.name }) }));
      dlg.setActions([
        { id: "play", label: t("cast.play"), keepOpen: true, run: () => control("play") },
        { id: "pause", label: t("cast.pause"), keepOpen: true, run: () => control("pause") },
        { id: "stop", label: t("cast.stop"), danger: true, keepOpen: true, run: () => control("stop") },
        { id: "close", label: t("actions.common.close") },
      ]);
      stopPolling();
      timer = setInterval(poll, POLL_MS);
      poll();
    }

    function showSearchActions() {
      dlg.setActions([
        { id: "search", label: t("cast.search"), keepOpen: true, run: () => search() },
        { id: "close", label: t("actions.common.close") },
      ]);
    }

    if (session) {
      showControls();
    } else {
      showSearchActions();
      search();
    }
    return dlg;
  }

  const fmt = (s) => {
    const n = Math.max(0, Math.round(s));
    const hh = Math.floor(n / 3600);
    const mm = String(Math.floor(n / 60) % 60).padStart(hh ? 2 : 1, "0");
    return `${hh ? `${hh}:` : ""}${mm}:${String(n % 60).padStart(2, "0")}`;
  };

  return {
    open,
    get active() { return !!session; },
    get status() { return lastStatus; },
  };
}
