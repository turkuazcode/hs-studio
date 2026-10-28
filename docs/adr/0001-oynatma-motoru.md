# ADR 0001 — Oynatma motoru: libmpv (LGPL) + Windows'ta "sahipli açılır pencere" gömme

- **Durum:** Önerildi (Dalga 1 / Ajan A2 denemesi, 2026-10-23) — ana oturumun onayını bekliyor
- **İlgili:** [Plan 02](../plans/02-oynatma-motoru.md) §1, [Yol haritası](../plans/00-YOL-HARITASI.md) (lisans politikası)
- **Kanıtlar:** [`experiments/mpv-spike/`](../../experiments/mpv-spike/) (deneme uygulaması, ölçüm günlükleri,
  ekran görüntüleri), [`third_party/mpv/`](../../third_party/mpv/) (derleme betiği, tarifler, lisans kanıtları)

## Karar (özet)
**GO — koşullu.** VHO'nun oynatma motoru libmpv olur; yalnızca LGPL derlemesi dağıtılır.

1. **Windows:** LGPL libmpv (mpv v0.41.0 `-Dgpl=false` + FFmpeg n8.1.3 `--enable-gpl` olmadan) MSYS2 ile
   **derlendi ve doğrulandı**. Görüntü, Plan 02'deki "çocuk pencere + şeffaf WebView" (yol A) ile
   **çalışmadı**; bunun yerine ölçülen ve çalışan **A′ "sahipli açılır pencere" (owned popup)** yolu kullanılır:
   video ayrı, kenarlıksız bir üst düzey pencerede; şeffaf Tauri penceresi onun *sahipli* (owned) penceresi
   olarak her zaman üstte durur ve DWM ikisini alfa ile birleştirir.
2. **Rust bağlantısı:** crate yerine **elle yazılmış ince FFI** (~390 satır, MIT) + `libloading` (ISC) ile
   **çalışma anında** DLL yükleme. Mevcut crate'lerin hepsi LGPL/GPL ve derleme anında bağlanıyor.
3. **Linux:** mpv 0.41'de **X11 arka ucu GPL'e bağlı** (`x11_opt.require(get_option('gpl'))`). LGPL libmpv ile
   Linux'ta `wid` gömme hiç mümkün değil (ne X11 ne Wayland) → Linux **yol B (render API, OpenGL)** ister.
