# Plan 02 — Oynatma Motoru: libmpv (LGPL)

## Neden
VHO şu an videoyu işletim sisteminin web motoruna (WebView2 / WebKit / WebKitGTK) çözdürüyor. macOS'ta MKV/AVI/WMV/FLV açılmaz, Linux'ta GStreamer paketlerine bağlıdır; çoklu ses/altyazı kanalı, bölümler, ASS altyazı, HDR yoktur. libmpv bunların hepsini tek seferde ve her platformda çözer.

## §1 Teknik deneme — Ajan A2 (Dalga 1)
Çıktı: `experiments/mpv-spike/` altında çalışan küçük bir Tauri v2 örneği + karar raporu `docs/adr/0001-oynatma-motoru.md`.

### 1a. LGPL libmpv derlemesi (Windows x64)
- mpv `-Dgpl=false`, FFmpeg `--enable-gpl` / `--enable-nonfree` **olmadan**; libass, harfbuzz, freetype, fribidi, dav1d (BSD), libplacebo (LGPL-2.1), zlib, uchardet.
- Önerilen yol: MSYS2/MinGW-w64 içinde mpv'nin meson derlemesi **veya** güvenilir bir LGPL ön-derlemesi (kaynağı ve derleme bayrakları doğrulanabilir olmalı; `mpv --version` / `ffmpeg -buildconf` çıktısı raporda).
- Doğrulama: `mpv_client_api_version`, `ffmpeg configuration` dizesinde `--enable-gpl` OLMADIĞI, DLL boyutu, bağımlılık listesi (`dumpbin /dependents` veya `objdump -p`).
- Derleme betiği depoya: `third_party/mpv/build-windows.md` + betikler. macOS (Homebrew/meson) ve Linux (meson) için **tarif** (derleme CI'da yapılacak).

### 1b. Görüntüyü Tauri penceresine gömme (iki yol, ölçülerek seçilecek)
| Yol | Açıklama | Platform |
|---|---|---|
| **A. `wid` gömme** | Ana pencerenin altında bir çocuk pencere (HWND / NSView / X11 Window) oluştur, mpv'ye `wid` olarak ver; WebView **şeffaf** (`transparent: true`, CSS arka planı şeffaf) olur, arayüz videonun üstünde çizilir. | Win ✅, macOS ✅, Linux/X11 ✅, **Wayland ❌** |
| **B. Render API (OpenGL)** | `mpv_render_context` + kendi GL yüzeyimiz (WGL/CGL/EGL) WebView'in arkasında. | Hepsi (Wayland dahil), daha karmaşık |

Deneme önce **A**'yı Windows'ta kanıtlar: 1080p H.264 + 4K HEVC + MKV (çoklu ses/altyazı) oynatma, arayüz üstte, yeniden boyutlandırma/tam ekran, CPU/GPU kullanımı ölçümü. Wayland için B'nin fizibilitesi raporlanır.

### 1c. Rust bağlantısı
- `libmpv2` crate (lisansını doğrula) **veya** ince bir `bindgen`/elle FFI katmanı (`mpv_create`, `mpv_initialize`, `mpv_command`, `mpv_set_property`, `mpv_observe_property`, `mpv_wait_event`).
- Olay döngüsü ayrı thread'de; özellik değişimleri Tauri olayı olarak ön yüze: `time-pos`, `duration`, `pause`, `track-list`, `chapter-list`, `volume`, `eof-reached`, `video-params`.

### Karar ölçütleri (ADR'de tablo)
Lisans temizliği, Windows'ta A yolunun kararlılığı, 4K HEVC'de kare atlama, DLL boyutu, Wayland yolu maliyeti.

## §2 Motor soyutlaması — Ajan B1 (Dalga 2)
```
src/media/engine/
├── engine.js        # ortak arayüz: load(item), play(), pause(), seek(t), setVolume(v), setRate(r),
│                    #   tracks(), selectTrack(type,id), chapters(), screenshot(), on(event, fn)
├── mpv-engine.js    # Tauri komut/olaylarıyla libmpv
└── html5-engine.js  # mevcut <video> yolu (yedek; libmpv yüklenemezse)
```
Rust: `src-tauri/src/engine/{mod.rs, mpv.rs, window.rs}` — komutlar `engine_load`, `engine_command`, `engine_set`, olay `engine://property`.
Mevcut video arayüzü (HUD, zaman çubuğu, A-B, kaldığın yer, uyku zamanlayıcısı) **yalnızca engine.js** üzerinden konuşacak şekilde uyarlanır. Media Foundation dönüştürme yolu html5 yedeğinde kalır.

## §3 Yeni oynatma özellikleri (Ajan B1)
| Özellik | mpv karşılığı | Arayüz |
|---|---|---|
| Ses kanalı seçimi | `aid`, `track-list` | HUD'da "Ses" menüsü (dil/başlık) |
| Altyazı kanalı (gömülü + harici) | `sid`, `sub-add` | CC menüsü kanal listesi |
| ASS/SSA tam stil | libass (otomatik) | — |
| Altyazı stili | `sub-font-size`, `sub-color`, `sub-pos`, `sub-border-*` | Ayarlar > Altyazı |
| Ses gecikmesi | `audio-delay` | Filtreler paneli ±50 ms |
| Ekolayzır (10 bant) | `af=lavfi=[equalizer...]` | Ses paneli + hazır ayarlar |
| Ses normalizasyonu | `af=lavfi=[loudnorm]` / `dynaudnorm` | anahtar |
| %200 ses | `volume-max=200` | mevcut kaydırıcı |
| Bölümler | `chapter-list`, `chapter` | zaman çubuğunda işaretler, menü |
| Yer imleri | kendi listemiz (dosya başına) | zaman çubuğunda işaret + menü |
| Kare kare | `frame-step`, `frame-back-step` | `.` `,` tuşları |
| Ekran görüntüsü | `screenshot-to-file` | mevcut buton |
| Döndürme/yansıtma | `video-rotate`, `vf=hflip` | Görüntü menüsü |
| Yakınlaştırma/kaydırma | `video-zoom`, `video-pan-*` | fare tekerleği + Ctrl |
| Görüntü ayarları | `brightness`, `contrast`, `saturation`, `gamma`, `hue` | mevcut Filtreler paneli |
| Deinterlace | `deinterlace=auto` | otomatik |
| HDR → SDR ton eşleme | `tone-mapping` (libplacebo) | otomatik |
| Donanım çözme | `hwdec=auto-safe` | Ayarlar > Gelişmiş |

## §4 Testler
- Birim: `engine.js` sözleşme testleri (sahte motorla).
- E2E: MKV (2 ses + 2 altyazı kanalı) fixture'ı — kanal değiştir, doğru dil seçildi; bölümlü dosyada bölüme atla; ses gecikmesi; ekran görüntüsü dosyası oluştu.
- Performans: 1080p/4K oynatırken CPU kullanımı (rapor).
- Fixture'lar LGPL FFmpeg CLI ile üretilir (derleme çıktısından) ve depoya küçük boyutta eklenir.

## Riskler
- WebView şeffaflığı + çocuk pencere: Windows'ta DirectComposition ile çakışma ihtimali (A2 ölçecek).
- Wayland desteği B yolunu gerektirir (Linux için ayrı iş paketi).
- LGPL uyumu: libmpv/FFmpeg **dinamik** bağlanmalı; kaynak kodun/yeniden derleme talimatının erişilebilir olması (bildirimde bağlantı) gerekir.
