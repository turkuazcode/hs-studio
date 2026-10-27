<div align="center">

# 🎬 VHO — Video H Oynatıcısı
### Açık kaynak video, fotoğraf ve müzik oynatıcısı / stüdyosu

[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.85+-orange?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Test%20edilen-Windows%2011%20x64-lightgrey?style=for-the-badge)](docs/platform-support.md)
[![Developer](https://img.shields.io/badge/Developer-Halil%20SARITAŞ%20(hsrts)-E11D48?style=for-the-badge)](https://github.com/hsrts)

<br/>

**VHO (Video H Oynatıcısı)**, oynatma motoru olarak LGPL **libmpv**'yi, arayüz için **Tauri 2.0 + Rust + sade bir web arayüzünü** kullanan masaüstü medya uygulamasıdır: video oynatıcı, fotoğraf stüdyosu ve müzik araçları bir arada.

</div>

> **Platform durumu:** Yalnızca **Windows 11 x64** üzerinde gerçek cihazda test edildi. macOS ve Linux için kod derlenebilir durumda olabilir, fakat libmpv gömme yok ve **test edilmedi**; ayrıntılı yetenek tablosu: [docs/platform-support.md](docs/platform-support.md).

---

## ✨ Öne Çıkan Özellikler

| Özellik | Açıklama |
|---|---|
| 🎞️ **libmpv oynatma motoru** | LGPL libmpv + FFmpeg (Windows): ses/altyazı kanalları, bölümler, kare kare, A-B döngü, HDR ton eşleme, donanım çözme (`hwdec=auto-safe`). libmpv DLL'leri yoksa uygulama **HTML5 `<video>` yedeğiyle** açılır: o durumda codec desteği WebView2'ninkiyle sınırlıdır (eski WMV/WMA için Media Foundation dönüştürmesi), ekolayzır/normalizasyon/ses gecikmesi kullanılamaz. |
| 🎨 **Görüntü filtreleri** (oynatma sırasında) | Parlaklık, kontrast, doygunluk (libmpv'de gama/renk tonu da). "İyileştir" panelindeki **görüntü filtresi** HTML5 motorunda WebGL2 ile FSR 1.0 büyütme + CAS keskinleştirme uygular; libmpv motorunda yalnızca kontrast/doygunluk artırır. **Sinir ağı değildir**, kaybolmuş ayrıntıyı geri getirmez ve videoyu dışa aktarmaz. |
| 🔊 **Ses filtreleri ve %200'e kadar ses** | Konuşma bandı (+5,5 dB @ 2,4 kHz), 90 Hz–7,5 kHz bant filtresi, kompresör, 10 bant ekolayzır, normalizasyon (DSP; sinir ağı değil). %100'ün üstü doğrusal kazançtır (%200 = 2,5×) ve **her iki motorda da sınırlayıcıyla (limiter) biter**: yüksek sesli içerik kırpılmaz ama sıkıştırılır, yani kayıpsız değildir. Ölçüm: `tests/e2e/audio-limiter.e2e.mjs`. |
| ⚖️ **A/B karşılaştırma** | Görüntü filtresinin yarım ekran önce/sonra görünümü. Yalnızca filtreyi WebGL2'nin çizdiği **HTML5 motorunda** çalışır; libmpv motorunda düğme devre dışıdır ve nedeni yazar. |
| ✨ **Fotoğrafı AI ile iyileştir** | Sinir ağıyla (4xRealWebPhoto DAT-2, isteğe bağlı GFPGAN yüz onarımı) 4× büyütme; WebGPU, yoksa WASM. Eklenen ayrıntı **modelin tahminidir**, gerçek ayrıntı kurtarma değildir. Çıktı en fazla 40 MP'dir (büyük fotoğraflar önce küçültülür); PNG olarak kaydedilir, EXIF/ICC ve saydamlık henüz korunmaz. Modeller ilk kullanımda onayla indirilir (internet gerekir), sonra çevrimdışı çalışır. |
| 🎬 **Video restorasyonu (AI)** | **Henüz hazır değil** (Plan 12). Uygulamada bu adla çalışan bir özellik yoktur. |
| 🖼️ **Fotoğraf Stüdyosu** | Klasör ızgarası, EXIF, histogram, kırp/döndür/kaydet, karşılaştırma, toplu dönüştürme. HEIC/AVIF Windows codec'lerine bağlıdır; **RAW dosyalarında gömülü JPEG önizlemesi** gösterilir (tam RAW geliştirme yok). |
| 🧰 **Medya eylemleri** | Kes, dönüştür, GIF, sesi çıkar, kare kaydet (FFmpeg gerekir), etiket/şarkı sözü düzenleme, OCR ve paylaşım (Windows). Ayrıntı: [docs/media-actions.md](docs/media-actions.md). |
| 🌐 **Altyazı** | SRT/VTT/ASS; UTF-8 ve Windows-1254 (Türkçe). "Online altyazı bul" yalnızca tıkladığınızda OpenSubtitles.org aramasını tarayıcıda açar. |
| 🌙 **Uyku zamanlayıcısı** | 15–60 dk veya "video bitince": sesi kısıp duraklatır; isteğe bağlı bilgisayarı uyutma (Windows'ta test edildi). |
| 📸 **Ekran görüntüsü, PiP, oynatma listesi, kaldığın yer** | Ekran görüntüsü videonun kendi çözünürlüğündedir. Resim içinde resim yalnızca HTML5 motorunda. |

---

## 🏗️ Mimari ve Teknoloji Yığını

```
┌─────────────────────────────────────────────────────────────────┐
│          Ön yüz: vanilla JS ES modülleri (WebView2)             │
│   HTML5 <video> yedeği · WebGL2 filtre · Web Audio · ONNX Web   │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Tauri IPC
┌────────────────────────────────▼────────────────────────────────┐
│                   Tauri 2.0 çekirdeği (Rust)                    │
│  fotoğraf (image/WIC) · medya eylemleri (FFmpeg) · platform     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ dinamik yükleme (Windows)
┌────────────────────────────────▼────────────────────────────────┐
│        libmpv (LGPL) + FFmpeg (LGPL): gpu-next, D3D11/Vulkan    │
└─────────────────────────────────────────────────────────────────┘
```

* **Arayüz:** Vanilla CSS & JavaScript, çerçeve bağımlılığı yok. Açılış süresi ölçülmedi; hız iddiası yapılmaz.
* **Masaüstü katmanı:** [Tauri 2.0](https://tauri.app/).
* **Medya motoru:** Windows'ta libmpv ([docs/engine.md](docs/engine.md)); diğer platformlarda şimdilik yalnızca HTML5 yedeği. Yetenekler tek kaynaktan sorgulanır: [docs/platform-support.md](docs/platform-support.md).

---

## ⌨️ Klavye Kısayolları (Cheatsheet)

Tüm kısayollar **Ayarlar → Kısayollar**'dan değiştirilebilir; <kbd>?</kbd> yardım penceresini açar.

| Kısayol | İşlev |
|---|---|
| <kbd>Boşluk</kbd> | Oynat / Duraklat (fotoğrafta slayt gösterisi) |
| <kbd>←</kbd> / <kbd>→</kbd> | 5 saniye geri / ileri sar (Shift ile 30 saniye) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Ses seviyesini %5 artır / azalt (%0 - %200, %100 üstü sınırlayıcılı) |
| <kbd>M</kbd> | Sesi Kapat / Aç (Mute) |
| <kbd>F</kbd> veya **Çift Tıklama** | Tam Ekran Aç / Kapat |
| <kbd>C</kbd> veya <kbd>V</kbd> | Altyazıyı Aç / Gizle |
| <kbd>G</kbd> / <kbd>H</kbd> | Altyazı gecikmesini -50ms / +50ms kaydır |
| <kbd>S</kbd> | Ekran görüntüsü kaydet |
| <kbd>L</kbd> | Oynatma listesini aç / kapat |
| <kbd>P</kbd> | Resim içinde resim (yalnızca HTML5 motoru) |
| <kbd>A</kbd> | Görüntü ve ses filtrelerini aç / kapat |
| <kbd>B</kbd> | A/B karşılaştırma (yalnızca HTML5 motoru + WebGL2) |
| <kbd>E</kbd> | Fotoğrafı AI ile iyileştir (fotoğrafta) |

---

## 🚀 Kurulum ve Çalıştırma

### Gereksinimler
* [Node.js](https://nodejs.org/) 20.19+ veya 22.12+ (Vite 8 gereksinimi; testler Node 24 ile çalıştırıldı)
* [Rust](https://rustup.rs/) (Cargo)
* Windows'ta libmpv için LGPL mpv derlemesi (`npm run stage:mpv`, aşağıda); olmadan HTML5 yedeği kullanılır

### Geliştirme Ortamı (Development)
```bash
# Depoyu klonlayın
git clone https://github.com/hsrts/vho.git
cd vho

# Bağımlılıkları yükleyin
npm ci

# Masaüstü penceresiyle geliştirme
npm run tauri dev
```

---

## 📦 Dağıtım & Derleme

```bash
npm run build:release      # src-tauri/target/release/vho.exe (paketsiz)
npm run stage:mpv          # libmpv DLL'leri + ffmpeg/ffprobe exe'nin yanına
```

Kurulum paketleri (`npm run tauri build`: NSIS/MSI, DMG, AppImage/deb) henüz temiz makinede doğrulanmadı (Plan 10 / P05). macOS ve Linux paketleri **test edilmedi**; libmpv bu platformlarda henüz gömülmüyor.

---

## 🧪 Geliştirme ve test

### Ön yüz modül yapısı
`src/main.js` yalnızca önyüklemedir; modüller tek bir `app` bağlamı üzerinden birbirine bağlanır (döngüsel import yok). Paylaşılan durum `src/core/state.js`'de, bildirimler `src/core/events.js` olay veriyolunda.

| Klasör | İçerik |
|---|---|
| `src/core/` | `dom.js` (tüm DOM referansları), `state.js` (reaktif store), `events.js` (olay veriyolu), `tauri.js` (`__TAURI__` sarmalayıcıları, tarayıcıda no-op), `format.js` (saf biçimleme), `settings-schema.js` + `settings.js` (sürümlü ayar şeması, doğrulama, göç, `settings.register()`), `library.js` (son açılanlar + kaldığın yer), `i18n.js` (`t()`, `applyTranslations()`), `keymap.js` (kısayol birleşimleri, çakışma denetimi) |
| `src/media/engine/` | Oynatma motoru cephesi: `engine.js` (ortak sözleşme + saf yardımcılar), `mpv-engine.js` (libmpv, birincil), `html5-engine.js` (`<video>` yedeği + Media Foundation dönüştürme) — ayrıntı: [docs/engine.md](docs/engine.md) |
| `src/media/` | `audio-fx.js` (ekolayzır/normalizasyon/ses gecikmesi), `classify.js`, `subtitles.js`, `loader.js`, `video-player.js`, `audio-engine.js`, `visual-filters.js`, `photo-viewer.js`, `photo-ai.js`, `snapshot.js`, `onnx-patch.js` + mevcut `gpu-enhancer.js`, `ai-*.js`, `face-restore.js` |
| `src/ui/` | `hud.js`, `timeline.js`, `playlist.js`, `panels.js`, `modals.js`, `sleep-timer.js`, `shortcuts.js` (merkezî kısayol tablosu), `fullscreen.js`, `toasts.js`, `window-controls.js`, `platform.js` (platform katmanı önyüklemesi), `settings-modal.js`, `settings-bindings.js`, `recent-files.js`, `menus.js` (sağ tık + titlebar menüsü, fare), `shortcut-editor.js`, `shortcut-help.js`, `theme.js`, `playback-menus.js` (ses/altyazı kanalı, bölümler, yer imleri, görüntü menüsü) |
| `src/studio/` | Fotoğraf Stüdyosu: `studio.js` (klasör tarayıcı, görüntüleyici oturumu), `grid.js` (sanal ızgara), `thumbs.js`, `info-panel.js` (EXIF, histogram), `map.js` (Leaflet + OSM, isteğe bağlı), `editor.js`, `compare.js`, `batch.js`, `filmstrip.js`, `logic.js` (saf yardımcılar). Stil: `src/styles/photo-studio.css`; Leaflet: `src/vendor/leaflet/` (BSD-2) |
| `src/ui/` (eylemler) | `media-actions.js` (medya türüne göre ince araç çubuğu + "⋯"/sağ tık menüsü, kısayollar, Ayarlar alanları), `action-dialogs.js` (onay, yeniden adlandırma, özellikler, ffmpeg iş ilerlemesi/iptal), `export-dialogs.js` (kes, GIF, klip, dönüştür, sesi çıkar, döndür, altyazı, kontak sayfası, zil sesi, ReplayGain), `photo-tools.js` (görüntüyü kopyala, yazdırma önizlemesi, arka plan/kilit ekranı, OCR katmanı), `music-tools.js` (etiket düzenleyici + kapak, şarkı sözleri paneli) — ayrıntı: [docs/media-actions.md](docs/media-actions.md) |
| `src/media/` (eylemler) | `actions-logic.js` (saf: ad doğrulama, aralıklar, yazdırma yerleşimi, OCR katmanı, kısayol tablosu), `lyrics.js` (LRC ayrıştırıcı) |
| `src/i18n/` | `tr.json`, `en.json` (arayüz metinleri: platform katmanı + medya eylemleri `actions.*`) |

Saf mantık (sınıflandırma, zaman biçimleme, altyazı ayrıştırma/kod çözme, çalma listesi gezinme, ONNX yaması...) DOM'suz fonksiyonlardır ve birim testlidir.

### Komutlar
| Komut | Ne yapar |
|---|---|
| `npm ci` | Bağımlılıkları kurar |
| `npm test` | Birim testleri (Node 24 yerleşik `node:test`, ek bağımlılık yok) |
| `npm run build:release` | Release derlemesi: `src-tauri/target/release/vho.exe` |
| `npm run stage:mpv` | LGPL libmpv DLL'lerini (38 adet) ve aynı derlemenin `ffmpeg.exe`/`ffprobe.exe` araçlarını exe'nin yanına kopyalar; kaynak `third_party/mpv/_build/dist` ya da `-Source`/`VHO_MPV_DIST` (araçlar dist'te yoksa `..\prefix\bin`). DLL yoksa uygulama HTML5 motoruyla çalışır; ffmpeg yoksa dışa aktarma eylemleri kapalıdır |
| `npm run e2e` | Uçtan uca testler; önce `npm run build:release` gerekir |
| `cd src-tauri; cargo test --release --lib` | Rust birim testleri (`transcode` gerçek dosya testi `#[ignore]`; `actions::*`: ad/çakışma, tüm ffmpeg hazır ayar argümanları, etiket eşleme, LRC/ebur128 ayrıştırma) |
| `npm run fixtures` | Test medyasını yeniden üretir (Windows) |
| `npm run fixtures:engine` | libmpv test medyasını (çok kanallı MKV, HEVC) LGPL ffmpeg ile üretir |

### Uçtan uca (E2E) testler
`tests/e2e/` altındaki testler `vho.exe`'yi `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<9500-9599>` ile başlatır ve Chrome DevTools Protocol üzerinden sayfayı sürer (`lib/cdp.mjs`, `lib/app.mjs`). Medya dosyaları komut satırı argümanı olarak açılır ("Birlikte aç" yolu).

- Her çalıştırma ayrı, geçici bir WebView2 profili (`WEBVIEW2_USER_DATA_FOLDER`) ve ayrı bir veri klasörü (`VHO_DATA_DIR`: `settings.json`, `library.json`, pencere konumu) kullanır: kullanıcının ayarlarına ve kaldığı yer kayıtlarına dokunmaz. `VHO_DATA_DIR` tek örnek (single-instance) kilidini de o klasöre özgü yapar; test VHO'su dosyalarını kullanıcının açık VHO'suna iletmez. Testler yalnızca kendi başlattıkları süreci kapatır.
- CDP port aralığı varsayılan 9500-9599; paralel çalışmalar için `VHO_E2E_PORT_MIN` / `VHO_E2E_PORT_MAX` ile değiştirilebilir.
- Arka plandaki pencere yeniden çizilmeyebilir; bu yüzden testler ekran görüntüsüne değil, DOM ve medya durumuna (`videoWidth`, `getVideoPlaybackQuality()`, metinler) bakar.
- **Güvenlik (sistem eylemleri):** `vho.exe` her zaman `VHO_DISABLE_SYSTEM_CHANGES=1` ile başlatılır: masaüstü arka planı, kilit ekranı, paylaşım, yazdırma, "Birlikte aç" ve "Klasörde göster" yalnızca `actions_system_log` günlüğüne yazılır, uygulanmaz. Silme testi yalnızca testin kendi geçici kopyasını Geri Dönüşüm Kutusu'na taşır ve o öğeyi yeniden kalıcı olarak siler; panodaki metin test öncesi saklanıp sonra geri yüklenir.
- **Güvenlik:** testler bilgisayarı asla uyku moduna almaz. `vho.exe`, `VHO_DISABLE_SYSTEM_SUSPEND=1` ile başlatılır (`suspend_system` hiçbir şey yapmaz) ve sayfa betikleri çalışmadan önce `__TAURI__.core.invoke` sarmalanır: `suspend_system` ve `set_compat_mode` arka uca hiç gitmez. Koruma her açılışta doğrulanır; doğrulanamazsa testler çalışmaz. Uyku zamanlayıcısı testleri "PC Uyku" kutusunu önce kapatır.
- `window.confirm` ve indirmeler (ekran görüntüsü) test tarafında taklit edilir; yakalanmamış sayfa hataları toplanır ve her testin sonunda boş olmalıdır.
- Motor: `engine.e2e.mjs` libmpv'yi test eder (DLL'ler `npm run stage:mpv` ile hazırlanmamışsa atlanır); diğer dosyalar ve yedek testi `VHO_DISABLE_MPV=1` ile **HTML5 motorunu** kullanır. mpv ekran görüntüleri geçici profile yazılır (`VHO_SCREENSHOT_DIR`). CDP port aralığı `VHO_E2E_PORT_MIN`/`VHO_E2E_PORT_MAX` ile değiştirilebilir.
- Başka bir derlemeyi denemek için: `$env:VHO_EXE = "C:\yol\vho.exe"; npm run e2e`. Ayrıntılı zamanlama günlüğü: `$env:VHO_E2E_DEBUG = 1`.

| Dosya | Kapsam |
|---|---|
| `audio-limiter.e2e.mjs` | %200 ses + sınırlayıcı: libmpv `af` zinciri aynı LGPL libavfilter'lı `ffmpeg.exe` ile, HTML5 Web Audio sınırlayıcısı `OfflineAudioContext` ile ölçülür (tepe ≤ -0,9 dBFS / tam ölçeğe ulaşan örnek yok; sınırlayıcısız hâlin kırptığı gösterilir) |
| `smoke.e2e.mjs` | Açılış, boş ekran, Lisanslar penceresi, AI işçi modülü, URL penceresi doğrulaması, paneller, uyumluluk modu onayı, tam ekran, uyku zamanlayıcı penceresi |
| `video.e2e.mjs` | H.264 oynatma, duraklatma, atlama, ses %150/sessiz, A-B döngü, altyazı (UTF-8 SRT, Windows-1254 SRT, BOM'lu VTT, gecikme), hız/en-boy, renk filtreleri, AI/bölünmüş ekran, ekran görüntüsü, çalma listesi otomatik geçiş, "video bitince" uyku modu |
| `legacy.e2e.mjs` | WMV9/WMA → Media Foundation dönüştürme → H.264/AAC kareleri çözülüyor (Windows) |
| `engine.e2e.mjs` | libmpv: motor etkin, oynat/duraklat/atla, ses kanalı (`aid` + dil), altyazı kanalı, `sub-add` ile harici SRT, bölüm atlama, ses gecikmesi, ekolayzır (`af`), ses %150 + renk ayarları, kare kare, ekran görüntüsü dosyası, yer imi, A-B (`ab-loop`), döndür/yansıt/yakınlaştır, fotoğrafta video penceresi gizli, HEVC, otomatik geçiş; `VHO_DISABLE_MPV=1` → HTML5 yedeği |
| `photo.e2e.mjs` | JPEG + PNG, bilgi kartı, yakınlaştırma, döndürme, sarmalı gezinme, slayt gösterisi, ekran görüntüsü |
| `platform.e2e.mjs` | Ayarlar penceresi (sekmeler, dil değişimi yeniden yüklemeden), kısayol düzenleyici çakışma denetimi, `?` yardım, sağ tık menüsü, tema; ayar değiştir → yeniden başlat → korunmuş; son açılanlar (küçük resim, kaldır, temizle); ikinci `vho.exe dosya.mp4` → aynı pencerede açılır |
| `actions.e2e.mjs` | Medya eylemleri (geçici kopyalar üzerinde): türe göre araç çubukları ve menüler, yolu/dosyayı/görüntüyü/kareyi panoya kopyala, kayıpsız kesim (süre ±1 sn), sesi çıkar (yalnızca ses), 720p dönüştürme (960×720), GIF, kayıpsız döndürme, kontak sayfası, altyazı göm/ayıkla, iş iptali (yarım dosya kalmaz), favori, her zaman üstte, mini oynatıcı, yeniden adlandırma (çakışma denetimi), sil → Geri Dönüşüm Kutusu + listeden çıkar, özellikler, yazdırma önizlemesi, OCR (Windows OCR dili yoksa atlanır), etiket düzenle → yeniden oku, LRC sözleri, ReplayGain, M4R zil sesi; sistem eylemleri günlüğe yazılıp uygulanmaz |
| `photo-studio.e2e.mjs` | Geçici klasörde üretilen 300 fotoğraf (EXIF tarih/GPS/yönlendirme) + video: ızgara, sıralama, filtre/arama, çoklu seçim, bilgi paneli, görüntüleyici + şerit gezinme, kırp/döndür + kaydet, karşılaştırma, toplu WebP dönüştürme (EXIF tarihi korunur), iptal, 5.000 dosyada ilk çizim süresi |

### Test medyası (`tests/fixtures/`)
Tamamı sentetik ve depoya dahildir (toplam ~185 KB); `tests/fixtures/make-fixtures.ps1` ile yeniden üretilir:
- `sample-h264.mp4` (3 sn, 320×240, H.264/AAC) ve `legacy-wmv9.wmv` (3 sn, WMV9/WMA): `tests/fixtures/gen` içindeki küçük Rust aracı, Windows'un kendi Media Foundation kodlayıcılarıyla yazar.
- `photo-a.jpg`, `photo-b.png`: System.Drawing ile çizilir.
- `sample.srt` (UTF-8, CRLF), `sample.vtt` (UTF-8 BOM), `sample-1254.srt` (Windows-1254): `make-subtitles.mjs`.

---

## 🤝 Katkıda Bulunma (Contributing)

Katkılar memnuniyetle karşılanır. Temiz klondan kurulum, test katmanları, mimari, lisans/i18n beklentileri ve küçük ilk görevler: **[CONTRIBUTING.md](CONTRIBUTING.md)** (EN, Türkçe özetli). Katkılar Apache-2.0 ile gelir ve `git commit -s` (DCO) gerektirir. Davranış kuralları: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Güvenlik açıkları herkese açık issue olarak değil, [SECURITY.md](SECURITY.md)'deki yoldan bildirilir. Değişiklik geçmişi: [CHANGELOG.md](CHANGELOG.md).

---

## 📄 Lisans

<!-- license-section: the only README place that states the project license (with the badge above) -->
**HS Studio** (eski çalışma adı **VHO**) — Copyright 2026 Halil SARITAŞ. [Apache License 2.0](LICENSE) ile lisanslanmış açık kaynak yazılımdır: kullanabilir, inceleyebilir, değiştirebilir ve (değiştirilmiş hâliyle de) dağıtabilirsiniz. Dağıtırken lisans metnini ve **[NOTICE](NOTICE)** dosyasındaki atıfları korumanız gerekir; kullanıcılara görünür tutmanız rica edilir (örn. Hakkında/Lisanslar ekranı). Garanti verilmez.

*HS Studio (formerly VHO) is open source under the Apache License 2.0; keep the NOTICE when you redistribute it. No warranty.*

**Ad ve logo:** "HS Studio" adı ve logosu Apache lisansı kapsamında değildir (lisansın 6. maddesi); değiştirilmiş sürümler farklı bir ad ve logo kullanmalıdır. Ayrıntı: [TRADEMARKS.md](TRADEMARKS.md) (tescilli marka iddiası yoktur).
<!-- /license-section -->

### Üçüncü taraf bileşenler

VHO yalnızca açık kaynak lisanslı (MIT, Apache-2.0, BSD, CC-BY-4.0 vb.; libmpv/FFmpeg LGPL, ayrı DLL olarak) bileşenler kullanır. Makinece okunur envanter ve CycloneDX SBOM: [legal/INVENTORY.md](legal/INVENTORY.md), `npm run sbom`. Tam liste ve lisans metinleri [src/legal/THIRD_PARTY_NOTICES.txt](src/legal/THIRD_PARTY_NOTICES.txt) dosyasında ve uygulamada **Ayarlar → Hakkında / Lisanslar** ile **İyileştir → Lisanslar ve Teşekkürler** penceresindedir.

- **Yapay zeka bileşenleri uygulamayla birlikte gelmez.** İlk kullanımda, kullanıcı onayıyla, sabit sürüm/commit adreslerinden indirilir ve SHA-256 ile doğrulanır. Lisans dosyaları da yanlarında saklanır.
  - [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0: Microsoft, MIT
  - [4xRealWebPhoto_v4_dat2](https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2): Philip Hofmann, CC-BY-4.0 (değiştirilmeden kullanılır)
- GPU görüntü filtresi, AMD FidelityFX FSR 1.0'ın (MIT) WebGL2 uyarlamasıdır (sinir ağı değildir).
- Rust bağımlılıklarının bildirimleri `cargo-about` ile üretilir. Bağımlılık değiştiğinde `powershell -File legal\generate-notices.ps1` çalıştırın.

---

<div align="center">

Geliştirici: **[Halil SARITAŞ](https://github.com/hsrts)** · TurkuazCode  
*Sorularınız veya özellik önerileriniz için [GitHub Issues](https://github.com/hsrts/vho/issues) sekmesini kullanabilirsiniz.*

</div>
