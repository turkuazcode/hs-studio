<div align="center">

# 🎬 VHO — Video H Oynatıcısı
### Yeni Nesil, Ultra Hafif & Çapraz Platform Açık Kaynak Video Oynatıcı

[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.85+-orange?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)](#-platformlar)
[![Developer](https://img.shields.io/badge/Developer-Halil%20SARITAŞ%20(hsrts)-E11D48?style=for-the-badge)](https://github.com/hsrts)

<br/>

**VHO (Video H Oynatıcısı)**, VLC'nin zengin format desteğini ve mpv'nin güçlü video motorunu; **Tauri 2.0, Rust ve modern cam tasarım (Glassmorphism)** ile birleştiren yüksek performanslı, minimalist bir masaüstü medya oynatıcısıdır.

Geleneksel medya oynatıcıların hantal ve 90'lardan kalma arayüzlerini geride bırakarak, Apple TV ve IINA standartlarında modern bir seyir deneyimi sunar.

</div>

---

## ✨ Öne Çıkan Özellikler

| Özellik | Açıklama |
|---|---|
| ⚡ **Yerel AI Restorasyon (144p Kurtarma)** | 144p/360p eski kamera ve telefon videoları için GPU donanım hızlandırmalı kenar keskinleştirme (Unsharp Mask), dinamik kontrast (CAS) ve diyalog netleştirici DSP ses filtresi. |
| 🔊 **%200 Ses Yükseltici (Audio Boost)** | Web Audio API dinamik kazanç (gain) filtresi ile fısıltılı videoları kaliteden ödün vermeden %200'e kadar yükseltme. |
| 🌐 **Akıllı Altyazı Motoru** | Film adını karmaşık dosya isimlerinden ayıklayıp OpenSubtitles.org aramasını tarayıcıda açar. SRT/VTT, UTF-8 ve Windows-1254 (Türkçe) kodlamalı dosyaları okur. |
| 🎞️ **Canlı Zaman Çubuğu Önizlemesi** | Zaman çubuğunda (seek bar) gezinirken o saniyenin video karesini YouTube tarzı canlı küçük kutuda (thumbnail canvas) gösterme. |
| 🌙 **Akıllı Uyku Zamanlayıcısı & PC Standby** | 15–60 dk veya "Video Bitince" seçenekleriyle sesi 3 saniyede kısıp bilgisayarı uyku moduna (`Windows`, `macOS`, `Linux`) alma. |
| ⚖️ **A/B Karşılaştırma Ekranı** | Eski 144p orijinal görüntü ile AI restore edilmiş görüntüyü gerçek zamanlı yan yana (Split-Screen) kıyaslama. |
| 🔁 **A-B Tekrar Döngüsü (A-B Repeat)** | Eğitim, dil öğrenme veya müzik videolarında iki zaman damgası arasını kesintisiz döngüye alma. |
| 🎨 **Canlı Renk & Filtre Laboratuvarı** | Gerçek zamanlı parlaklık, kontrast ve doygunluk ayarları; milisaniyelik `+/- 100ms` altyazı senkronu. |
| 📸 **4K HD Ekran Görüntüsü (Snapshot)** | Oynatılan karenin tam çözünürlüklü ekran görüntüsünü flaş efektiyle anında kaydetme. |
| 🪟 **Resim İçinde Resim (PiP)** | Çalışırken videoyu ekranın köşesinde küçük pencerede sabit tutarak izleme. |
| 📑 **Akıllı Oynatma Listesi (Playlist)** | Çoklu video dosyalarını sıralı oynatma, otomatik sonraki bölüme geçme ve kaldığı yerden devam etme. |
| 🖥️ **Çapraz Platform & Çerçevesiz Tasarım** | Windows, macOS (Traffic Lights) ve Linux için özel pencere kontrolleri ve donanım hızlandırma. |

---

## 🏗️ Mimari ve Teknoloji Yığını

```
┌─────────────────────────────────────────────────────────────────┐
│                    VHO Media Player (Frontend)                  │
│       HTML5 Canvas · Web Audio API · Obsidian Glassmorphism     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Tauri IPC Bridge
┌────────────────────────────────▼────────────────────────────────┐
│                   Tauri 2.0 Core (Rust Layer)                   │
│   Windows SetSuspendState · macOS pmset · Linux systemctl       │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Native Rendering Loop
┌────────────────────────────────▼────────────────────────────────┐
│               libmpv / Direct3D11 / Metal / Vulkan              │
│       H.264 · HEVC / H.265 · AV1 · VP9 · MKV · MP4 · Subtitles  │
└─────────────────────────────────────────────────────────────────┘
```

* **Arayüz (Frontend):** Vanilla CSS & JavaScript, donanım hızlandırmalı HTML5 Canvas ve Web Audio API. Hiçbir ağır framework bağımlılığı yoktur, 10 milisaniyede açılır.
* **Masaüstü Katmanı:** [Tauri 2.0](https://tauri.app/) (Rust tabanlı güvenli, düşük bellek tüketen çalışma ortamı).
* **Medya Motoru Desteği:** `libmpv` / Chromium Media Core entegrasyonu.

---

## ⌨️ Klavye Kısayolları (Cheatsheet)

| Kısayol | İşlev |
|---|---|
| <kbd>Boşluk</kbd> | Oynat / Duraklat |
| <kbd>←</kbd> / <kbd>→</kbd> | 5 saniye geri / ileri sar (Shift ile 30 saniye) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Ses seviyesini %5 artır / azalt (%0 - %200) |
| <kbd>M</kbd> | Sesi Kapat / Aç (Mute) |
| <kbd>F</kbd> veya **Çift Tıklama** | Tam Ekran (Fullscreen) Aç / Kapat |
| <kbd>C</kbd> veya <kbd>V</kbd> | Altyazıyı Aç / Gizle (Toggle Subtitles) |
| <kbd>G</kbd> / <kbd>H</kbd> | Altyazı gecikmesini -50ms / +50ms kaydır |
| <kbd>S</kbd> | Anlık Ekran Görüntüsü Kaydet (Snapshot) |
| <kbd>L</kbd> | Oynatma Listesini (Playlist) Aç / Kapat |
| <kbd>P</kbd> | Resim İçinde Resim (PiP) Modu |

---

## 🚀 Kurulum ve Çalıştırma

### Gereksinimler
* [Node.js](https://nodejs.org/) (v18 veya üzeri)
* [Rust](https://rustup.rs/) (Cargo)

### Geliştirme Ortamı (Development)
```bash
# Depoyu klonlayın
git clone https://github.com/hsrts/vho.git
cd vho

# Bağımlılıkları yükleyin
npm install

# Geliştirme sunucusunu başlatın
npm run dev
```

Masaüstü penceresi olarak başlatmak için:
```bash
cargo tauri dev
```

---

## 📦 Dağıtım & Derleme (Production Build)

Tauri çoklu platform desteği sayesinde tek bir komutla işletim sisteminize uygun bağımsız binary çıktısı alabilirsiniz:

### 🪟 Windows (.exe / .msi)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/nsis/vho_0.1.0_x64-setup.exe
```

### 🍎 macOS (.dmg / .app)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/dmg/vho_0.1.0_x64.dmg
```

### 🐧 Linux (.AppImage / .deb)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/appimage/vho_0.1.0_amd64.AppImage
```

---

## 🧪 Geliştirme ve test

### Ön yüz modül yapısı
`src/main.js` yalnızca önyüklemedir; modüller tek bir `app` bağlamı üzerinden birbirine bağlanır (döngüsel import yok). Paylaşılan durum `src/core/state.js`'de, bildirimler `src/core/events.js` olay veriyolunda.

| Klasör | İçerik |
|---|---|
| `src/core/` | `dom.js` (tüm DOM referansları), `state.js` (reaktif store), `events.js` (olay veriyolu), `tauri.js` (`__TAURI__` sarmalayıcıları, tarayıcıda no-op), `format.js` (saf biçimleme) |
| `src/media/engine/` | Oynatma motoru cephesi: `engine.js` (ortak sözleşme + saf yardımcılar), `mpv-engine.js` (libmpv, birincil), `html5-engine.js` (`<video>` yedeği + Media Foundation dönüştürme) — ayrıntı: [docs/engine.md](docs/engine.md) |
| `src/media/` | `audio-fx.js` (ekolayzır/normalizasyon/ses gecikmesi), `classify.js`, `subtitles.js`, `loader.js`, `video-player.js`, `audio-engine.js`, `visual-filters.js`, `photo-viewer.js`, `photo-ai.js`, `snapshot.js`, `onnx-patch.js` + mevcut `gpu-enhancer.js`, `ai-*.js`, `face-restore.js` |
| `src/ui/` | `hud.js`, `timeline.js`, `playlist.js`, `panels.js`, `modals.js`, `sleep-timer.js`, `shortcuts.js`, `fullscreen.js`, `toasts.js`, `window-controls.js`, `playback-menus.js` (ses/altyazı kanalı, bölümler, yer imleri, görüntü menüsü) |

Saf mantık (sınıflandırma, zaman biçimleme, altyazı ayrıştırma/kod çözme, çalma listesi gezinme, ONNX yaması...) DOM'suz fonksiyonlardır ve birim testlidir.

### Komutlar
| Komut | Ne yapar |
|---|---|
| `npm ci` | Bağımlılıkları kurar |
| `npm test` | Birim testleri (Node 24 yerleşik `node:test`, ek bağımlılık yok) |
| `npm run build:release` | Release derlemesi: `src-tauri/target/release/vho.exe` |
| `npm run stage:mpv` | LGPL libmpv DLL'lerini (38 adet) exe'nin yanına kopyalar; kaynak `third_party/mpv/_build/dist` ya da `-Source`/`VHO_MPV_DIST`. DLL yoksa uygulama HTML5 motoruyla çalışır |
| `npm run e2e` | Uçtan uca testler; önce `npm run build:release` gerekir |
| `cd src-tauri; cargo test --release --lib` | Rust birim testleri (`transcode` gerçek dosya testi `#[ignore]`) |
| `npm run fixtures` | Test medyasını yeniden üretir (Windows) |
| `npm run fixtures:engine` | libmpv test medyasını (çok kanallı MKV, HEVC) LGPL ffmpeg ile üretir |

### Uçtan uca (E2E) testler
`tests/e2e/` altındaki testler `vho.exe`'yi `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<9500-9599>` ile başlatır ve Chrome DevTools Protocol üzerinden sayfayı sürer (`lib/cdp.mjs`, `lib/app.mjs`). Medya dosyaları komut satırı argümanı olarak açılır ("Birlikte aç" yolu).

- Her çalıştırma ayrı, geçici bir WebView2 profili kullanır (`WEBVIEW2_USER_DATA_FOLDER`): kullanıcının açık VHO'suna ve kaldığı yer kayıtlarına dokunmaz. Testler yalnızca kendi başlattıkları süreci kapatır.
- Arka plandaki pencere yeniden çizilmeyebilir; bu yüzden testler ekran görüntüsüne değil, DOM ve medya durumuna (`videoWidth`, `getVideoPlaybackQuality()`, metinler) bakar.
- **Güvenlik:** testler bilgisayarı asla uyku moduna almaz. `vho.exe`, `VHO_DISABLE_SYSTEM_SUSPEND=1` ile başlatılır (`suspend_system` hiçbir şey yapmaz) ve sayfa betikleri çalışmadan önce `__TAURI__.core.invoke` sarmalanır: `suspend_system` ve `set_compat_mode` arka uca hiç gitmez. Koruma her açılışta doğrulanır; doğrulanamazsa testler çalışmaz. Uyku zamanlayıcısı testleri "PC Uyku" kutusunu önce kapatır.
- `window.confirm` ve indirmeler (ekran görüntüsü) test tarafında taklit edilir; yakalanmamış sayfa hataları toplanır ve her testin sonunda boş olmalıdır.
- Motor: `engine.e2e.mjs` libmpv'yi test eder (DLL'ler `npm run stage:mpv` ile hazırlanmamışsa atlanır); diğer dosyalar ve yedek testi `VHO_DISABLE_MPV=1` ile **HTML5 motorunu** kullanır. mpv ekran görüntüleri geçici profile yazılır (`VHO_SCREENSHOT_DIR`). CDP port aralığı `VHO_E2E_PORT_MIN`/`VHO_E2E_PORT_MAX` ile değiştirilebilir.
- Başka bir derlemeyi denemek için: `$env:VHO_EXE = "C:\yol\vho.exe"; npm run e2e`. Ayrıntılı zamanlama günlüğü: `$env:VHO_E2E_DEBUG = 1`.

| Dosya | Kapsam |
|---|---|
| `smoke.e2e.mjs` | Açılış, boş ekran, Lisanslar penceresi, AI işçi modülü, URL penceresi doğrulaması, paneller, uyumluluk modu onayı, tam ekran, uyku zamanlayıcı penceresi |
| `video.e2e.mjs` | H.264 oynatma, duraklatma, atlama, ses %150/sessiz, A-B döngü, altyazı (UTF-8 SRT, Windows-1254 SRT, BOM'lu VTT, gecikme), hız/en-boy, renk filtreleri, AI/bölünmüş ekran, ekran görüntüsü, çalma listesi otomatik geçiş, "video bitince" uyku modu |
| `legacy.e2e.mjs` | WMV9/WMA → Media Foundation dönüştürme → H.264/AAC kareleri çözülüyor (Windows) |
| `engine.e2e.mjs` | libmpv: motor etkin, oynat/duraklat/atla, ses kanalı (`aid` + dil), altyazı kanalı, `sub-add` ile harici SRT, bölüm atlama, ses gecikmesi, ekolayzır (`af`), ses %150 + renk ayarları, kare kare, ekran görüntüsü dosyası, yer imi, A-B (`ab-loop`), döndür/yansıt/yakınlaştır, fotoğrafta video penceresi gizli, HEVC, otomatik geçiş; `VHO_DISABLE_MPV=1` → HTML5 yedeği |
| `photo.e2e.mjs` | JPEG + PNG, bilgi kartı, yakınlaştırma, döndürme, sarmalı gezinme, slayt gösterisi, ekran görüntüsü |

### Test medyası (`tests/fixtures/`)
Tamamı sentetik ve depoya dahildir (toplam ~185 KB); `tests/fixtures/make-fixtures.ps1` ile yeniden üretilir:
- `sample-h264.mp4` (3 sn, 320×240, H.264/AAC) ve `legacy-wmv9.wmv` (3 sn, WMV9/WMA): `tests/fixtures/gen` içindeki küçük Rust aracı, Windows'un kendi Media Foundation kodlayıcılarıyla yazar.
- `photo-a.jpg`, `photo-b.png`: System.Drawing ile çizilir.
- `sample.srt` (UTF-8, CRLF), `sample.vtt` (UTF-8 BOM), `sample-1254.srt` (Windows-1254): `make-subtitles.mjs`.

---

## 🤝 Katkıda Bulunma (Contributing)

Açık kaynak topluluğunun katkılarını memnuniyetle karşılıyoruz!

1. Bu depoyu Fork'layın (`Fork` butonu)
2. Yeni bir özellik dalı oluşturun (`git checkout -b feature/YeniOzellik`)
3. Değişikliklerinizi commit edin (`git commit -m 'feat: Yeni özellik eklendi'`)
4. Dalınıza push edin (`git push origin feature/YeniOzellik`)
5. Bir **Pull Request (PR)** açın.

---

## 📄 Lisans

Bu proje [MIT Lisansı](LICENSE) kapsamında açık kaynak olarak lisanslanmıştır. Özgürce kullanılabilir, değiştirilebilir ve dağıtılabilir.

### Üçüncü taraf bileşenler

VHO yalnızca açık kaynak lisanslı (MIT, Apache-2.0, BSD, CC-BY-4.0 vb.) bileşenler kullanır. Tam liste ve lisans metinleri [src/legal/THIRD_PARTY_NOTICES.txt](src/legal/THIRD_PARTY_NOTICES.txt) dosyasında ve uygulamada **AI Restorasyon → Lisanslar ve Teşekkürler** penceresindedir.

- **Yapay zeka bileşenleri uygulamayla birlikte gelmez.** İlk kullanımda, kullanıcı onayıyla, sabit sürüm/commit adreslerinden indirilir ve SHA-256 ile doğrulanır. Lisans dosyaları da yanlarında saklanır.
  - [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0: Microsoft, MIT
  - [4xRealWebPhoto_v4_dat2](https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2): Philip Hofmann, CC-BY-4.0 (değiştirilmeden kullanılır)
- GPU görüntü iyileştirici, AMD FidelityFX FSR 1.0'ın (MIT) WebGL2 uyarlamasıdır.
- Rust bağımlılıklarının bildirimleri `cargo-about` ile üretilir. Bağımlılık değiştiğinde `powershell -File legal\generate-notices.ps1` çalıştırın.

---

<div align="center">

Geliştirici: **[Halil SARITAŞ](https://github.com/hsrts)** · TurkuazCode  
*Sorularınız veya özellik önerileriniz için [GitHub Issues](https://github.com/hsrts/vho/issues) sekmesini kullanabilirsiniz.*

</div>
