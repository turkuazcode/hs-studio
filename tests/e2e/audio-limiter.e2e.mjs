// S04: the volume booster (up to 200 %) is NOT lossless. Both engines must end the boosted
// signal in a limiter so loud material is held under full scale instead of hard-clipping.
//
// Fixture: a loud synthetic tone (440 Hz + 3 kHz, peak 0.7 = -3.1 dBFS, 2 s, 48 kHz, 16-bit
// mono WAV) written to a temp folder by this test (no user media).
//  - libmpv path: the exact af chain the app sends to mpv (audioFilterChain with the 200 %
//    boost) is run through the staged ffmpeg.exe, which uses the SAME LGPL libavfilter build
//    as libmpv. Measured with astats: peak <= -0.9 dBFS while RMS still rises; mpv's own
//    cubic volume at 200 % (8x) and the boost without limiter both exceed 0 dBFS (= clipping).
//  - HTML5 path: the app's own Web Audio limiter (createLimiter) rendered in an
//    OfflineAudioContext inside vho.exe's WebView2 with the 200 % gain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HTML5_ENGINE, defaultExe, launchApp } from "./lib/app.mjs";
import { audioFilterChain } from "../../src/media/engine/engine.js";
import { volumeToGain } from "../../src/media/audio-engine.js";

// Same lookup locations as the backend (actions/ffmpeg.rs): next to the exe, exe\mpv\, resources\mpv\.
const FFMPEG = ["", "mpv", join("resources", "mpv")]
  .map((sub) => join(dirname(defaultExe()), sub, "ffmpeg.exe"))
  .find((p) => existsSync(p)) ?? join(dirname(defaultExe()), "ffmpeg.exe");
const skipFfmpeg = existsSync(FFMPEG) ? false : "ffmpeg.exe not staged next to vho.exe (npm run stage:mpv)";

const RATE = 48000;
const PEAK = 0.7;

/** 16-bit mono PCM WAV: 440 Hz + 3 kHz, normalised to PEAK. */
function loudToneWav(seconds = 2, peak = PEAK) {
  const n = RATE * seconds;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const v = (Math.sin(2 * Math.PI * 440 * t) * 0.7 + Math.sin(2 * Math.PI * 3000 * t) * 0.3) * peak;
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Runs `filters` + astats with ffmpeg (float pipeline, so overs stay measurable). */
function runStats(wav, filters) {
  const af = [filters, "astats=metadata=0"].filter(Boolean).join(",");
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-i", wav, "-af", af, "-f", "null", "-"],
    { cwd: dirname(FFMPEG), encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error(`ffmpeg exit ${r.status}: ${r.stderr}`);
  const overall = r.stderr.slice(r.stderr.lastIndexOf("Overall"));
  const num = (label) => {
    const m = overall.match(new RegExp(`${label}:\\s*(-?[\\d.]+|-inf)`));
    assert.ok(m, `astats ${label} in:
${r.stderr.slice(-1500)}`);
    return m[1] === "-inf" ? -Infinity : Number(m[1]);
  };
  return { peakDb: num("Peak level dB"), rmsDb: num("RMS level dB") };
}

test("booster limiter: libmpv chain (same LGPL libavfilter via ffmpeg.exe)", { skip: skipFfmpeg, timeout: 120000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-limiter-"));
  try {
    const wav = join(dir, "loud-tone.wav");
    writeFileSync(wav, loudToneWav());
    const chain = audioFilterChain({ boost: volumeToGain(200) });
    const inner = chain.replace(/^lavfi=\[/, "").replace(/\]$/, "");
    assert.match(inner, /^volume=2\.500,alimiter=/);

    const src = runStats(wav, "");
    const mpvCubic = runStats(wav, "volume=8");              // mpv's own volume=200 (cubic curve)
    const noLimiter = runStats(wav, "volume=2.500");         // boost alone
    const limited = runStats(wav, inner);                    // what the app sends to mpv now

    assert.ok(Math.abs(src.peakDb - 20 * Math.log10(PEAK)) < 0.2, `fixture peak ${src.peakDb} dB`);
    assert.ok(mpvCubic.peakDb > 0, `mpv cubic 200 % would clip: ${mpvCubic.peakDb} dB`);
    assert.ok(noLimiter.peakDb > 0, `boost without limiter would clip: ${noLimiter.peakDb} dB`);
    assert.ok(limited.peakDb <= -0.9, `limited peak ${limited.peakDb} dBFS`);
    // loud material gains little (the limiter holds it), quiet material gets the full +8 dB
    assert.ok(limited.rmsDb > src.rmsDb + 1.5, `boost still louder: ${src.rmsDb} -> ${limited.rmsDb} dB RMS`);
    const quiet = join(dir, "quiet-tone.wav");
    writeFileSync(quiet, loudToneWav(2, 0.1));
    const q0 = runStats(quiet, "");
    const q1 = runStats(quiet, inner);
    assert.ok(Math.abs(q1.rmsDb - q0.rmsDb - 20 * Math.log10(2.5)) < 0.3, `quiet tone +8 dB: ${q0.rmsDb} -> ${q1.rmsDb}`);
    t.diagnostic(`loud: src peak ${src.peakDb} dB, mpv cubic ${mpvCubic.peakDb} dB, no limiter ${noLimiter.peakDb} dB, ` +
      `limited ${limited.peakDb} dB (rms ${src.rmsDb} -> ${limited.rmsDb}); quiet rms ${q0.rmsDb} -> ${q1.rmsDb}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("booster limiter: HTML5 Web Audio graph (createLimiter) in vho.exe", { timeout: 120000 }, async () => {
  const b64 = loudToneWav().toString("base64");
  const app = await launchApp({ env: HTML5_ENGINE });
  try {
    const r = await app.eval(`(async () => {
      const { createLimiter, volumeToGain } = await import("/media/audio-engine.js");
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const buf = await new OfflineAudioContext(1, ${RATE}, ${RATE}).decodeAudioData(bytes.buffer);
      const stats = (d) => {
        let peak = 0, over = 0, sum = 0;
        for (const x of d) { const a = Math.abs(x); if (a > peak) peak = a; if (a >= 1) over++; sum += x * x; }
        return { peak, over, rms: Math.sqrt(sum / d.length) };
      };
      const render = async (gain, limiter) => {
        const ctx = new OfflineAudioContext(1, buf.length, buf.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g);
        if (limiter) { const l = createLimiter(ctx); g.connect(l.input); l.output.connect(ctx.destination); }
        else g.connect(ctx.destination);
        src.start();
        return stats((await ctx.startRendering()).getChannelData(0));
      };
      return {
        source: stats(buf.getChannelData(0)),
        raw: await render(volumeToGain(200), false),
        limited: await render(volumeToGain(200), true),
      };
    })()`, { timeoutMs: 60000 });
    assert.ok(Math.abs(r.source.peak - PEAK) < 0.01, `fixture peak ${r.source.peak}`);
    assert.ok(r.raw.peak > 1 && r.raw.over > 1000, `2.5x without limiter overshoots: peak ${r.raw.peak}, ${r.raw.over} samples >= 1`);
    assert.ok(r.limited.peak < 1, `limited peak ${r.limited.peak}`);
    assert.equal(r.limited.over, 0, "no sample at or above full scale");
    assert.ok(r.limited.rms > r.source.rms * 1.4, `boost still louder: rms ${r.source.rms} -> ${r.limited.rms}`);
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }
});
