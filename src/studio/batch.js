// ==========================================================================
// Batch processing dialog: rename pattern, convert, resize, rotate, strip
// EXIF/GPS for the selection; live name preview, progress, cancel.
// Everything runs in the backend's photo_batch (parallel, EXIF aware).
// ==========================================================================

import { batchPreview } from "./logic.js";

const PREVIEW_LIMIT = 200;

const TEMPLATE = `
  <div class="ps-modal-card ps-batch-card" role="dialog" aria-label="Toplu işlem">
    <div class="ps-modal-head">
      <h3>Toplu İşlem</h3>
      <span class="ps-batch-count"></span>
      <button class="btn-icon-close" data-act="close" title="Kapat">✕</button>
    </div>
    <div class="ps-batch-body">
      <form class="ps-batch-form" autocomplete="off">
        <fieldset>
          <legend>Yeniden adlandır</legend>
          <input name="template" class="modal-input" value="{name}" spellcheck="false" aria-label="Ad deseni">
          <div class="ps-chips ps-token-chips">
            <button type="button" class="ps-chip" data-token="{name}">{name}</button>
            <button type="button" class="ps-chip" data-token="{counter:3}">{counter:3}</button>
            <button type="button" class="ps-chip" data-token="{date}">{date}</button>
            <button type="button" class="ps-chip" data-token="{ext}">{ext}</button>
          </div>
          <label class="ps-inline">Sayaç başlangıcı <input name="counterStart" type="number" min="0" value="1" class="modal-input ps-num"></label>
        </fieldset>
        <fieldset>
          <legend>Dönüştür</legend>
          <label class="ps-inline">Biçim
            <select name="format" class="modal-select">
              <option value="same">Aynı biçim</option><option value="jpeg">JPEG</option><option value="png">PNG</option>
              <option value="webp">WebP</option><option value="avif">AVIF</option>
            </select>
          </label>
          <label class="ps-inline">Kalite <input name="quality" type="range" min="1" max="100" value="90" class="filter-slider"><output name="qualityOut">90</output></label>
        </fieldset>
        <fieldset>
          <legend>Boyutlandır ve döndür</legend>
          <label class="ps-inline">
            <select name="resizeMode" class="modal-select">
              <option value="none">Boyut değişmesin</option><option value="longEdge">Uzun kenar (px)</option><option value="percent">Yüzde (%)</option>
            </select>
            <input name="resizeValue" type="number" min="1" value="1920" class="modal-input ps-num">
          </label>
          <label class="ps-inline">Döndür
            <select name="rotate" class="modal-select">
              <option value="0">Yok</option><option value="90">90° sağa</option><option value="180">180°</option><option value="-90">90° sola</option>
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Meta veriler ve çıktı</legend>
          <label class="ps-inline">EXIF
            <select name="metadata" class="modal-select">
              <option value="keep">Koru</option><option value="stripGps">Konumu (GPS) temizle</option><option value="strip">Tümünü temizle</option>
            </select>
          </label>
          <label class="ps-inline">Klasör
            <select name="dest" class="modal-select"><option value="same">Kaynakla aynı</option><option value="dir">Başka klasör…</option></select>
          </label>
          <div class="ps-batch-dir" hidden></div>
          <label class="ps-check"><input type="checkbox" name="removeSource"> Kaynak dosyaları kaldır (taşı / yeniden adlandır)</label>
        </fieldset>
      </form>
      <div class="ps-batch-preview">
        <div class="ps-batch-preview-head">Önizleme</div>
        <ol class="ps-batch-list"></ol>
      </div>
    </div>
    <div class="ps-batch-progress" hidden>
      <div class="ps-progress"><div class="ps-progress-bar"></div></div>
      <span class="ps-batch-status" role="status"></span>
    </div>
    <div class="ps-modal-actions">
      <button class="btn-primary btn-sm" data-act="start">Başlat</button>
      <button class="btn-secondary btn-sm" data-act="cancel" hidden>İptal</button>
      <button class="btn-ghost btn-sm" data-act="close">Kapat</button>
    </div>
  </div>`;

/** Form values -> photo_batch { ops, output } (pure; exported for tests). */
export function batchJobFromForm(v) {
  const ops = [];
  const rot = Number(v.rotate) || 0;
  if (rot) ops.push({ op: "rotate", degrees: rot });
  const size = Number(v.resizeValue);
  if (v.resizeMode === "longEdge" && size > 0) ops.push({ op: "resize", longEdge: Math.round(size) });
  if (v.resizeMode === "percent" && size > 0) ops.push({ op: "resize", percent: size });
  const output = {
    format: v.format || "same",
    quality: Math.max(1, Math.min(100, Number(v.quality) || 90)),
    nameTemplate: v.template?.trim() || "{name}",
    counterStart: Math.max(0, Number(v.counterStart) || 0),
    conflict: "rename",
    metadata: v.metadata || "keep",
    lossless: true,
    removeSource: !!v.removeSource,
    dir: v.dest === "dir" && v.dir ? v.dir : null,
  };
  return { ops, output };
}

