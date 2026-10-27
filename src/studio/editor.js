// ==========================================================================
// Photo editor: crop (free + ratio presets), rotate / flip, brightness,
// contrast, saturation, temperature, sharpen; undo/redo; Save / Save copy /
// Save as. The preview is a canvas rendered from a 1600 px upright copy with
// the same formulas as the backend; saving sends the edit as photo_batch ops,
// so the full-resolution original is processed by Rust with EXIF kept.
// "✨ Akıllı" tools (smart-tools.js, Plan 07) replace the edit's base image with an AI result
// file (state.base, an undoable step); saving then processes that base, never overwriting
// the original with an AI result (Save behaves as Save copy).
// ==========================================================================

import {
  CROP_RATIOS, adjustImageData, baseName, clampCrop, createHistory, cropForRatio, dragCropCorner,
  editFlip, editRotate, editToOps, initialEdit, isEditIdentity, parentDir, rotatedSize, sharpenImageData, stemOf,
} from "./logic.js";
import { loadBitmap } from "./info-panel.js";
import { createSmartTools } from "./smart-tools.js";
import { nextFrame } from "./logic.js";
import { t } from "../core/i18n.js";

const PREVIEW_SIZE = 1600;

const SLIDERS = [
  { key: "brightness", labelKey: "studio.editor.brightness", min: -100, max: 100 },
  { key: "contrast", labelKey: "studio.editor.contrast", min: -100, max: 100 },
  { key: "saturation", labelKey: "studio.editor.saturation", min: -100, max: 100 },
  { key: "temperature", labelKey: "studio.editor.temperature", min: -100, max: 100 },
  { key: "sharpen", labelKey: "studio.editor.sharpen", min: 0, max: 100 },
];

const SAVE_FORMATS = { jpg: "jpeg", jpeg: "jpeg", png: "png", webp: "webp", avif: "avif", tif: "tiff", tiff: "tiff", bmp: "bmp" };

// Built when the editor is created (the dictionary is loaded by then); every text carries its
// i18n key so a language switch re-translates it (core/i18n.js applyTranslations).
const tx = (key) => `data-i18n="${key}">${t(key)}`;
const ti = (key) => `data-i18n-title="${key}" title="${t(key)}"`;
const template = () => `
  <div class="ps-editor-stage">
    <canvas class="ps-editor-canvas"></canvas>
    <div class="ps-crop-box" hidden>
      <span class="ps-crop-grid"></span>
      <span class="ps-crop-h" data-h="nw"></span><span class="ps-crop-h" data-h="ne"></span>
      <span class="ps-crop-h" data-h="sw"></span><span class="ps-crop-h" data-h="se"></span>
    </div>
    <div class="ps-editor-busy" hidden>${t("ui.licenses.loading")}</div>
  </div>
  <aside class="ps-editor-tools">
    <div class="ps-editor-head">
      <strong class="ps-editor-title">${t("ui.studio.edit")}</strong>
      <span class="ps-editor-dims"></span>
    </div>
    <div class="ps-tool-row">
      <button class="ps-btn" data-act="undo" ${ti("studio.editor.undoTitle")} disabled ${tx("studio.editor.undo")}</button>
      <button class="ps-btn" data-act="redo" ${ti("studio.editor.redoTitle")} disabled ${tx("studio.editor.redo")}</button>
      <button class="ps-btn" data-act="reset" ${ti("studio.editor.resetTitle")} ${tx("common.reset")}</button>
    </div>
    <h5 ${tx("studio.editor.rotateFlip")}</h5>
    <div class="ps-tool-row">
      <button class="ps-btn" data-act="rotl" ${ti("shortcuts.actions.rotateLeft")} ${tx("studio.editor.left")}</button>
      <button class="ps-btn" data-act="rotr" ${ti("shortcuts.actions.rotateRight")} ${tx("studio.editor.right")}</button>
      <button class="ps-btn" data-act="fliph" ${ti("ui.menu.hflip")} ${tx("studio.editor.horizontal")}</button>
      <button class="ps-btn" data-act="flipv" ${ti("ui.menu.vflip")} ${tx("studio.editor.vertical")}</button>
    </div>
    <h5 ${tx("studio.editor.crop")}</h5>
    <div class="ps-tool-row">
      <button class="ps-btn" data-act="crop" ${tx("studio.editor.cropTool")}</button>
      <button class="ps-btn" data-act="uncrop" ${ti("studio.editor.uncrop")} ${tx("studio.editor.uncrop")}</button>
    </div>
    <div class="ps-crop-panel" hidden>
      <div class="ps-chips">${CROP_RATIOS.map((r) => `<button class="ps-chip" data-ratio="${r.id}"${r.labelKey ? ` ${tx(r.labelKey)}` : `>${r.label}`}</button>`).join("")}</div>
      <div class="ps-tool-row">
        <button class="ps-btn ps-btn-accent" data-act="crop-apply" ${tx("studio.editor.apply")}</button>
        <button class="ps-btn" data-act="crop-cancel" ${tx("common.cancel")}</button>
      </div>
    </div>
    <h5 ${tx("studio.editor.adjust")}</h5>
    ${SLIDERS.map((s) => `
      <label class="ps-slider">
        <span ${tx(s.labelKey)}</span><output data-out="${s.key}">0</output>
        <input type="range" class="filter-slider" data-adj="${s.key}" min="${s.min}" max="${s.max}" value="0" step="1">
      </label>`).join("")}
    <div class="ps-smart-host"></div>
    <div class="ps-editor-save">
      <button class="btn-primary btn-sm" data-act="save" ${ti("studio.editor.saveTitle")} ${tx("studio.editor.save")}</button>
      <button class="btn-secondary btn-sm" data-act="save-copy" ${ti("studio.editor.saveCopyTitle")} ${tx("studio.editor.saveCopy")}</button>
      <button class="btn-secondary btn-sm" data-act="save-as" ${tx("studio.editor.saveAs")}</button>
      <button class="btn-ghost btn-sm" data-act="close" ${tx("common.close")}</button>
    </div>
    <div class="ps-editor-status" role="status"></div>
  </aside>`;

