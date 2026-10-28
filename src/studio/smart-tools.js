// ==========================================================================
// "✨ Akıllı" tools of the photo editor (Plan 07 / Plan 11 A06): object removal (brush mask ->
// LaMa), background removal / replacement / blur (BiRefNet portrait), colorize (DDColor, only
// offered for black-and-white / faded photos). Each run is a persistent AI queue job on the
// editor's current base image (src/media/ai-jobs.js); its PNG result becomes the editor's
// new base (an undoable history step), saved later through the editor's normal save flow.
// Smart tools work on the upright, uncropped image: pending rotate/crop/adjust edits are
// saved or reset first (the tools say so).
// ==========================================================================

import { t } from "../core/i18n.js";
import { downloadConsentText, SMART_MODELS } from "../media/ai-engine.js";
import { memoryBudget, planInput } from "../media/ai-policy.js";
import { smartEditRequest, smartKindOf } from "../media/ai-jobs.js";
import { isColorizeCandidate } from "../media/smart-edit.js";

const tx = (key) => `data-i18n="${key}">${t(key)}`;
const BG_MODES = ["transparent", "white", "black", "color", "blur"];

const template = () => `
  <h5 ${tx("studio.smart.title")}</h5>
  <div class="ps-tool-row ps-smart-row">
    <button class="ps-btn" data-act="smart-remove" ${tx("studio.smart.remove")}</button>
    <button class="ps-btn" data-act="smart-bg" hidden><span ${tx("studio.smart.background")}</span> <span class="ps-smart-tag" ${tx("studio.smart.experimental")}</span></button>
    <button class="ps-btn" data-act="smart-color" hidden ${tx("studio.smart.colorize")}</button>
  </div>
  <p class="ps-smart-hint" hidden></p>
  <p class="ps-smart-applied" hidden></p>
  <div class="ps-smart-panel" data-panel="remove" hidden>
    <label class="ps-slider"><span ${tx("studio.smart.brush")}</span><output data-out="brush">4</output>
      <input type="range" class="filter-slider" data-brush min="1" max="15" value="4" step="1"></label>
    <div class="ps-tool-row">
      <button class="ps-btn" data-act="brush-erase" ${tx("studio.smart.eraser")}</button>
      <button class="ps-btn" data-act="brush-clear" ${tx("studio.smart.clear")}</button>
    </div>
    <div class="ps-tool-row">
      <button class="ps-btn ps-btn-accent" data-act="remove-apply" disabled ${tx("studio.smart.removeApply")}</button>
      <button class="ps-btn" data-act="smart-close" ${tx("common.cancel")}</button>
    </div>
  </div>
  <div class="ps-smart-panel" data-panel="bg" hidden>
    <div class="ps-chips">${BG_MODES.map((m) => `<button class="ps-chip" data-bg="${m}" ${tx(`studio.smart.bg.${m}`)}</button>`).join("")}</div>
    <input type="color" class="ps-smart-color" value="#3b82f6" hidden>
    <label class="ps-slider ps-smart-blur" hidden><span ${tx("studio.smart.blurAmount")}</span><output data-out="blur">4</output>
      <input type="range" class="filter-slider" data-blur min="1" max="10" value="4" step="1"></label>
    <div class="ps-tool-row">
      <button class="ps-btn ps-btn-accent" data-act="bg-apply" ${tx("studio.smart.apply")}</button>
      <button class="ps-btn" data-act="smart-close" ${tx("common.cancel")}</button>
    </div>
  </div>
  <div class="ps-smart-panel" data-panel="run" hidden>
    <div class="ps-progress"><div class="ps-progress-bar"></div></div>
    <button class="ps-btn" data-act="smart-cancel" ${tx("common.cancel")}</button>
  </div>`;

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * host: container in the editor tools; stage/canvas: the editor preview. deps: { invoke, jobs,
 * settings?, toast } ; editor: { base(), full(), identity(), steps(), onResult(path, op), setStatus(text) }.
 */