/** root: modal overlay element. deps: { invoke, listen, dialogOpen, toast, onDone(summary) } */
export function createBatch(root, { invoke, listen, dialogOpen, toast, onDone }) {
  root.innerHTML = TEMPLATE;
  const $ = (s) => root.querySelector(s);
  const form = $(".ps-batch-form");
  const list = $(".ps-batch-list");
  const bar = $(".ps-progress-bar");
  const statusEl = $(".ps-batch-status");
  const progress = $(".ps-batch-progress");
  const dirEl = $(".ps-batch-dir");
  let items = [];
  let outDir = null;
  let running = null; // jobId

  const values = () => {
    const f = new FormData(form);
    return {
      template: f.get("template"), counterStart: f.get("counterStart"), format: f.get("format"), quality: f.get("quality"),
      resizeMode: f.get("resizeMode"), resizeValue: f.get("resizeValue"), rotate: f.get("rotate"), metadata: f.get("metadata"),
      dest: f.get("dest"), dir: outDir, removeSource: f.get("removeSource") === "on",
    };
  };

  function updatePreview() {
    const v = values();
    form.qualityOut.value = v.quality;
    form.resizeValue.disabled = v.resizeMode === "none";
    const rows = batchPreview(items.slice(0, PREVIEW_LIMIT), { nameTemplate: v.template, counterStart: Number(v.counterStart) || 0, format: v.format });
    list.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("span"), { className: "ps-from", textContent: r.from });
      const b = Object.assign(document.createElement("span"), { className: "ps-to", textContent: r.to });
      li.append(a, " → ", b);
      return li;
    }));
    if (items.length > PREVIEW_LIMIT) {
      list.append(Object.assign(document.createElement("li"), { className: "ps-more", textContent: `… ve ${items.length - PREVIEW_LIMIT} dosya daha` }));
    }
    dirEl.hidden = v.dest !== "dir";
    dirEl.textContent = outDir ?? "Klasör seçilmedi";
  }

  async function chooseDir() {
    if (!dialogOpen) return;
    const picked = await dialogOpen({ directory: true, multiple: false }).catch(() => null);
    if (picked) outDir = Array.isArray(picked) ? picked[0] : picked;
    else if (!outDir) form.dest.value = "same";
    updatePreview();
  }

  function setRunning(on) {
    $('[data-act="start"]').disabled = on;
    $('[data-act="cancel"]').hidden = !on;
    for (const el of form.elements) el.disabled = on;
    root.dataset.running = on ? "1" : "0";
    if (!on) updatePreview();
  }

  async function start() {
    if (running || !items.length) return;
    const v = values();
    if (v.dest === "dir" && !outDir) {
      toast("Önce bir çıktı klasörü seçin");
      return;
    }
    const { ops, output } = batchJobFromForm(v);
    if (output.removeSource && !window.confirm(`${items.length} kaynak dosya işlemden sonra silinecek (taşıma / yeniden adlandırma). Devam edilsin mi?`)) return;
    const jobId = `batch-${Date.now()}`;
    running = jobId;
    setRunning(true);
    progress.hidden = false;
    bar.style.width = "0%";
    statusEl.textContent = `0 / ${items.length}`;
    const un = await listen?.("photo-batch-progress", (e) => {
      const p = e.payload;
      if (p.jobId !== jobId) return;
      bar.style.width = `${(100 * p.done) / p.total}%`;
      statusEl.textContent = `${p.done} / ${p.total}${p.error && p.error !== "[cancelled]" ? ` · hata: ${p.input.split(/[\\/]/).pop()}` : ""}`;
      root.dataset.done = p.done;
    });
    try {
      const s = await invoke("photo_batch", { job: { jobId, files: items.map((i) => i.path), ops, output } });
      root.dataset.summary = JSON.stringify({ total: s.total, succeeded: s.succeeded, failed: s.failed, skipped: s.skipped, cancelled: s.cancelled, elapsedMs: s.elapsedMs });
      const cancelledN = s.results.filter((r) => r.error === "[cancelled]").length;
      statusEl.textContent = [
        `${s.succeeded} başarılı`, s.failed ? `${s.failed} hatalı` : "", s.skipped ? `${s.skipped} atlandı` : "",
        s.cancelled ? `${cancelledN} iptal edildi` : "", `${(s.elapsedMs / 1000).toFixed(1)} sn`,
      ].filter(Boolean).join(" · ");
      const firstError = s.results.find((r) => !r.ok && r.error && r.error !== "[cancelled]");
      if (firstError) statusEl.title = `${firstError.input}: ${firstError.error}`;
      toast(s.cancelled ? "Toplu işlem iptal edildi" : `Toplu işlem bitti: ${s.succeeded} dosya`);
      onDone?.(s);
    } catch (e) {
      statusEl.textContent = `Hata: ${e}`;
    } finally {
      un?.();
      running = null;
      setRunning(false);
    }
  }

  function cancel() {
    if (running) invoke("photo_cancel", { id: running }).catch(() => {});
  }

  form.addEventListener("input", updatePreview);
  form.addEventListener("change", (e) => {
    if (e.target.name === "dest" && e.target.value === "dir" && !outDir) chooseDir();
    updatePreview();
  });
  form.addEventListener("submit", (e) => e.preventDefault());
  dirEl.addEventListener("click", chooseDir);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.token) {
      const input = form.template;
      const pos = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, pos) + b.dataset.token + input.value.slice(input.selectionEnd ?? pos);
      updatePreview();
    } else if (b.dataset.act === "start") start();
    else if (b.dataset.act === "cancel") cancel();
    else if (b.dataset.act === "close") close();
  });
  root.addEventListener("mousedown", (e) => { if (e.target === root && !running) close(); });

  function open(selection) {
    items = selection.filter((i) => i.kind !== "video");
    root.hidden = false;
    progress.hidden = true;
    statusEl.textContent = "";
    root.dataset.summary = "";
    root.dataset.done = "0";
    $(".ps-batch-count").textContent = `${items.length} fotoğraf`;
    updatePreview();
    form.template.focus();
  }

  function close() {
    if (running) return false;
    root.hidden = true;
    return true;
  }

  return {
    open, close, start, cancel,
    get isOpen() { return !root.hidden; },
    handleKey(e) {
      if (root.hidden) return false;
      if (e.key === "Escape") { running ? cancel() : close(); return true; }
      return false; // typing in the form must work
    },
  };
}
