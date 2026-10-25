// ==========================================================================
// GPS map: Leaflet (BSD-2, vendored in src/vendor/leaflet) + OpenStreetMap
// tiles. Leaflet and the tiles are loaded only when the map tab is opened,
// and never while offline. Attribution "© OpenStreetMap contributors" is
// always shown; links open in the system browser, never inside the app.
// ==========================================================================

import { openUrl } from "../core/tauri.js";
import { t } from "../core/i18n.js";

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

let leafletPromise = null;

/** Loads vendor/leaflet once (script + stylesheet). */
export function loadLeaflet(doc = document) {
  if (globalThis.L?.map) return Promise.resolve(globalThis.L);
  leafletPromise ??= new Promise((resolve, reject) => {
    const css = Object.assign(doc.createElement("link"), { rel: "stylesheet", href: "vendor/leaflet/leaflet.css" });
    doc.head.append(css);
    const s = Object.assign(doc.createElement("script"), { src: "vendor/leaflet/leaflet.js", async: true });
    s.onload = () => (globalThis.L?.map ? resolve(globalThis.L) : reject(new Error(t("studio.map.leafletFailed"))));
    s.onerror = () => { leafletPromise = null; reject(new Error(t("studio.map.leafletFailed"))); };

    doc.head.append(s);
  });
  return leafletPromise;
}

/** Map view inside `container`; show(lat, lon) creates the map on first use. */
export function createMapView(container) {
  let map = null, marker = null;

  // Attribution / Leaflet links: open externally (the webview must never navigate away)
  container.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || !/^https?:/i.test(a.getAttribute("href"))) return;
    e.preventDefault();
    openUrl(a.href).catch(() => {});
  });

  return {
    async show(lat, lon) {
      const L = await loadLeaflet();
      if (!map) {
        map = L.map(container, { zoomControl: true, attributionControl: true, worldCopyJump: true });
        map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
        L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION, crossOrigin: false }).addTo(map);
        marker = L.circleMarker([lat, lon], { radius: 8, color: "#e11d48", weight: 3, fillColor: "#f43f5e", fillOpacity: 0.6 }).addTo(map);
        map.setView([lat, lon], 14);
      } else {
        marker.setLatLng([lat, lon]);
        map.setView([lat, lon], map.getZoom() || 14);
      }
      // The container may have just become visible
      setTimeout(() => map.invalidateSize(), 0);
      return map;
    },
    get loaded() { return !!map; },
  };
}