export function createSmartTools(host, stage, canvas, deps, editor) {
  host.innerHTML = template();
  host.classList.add("ps-smart");
  const $ = (s) => host.querySelector(s);
  const hint = $(".ps-smart-hint");
  const applied = $(".ps-smart-applied");
  const overlay = document.createElement("canvas");
  overlay.className = "ps-mask-canvas";
  overlay.hidden = true;
  stage.append(overlay);
  const octx = overlay.getContext("2d");

  let panel = null;            // "remove" | "bg" | "run" | null
  let strokes = [];            // normalized: { points, radius, erase }
  let current = null;
  let erase = false;
  let bgMode = "transparent";
  let running = null;          // { jobId, cancelled }

  const showPanel = (name) => {
    panel = name;
    for (const p of host.querySelectorAll(".ps-smart-panel")) p.hidden = p.dataset.panel !== name;
    overlay.hidden = name !== "remove";
    host.dataset.panel = name ?? "";
    if (name === "remove") placeOverlay();
  };

  // -------------------------------------------------------------- availability
  function refresh(bitmapPixels) {
    const ok = editor.identity();
    for (const b of host.querySelectorAll(".ps-smart-row button")) b.disabled = !ok || !!running;
    hint.hidden = ok;
    hint.textContent = ok ? "" : t("studio.smart.saveEditsFirst");
    if (bitmapPixels) $('[data-act="smart-color"]').hidden = !isColorizeCandidate(bitmapPixels);
    // experimental background removal: only when turned on in Settings > AI models
    const bgOn = deps.settings?.get?.("ai.smart.backgroundExperimental") === true;
    $('[data-act="smart-bg"]').hidden = !bgOn;
    if (!bgOn && panel === "bg") showPanel(null);
    // which AI steps the current image went through (undo removes them again)
    const steps = editor.steps();
    applied.hidden = !steps.length;
    applied.textContent = steps.length ? t("studio.smart.applied", { list: steps.map((op) => t(`studio.smart.op.${op}`)).join(", ") }) : "";
    host.dataset.steps = steps.join(",");
    if (!ok && panel && panel !== "run") showPanel(null);
  }

  // ------------------------------------------------------------- brush overlay
  function placeOverlay() {
    const c = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const scale = Math.min(c.width / canvas.width, c.height / canvas.height);
    const w = canvas.width * scale, h = canvas.height * scale;
    overlay.style.left = `${c.left - s.left + (c.width - w) / 2}px`;
    overlay.style.top = `${c.top - s.top + (c.height - h) / 2}px`;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }
    drawMask();
  }

  function drawMask() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const short = Math.min(overlay.width, overlay.height);
    for (const s of [...strokes, ...(current ? [current] : [])]) {
      octx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
      octx.strokeStyle = octx.fillStyle = "rgba(244, 63, 94, 0.55)";
      octx.lineWidth = s.radius * short * 2;
      octx.lineCap = octx.lineJoin = "round";
      octx.beginPath();
      s.points.forEach(([x, y], i) => (i ? octx.lineTo(x * overlay.width, y * overlay.height) : octx.moveTo(x * overlay.width, y * overlay.height)));
      if (s.points.length === 1) octx.lineTo(s.points[0][0] * overlay.width + 0.01, s.points[0][1] * overlay.height);
      octx.stroke();
    }
    octx.globalCompositeOperation = "source-over";
    $('[data-act="remove-apply"]').disabled = !strokes.some((s) => !s.erase);
    host.dataset.strokes = String(strokes.length);
  }

  const point = (e) => {
    const r = overlay.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  overlay.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    current = { points: [point(e)], radius: Number($("[data-brush]").value) / 200, erase };
    drawMask();
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!current) return;
    current.points.push(point(e));
    drawMask();
  });
  const end = () => {
    if (current) strokes.push(current);
    current = null;
    drawMask();
  };
  overlay.addEventListener("pointerup", end);
  overlay.addEventListener("pointercancel", end);
  new ResizeObserver(() => { if (panel === "remove") placeOverlay(); }).observe(stage);
  deps.settings?.subscribe?.("ai.smart.backgroundExperimental", () => refresh());

  // ------------------------------------------------------------------ running
  async function run(op, params) {
    const path = editor.base();
    const { w, h } = editor.full();
    const background = deps.settings?.get?.("ai.smart.background") === "general" ? "general" : "portrait";
    const model = op === "matting" && background === "general" ? "matting-general" : op;
    const plan = planInput(w, h, 1, { budget: memoryBudget(globalThis.navigator?.deviceMemory) });
    if (plan.downscaled && !window.confirm(t("studio.smart.tooLarge", { w, h, ow: plan.width, oh: plan.height }))) return;
    let consent;
    try {
      consent = await downloadConsentText(SMART_MODELS[model].component);
    } catch (e) {
      editor.setStatus(String(e?.message ?? e));
      return;
    }
    if (consent && !window.confirm(consent)) return;
    const metadata = deps.settings?.get?.("ai.output.metadata") ?? "keep";
    const request = smartEditRequest({ op, path, params, inputWidth: plan.width, inputHeight: plan.height, metadata, background });
    running = { jobId: null, cancelled: false };
    showPanel("run");
    refresh();
    host.dataset.running = "1";
    const bar = $(".ps-progress-bar");
    bar.style.width = "0%";
    editor.setStatus(t("studio.smart.working"));
    try {
      const final = await deps.jobs.run(smartKindOf(op), request, {
        onSubmitted: (snap) => {
          running.jobId = snap.id;
          host.dataset.jobId = snap.id;
          if (running.cancelled) deps.jobs.cancel(snap.id).catch(() => {});
        },
        onUpdate: (job) => {
          if (job.state === "queued") editor.setStatus(t("jobs.waiting"));
          else if (job.state === "running") {
            editor.setStatus(t("studio.smart.working"));
            if (typeof job.fraction === "number") bar.style.width = `${Math.round(job.fraction * 100)}%`;
          }
        },
      });
      // the queue's own record holds the output (AI jobs have no batch-style result list)
      const item = (await deps.invoke("jobs_get", { id: final.id }).catch(() => null))?.items?.[0];
      if (editor.base() !== path) {
        // another photo (or another base) is open now: the result stays in the jobs panel
      } else if (final.state === "completed" && item?.outputPath) {
        strokes = [];
        editor.onResult(item.outputPath, op);
        editor.setStatus(t("studio.smart.done"));
      } else if (final.state === "cancelled" || final.state === "paused") {
        editor.setStatus(t("studio.smart.cancelled"));
      } else {
        const code = item?.errorCode ?? final.errorCode ?? "failed";
        const key = `jobs.error.${code}`;
        if (op === "matting" && code === "memory") editor.setStatus(t("studio.smart.bgMemory"));
        else editor.setStatus(t("studio.smart.failed", { error: t(key) !== key ? t(key) : final.errorDetail || t("jobs.error.failed") }));
      }
    } catch (e) {
      editor.setStatus(t("studio.smart.failed", { error: String(e?.message ?? e) }));
    } finally {
      running = null;
      host.dataset.running = "0";
      showPanel(null);
      refresh();
    }
  }

  host.addEventListener("input", (e) => {
    if (e.target.matches("[data-brush]")) $('[data-out="brush"]').textContent = e.target.value;
    if (e.target.matches("[data-blur]")) $('[data-out="blur"]').textContent = e.target.value;
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.bg) {
      bgMode = b.dataset.bg;
      for (const c of host.querySelectorAll("[data-bg]")) c.classList.toggle("active", c === b);
      $(".ps-smart-color").hidden = bgMode !== "color";
      $(".ps-smart-blur").hidden = bgMode !== "blur";
      return;
    }
    switch (b.dataset.act) {
      case "smart-remove": strokes = []; erase = false; showPanel("remove"); break;
      case "smart-bg": showPanel("bg"); host.querySelector(`[data-bg="${bgMode}"]`)?.classList.add("active"); break;
      case "smart-color": run("colorize", {}); break;
      case "smart-close": strokes = []; showPanel(null); break;
      case "brush-erase": erase = !erase; b.classList.toggle("active", erase); break;
      case "brush-clear": strokes = []; drawMask(); break;
      case "remove-apply": run("inpaint", { strokes }); break;
      case "bg-apply": {
        const mode = bgMode === "white" || bgMode === "black" ? "color" : bgMode;
        const color = bgMode === "white" ? [255, 255, 255] : bgMode === "black" ? [0, 0, 0] : hexToRgb($(".ps-smart-color").value);
        const { w, h } = editor.full();
        const blur = Math.round((Math.max(w, h) * Number($("[data-blur]").value)) / 400);
        run("matting", { mode, color, blur });
        break;
      }
      case "smart-cancel":
        if (running) {
          running.cancelled = true;
          if (running.jobId) deps.jobs.cancel(running.jobId).catch(() => {});
          editor.setStatus(t("actions.job.cancelling"));
        }
        break;
      default:
    }
  });

  return {
    refresh,
    /** Editor reset (another photo / closed): drop the mask and panels. */
    reset() {
      strokes = [];
      current = null;
      showPanel(null);
    },
    get busy() { return !!running; },
    get strokes() { return strokes; },
    /** Test hook: a stroke in normalized image coordinates. */
    addStroke(stroke) { strokes.push(stroke); drawMask(); },
    /** Test hook: what a finished queue job does with its result file (E2E has no models). */
    applyResult(path, op) { strokes = []; editor.onResult(path, op); },
  };
}
