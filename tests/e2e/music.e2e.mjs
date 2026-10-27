// Music mode (Plan 13/L03) in the real app with generated audio (ffmpeg, temp folder):
// own layout without video controls, tags + cover, system media controls (Windows SMTC read
// back from the OS object) follow the track, simulated media key, shuffle / repeat persisted,
// gapless switch inside libmpv (no reload), ReplayGain options (libmpv) and factor (HTML5),
// album ReplayGain written, library artist / album views, saved list survives a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HTML5_ENGINE, defaultExe, launchApp, makeDataDir, mpvStaged, removeDir } from "./lib/app.mjs";
import { sleep } from "./lib/cdp.mjs";

const J = JSON.stringify;
const FFMPEG = ["", "mpv", join("resources", "mpv")].map((s) => join(dirname(defaultExe()), s, "ffmpeg.exe")).find((p) => existsSync(p));
const skip = !FFMPEG ? "ffmpeg.exe not staged (npm run stage:mpv)" : !mpvStaged() ? "libmpv not staged" : false;
const inv = (cmd, args = {}) => `__TAURI__.core.invoke(${J(cmd)}, ${J(args)})`;

function ffmpeg(args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe", timeout: 60000 });
}

/** Three tagged FLAC tracks (6 s, different levels) + a cover image. */
function makeAlbum(dir) {
  const tracks = [];
  const levels = [-20, -10, -6];
  levels.forEach((db, i) => {
    const p = join(dir, `0${i + 1} Parça ${i + 1}.flac`);
    ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${440 + i * 110}:sample_rate=48000:duration=6`, "-af", `volume=${db}dB`, "-ac", "2",
      "-metadata", `title=Şarkı ${i + 1}`, "-metadata", "artist=Barış Manço", "-metadata", "album=Sakla Samanı", "-metadata", "genre=Rock",
      "-metadata", `track=${i + 1}`, "-c:a", "flac", p]);
    tracks.push(p);
  });
  const cover = join(dir, "kapak.png");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x2266aa:s=64x64:d=1", "-frames:v", "1", cover]);
  return { tracks, cover };
}

const smtc = (app) => app.eval(inv("media_controls_state"));

test("music mode: layout, system controls, gapless, ReplayGain, library views, restart", { timeout: 300000, skip }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "vho-e2e-music-"));
  const albumDir = join(work, "Müzik", "Sakla Samanı");
  execFileSync("cmd", ["/c", "mkdir", albumDir]);
  const { tracks, cover } = makeAlbum(albumDir);
  const dataDir = await makeDataDir();
  let app = await launchApp({ dataDir });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!window.__vhoMusic`, { timeoutMs: 15000 });
    assert.equal(await app.eval("window.__vhoEngine.kind"), "html5"); // nothing loaded yet

    await t.test("album ReplayGain (one joint measurement) and the cover are written to the files", async () => {
      const r = await app.eval(inv("replaygain_album", { paths: tracks, write: true }));
      assert.equal(r.method, "joint");
      assert.equal(r.tracks.length, 3);
      assert.ok(r.albumGainDb < (r.tracks[0].trackGainDb + r.tracks[2].trackGainDb) / 2, "album gain is not the mean of track gains");
      const back = await app.eval(inv("tags_write", { path: tracks[0], tags: { cover } }));
      assert.ok(back.cover, "cover embedded");
      assert.equal(back.replaygainAlbumGain, `${r.albumGainDb.toFixed(2)} dB`);
    });

    await t.test("music layout: own screen, no video controls, tags and cover", async () => {
      await app.eval(`window.__vhoEngine.openPaths(${J(tracks)}), true`);
      await app.waitFor(`window.__vhoEngine.kind === "mpv" && window.__vhoEngine.duration > 5 && !document.getElementById("music-mode").hidden`, { timeoutMs: 20000, message: "music mode" });
      assert.equal(await app.eval(`document.documentElement.classList.contains("music-mode")`), true);
      await app.waitFor(`document.getElementById("music-title").textContent === "Şarkı 1"`, { timeoutMs: 8000 });
      assert.equal(await app.text("#music-meta"), "Barış Manço · Sakla Samanı");
      assert.equal(await app.eval(`document.getElementById("music-cover").dataset.hasCover`), "1");
      for (const id of ["btn-snapshot", "btn-aspect-ratio", "btn-pip", "btn-toggle-subtitles", "btn-toggle-effects"]) {
        assert.equal(await app.eval(`getComputedStyle(document.getElementById(${J(id)})).display`), "none", id);
      }
      assert.deepEqual(await app.eval(`[...document.querySelectorAll("#music-upnext li")].map((l) => l.textContent)`), ["02 Parça 2.flac", "03 Parça 3.flac"]);
    });

    await t.test("ReplayGain options reach libmpv (album, clipping prevention)", async () => {
      assert.equal(await app.eval(`window.__vhoEngine && __TAURI__.core.invoke("engine_get", { name: "replaygain" })`), "album");
      assert.equal(await app.eval(`__TAURI__.core.invoke("engine_get", { name: "replaygain-clip" })`), true);
      assert.equal(await app.eval(`__TAURI__.core.invoke("engine_get", { name: "gapless-audio" })`), "yes");
    });

    await t.test("system media controls show the playing track; a media key moves to the next one", async () => {
      const end = Date.now() + 8000;
      let s = await smtc(app);
      while (s.title !== "Şarkı 1" && Date.now() < end) { await sleep(200); s = await smtc(app); }
      assert.equal(s.available, true);
      assert.deepEqual([s.title, s.artist, s.album, s.status], ["Şarkı 1", "Barış Manço", "Sakla Samanı", "playing"]);
      assert.equal(s.hasThumbnail, true);
      await app.eval(inv("media_controls_simulate", { button: "next" }));
      await app.waitFor(`document.getElementById("music-title").textContent === "Şarkı 2"`, { timeoutMs: 10000, message: "next track" });
      const end2 = Date.now() + 8000;
      s = await smtc(app);
      while (s.title !== "Şarkı 2" && Date.now() < end2) { await sleep(200); s = await smtc(app); }
      assert.equal(s.title, "Şarkı 2", "the OS card shows the new track");
      await app.eval(inv("media_controls_simulate", { button: "pause" }));
      await app.waitFor("window.__vhoEngine.paused", { timeoutMs: 5000 });
      const end3 = Date.now() + 5000;
      while ((await smtc(app)).status !== "paused" && Date.now() < end3) await sleep(200);
      assert.equal((await smtc(app)).status, "paused");
      await app.eval(inv("media_controls_simulate", { button: "play" }));
      await app.waitFor("!window.__vhoEngine.paused", { timeoutMs: 5000 });
    });

    await t.test("gapless: the next track is switched inside libmpv without reloading", async () => {
      await app.waitFor("window.__vhoMusic.queuedIndex === 2", { timeoutMs: 5000, message: "track 3 queued in mpv" });
      const loadsBefore = await app.eval(`__invokeLog.filter((c) => c === "engine_load").length`);
      await app.eval("window.__vhoEngine.seek(window.__vhoEngine.duration - 1.0), true");
      await app.waitFor(`document.getElementById("music-title").textContent === "Şarkı 3"`, { timeoutMs: 15000, message: "gapless switch" });
      assert.equal(await app.eval(`document.documentElement.dataset.gaplessSwitches`), "1");
      assert.equal(await app.eval(`__invokeLog.filter((c) => c === "engine_load").length`), loadsBefore, "no loadfile replace");
      assert.equal(await app.text("#current-filename"), "03 Parça 3.flac");
      const end = Date.now() + 8000;
      while ((await smtc(app)).title !== "Şarkı 3" && Date.now() < end) await sleep(200);
      assert.equal((await smtc(app)).title, "Şarkı 3");
    });

    await t.test("shuffle / repeat buttons are stored settings", async () => {
      await app.click("#music-repeat");
      await app.click("#music-shuffle");
      assert.deepEqual(await app.eval(`[window.__vhoMusic.repeat, window.__vhoMusic.shuffle]`), ["all", true]);
      await app.click("#music-shuffle");
      assert.equal(await app.eval("window.__vhoMusic.shuffle"), false);
    });

    await t.test("library: artist and album views, drill into the album; a saved list", async () => {
      await app.eval(`window.__vhoLibrary.api.addFolder(${J(join(work, "Müzik"))})`);
      await app.waitFor(`window.__vhoLibrary.api.query({ kind: "audio" }).then((p) => p.total === 3)`, { timeoutMs: 20000, message: "scanned" });
      await app.waitFor(`window.__vhoLibrary.api.musicGroups("album").then((g) => g.length === 1 && g[0].name === "Sakla Samanı")`, { timeoutMs: 10000, message: "tags read" });
      await app.eval(`(window.__vhoLibrary.show("audio"), true)`);
      await app.eval(`(() => { const s = document.getElementById("lib-view"); s.value = "albums"; s.dispatchEvent(new Event("change")); return true; })()`);
      await app.waitFor(`document.querySelector("#lib-list .lib-group .lib-name")?.textContent === "Sakla Samanı"`, { timeoutMs: 8000 });
      await app.eval(`document.querySelector("#lib-list .lib-group").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
      await app.waitFor(`document.getElementById("library").dataset.drill === "Sakla Samanı" && document.getElementById("library").dataset.total === "3"`, { timeoutMs: 8000 });
      await app.waitFor(`[...document.querySelectorAll("#lib-list .lib-name")].map((e) => e.textContent).join("|") === "Şarkı 1|Şarkı 2|Şarkı 3"`, { timeoutMs: 8000, message: "album tracks in track order" });
      const artists = await app.eval(`window.__vhoLibrary.api.musicGroups("artist")`);
      assert.deepEqual(artists.map((g) => [g.name, g.count]), [["Barış Manço", 3]]);
      const id = await app.eval(`window.__vhoLibrary.api.savePlaylist("Yolculuk", ${J(tracks.map((p) => ({ path: p })))})`);
      assert.match(id, /^[0-9a-f-]{36}$/);
      await app.eval(`(window.__vhoLibrary.hide(), true)`);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }

  // restart: settings, saved list and album views are still there
  app = await launchApp({ dataDir });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!window.__vhoLibrary?.api`, { timeoutMs: 15000 });
    await t.test("after a restart: saved list, album group, repeat setting", async () => {
      const lists = await app.eval(`window.__vhoLibrary.api.playlists()`);
      assert.deepEqual(lists.map((l) => [l.name, l.count]), [["Yolculuk", 3]]);
      const albums = await app.eval(`window.__vhoLibrary.api.musicGroups("album")`);
      assert.deepEqual(albums.map((g) => g.name), ["Sakla Samanı"]);
      await app.waitFor(`window.__vhoMusic.repeat === "all"`, { timeoutMs: 5000 });
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
  }

  // HTML5 engine: the same ReplayGain rule lowers the element volume
  app = await launchApp({ dataDir, env: HTML5_ENGINE });
  try {
    await app.waitFor(`document.documentElement.dataset.platformReady === "1" && !!window.__vhoMusic`, { timeoutMs: 15000 });
    await t.test("HTML5 engine: ReplayGain factor from the album tags", async () => {
      const tags = await app.eval(inv("tags_read", { path: tracks[2] }));
      await app.eval(`window.__vhoEngine.openPaths([${J(tracks[2])}]), true`);
      await app.waitFor(`!!document.documentElement.dataset.replayGain`, { timeoutMs: 15000, message: "replaygain applied" });
      const f = Number(await app.eval("document.documentElement.dataset.replayGain"));
      const gain = parseFloat(tags.replaygainAlbumGain);
      const peak = parseFloat(tags.replaygainAlbumPeak);
      const expected = Math.min(10 ** (gain / 20), 1 / peak);
      assert.ok(Math.abs(f - expected) < 1e-3, `${f} vs ${expected}`);
      assert.ok(f < 1);
    });
    assert.deepEqual(await app.errors(), []);
  } finally {
    await app.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await removeDir(dataDir);
  }
});
