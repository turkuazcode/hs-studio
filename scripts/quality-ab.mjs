// Blind A/B rating sheet for the Q02 photo set (Plan 14 Q02: product names hidden, random
// order and side, equal resolution and zoom, at least three raters).
//
//   node scripts/quality-ab.mjs sheet [--pairs=lanczos:vho-x4,vho-x4:vho-x4-faces] [--seed=N]
//       -> tests/.results/quality/blind-ab/index.html (+ images, key.json kept OUT of the page)
//   node scripts/quality-ab.mjs score <ratings-1.json> [ratings-2.json ...]
//       -> preference per profile pair, rubric means, red-flag rate, number of raters
//
// Needs a finished `npm run test:quality` run (tests/.results/quality/photo.json and the
// output images in tests/.cache/quality/out/photo). This is a rater tool, not app UI.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = join(ROOT, "tests", ".results", "quality");
const IMAGES = join(ROOT, "tests", ".cache", "quality", "out", "photo");
const SET = join(ROOT, "tests", ".cache", "quality", "set");
const SHEET = join(RESULTS, "blind-ab");
const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sheet() {
  const run = JSON.parse(readFileSync(join(RESULTS, "photo.json"), "utf8"));
  const pairs = String(opt.pairs ?? "lanczos:vho-x4,vho-x4:vho-x4-faces").split(",").map((p) => p.split(":"));
  const seed = Number(opt.seed ?? Date.now() % 1e9);
  const rand = rng(seed);
  const items = [];
  for (const [a, b] of pairs) {
    for (const id of [...new Set(run.results.map((r) => r.id))]) {
      const ra = run.results.find((r) => r.id === id && r.profile === a), rb = run.results.find((r) => r.id === id && r.profile === b);
      if (!ra || !rb) continue;
      const swap = rand() < 0.5;
      items.push({ id, left: swap ? b : a, right: swap ? a : b, hasRef: existsSync(join(SET, id, "ref.png")) });
    }
  }
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  rmSync(SHEET, { recursive: true, force: true });
  mkdirSync(SHEET, { recursive: true });
  const key = items.map((it, n) => {
    const q = `q${String(n + 1).padStart(2, "0")}`;
    copyFileSync(join(IMAGES, `${it.left}--${it.id}.png`), join(SHEET, `${q}-a.png`));
    copyFileSync(join(IMAGES, `${it.right}--${it.id}.png`), join(SHEET, `${q}-b.png`));
    copyFileSync(join(SET, it.id, "input.png"), join(SHEET, `${q}-input.png`));
    return { q, sample: it.id, a: it.left, b: it.right };
  });
  writeFileSync(join(SHEET, "key.json"), JSON.stringify({ seed, run: run.meta, key }, null, 2));
  const rubric = ["naturalness / doğallık", "detail / ayrıntı", "fidelity (person, text) / kişi-yazı sadakati", "artifacts (5 = none) / bozulma (5 = yok)"];
  const card = ({ q }) => `
  <section class="q" data-q="${q}">
    <h2>${q}</h2>
    <div class="row">
      <figure><img src="${q}-input.png" class="in" alt=""><figcaption>input / girdi</figcaption></figure>
      <figure><img src="${q}-a.png" alt=""><figcaption>A</figcaption></figure>
      <figure><img src="${q}-b.png" alt=""><figcaption>B</figcaption></figure>
    </div>
    <fieldset><legend>Preference / Tercih</legend>
      ${["A", "B", "equal"].map((v) => `<label><input type="radio" name="${q}-pref" value="${v}"> ${v === "equal" ? "equal / eşit" : v}</label>`).join(" ")}
    </fieldset>
    ${["A", "B"].map((s) => `<fieldset><legend>${s}: 1–5</legend>${rubric.map((r, k) =>
      `<label>${r} <select name="${q}-${s}-${k}"><option></option>${[1, 2, 3, 4, 5].map((n) => `<option>${n}</option>`).join("")}</select></label>`).join("")}
      <label><input type="checkbox" name="${q}-${s}-flag"> identity/text changed / kimlik-yazı değişmiş</label></fieldset>`).join("")}
  </section>`;
  writeFileSync(join(SHEET, "index.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VHO blind A/B</title><style>
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1b1b1b; --line: #ccc; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #eee; --line: #444; } }
body { font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0 auto; padding: 16px; max-width: 1100px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; } figure { margin: 0; text-align: center; }
img { width: 320px; height: 320px; object-fit: contain; image-rendering: auto; background: repeating-conic-gradient(#888 0 25%, #bbb 0 50%) 0 0 / 16px 16px; }
img.in { image-rendering: pixelated; }
section { border-top: 1px solid var(--line); padding: 12px 0; } fieldset { border: 1px solid var(--line); margin: 8px 0; }
label { display: inline-block; margin: 4px 12px 4px 0; } button { font: inherit; padding: 8px 16px; }
</style></head><body>
<h1>Blind A/B / Kör karşılaştırma</h1>
<p>A and B are two restorations of the same input, shown at the same size; which method is which is hidden and the side is random.
Rate what you see; more sharpness alone is not better. / A ve B aynı girdinin iki farklı iyileştirmesidir, aynı boyutta gösterilir; hangisinin hangi yöntem olduğu gizlidir.
Yalnızca daha keskin olmak daha iyi demek değildir.</p>
<label>Rater / Değerlendirici <input id="rater" autocomplete="off"></label>
${key.map(card).join("")}
<p><button id="save">Download ratings / Puanları indir</button></p>
<script>
document.getElementById("save").onclick = () => {
  const out = { rater: document.getElementById("rater").value.trim() || "anonymous", date: new Date().toISOString(), answers: {} };
  for (const s of document.querySelectorAll("section.q")) {
    const q = s.dataset.q, a = {};
    a.pref = s.querySelector('input[name="' + q + '-pref"]:checked')?.value ?? null;
    for (const side of ["A", "B"]) {
      a[side] = { scores: [0, 1, 2, 3].map((k) => Number(s.querySelector('select[name="' + q + "-" + side + "-" + k + '"]').value) || null),
        flag: s.querySelector('input[name="' + q + "-" + side + '-flag"]').checked };
    }
    out.answers[q] = a;
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "ratings-" + out.rater.replace(/[^a-z0-9_-]/gi, "_") + ".json";
  link.click();
};
</script></body></html>
`);
  console.log(`blind A/B sheet: ${join(SHEET, "index.html")} (${key.length} questions, seed ${seed}); key: ${join(SHEET, "key.json")} — do not show the key to raters`);
}

function score(files) {
  const { key } = JSON.parse(readFileSync(join(SHEET, "key.json"), "utf8"));
  const raters = new Set();
  const agg = {}; // "x vs y" -> { x: wins, y: wins, equal, n }
  const rubric = {}; // profile -> sums
  for (const f of files) {
    const r = JSON.parse(readFileSync(f, "utf8"));
    raters.add(r.rater);
    for (const k of key) {
      const a = r.answers[k.q];
      if (!a) continue;
      const pair = [k.a, k.b].sort().join(" vs ");
      agg[pair] ??= { n: 0, equal: 0, [k.a]: 0, [k.b]: 0 };
      if (a.pref) {
        agg[pair].n++;
        if (a.pref === "equal") agg[pair].equal++;
        else agg[pair][a.pref === "A" ? k.a : k.b]++;
      }
      for (const [side, prof] of [["A", k.a], ["B", k.b]]) {
        rubric[prof] ??= { n: 0, sums: [0, 0, 0, 0], counts: [0, 0, 0, 0], flags: 0 };
        rubric[prof].n++;
        a[side].scores.forEach((v, i) => { if (v) { rubric[prof].sums[i] += v; rubric[prof].counts[i]++; } });
        if (a[side].flag) rubric[prof].flags++;
      }
    }
  }
  console.log(`raters: ${raters.size}${raters.size < 3 ? " (fewer than 3: label the result as preliminary / developer-only)" : ""}`);
  for (const [pair, v] of Object.entries(agg)) console.log(`${pair}: ${JSON.stringify(v)}`);
  for (const [p, v] of Object.entries(rubric)) {
    console.log(`${p}: rubric means ${v.sums.map((s, i) => (v.counts[i] ? (s / v.counts[i]).toFixed(2) : "—")).join(" / ")} (naturalness / detail / fidelity / artifacts), red flags ${v.flags}/${v.n}`);
  }
}

if (cmd === "sheet") sheet();
else if (cmd === "score") score(rest.filter((a) => !a.startsWith("--")));
else { console.error("usage: node scripts/quality-ab.mjs sheet|score ..."); process.exit(2); }