/**
 * root: empty overlay element. deps: { invoke, convertFileSrc, dialogSave, toast, onSaved(outcome, mode), onClose,
 * jobs?, settings? } (jobs: the AI queue client for the smart tools)
 */
export function createEditor(root, { invoke, convertFileSrc, dialogSave, toast, onSaved, onClose, jobs, settings }) {
  root.innerHTML = template();
  const $ = (s) => root.querySelector(s);
  const canvas = $(".ps-editor-canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const stage = $(".ps-editor-stage");
  const cropBox = $(".ps-crop-box");
  const cropPanel = $(".ps-crop-panel");
  const busy = $(".ps-editor-busy");
  const status = $(".ps-editor-status");

  const history = createHistory(initialEdit());
  let item = null;
  let bitmap = null;           // upright preview
  let full = { w: 0, h: 0 };   // upright full-resolution size
  let live = history.state;    // state shown (slider drags are live, committed on change)
  let saved = history.state;
  let cropMode = false;
  let cropDraft = null;
  let ratioId = "free";
  let geomKey = "";
  let geomCanvas = null;
  let raf = 0;
  let saving = false;
  let loadedBase = null;       // path the preview bitmap was made from

  const basePath = (e = history.state) => e.base ?? item?.path;
  const smart = jobs ? createSmartTools($(".ps-smart-host"), stage, canvas, { invoke, jobs, settings, toast }, {
    base: () => basePath(),
    full: () => ({ ...full }),
    identity: () => isEditIdentity(history.state),
    setStatus: (text) => { status.textContent = text; },
    onResult: (path) => commit({ ...initialEdit(), base: path }),
  }) : null;

  const isOpen = () => !root.hidden;

  // ---------------------------------------------------------------- render
  function orientedCanvas(e) {
    const key = `${e.rotation}|${e.flipH}|${e.flipV}|${cropMode ? "" : JSON.stringify(e.crop)}`;
    if (key === geomKey && geomCanvas) return geomCanvas;
    const { w: RW, h: RH } = rotatedSize(bitmap.width, bitmap.height, e.rotation);
    const o = new OffscreenCanvas(RW, RH);
    const g = o.getContext("2d");
    g.translate(RW / 2, RH / 2);
    g.scale(e.flipH ? -1 : 1, e.flipV ? -1 : 1);
    g.rotate((e.rotation * Math.PI) / 180);
    g.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    let out = o;
    if (e.crop && !cropMode) {
      const sx = Math.round(e.crop.x * RW), sy = Math.round(e.crop.y * RH);
      const sw = Math.max(1, Math.round(e.crop.w * RW)), sh = Math.max(1, Math.round(e.crop.h * RH));
      out = new OffscreenCanvas(sw, sh);
      out.getContext("2d").drawImage(o, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    geomKey = key;
    geomCanvas = out;
    return out;
  }

  function render() {
    raf = 0;
    if (!bitmap) return;
    if (item && basePath(live) !== loadedBase) {
      loadBase(basePath(live)); // undo/redo across an AI step: another base image
      return;
    }
    const e = live;
    const src = orientedCanvas(e);
    if (canvas.width !== src.width || canvas.height !== src.height) {
      canvas.width = src.width;
      canvas.height = src.height;
    }
    ctx.drawImage(src, 0, 0);
    if (!isNeutral(e)) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      adjustImageData(img.data, e.adjust);
      if (e.sharpen > 0) img.data.set(sharpenImageData(img.data, img.width, img.height, e.sharpen));
      ctx.putImageData(img, 0, 0);
    }
    placeCropBox();
    syncControls();
  }
  const isNeutral = (e) => !e.sharpen && Object.values(e.adjust).every((v) => !Number(v));
  const schedule = () => { if (!raf) raf = nextFrame(render); };

  function syncControls() {
    const e = live;
    for (const s of SLIDERS) {
      const input = root.querySelector(`[data-adj="${s.key}"]`);
      const v = s.key === "sharpen" ? e.sharpen : e.adjust[s.key];
      if (document.activeElement !== input) input.value = v;
      root.querySelector(`[data-out="${s.key}"]`).textContent = v > 0 && s.key !== "sharpen" ? `+${v}` : `${v}`;
    }
    $('[data-act="undo"]').disabled = !history.canUndo;
    $('[data-act="redo"]').disabled = !history.canRedo;
    $('[data-act="uncrop"]').disabled = !e.crop;
    const ops = editToOps(e, full.w, full.h);
    const { w, h } = outputSize(e);
    $(".ps-editor-dims").textContent = full.w ? `${w} × ${h}` : "";
    root.dataset.ops = JSON.stringify(ops);
    root.dataset.base = e.base ?? "";
    smart?.refresh();
    root.dataset.dirty = JSON.stringify(history.state) !== JSON.stringify(saved) ? "1" : "0";
  }

  function outputSize(e) {
    const { w: RW, h: RH } = rotatedSize(full.w, full.h, e.rotation);
    if (!e.crop) return { w: RW, h: RH };
    const op = editToOps(e, full.w, full.h).find((o) => o.op === "crop");
    return op ? { w: op.width, h: op.height } : { w: RW, h: RH };
  }

  // ------------------------------------------------------------------ crop UI
  function canvasRect() {
    const c = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect();
    // object-fit: contain inside the canvas box
    const scale = Math.min(c.width / canvas.width, c.height / canvas.height);
    const w = canvas.width * scale, h = canvas.height * scale;
    return { left: c.left - s.left + (c.width - w) / 2, top: c.top - s.top + (c.height - h) / 2, width: w, height: h, abs: { left: c.left + (c.width - w) / 2, top: c.top + (c.height - h) / 2 } };
  }

  function placeCropBox() {
    cropBox.hidden = !cropMode;
    if (!cropMode || !cropDraft) return;
    const r = canvasRect();
    cropBox.style.left = `${r.left + cropDraft.x * r.width}px`;
    cropBox.style.top = `${r.top + cropDraft.y * r.height}px`;
    cropBox.style.width = `${cropDraft.w * r.width}px`;
    cropBox.style.height = `${cropDraft.h * r.height}px`;
  }

  function currentRatio() {
    const r = CROP_RATIOS.find((x) => x.id === ratioId)?.ratio ?? null;
    if (r === "orig") {
      const { w, h } = rotatedSize(full.w || bitmap.width, full.h || bitmap.height, live.rotation);
      return w / h;
    }
    return r;
  }

  function enterCrop() {
    cropMode = true;
    cropDraft = live.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    cropPanel.hidden = false;
    $('[data-act="crop"]').classList.add("active");
    geomKey = "";
    setRatio(ratioId, false);
    schedule();
  }

  function exitCrop(apply) {
    if (!cropMode) return;
    cropMode = false;
    cropPanel.hidden = true;
    $('[data-act="crop"]').classList.remove("active");
    geomKey = "";
    if (apply && cropDraft) {
      const full1 = cropDraft.x <= 0.0005 && cropDraft.y <= 0.0005 && cropDraft.w >= 0.9995 && cropDraft.h >= 0.9995;
      commit({ ...live, crop: full1 ? null : clampCrop(cropDraft) });
    } else {
      schedule();
    }
    cropDraft = null;
  }

  function setRatio(id, reshape = true) {
    ratioId = id;
    for (const b of root.querySelectorAll("[data-ratio]")) b.classList.toggle("active", b.dataset.ratio === id);
    const ratio = currentRatio();
    if (cropMode && ratio && (reshape || !live.crop)) {
      const { w, h } = rotatedSize(bitmap.width, bitmap.height, live.rotation);
      cropDraft = cropForRatio(ratio, w, h);
    }
    placeCropBox();
  }

  let drag = null;
  cropBox.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cropBox.setPointerCapture(e.pointerId);
    const handle = e.target.dataset.h;
    const r = canvasRect();
    drag = { handle, startX: e.clientX, startY: e.clientY, start: { ...cropDraft }, r };
  });
  stage.addEventListener("pointerdown", (e) => {
    if (!cropMode || e.target !== canvas && e.target !== stage) return;
    const r = canvasRect();
    const px = (e.clientX - r.abs.left) / r.width, py = (e.clientY - r.abs.top) / r.height;
    if (px < 0 || py < 0 || px > 1 || py > 1) return;
    cropDraft = { x: px, y: py, w: 0.02, h: 0.02 };
    stage.setPointerCapture(e.pointerId);
    drag = { handle: "se", startX: e.clientX, startY: e.clientY, start: { ...cropDraft }, r };
    placeCropBox();
  });
  const onMove = (e) => {
    if (!drag) return;
    const { r } = drag;
    const { w: W, h: H } = { w: canvas.width, h: canvas.height };
    if (!drag.handle) {
      const dx = (e.clientX - drag.startX) / r.width, dy = (e.clientY - drag.startY) / r.height;
      cropDraft = clampCrop({ ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy });
    } else {
      const px = (e.clientX - r.abs.left) / r.width, py = (e.clientY - r.abs.top) / r.height;
      cropDraft = dragCropCorner(drag.start, drag.handle, px, py, currentRatio(), W, H);
    }
    placeCropBox();
  };
  const onUp = () => { drag = null; };
  cropBox.addEventListener("pointermove", onMove);
  stage.addEventListener("pointermove", onMove);
  cropBox.addEventListener("pointerup", onUp);
  stage.addEventListener("pointerup", onUp);
  new ResizeObserver(() => placeCropBox()).observe(stage);

  // ------------------------------------------------------------- state changes
  function commit(next) {
    live = history.push(next);
    geomKey = "";
    syncControls();
    schedule();
  }

  function undo() { live = history.undo(); geomKey = ""; syncControls(); schedule(); }
  function redo() { live = history.redo(); geomKey = ""; syncControls(); schedule(); }

  for (const input of root.querySelectorAll("[data-adj]")) {
    const key = input.dataset.adj;
    const patch = (v) => (key === "sharpen" ? { ...history.state, sharpen: v } : { ...history.state, adjust: { ...history.state.adjust, [key]: v } });
    input.addEventListener("input", () => { live = patch(Number(input.value)); schedule(); });
    input.addEventListener("change", () => commit(patch(Number(input.value))));
    input.addEventListener("dblclick", () => { input.value = 0; commit(patch(0)); });
  }

  const actions = {
    undo, redo,
    reset: () => commit(initialEdit()),
    rotl: () => commit(editRotate(history.state, -90)),
    rotr: () => commit(editRotate(history.state, 90)),
    fliph: () => commit(editFlip(history.state, "horizontal")),
    flipv: () => commit(editFlip(history.state, "vertical")),
    crop: () => (cropMode ? exitCrop(true) : enterCrop()),
    uncrop: () => { exitCrop(false); commit({ ...history.state, crop: null }); },
    "crop-apply": () => exitCrop(true),
    "crop-cancel": () => exitCrop(false),
    save: () => save("save"),
    "save-copy": () => save("copy"),
    "save-as": () => save("as"),
    close: () => close(),
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b) || b.disabled) return;
    if (b.dataset.ratio) setRatio(b.dataset.ratio);
    else if (actions[b.dataset.act]) {
      // Rotations/flips while cropping: apply the draft first so it follows the image
      if (cropMode && ["rotl", "rotr", "fliph", "flipv", "reset", "undo", "redo"].includes(b.dataset.act)) exitCrop(true);
      actions[b.dataset.act]();
    }
  });

  // ------------------------------------------------------------------ saving
  async function save(mode) {
    if (!item || saving) return;
    if (cropMode) exitCrop(true);
    const e = history.state;
    const ops = editToOps(e, full.w, full.h);
    if (!ops.length && !e.base) {
      toast(t("studio.editor.nothingToSave"));
      return;
    }
    // an AI result is never written over the original by "Save": it becomes a copy (PNG keeps
    // transparency), next to the original
    if (e.base && mode === "save") mode = "copy";
    const output = { format: "same", quality: 92, metadata: "keep", lossless: true, counterStart: 1 };
    if (e.base) Object.assign(output, { dir: parentDir(item.path) });
    if (mode === "save") {
      if (!window.confirm(t("studio.editor.overwriteConfirm", { name: item.name }))) return;
      Object.assign(output, { conflict: "overwrite", nameTemplate: "{name}" });
    } else if (mode === "copy") {
      const stem = e.base ? stemOf(item.name).replace(/[{}]/g, "_") : "{name}";
      Object.assign(output, { conflict: "rename", nameTemplate: `${stem}${t("studio.editor.copySuffix")}` });
    } else {
      if (!dialogSave) {
        toast(t("studio.editor.saveAsUnavailable"));
        return;
      }
      const ext = item.browserNative === false ? "jpg" : (item.ext || "jpg");
      const target = await dialogSave({
        defaultPath: `${parentDir(item.path)}${item.path.includes("\\") ? "\\" : "/"}${stemOf(item.name)}${t("studio.editor.copySuffix")}.${ext}`,
        filters: [
          { name: "JPEG", extensions: ["jpg", "jpeg"] }, { name: "PNG", extensions: ["png"] },
          { name: "WebP", extensions: ["webp"] }, { name: "AVIF", extensions: ["avif"] }, { name: "TIFF", extensions: ["tif", "tiff"] },
        ],
      }).catch(() => null);
      if (!target) return;
      const name = baseName(target);
      const tExt = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
      Object.assign(output, {
        conflict: "overwrite", dir: parentDir(target),
        nameTemplate: stemOf(name).replace(/[{}]/g, "_"),
        format: SAVE_FORMATS[tExt] ?? "same",
      });
    }
    saving = true;
    status.textContent = t("studio.editor.saving");
    root.dataset.saving = "1";
    try {
      const summary = await invoke("photo_batch", { job: { jobId: `edit-${Date.now()}`, files: [basePath(e)], ops, output } });
      const r = summary.results[0];
      root.dataset.lastResult = JSON.stringify(r);
      if (!r?.ok) throw new Error(r?.error ?? t("studio.editor.unknownError"));
      saved = history.state;
      status.textContent = t("studio.editor.savedDims", { name: baseName(r.output), w: r.width, h: r.height });
      toast(t("studio.editor.saved", { name: baseName(r.output) }));
      onSaved?.(r, mode, item);
      if (mode === "save") {
        // The original changed: start over from the saved file
        const again = item;
        item = null;
        await open(again);
      }
    } catch (err) {
      status.textContent = t("studio.editor.saveFailed", { error: String(err.message ?? err).replace(/^\[[a-z-]+\]\s*/, "") });
      toast(t("studio.editor.saveFailedToast"));
    } finally {
      saving = false;
      root.dataset.saving = "0";
      syncControls();
    }
  }

  // ------------------------------------------------------------- open / close
  async function open(next) {
    root.hidden = false;
    item = next;
    $(".ps-editor-title").textContent = next.name;
    $(".ps-editor-title").title = next.path;
    status.textContent = "";
    busy.hidden = false;
    root.dataset.ready = "0";
    exitCrop(false);
    live = saved = history.reset(initialEdit());
    geomKey = "";
    smart?.reset();
    await loadBase(next.path);
  }

  /** Preview bitmap + full size of the edit's base image (the original or an AI result). */
  async function loadBase(path) {
    const next = item;
    loadedBase = path;
    busy.hidden = false;
    root.dataset.ready = "0";
    try {
      const [info, thumb] = await Promise.all([
        invoke("photo_info", { path }).catch(() => null),
        invoke("photo_thumb", { path, size: PREVIEW_SIZE }),
      ]);
      if (item !== next || loadedBase !== path) return;
      bitmap?.close?.();
      bitmap = await loadBitmap(convertFileSrc(thumb.path));
      full = info?.width && info?.height ? { w: info.width, h: info.height } : { w: thumb.width, h: thumb.height };
      geomKey = "";
      busy.hidden = true;
      root.dataset.ready = "1";
      root.dataset.full = `${full.w}x${full.h}`;
      schedule();
      if (smart) {
        // colorize is offered for black-and-white / faded photos only
        const o = new OffscreenCanvas(Math.min(256, bitmap.width), Math.min(256, bitmap.height));
        o.getContext("2d").drawImage(bitmap, 0, 0, o.width, o.height);
        smart.refresh(o.getContext("2d").getImageData(0, 0, o.width, o.height).data);
      }
    } catch (e) {
      busy.textContent = t("studio.editor.openFailed", { error: String(e).replace(/^\[[a-z-]+\]\s*/, "") });
    }
  }

  function close(force = false) {
    if (!isOpen()) return true;
    const st = history.state;
    const dirty = JSON.stringify(st) !== JSON.stringify(saved) && (!isEditIdentity(st) || (st.base ?? null) !== (saved.base ?? null));
    if (!force && smart?.busy) return false;
    if (!force && dirty && !window.confirm(t("studio.editor.discardConfirm"))) return false;
    exitCrop(false);
    root.hidden = true;
    smart?.reset();
    bitmap?.close?.();
    bitmap = null;
    item = null;
    loadedBase = null;
    busy.textContent = t("ui.licenses.loading");

    onClose?.();
    return true;
  }

  /** Editor keys; returns true when handled. */
  function handleKey(e) {
    if (!isOpen()) return false;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.shiftKey ? redo() : undo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { redo(); return true; }
    if ((e.ctrlKey || e.metaKey) && k === "s") { save(e.shiftKey ? "as" : "copy"); return true; }
    if (e.key === "Escape") { cropMode ? exitCrop(false) : close(); return true; }
    if (e.key === "Enter" && cropMode) { exitCrop(true); return true; }
    return false;
  }

  return {
    open, close, handleKey,
    get isOpen() { return isOpen(); },
    get state() { return history.state; },
    /** Smart tools (tests / automation). */
    get smart() { return smart; },
    /** Test / automation hook: set the crop rect (normalised) directly. */
    setCrop(c) { commit({ ...history.state, crop: c ? clampCrop(c) : null }); },
  };
}
