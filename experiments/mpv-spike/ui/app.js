// VHO mpv spike UI: plain HTML controls over the mpv child window + an automated self-test.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, LogicalSize } = window.__TAURI__.window;
const win = getCurrentWindow();
const $ = (id) => document.getElementById(id);

const state = { duration: 0, time: 0, pause: false, tracks: [], counts: {} };
const waiters = [];
const t0 = performance.now();

listen('mpv://event', ({ payload: ev }) => {
  state.counts[ev.event] = (state.counts[ev.event] || 0) + 1;
  if (ev.event === 'property-change') {
    state.counts['prop:' + ev.name] = (state.counts['prop:' + ev.name] || 0) + 1;
    onProp(ev.name, ev.data);
  }
  for (const w of [...waiters]) if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
});

function waitFor(match, ms = 10000) {
  return new Promise((resolve, reject) => {
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout')); } }, ms);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const cmd = (args) => invoke('mpv_command', { args });
const set = (name, value) => invoke('mpv_set', { name, value });
const get = (name) => invoke('mpv_get', { name }).catch((e) => `ERR ${e}`);

function onProp(name, v) {
  if (name === 'time-pos') state.time = v || 0;
  if (name === 'duration') state.duration = v || 0;
  if (name === 'pause') state.pause = v;
  if (name === 'track-list') { state.tracks = v || []; fillTracks(); }
  if (name === 'aid') $('aid').value = String(v);
  if (name === 'sid') $('sid').value = String(v);
  if (!seeking && state.duration) $('seek').value = Math.round((state.time / state.duration) * 1000);
  $('time').textContent = `${fmt(state.time)} / ${fmt(state.duration)}`;
}

function fillTracks() {
  for (const type of ['audio', 'sub']) {
    const sel = $(type === 'audio' ? 'aid' : 'sid');
    sel.innerHTML = '';
    if (type === 'sub') sel.add(new Option('kapalı', 'no'));
    for (const t of state.tracks.filter((t) => t.type === type)) {
      sel.add(new Option(`${t.id}: ${t.lang || '?'} ${t.title || ''} (${t.codec})`, String(t.id)));
    }
  }
}

let seeking = false;
$('seek').addEventListener('input', () => { seeking = true; });
$('seek').addEventListener('change', async () => {
  await cmd(['seek', ($('seek').value / 1000) * 100, 'absolute-percent']).catch(() => {});
  seeking = false;
});
$('play').onclick = () => cmd(['cycle', 'pause']);
$('back').onclick = () => cmd(['seek', -10, 'relative']);
$('fwd').onclick = () => cmd(['seek', 10, 'relative']);
$('aid').onchange = (e) => set('aid', e.target.value);
$('sid').onchange = (e) => set('sid', e.target.value);
$('load').onclick = () => cmd(['loadfile', $('file').value]);
$('fs').onclick = async () => win.setFullscreen(!(await win.isFullscreen()));
$('close').onclick = () => invoke('spike_quit', { code: 0 });

// live stats (CPU % of the whole machine for this process: mpv decode+render + Rust host)
let lastCpu = null;
setInterval(async () => {
  const c = await invoke('spike_cpu');
  let cpu = '';
  if (lastCpu) cpu = (((c.cpu_ms - lastCpu.cpu_ms) / (c.wall_ms - lastCpu.wall_ms)) * 100 / c.cores).toFixed(1);
  lastCpu = c;
  const [hw, drop, ddrop, fps] = await Promise.all([get('hwdec-current'), get('frame-drop-count'), get('decoder-frame-drop-count'), get('estimated-vf-fps')]);
  $('stats').textContent = `cpu ${cpu}%  hwdec ${hw}\nfps ${typeof fps === 'number' ? fps.toFixed(2) : fps}  vo-drop ${drop}  dec-drop ${ddrop}`;
}, 1000);

// ---------------------------------------------------------------------------------- self-test
const cap = (name) => invoke('spike_capture', { name }).catch((e) => ({ error: String(e) }));
const log = (o) => invoke('spike_log', { line: JSON.stringify({ t: Math.round(performance.now() - t0), ...o }) });

async function cpuWindow(ms) {
  const a = await invoke('spike_cpu');
  const d0 = await get('frame-drop-count'), dd0 = await get('decoder-frame-drop-count');
  await sleep(ms);
  const b = await invoke('spike_cpu');
  const d1 = await get('frame-drop-count'), dd1 = await get('decoder-frame-drop-count');
  return {
    cpu_pct_machine: +(((b.cpu_ms - a.cpu_ms) / (b.wall_ms - a.wall_ms)) * 100 / b.cores).toFixed(2),
    cpu_pct_one_core: +(((b.cpu_ms - a.cpu_ms) / (b.wall_ms - a.wall_ms)) * 100).toFixed(1),
    vo_drops: d1 - d0, dec_drops: dd1 - dd0, ms,
  };
}

async function clickEl(id) {
  const r = $(id).getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  return invoke('spike_click', { x: Math.round((r.left + r.width / 2) * dpr), y: Math.round((r.top + r.height / 2) * dpr) });
}

async function selftest(file) {
  const res = { file, steps: {} };
  const S = (k, v) => { res.steps[k] = v; log({ step: k, ...v }); };
  try {
    // keep the test window visible above whatever the user is doing (captures/clicks check occlusion)
    await win.setAlwaysOnTop(true).catch(() => {});
    await win.setFocus().catch(() => {});
    const loaded = waitFor((e) => e.event === 'file-loaded', 15000);
    await cmd(['loadfile', file]);
    await loaded;
    await sleep(3000);
    const tl = await get('track-list');
    S('loaded', {
      duration: await get('duration'), video_params: await get('video-params'), hwdec: await get('hwdec-current'),
      vo: await get('current-vo'), gpu_api: await get('gpu-api'), container_fps: await get('container-fps'),
      tracks: (Array.isArray(tl) ? tl : []).map((t) => ({ id: t.id, type: t.type, lang: t.lang, codec: t.codec, sel: t.selected })),
      osd: [await get('osd-width'), await get('osd-height')],
    });
    S('capture_playing', await cap('playing'));
    S('perf_window', await cpuWindow(8000));

    // tracks
    const audio = (Array.isArray(tl) ? tl : []).filter((t) => t.type === 'audio');
    const subs = (Array.isArray(tl) ? tl : []).filter((t) => t.type === 'sub');
    for (const t of audio) { await set('aid', t.id); await sleep(700); S(`aid_${t.id}`, { want: t.id, got: await get('aid'), lang: await get('current-tracks/audio/lang') }); }
    for (const t of subs) { await set('sid', t.id); await sleep(1200); S(`sid_${t.id}`, { want: t.id, got: await get('sid'), lang: await get('current-tracks/sub/lang'), text: await get('sub-text') }); }
    if (subs.length) S('capture_sub', await cap('subtitle'));

    // seek
    const dur = await get('duration');
    const restarted = waitFor((e) => e.event === 'playback-restart', 8000);
    const ts = performance.now();
    await cmd(['seek', dur / 2, 'absolute']);
    await restarted;
    S('seek', { target: dur / 2, time_pos: await get('time-pos'), ms: Math.round(performance.now() - ts) });

    // input: which HWND gets the mouse over the video area and over a button?
    const dpr = window.devicePixelRatio;
    const hitVideo = await invoke('spike_hittest', { x: Math.round(innerWidth * dpr / 2), y: Math.round(innerHeight * dpr / 2) });
    S('hittest_video_area', hitVideo);
    // pause via a REAL OS mouse click on the HTML button (only if the point is our window)
    try {
      const hitBtn = await clickEl('play'); await sleep(600);
      const p1 = await get('pause'), tA = await get('time-pos'); await sleep(1000); const tB = await get('time-pos');
      await clickEl('play'); await sleep(600);
      S('pause_by_click', { hit: hitBtn, paused_after_click: p1, frozen: tA === tB, resumed: (await get('pause')) === false });
    } catch (e) { S('pause_by_click', { skipped: String(e) }); }
    // pause via API
    await set('pause', true); await sleep(300);
    const q1 = await get('time-pos'); await sleep(1000); const q2 = await get('time-pos');
    await set('pause', false);
    S('pause_api', { frozen: q1 === q2 });

    // resize
    await win.setSize(new LogicalSize(800, 500)); await sleep(1200);
    S('resize', { osd: [await get('osd-width'), await get('osd-height')], inner: await win.innerSize(), cap: await cap('resized') });
    await win.setSize(new LogicalSize(1100, 680)); await sleep(800);

    // fullscreen
    await win.setFullscreen(true); await sleep(2000);
    S('fullscreen', { osd: [await get('osd-width'), await get('osd-height')], inner: await win.innerSize(), cap: await cap('fullscreen') });
    S('perf_fullscreen', await cpuWindow(8000));
    await win.setFullscreen(false); await sleep(1000);
    S('windowed_again', { osd: [await get('osd-width'), await get('osd-height')], cap: await cap('windowed') });
    S('event_counts', { ...state.counts, seconds: Math.round((performance.now() - t0) / 1000) });
    res.ok = true;
  } catch (e) {
    res.ok = false; res.error = String(e);
    log({ error: String(e), stack: e && e.stack });
  }
  log({ done: true, ok: res.ok });
  await invoke('spike_quit', { code: res.ok ? 0 : 1 });
}

(async () => {
  const info = await invoke('spike_info');
  log({ ev: 'info', info });
  if (info.mpv_error) { $('stats').textContent = 'mpv yüklenemedi: ' + info.mpv_error; }
  const file = info.args && info.args.file;
  if (file) $('file').value = file;
  if (info.args && info.args.selftest && file) selftest(file);
  else if (file) cmd(['loadfile', file]);
})();
