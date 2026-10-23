# Plan 01 — Temel Mimari ve Test Altyapısı (Ajan A1, Dalga 1)

## Amaç
2.700 satırlık `src/main.js`'i davranışı değiştirmeden ES modüllerine bölmek ve her sonraki dalganın üzerine kurulacağı test altyapısını kurmak. **Bu görev özellik eklemez; mevcut her özellik aynen çalışmalıdır.**

## §1 Modül yapısı
```
src/
├── main.js                 # yalnızca önyükleme: modülleri oluşturur ve bağlar (< 150 satır)
├── core/
│   ├── dom.js              # $ / $$ yardımcıları, tüm DOM referansları tek yerde
│   ├── events.js           # uygulama olay veriyolu (EventTarget tabanlı): "media:loaded", "media:time", ...
│   ├── state.js            # küçük reaktif store (get/set/subscribe); oynatma, çalma listesi, ayarlar
│   └── tauri.js            # __TAURI__ sarmalayıcıları (invoke, convertFileSrc, listen, pencere); tarayıcıda no-op
├── media/
│   ├── classify.js         # uzantı/MIME sınıflandırma (saf fonksiyonlar)
│   ├── loader.js           # openEntries/openPaths/pickFiles, kaynak çözümleme, ObjectURL yönetimi
│   ├── video-player.js     # oynat/duraklat/atlama/A-B/kaldığın yer/hız/en-boy, codec tanılama, dönüştürme akışı
│   ├── audio-engine.js     # Web Audio grafiği, booster, DSP, limiter
│   ├── subtitles.js        # decode/parse (SRT/VTT)/findCue/gecikme
│   ├── photo-viewer.js     # zoom/pan/döndürme/slayt/bilgi kartı
│   ├── gpu-enhancer.js     # (mevcut)
│   ├── ai-*.js, face-restore.js  # (mevcut, dokunma)
├── ui/
│   ├── hud.js  playlist.js  panels.js  toasts.js  shortcuts.js  window-controls.js  modals.js
│   └── fullscreen.js
└── legal/ (mevcut)
```
Kurallar:
- Modüller birbirini **olay veriyolu veya açık bağımlılık enjeksiyonu** ile çağırır; döngüsel import yok.
- Saf mantık (ayrıştırma, sınıflandırma, zaman biçimleme, çalma listesi indeksleme) DOM'suz fonksiyonlara çıkarılır → birim testlenebilir.
- Global durum yalnızca `core/state.js`'de.
- Davranış değişikliği yasak; yeniden düzenleme sırasında bulunan hatalar ayrı commit + rapor.

## §2 Birim testleri
- **Çalıştırıcı:** Node 24 yerleşik `node:test` + `node:assert` (ek bağımlılık yok). Komut: `npm test`.
- Kapsam (en az): `classify`, `formatTime`, `subtitles.parseCues` (SRT, VTT, BOM, CRLF, ASS etiketleri, Windows-1254 çözme), `findCue`, çalma listesi gezinme (sınırlar, sarma), `gpu-enhancer` dışındaki saf yardımcılar, `ai-worker` protobuf yaması (`fixOutputDimNames` — sabit küçük bir ONNX parçasıyla).
- Rust: `cargo test --release --lib` (mevcut `transcode` testi `#[ignore]` kalır).

## §3 Uçtan uca (E2E) test düzeneği
Mevcut PowerShell + CDP betikleri (`scratchpad`) proje içine **Node** ile taşınır:
```
tests/e2e/
├── lib/cdp.mjs        # Node 24 yerleşik WebSocket ile CDP istemcisi (evaluate, screenshot, zaman aşımı)
├── lib/app.mjs        # vho.exe'yi WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port ile başlat/kapat, dosya argümanı
├── fixtures/          # küçük test medyası (aşağıya bkz.)
├── smoke.e2e.mjs      # açılış, boş ekran, Lisanslar penceresi
├── video.e2e.mjs      # H.264 MP4 oynat, duraklat, atla, ses %150, A-B, altyazı yükle
├── legacy.e2e.mjs     # MPEG-4 Part 2 → dönüştürme → kare çözüldü (Windows)
└── photo.e2e.mjs      # JPEG aç, zoom, döndür, slayt, ekran görüntüsü
```
- Komut: `npm run e2e` (önce `npm run build:release` gerektirir).
- **Fixture üretimi:** telifsiz, depoya küçük dosyalar: Media Foundation ile üretilmiş 3 sn H.264/AAC MP4, 3 sn MPEG-4 Part 2 MP4, 2 küçük JPEG/PNG, bir SRT ve bir VTT. Üretim betiği `tests/fixtures/make-fixtures.ps1` (Rust test yardımcısı veya PowerShell + MF). Toplam < 2 MB.
- Testler pencere odağına/ekran görüntüsüne güvenmez (arka plandaki pencerede kare güncellenmez); durum DOM/medya API'leri üzerinden okunur (`videoWidth`, `getVideoPlaybackQuality`, metinler).
- Türkçe karakter içeren karşılaştırmalar için betikler UTF-8 kaydedilir.

## §4 Kabul ölçütleri
- `npm test` ve `npm run e2e` yeşil; E2E toplam < 5 dk.
- Uygulamanın tüm özellikleri yeniden düzenleme öncesi gibi çalışır (E2E + elle kontrol listesi raporda).
- `main.js` < 150 satır; hiçbir modül > 600 satır.
- Release derlemesi başarılı; `README.md`'ye "Geliştirme ve test" bölümü eklenir.