4. **macOS:** derleme tarifi hazır, çalıştırılmadı. Gömme için yol B (render API) önerilir (IINA'nın yolu);
   `wid`/NSView yolu CI'da denenmeli.

Koşullar (Dalga 2'ye geçmeden): (a) B1 motor cephesini (facade) aşağıdaki taslağa göre kurar; html5 yedeği
korunur; (b) Linux/macOS için yol B ayrı iş paketi olarak planlanır (Dalga 2 sonu/Dalga 3, CI gerektirir);
(c) dağıtılan her DLL bildirim dosyasına eklenir.

## Karar ölçütleri tablosu
| Ölçüt | Sonuç | Kanıt |
|---|---|---|
| Lisans temizliği | ✅ FFmpeg `License: LGPL version 2.1 or later`; mpv `gpl : false`; GPL paket koruması; bağımlılıkların hepsi politikaya uygun | `third_party/mpv/evidence/windows/*`, [build-windows.md](../../third_party/mpv/build-windows.md) |
| Windows'ta gömme kararlılığı | ⚠️ yol A ❌ (2 varyant) · **yol A′ ✅** (tüm kontroller geçti) | `results/*bgcolor*`, `*transparent*`, `owned-*` |
| 4K HEVC kare atlama | ✅ 0 VO / 0 çözücü düşmesi (d3d11va; yazılım çözmede de 0) | `owned-hevc-4k*.log.jsonl` |
| DLL boyutu | 38 DLL, 67,3 MB (zip 28,2 MB); `libmpv-2.dll` 3,2 MB. (GPL referans tek DLL: 121 MB) | `evidence/windows/dist-sizes.tsv` |
| Wayland yolu maliyeti | Yol B zorunlu; tahmini 1–2 hafta + CI | §Linux/Wayland |

## Ölçümler (Windows 11, Ryzen 5 7535U 6C/12T, Radeon 660M iGPU, A′ yolu, LGPL DLL)
Test ortamı: başka iki ajan aynı anda Rust derliyordu; değerler gösterge niteliğindedir. Medya sentetiktir
(`gen-media.ps1`, LGPL ffmpeg + Media Foundation kodlayıcıları). CPU: işlem ağacındaki payı, makinenin
12 iş parçacığının yüzdesi olarak (ort./maks., 1 Hz örnekleme, ilk 6 sn hariç). GPU: Windows "GPU Engine"
sayaçları, işlem başına (AMD'de video motoru "Video Codec 0").

| Dosya | hwdec | Uygulama CPU % | WebView CPU % | GPU 3D % (mpv) | GPU Video % | VO/çözücü düşme | Atlama (seek) |
|---|---|---|---|---|---|---|---|
| H.264 1080p30, 8 Mb/s | d3d11va | 0,7 / 1,3 | 0,8 / 2,6 | 33,6 / 44,4 | 8,8 / 10,8 | 0 / 0 | 26 ms |
| HEVC 4K30, 20 Mb/s | d3d11va | 0,9 / 2,1 | 1,5 / 2,2 | 61,7 / 77,7 | 48,6 / 99,9 | 0 / 0 | 1267 ms* |
| HEVC 4K30, 20 Mb/s | **yok** (yazılım) | 9,5 / 29,9 | 1,4 / 3,2 | 41,7 / 85,4 | 0 | 0 / 0 | 2420 ms* |
| MKV 720p (2 ses + 2 altyazı + 3 bölüm) | d3d11va | 0,8 / 1,2 | 1,5 / 2,9 | 33,4 / 48,3 | 5,1 / 6,2 | 0 / 0 | 32 ms |
| H.264 + VHO'nun mevcut WebView2 bayrakları | d3d11va | 0,7 / 1,2 | 1,6 / 2,4 | 33,7 / 45,3 | 8,8 / 11,0 | 0 / 0 | 39 ms |
| H.264 + `--disable-gpu-compositing` (uyumluluk modu) | d3d11va | 0,8 / 1,5 | 3,0 / 5,1 | 34,3 / 47,0 | 9,1 / 12,7 | 0 / 0 | 39 ms |

\* MF HEVC kodlayıcısının uzun GOP'u (anahtar kare aralığı) nedeniyle; motorla ilgili değil.
Uygulama içi ölçüm (8 sn pencere): donanım çözmede tek çekirdeğin %7–11'i, 4K yazılım çözmede %178'i.
GPU 3D yükünün çoğu `vo=gpu-next` ölçekleme/renk işlemesi; 1 GB'lık iGPU'da `profile=fast` seçeneği B1'de
ayar olarak sunulmalı.

### İşlevsel kontroller (otomatik self-test, A′ yolu, hepsi ✅)
dosya açma · `track-list` (2 ses tur/eng, 2 altyazı tur-ASS/eng-SRT) · `aid` değiştirme (dil doğrulandı) ·
`sid` değiştirme (`sub-text` doğrulandı, libass ile stil) · `chapter-list` olayı · mutlak atlama (±0,07 sn) ·
**gerçek fare tıklamasıyla** HTML düğmesinden duraklat/devam (WindowFromPoint zinciri:
`Chrome_RenderWidgetHostHWND → … → WRY_WEBVIEW → Tauri Window`) · API ile duraklatma · yeniden boyutlandırma
(mpv OSD 1000×625'i izledi) · pencere taşıma (video penceresi = istemci alanı, piksel piksel) · simge durumuna
küçültme (video penceresi gizlendi) / geri yükleme · tam ekran (1920×1200) ve geri dönüş · HUD'un yarı
saydam arka planı videonun üstünde alfa ile karıştı (ekran görüntüleri `results/captures/owned-*.png`; yerel kullanıcı yolunu gösterdikleri için herkese açık yayından önce git geçmişinden çıkarıldı).

### Gömme varyantları ve siyah ekran / z-sırası bulguları
| Varyant | Sonuç | Açıklama |
|---|---|---|
| A: çocuk HWND (WebView2'nin altında) + Tauri `transparent: true` | ❌ | Şeffaf alanlarda **masaüstü** görünüyor; tao, şeffaf pencereyi `DwmEnableBlurBehindWindow` ile yapıyor, GDI/çocuk-swapchain içeriği alfa=0 sayılıyor. |
| A: çocuk HWND + opak pencere, WebView2 arka planı alfa=0 | ❌ | Video yerine **siyah**. WebView2 (pencereli barındırma, DirectComposition) kardeş HWND'leri göstermiyor. `d3d11-flip=no` ile de aynı. |
| Tanı: video çocuğu WebView2'nin **üstünde** | video görünür | mpv'nin `wid` içine doğru çizdiğini kanıtlar (arayüz görünmez). |
| **A′: video ayrı üst düzey popup, Tauri penceresi onun owned penceresi** | ✅ | İki üst düzey pencereyi DWM alfa ile birleştirir. Bayrak gerekmez; `--disable-gpu-compositing` ile de çalışır. |

Notlar: (1) Ekran görüntüsü GDI `BitBlt` ile alındığı için, flip-model swapchain'in tüm pencereyi kapladığı
bazı anlarda (MPO/bağımsız flip) görüntü siyah çıkabiliyor — bu yakalama yönteminin sınırı, kullanıcı
görüntüsü değil. A′ ölçümleri varsayılan flip modeliyle yapıldı ve görüntüler videoyu gösteriyor.
(2) Ana uygulamadaki eski "WebView2 DirectComposition siyah video" sorunu `<video>` öğesine özgüydü; libmpv
yolunda video WebView2'den geçmediği için bu bayraklara gerek yok; uyumluluk modu açık olsa da A′ çalışıyor.

## LGPL doğrulama özeti
- `ffmpeg -buildconf`: `--enable-shared --disable-static … --enable-libdav1d --enable-d3d11va --enable-dxva2
  --enable-d3d12va --enable-mediafoundation --enable-zlib --enable-iconv --enable-schannel` — `--enable-gpl`,
  `--enable-version3`, `--enable-nonfree` **yok**; configure özeti `License: LGPL version 2.1 or later`.
- mpv meson özeti `gpl : false`; 0.41'de GPL'e bağlı özellikler: cdda, dvbin, dvdnav, jack, oss-audio, caca,
  direct3d, **x11**. Windows için gerekenlerin hepsi (d3d11, gpu-next/libplacebo, d3d11va, wasapi, libass,
  win32-desktop/`wid`) LGPL.
- Çalışma anında: `mpv-version = mpv v0.41.0`, `ffmpeg-version = n8.1.3`, istemci API 2.5.
- Bağımlılık lisansları ve DLL listesi: [build-windows.md](../../third_party/mpv/build-windows.md). Dikkat:
  libstdc++/libgcc_s GPL-3 + **GCC Runtime Library Exception** (izinli); freetype FTL (atıf gerekir).

## Rust bağlantısı (Plan 02 §1c)
| Seçenek | Lisans (crates.io) | Bakım | Değerlendirme |
|---|---|---|---|
| `libmpv2` 6.0.0 / `libmpv2-sys` 4.0.1 | LGPL-2.1 | etkin (2026-05) | ❌ Rust crate'i exe'ye **statik** derlenir → politika "LGPL yalnızca dinamik"; ayrıca derleme anında libmpv'ye bağlanır (yedek motora düşülemez). |
| `libmpv` 2.0.1 / `libmpv-sys` 3.1.0 | LGPL-2.1 | terk (2020) | ❌ |
| `mpv-client-dyn` 0.5.0 | GPL-3.0 | az | ❌ GPL |
| `tauri-plugin-libmpv` 0.3.2 / `tauri-plugin-mpv` 0.5.2 (nini22P) | MPL-2.0 | küçük topluluk (~6 bin indirme, 2025-11) | ⚠️ lisans uygun ama gömme/olay modeli üzerinde denetim kaybı; yalnızca fikir kaynağı |
| **Elle FFI** (`experiments/mpv-spike/src-tauri/src/mpv.rs`) + `libloading` 0.8 (ISC) | MIT (VHO) | bizde | ✅ **Önerilen.** 16 fonksiyon; `mpv_node` ↔ `serde_json::Value`; olaylar `mpv_event_to_node` ile mpv JSON-IPC biçiminde; DLL yoksa hata döner → html5 yedeği. |

Olay döngüsü: ayrı `mpv-events` iş parçacığında `mpv_wait_event(-1)`; her olay JSON olarak Tauri olayına
(`mpv://event`) aktarılır. Ölçüm: `time-pos` ~26 olay/sn (32 sn'de 850) — cephe bunu ~4–10 Hz'e kısmalı.

## Linux/Wayland — yol B fizibilitesi (yazılı değerlendirme)
- LGPL libmpv'de X11 yok, Wayland'da yabancı pencere gömme yok → **tek yol render API**:
  `mpv_render_context_create(MPV_RENDER_API_TYPE_OPENGL, get_proc_address)`; `mpv_render_context_set_update_callback`
  ile yeni kare bildirimi; çizim, VHO'nun GL bağlamında `mpv_render_context_render(fbo)` ile.
- Tauri/wry Linux'ta GTK3 + WebKitGTK kullanır; wry `build_gtk(container)` ile WebView'i kendi GTK kabımıza
  koymaya izin verir. Plan: `GtkOverlay` içinde altta `GtkGLArea` (mpv çizer), üstte arka planı şeffaf
  (`webkit_web_view_set_background_color` rgba 0) WebKitWebView. GTK bileşimi istemci tarafında yaptığı için
  hem Wayland hem X11'de çalışır; maliyet kare başına bir doku kopyası.
- Donanım çözme: `vaapi` + EGL interop için `MPV_RENDER_PARAM_WL_DISPLAY` (Wayland) verilmeli; X11 oturumunda
  `egl-x11` GPL x11 özelliğine bağlı olabileceğinden `vaapi-copy` yedeği gerekir (CI'da doğrulanmalı).
- Riskler: WebKitGTK'nın şeffaf arka planla performansı, HiDPI ölçekleme, GtkGLArea'nın Tauri pencere
  yönetimiyle uyumu. Tahmini iş: 1–2 hafta + CI (Ubuntu 22.04/24.04, GNOME Wayland + X11).
- Aynı render API yolu macOS'ta bir `CAOpenGLLayer` ile uygulanabilir (render API'nin macOS'taki tek
  arka ucu OpenGL'dir; Apple'da kullanımdan kalkmış ama çalışıyor, IINA bu yolu kullanıyor). Windows'ta A′
  daha basit ve ölçüldü; orada render API'ye gerek yok.

## macOS riskleri
Tarif: [build-macos.md](../../third_party/mpv/build-macos.md) (Homebrew yalnız araç/LGPL kütüphaneler için;
Homebrew `ffmpeg` formülü GPL'dir, kullanılmaz). Gömme denenmedi: (1) `wid` = NSView ve şeffaf WKWebView
(`macOSPrivateApi: true` → Mac App Store engeli), (2) render API (önerilen). Kod imzalama/notarization her
dylib için gerekli. İlk CI koşusunda doğrulanacak.

## Plan 02 §2 için uygulama taslağı (motor cephesi)
**Rust** — `src-tauri/src/engine/`
```
mod.rs     Engine durumu (Option<Arc<Mpv>>, video penceresi), Tauri komutları, kurulum
mpv.rs     deneme sürümündeki mpv.rs (FFI) aynen taşınır; + render API bağlantıları Linux/macOS için sonra
window.rs  #[cfg(windows)] owned popup (create_owner_popup / sync_owner_popup / geometry)
           #[cfg(linux)]   GtkOverlay + GtkGLArea (yol B)   #[cfg(macos)] NSView/CAOpenGLLayer (yol B)
events.rs  olay iş parçacığı → kısma (time-pos ≤10 Hz, diğerleri anında) → app.emit
```
- Kurulum: ana pencere `transparent: true` olur (`tauri.conf.json`); `lib.rs` kurulumunda pencere
  oluşturulduktan sonra `engine::init(app, &window)`: DLL'i `resources/mpv/libmpv-2.dll`'den yükle; başarısızsa
  `EngineState::Unavailable(reason)` → ön yüz html5 motoruna düşer.
- Senkron: `WindowEvent::{Moved,Resized,Focused,ScaleFactorChanged}` → `sync_owner_popup`. Sürükleme sırasında
  gecikme görülürse ana HWND'yi `SetWindowSubclass` ile alt sınıflayıp `WM_WINDOWPOSCHANGED`'de eşzamanlı taşı.
- mpv seçenekleri: `wid`, `config=no`, `terminal=no`, `input-default-bindings=no`, `input-vo-keyboard=no`,
  `input-cursor=no`, `load-scripts=no`, `idle=yes`, `force-window=yes`, `keep-open=yes`, `vo=gpu-next`,
  `hwdec=auto-safe` (+ ayardan `profile=fast`, `volume-max=200`, altyazı stili, `screenshot-directory`).
- Komutlar: `engine_status() -> {available, mpv_version, ffmpeg_version, error}`,
  `engine_load(path, start?: f64)`, `engine_command(args: Value) -> Value`, `engine_set(name, value)`,
  `engine_get(name) -> Value`; olaylar: `engine://property {name, value}`, `engine://event {event, ...}`
  (`file-loaded`, `end-file{reason}`, `seek`, `playback-restart`, `video-reconfig`).
- Gözlenen özellikler: `time-pos, duration, pause, track-list, chapter-list, chapter, volume, mute,
  eof-reached, video-params, hwdec-current, aid, sid, speed, sub-delay, audio-delay, demuxer-cache-time`.

**JS** — `src/media/engine/`
```js
// engine.js — ortak sözleşme (sahte motorla birim testi)
export function createEngine({ preferMpv = true } = {}) // mpv-engine veya html5-engine döndürür
// arayüz: load(item), play(), pause(), toggle(), seek(t, mode='absolute'), setVolume(v), setRate(r),
//         tracks() -> {audio:[], sub:[], video:[]}, selectTrack(type, id), chapters(), screenshot(),
//         set(name, value), on(event, fn) -> unsubscribe, destroy()
// olay adları: 'time', 'duration', 'pause', 'tracks', 'chapters', 'ended', 'error', 'loaded'
```
`mpv-engine.js`, `engine://property` olaylarını bu adlara eşler (ör. `track-list` → `tracks` normalleştirilmiş
`{id,type,lang,title,codec,selected}`); `html5-engine.js` mevcut `<video>` yolunu sarar (Media Foundation
dönüştürme yalnızca bu yedekte). HUD/zaman çubuğu/A-B/kaldığın yer/uyku zamanlayıcısı yalnızca `engine.js`
üzerinden konuşur. mpv etkinken `<body>` arka planı şeffaf, HUD altyazının üstünü kapatmamalı
(`sub-margin-y`/`sub-pos` HUD görünürken artırılır — denemede HUD altyazıyı örttü).

## Sonuçlar ve riskler
- (+) Tek motorla tüm biçimler, çoklu ses/altyazı, ASS, bölümler, HDR ton eşleme; 4K HEVC donanımla kayıpsız.
- (+) MIT lisansı korunur: dinamik yükleme, kaynak/derleme betiği depoda.
- (−) Windows'ta iki üst düzey pencere: Alt+Tab/görev çubuğu (`WS_EX_APPWINDOW` verildi, görsel olarak
  doğrulanmadı), Aero Snap/çoklu monitör DPI geçişleri, sürüklemede olası 1 karelik gecikme B1'de test edilmeli.
- (−) Dağıtım boyutu +28 MB (sıkıştırılmış); küçültme seçenekleri build-windows.md'de.
- (−) Linux ve macOS yol B gerektirir (ayrı iş paketi, CI). Linux'ta LGPL derlemede X11 yok — sistem
  paketindeki (GPL) libmpv'yi kullanıcı makinesinde dlopen etmek yedek olabilir ama dağıtılmaz.
- (−) Yeni MSYS2 sürümleri bağımlılık DLL adlarını değiştirebilir (ör. `libplacebo-360.dll`); derleme sürümleri
  sabitlenmeli ve dist listesi CI'da yeniden üretilmeli.
