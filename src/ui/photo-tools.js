// ==========================================================================
// Photo actions (Plan 06 §2): copy image (with the viewer's rotation), print with a preview
// (paper, orientation, fit / fill, margins), desktop background / lock screen, text
// recognition (OCR) with a selectable text layer over the photo + "copy all".
// OS-level steps (print dialog, wallpaper) are gated by the backend
// (VHO_DISABLE_SYSTEM_CHANGES: logged, not applied).
// ==========================================================================

import { t } from "../core/i18n.js";
import { invoke } from "../core/tauri.js";
import { MARGINS, PAPERS, bestOrientation, errorCode, errorText, ocrLayer, printLayout } from "../media/actions-logic.js";
import { needsDecode } from "../media/classify.js";
import { field, h, select } from "./action-dialogs.js";

/**
 * app: { dialogs, dom, photo, settings, toast, bus, shortcuts }
 * current(): { item, kind }
 */
export function createPhotoTools(app, current) {
  const img = () => document.getElementById("image-element");
  const setting = (k, d) => app.settings?.get?.(k) ?? d;

  /** A path the OS components can read: the original, or the decoded copy (HEIC / RAW / TIFF). */
  async function readablePath(item) {
    if (!needsDecode(item.name)) return item.path;
    const r = await invoke("photo_decode", { path: item.path, maxSize: null });
    return r.path;
  }

  // ------------------------------------------------------------------------
  // Clipboard
  // ------------------------------------------------------------------------
  async function copyImage() {
    const { item } = current();
    if (!item) return;
    const rotation = app.photo?.rotation ?? 0;
    try {
      if (item.path) {
        await invoke("clipboard_copy_image", { path: item.path, rotation });
      } else {
        // browser File / URL: the displayed pixels
        const el = img();
        const c = document.createElement("canvas");
        const turn = rotation % 180 !== 0;
        c.width = turn ? el.naturalHeight : el.naturalWidth;
        c.height = turn ? el.naturalWidth : el.naturalHeight;
        const g = c.getContext("2d");
        g.translate(c.width / 2, c.height / 2);
        g.rotate((rotation * Math.PI) / 180);
        g.drawImage(el, -el.naturalWidth / 2, -el.naturalHeight / 2);
        await invoke("clipboard_copy_image_data", { data: c.toDataURL("image/png") });
      }
      app.toast(t("actions.toast.imageCopied"));
    } catch (e) {
      app.toast(`⚠️ ${errorText(e, t)}`);
    }
  }

  // ------------------------------------------------------------------------
  // Print
  // ------------------------------------------------------------------------
  /** Puts the image into `box` (percent based) the way the layout says. */
  function placeImage(box, layout, src, rotation) {
    const [pw, ph] = layout.page;
    const pct = (v, d) => `${(v / d) * 100}%`;
    const area = h("div", { class: "vho-print-area" });
    Object.assign(area.style, { left: pct(layout.area.x, pw), top: pct(layout.area.y, ph), width: pct(layout.area.w, pw), height: pct(layout.area.h, ph) });
    const im = h("img", { src, alt: "" });
    const turn = rotation % 180 !== 0;
    const { x, y, w, h: hh } = layout.image;
    // position relative to the area; rotated images keep their center
    const cx = x - layout.area.x + w / 2, cy = y - layout.area.y + hh / 2;
    // a quarter-turned image is laid out unrotated (width = displayed height), then rotated
    Object.assign(im.style, {
      left: pct(cx, layout.area.w), top: pct(cy, layout.area.h),
      width: pct(turn ? hh : w, layout.area.w), height: pct(turn ? w : hh, layout.area.h),
      transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
    });
    area.append(im);
    box.replaceChildren(area);
  }

  async function print() {
    const { item } = current();
    const el = img();
    if (!item || !el?.naturalWidth) return;
    const src = el.currentSrc || el.src;
    const rotation = app.photo?.rotation ?? 0;
    const dims = rotation % 180 ? [el.naturalHeight, el.naturalWidth] : [el.naturalWidth, el.naturalHeight];
    const paper = select("vho-print-paper", Object.keys(PAPERS).map((p) => ({ value: p, label: t(`actions.print.papers.${p}`) })), setting("actions.printPaper", "a4"));
    const orient = select("vho-print-orientation", ["portrait", "landscape"].map((o) => ({ value: o, label: t(`actions.print.${o}`) })), bestOrientation(dims));
    const fit = select("vho-print-fit", ["fit", "fill"].map((o) => ({ value: o, label: t(`actions.print.${o}`) })), setting("actions.printFit", "fit"));
    const margin = select("vho-print-margin", Object.keys(MARGINS).map((m) => ({ value: m, label: t(`actions.print.margins.${m}`) })), setting("actions.printMargin", "normal"));
    const page = h("div", { id: "vho-print-preview", class: "vho-print-page" });
    const opts = () => ({ paper: paper.value, orientation: orient.value, margin: margin.value, fit: fit.value, image: dims });
    const refresh = () => {
      const layout = printLayout(opts());
      page.style.aspectRatio = `${layout.page[0]} / ${layout.page[1]}`;
      placeImage(page, layout, src, rotation);
    };
    for (const s of [paper, orient, fit, margin]) s.addEventListener("change", refresh);
    refresh();
    app.dialogs.open({
      id: "vho-print", title: t("actions.print.title"), wide: true, className: "vho-print-dialog",
      body: h("div", { class: "vho-print-layout" },
        h("div", { class: "vho-print-stage" }, page),
        h("div", { class: "vho-print-options" },
          field(t("actions.print.paper"), paper), field(t("actions.print.orientation"), orient),
          field(t("actions.print.scaling"), fit), field(t("actions.print.margin"), margin))),
      actions: [
        { id: "cancel", label: t("actions.common.cancel"), cancel: true },
        {
          id: "ok", label: t("actions.print.print"), primary: true,
          run: async () => {
            app.settings?.set?.("actions.printPaper", paper.value);
            app.settings?.set?.("actions.printFit", fit.value);
            app.settings?.set?.("actions.printMargin", margin.value);
            const allowed = await invoke("system_action_allowed", { action: "print", target: item.path ?? item.name }).catch(() => true);
            if (!allowed) {
              app.toast(t("actions.toast.systemSkipped"));
              return true;
            }
            printNow(printLayout(opts()), src, rotation);
            return true;
          },
        },
      ],
    });
  }

  /** Print-only page with just the image (WebView print dialog). */
  function printNow(layout, src, rotation) {
    document.getElementById("vho-print-root")?.remove();
    document.getElementById("vho-print-style")?.remove();
    const [pw, ph] = layout.page;
    const root = h("div", { id: "vho-print-root" });
    const style = h("style", { id: "vho-print-style" });
    style.textContent = `@page { size: ${pw}mm ${ph}mm; margin: 0; }
@media print {
  html, body { background: #fff !important; }
  body > *:not(#vho-print-root) { display: none !important; }
  #vho-print-root { display: block !important; position: relative; width: ${pw}mm; height: ${ph}mm; overflow: hidden; }
}`;
    placeImage(root, layout, src, rotation);
    document.head.append(style);
    document.body.append(root);
    const cleanup = () => { root.remove(); style.remove(); };
    window.addEventListener("afterprint", cleanup, { once: true });
    const im = root.querySelector("img");
    (im.decode?.() ?? Promise.resolve()).catch(() => {}).finally(() => window.print());
  }

  // ------------------------------------------------------------------------
  // Desktop background / lock screen
  // ------------------------------------------------------------------------
  async function setBackground(target) {
    const { item } = current();
    if (!item?.path) return;
    try {
      await invoke("set_wallpaper", { path: await readablePath(item), target });
      app.toast(t(target === "lock" ? "actions.toast.lockScreenSet" : "actions.toast.wallpaperSet"));
    } catch (e) {
      app.toast(`⚠️ ${errorText(e, t)}`);
    }
  }

  // ------------------------------------------------------------------------
  // OCR
  // ------------------------------------------------------------------------
  let ocrState = null; // { layer, bar, off: [] }

  function closeOcr() {
    if (!ocrState) return false;
    ocrState.layer.remove();
    ocrState.bar.remove();
    for (const off of ocrState.off) off();
    ocrState = null;
    return true;
  }
  app.shortcuts?.onEscape?.(() => closeOcr());
  app.bus?.on?.("media:loading", () => closeOcr());

  function positionLayer() {
    if (!ocrState) return;
    const el = img();
    const vp = document.getElementById("viewport").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    Object.assign(ocrState.layer.style, { left: `${r.left - vp.left}px`, top: `${r.top - vp.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    for (const w of ocrState.layer.querySelectorAll(".vho-ocr-word")) {
      w.style.fontSize = `${Math.max(6, (Number(w.dataset.h) / 100) * r.height * 0.82)}px`;
    }
  }

  async function ocr() {
    const { item } = current();
    if (!item?.path) return;
    closeOcr();
    if (app.photo?.rotation || app.photo?.zoomLevel !== 1) app.photo?.resetTransform?.();
    app.toast(t("actions.ocr.running"));
    let res;
    try {
      const lang = setting("actions.ocrLanguage", "auto");
      res = await invoke("ocr_image", { path: await readablePath(item), language: lang === "auto" ? null : lang });
    } catch (e) {
      const code = errorCode(e);
      app.toast(code === "ocr-language" ? t("actions.ocr.noLanguage") : code === "unsupported" ? t("actions.ocr.unsupported") : `⚠️ ${errorText(e)}`);
      return null;
    }
    const layer = h("div", { id: "vho-ocr-layer", class: "vho-ocr-layer", "data-lines": String(res.lines.length) });
    for (const line of ocrLayer(res)) {
      line.words.forEach((w, i) => {
        const s = h("span", { class: "vho-ocr-word", "data-h": String(w.height) });
        s.textContent = w.text + (i === line.words.length - 1 ? "\n" : " ");
        Object.assign(s.style, { left: `${w.left}%`, top: `${w.top}%`, width: `${w.width}%`, height: `${w.height}%` });
        layer.append(s);
      });
    }
    const count = h("span", { text: res.lines.length ? t("actions.ocr.found", { n: res.lines.length }) : t("actions.ocr.none") });
    const bar = h("div", { id: "vho-ocr-bar", class: "vho-ocr-bar" },
      count,
      h("button", {
        type: "button", id: "vho-ocr-copy", class: "btn-primary btn-sm", text: t("actions.ocr.copyAll"), disabled: !res.text,
        onclick: () => invoke("clipboard_copy_text", { text: res.text }).then(() => app.toast(t("actions.toast.textCopied"))).catch((e) => app.toast(`⚠️ ${errorText(e, t)}`)),
      }),
      h("button", { type: "button", id: "vho-ocr-close", class: "btn-secondary btn-sm", text: t("actions.common.close"), onclick: () => closeOcr() }));
    const viewport = document.getElementById("viewport");
    viewport.append(layer, bar);
    const onResize = () => positionLayer();
    window.addEventListener("resize", onResize);
    const el = img();
    el.addEventListener("load", onResize);
    ocrState = { layer, bar, text: res.text, off: [() => window.removeEventListener("resize", onResize), () => el.removeEventListener("load", onResize)] };
    // after the transform reset transition
    positionLayer();
    setTimeout(positionLayer, 260);
    return res;
  }

  return { copyImage, print, setBackground, ocr, closeOcr, get ocrText() { return ocrState?.text ?? null; } };
}

