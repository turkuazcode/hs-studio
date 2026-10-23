# mpv-spike — libmpv under a Tauri v2 webview (Windows)

Throw-away experiment for Plan 02 §1 / ADR [0001](../../docs/adr/0001-oynatma-motoru.md).
Not part of the VHO build. Windows only.

```
src-tauri/src/mpv.rs           thin hand-written libmpv FFI (libloading, mpv_node <-> serde_json, event thread)
src-tauri/src/video_window.rs  Win32 video window(s), screen capture + hit-test helpers for the self-test
src-tauri/src/main.rs          Tauri app, commands mpv_command/mpv_set/mpv_get, emits "mpv://event"
ui/                            HTML controls (seek bar, play, ±10 s, audio/sub selectors) + automated self-test
gen-media.ps1                  synthetic test media with the LGPL ffmpeg (h264_mf / hevc_mf, 2 audio + 2 subs + chapters)
run-selftest.ps1               runs one self-test, samples CPU + GPU engines of the process tree, writes results/
results/                       logs (*.log.jsonl), 1 Hz samples (*.samples.csv), key screenshots (captures/*.png)
```

## Build & run
```powershell
$env:CARGO_BUILD_JOBS=2
cd experiments\mpv-spike\src-tauri; cargo build --release; cd ..
.\gen-media.ps1                                   # needs third_party/mpv/_build (LGPL build)
.\run-selftest.ps1 -File media\multitrack.mkv -Dll ..\..\third_party\mpv\_build\dist\libmpv-2.dll -Label owned-multitrack
# interactive:
.\src-tauri\target\release\mpv-spike.exe --dll ..\..\third_party\mpv\_build\dist\libmpv-2.dll media\h264-1080p.mp4
```
Options: `--mode owned|transparent|bgcolor|videotop` (default `owned`), `--browser-args "<chromium flags>"`,
`--mpv-opt key=value` (repeatable), `--selftest <log.jsonl>`.

The self-test keeps the window always-on-top while it runs, refuses to capture or click when another
application covers the window, and restores the mouse cursor after its two synthetic clicks.

## Composition variants (what the `--mode` flag tests)
| mode | layout | result |
|---|---|---|
| `transparent` | video = child HWND under WebView2; Tauri `transparent: true` | **fails**: desktop shows through, video invisible |
| `bgcolor` | video = child HWND under WebView2; opaque window, WebView2 background alpha 0 | **fails**: black where video should be |
| `videotop` | video child ABOVE WebView2 (diagnostic) | video visible, UI hidden → mpv renders fine |
| `owned` | video = separate borderless top-level popup; Tauri window (transparent) is an *owned* window of it | **works**: UI over video, alpha-blended HUD, input to UI, resize/move/minimize/fullscreen OK |
