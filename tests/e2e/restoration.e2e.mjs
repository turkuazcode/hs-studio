// V01 (Plan 12): source probe + restoration recipe through the real app IPC
// (restoration_probe / restoration_recipe) with the staged LGPL ffmpeg.
// Fixtures are GENERATED here (ffmpeg lavfi) in a fresh temp folder; nothing personal is read.
// The main UI is unchanged: video restoration stays labelled "not ready" (video.e2e checks it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultExe, launchApp } from "./lib/app.mjs";

const FFMPEG = ["", "mpv", join("resources", "mpv")]
  .map((sub) => join(dirname(defaultExe()), sub, "ffmpeg.exe"))
  .find((p) => existsSync(p)) ?? join(dirname(defaultExe()), "ffmpeg.exe");
const skipFfmpeg = existsSync(FFMPEG) ? false : "ffmpeg.exe not staged next to vho.exe (npm run stage:mpv)";

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { cwd: dirname(FFMPEG), stdio: "pipe", timeout: 60000 });
}

const inv = (cmd, args) => `__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;

test("restoration: probe + recipe (interlaced, lying flag, rotation+SAR, HDR, multi-audio)", { timeout: 240000, skip: skipFfmpeg }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vho-e2e-restoration-"));
  const f = (n) => join(dir, n);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x120:rate=50,weave=first_field=top", "-t", "2",
    "-c:v", "mpeg2video", "-flags", "+ildct+ilme", "-top", "1", "-q:v", "3", f("tff.mpg")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x120:rate=50,weave=first_field=top,setfield=prog", "-t", "2",
    "-c:v", "mpeg4", "-q:v", "3", f("lying.mkv")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=704x576:rate=25,scale=352:288,setsar=16/11", "-t", "1", "-c:v", "mpeg4", f("sar.mp4")]);
  ffmpeg(["-display_rotation", "90", "-i", f("sar.mp4"), "-c", "copy", f("rot.mp4")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25,scale=320:240", "-t", "1", "-vf",
    "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv", "-c:v", "ffv1", f("hdr.mkv")]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25,scale=320:240", "-f", "lavfi", "-i", "sine=frequency=440",
    "-f", "lavfi", "-i", "sine=frequency=880", "-t", "1", "-map", "0", "-map", "1", "-map", "2", "-c:v", "mpeg4", "-c:a", "aac", f("multi.mkv")]);

  const app = await launchApp();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const probe = (name) => app.eval(inv("restoration_probe", { path: f(name) }), { timeoutMs: 90000 });

  await t.test("interlaced TFF: field-rate bwdif, 720p-class target, notify only", async () => {
    const r = await probe("tff.mpg");
    const v = r.report.video;
    assert.equal(v.fieldOrder.value, "tff");
    assert.equal(v.fieldOrder.source, "metadata-and-analysis");
    assert.equal(v.frameRate.mode, "cfr");
    assert.equal(r.assessment.status, "notify", JSON.stringify(r.assessment));
    assert.deepEqual(r.recipe.output.fps, { num: 50, den: 1 });
    assert.match(r.filter, /^bwdif=mode=send_field:parity=tff:deint=all,/);
    assert.match(r.recipeHash, /^sha256:[0-9a-f]{64}$/);
    // never auto-4K: every target ≤ 1080 short side and ≤ 2x
    for (const tg of r.targets) assert.ok(Math.min(tg.width, tg.height) <= 1080 && tg.factor <= 2, JSON.stringify(tg));
    // recipe change → new hash; same recipe → same hash (cached report)
    const same = await app.eval(inv("restoration_recipe", { path: f("tff.mpg"), recipe: r.recipe }));
    assert.equal(same.recipeHash, r.recipeHash);
    const changed = await app.eval(inv("restoration_recipe", { path: f("tff.mpg"), recipe: { ...r.recipe, denoise: { filter: "atadenoise", strength: "light" } } }));
    assert.notEqual(changed.recipeHash, r.recipeHash);
    assert.match(changed.filter, /,atadenoise,/);
  });

  await t.test("progressive flag on interlaced content: blocked until the user confirms", async () => {
    const r = await probe("lying.mkv");
    const fo = r.report.video.fieldOrder;
    assert.deepEqual([fo.metadata, fo.value, fo.source, fo.needsChoice, fo.suggestion], ["progressive", "unknown", "conflict", true, "tff"]);
    assert.equal(r.assessment.status, "blocked");
    assert.ok(r.assessment.blockers.includes("field-order-unconfirmed"));
    const ok = await app.eval(inv("restoration_recipe", { path: f("lying.mkv"),
      recipe: { ...r.recipe, deinterlace: { ...r.recipe.deinterlace, userConfirmed: true } } }));
    assert.notEqual(ok.assessment.status, "blocked", JSON.stringify(ok.assessment));
  });

  await t.test("rotation + non-square pixels: display size and transpose before scale", async () => {
    const r = await probe("rot.mp4");
    const v = r.report.video;
    assert.deepEqual([v.width, v.height, v.rotation, v.displayWidth, v.displayHeight], [352, 288, 90, 288, 512]);
    assert.deepEqual(v.sar, { num: 16, den: 11 });
    assert.deepEqual([r.recipe.scale.width, r.recipe.scale.height], [576, 1024]);
    assert.match(r.filter, /^transpose=cclock,scale=576:1024:flags=lanczos,setsar=1,/);
    assert.equal(v.color.matrix, "unknown");
    assert.ok(r.assessment.notices.includes("color-assumed"));
  });

  await t.test("HDR (PQ, 10-bit) is blocked, output stays SDR BT.709 8-bit", async () => {
    const r = await probe("hdr.mkv");
    assert.equal(r.report.video.dynamicRange, "hdr-pq");
    assert.equal(r.report.video.bitDepth, 10);
    assert.equal(r.assessment.status, "blocked");
    assert.ok(r.assessment.blockers.includes("hdr-unsupported"));
    assert.equal(r.recipe.color.output.transfer, "bt709");
    assert.equal(r.recipe.color.output.bitDepth, 8);
  });

  await t.test("multiple audio streams are listed and copied by default; bad input is an error", async () => {
    const r = await probe("multi.mkv");
    assert.equal(r.report.audio.length, 2);
    assert.equal(r.recipe.audio.policy, "copy-all");
    const err = await app.eval(`${inv("restoration_probe", { path: f("missing.mp4") })}.then(() => "ok", (e) => String(e))`);
    assert.match(err, /^\[invalid\]/);
  });

  assert.deepEqual(await app.errors(), []);
});
