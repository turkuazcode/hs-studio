# Platform desteği ve yetenek matrisi (P01)

**Tarih:** 2026-10-25 · **Plan:** [10 — Platform ve paketleme](plans/10-platform-ve-paketleme.md) / P01 · **Doğruluk kuralları:** [09 — S04](plans/09-entegrasyon-ve-dogruluk.md)

Bu belge VHO'nun hangi platformda neyi **gerçekten** yapabildiğini tek bir sözleşmeyle anlatır. Windows'taki test sonucu macOS/Linux için kanıt sayılmaz.

## Sözleşme

Uygulama tek bir sorgu modeli kullanır; arayüz bir kontrolün çalışıp çalışmadığını yalnızca buradan öğrenir (ikinci bir yetenek sistemi yoktur).

| Katman | Kaynak | İçerik |
|---|---|---|
| Arka uç | `platform_capabilities` komutu (`src-tauri/src/capabilities.rs`) | Mevcut `engine_status`, `photo` codec yoklamaları (`heic::os_support`, `heic::avif_works`) ve `actions_capabilities` çıktılarının adaptörü: motor, video yüzeyi, donanım çözme, FFmpeg, fotoğraf codec'leri, OCR/paylaşım/arka plan/birlikte aç, sistem medya kontrolleri |
| Ön yüz | `src/core/capabilities.js` → `app.capabilities` | Arka uç girdileri + yalnızca WebView'in bildiği bilgiler (WebGL2, WebGPU, o anki öğeyi oynatan motor): görüntü filtresi, A/B karşılaştırma, fotoğraf AI arka ucu, video restorasyonu |

Her girdi aynı alanları taşır:

| Alan | Anlamı |
|---|---|
| `id` | Kararlı kimlik, ör. `engine.libmpv`, `photo.avif`, `video.compare` |
| `available` | Bu makinede, şu an kullanılabilir (derleme bayrağı **ve** çalışma anı varlığı/yoklaması) |
| `implementation` | İşi yapan bileşen (`libmpv-lgpl`, `wic`, `webgl2`, `onnx-webgpu` …) |
| `verified` | Bu OS/mimari için **gerçek cihaz testi** var. Derleme veya çalışma anı yoklaması tek başına `true` yapmaz. Yalnızca doğrulanmış platformda ve otomatik testi olan özellikte `true` |
| `reasonCode` | Kullanılamama/sınır nedeni (makine okunur) |

Desteklenmeyen kontrol ya gizlenir ya da **devre dışı + nedeni yazılı** gösterilir; sessizce başka bir işlem yapılmaz. Örnek: libmpv motorunda A/B karşılaştırma düğmesi devre dışıdır ve "libmpv motorunda kullanılamaz" yazar (`video.compare`, `reasonCode: engine-mpv`).

### Neden kodları

| Kod | Anlamı |
|---|---|
| `engine-missing` | libmpv DLL'leri bulunamadı (`npm run stage:mpv` çalıştırılmamış) → HTML5 yedeği |
| `engine-disabled` | `VHO_DISABLE_MPV` ile kapatıldı (testler) |
| `engine-failed` | DLL var, başlatılamadı |
| `engine-unsupported-platform` | Bu platformda libmpv gömme henüz yok (macOS/Linux: P02/P03) |
| `engine-mpv` | Özellik libmpv'nin kendi çizdiği karede yapılamıyor (WebGL erişimi yok) |
| `no-webgl2` | WebGL2 yok |
| `webview-codecs-only` | HTML5 yedeği: codec yelpazesi WebView'inki kadar |
| `success-not-measured` | İstenen yol (ör. `hwdec=auto-safe`) etkin; dosya başına başarı burada ölçülmüyor |
| `codec-missing` / `codec-failed` | OS codec'i yok / kurulu ama çözemiyor (S03, `0x88982F8B`) |
| `raw-preview-only` | RAW'da yalnızca gömülü JPEG önizlemesi |
| `ffmpeg-missing` | `ffmpeg.exe` yerleştirilmemiş: dışa aktarma eylemleri kapalı |
| `unsupported-platform` | Bu platformda uygulanmadı |
| `system-changes-disabled` | `VHO_DISABLE_SYSTEM_CHANGES` (testler): eylem yalnızca günlüğe yazılır |
| `not-implemented` | Hiçbir platformda yok (ör. sistem medya tuşları) |
| `not-ready` | Kalite kapısı geçilmedi (video restorasyonu, Plan 12 / V06) |
| `no-backend` | Tauri arka ucu yok (yalnızca tarayıcı) |
| `model-download-on-first-use` | Fotoğraf AI: model ilk kullanımda indirilir |

## Hedef platformlar

| Platform | Durum | Kanıt |
|---|---|---|
| Windows 11 x64 (WebView2) | **destekli / testli** | Windows 11 Pro 10.0.26300, 1 GB dahili AMD GPU: birim + Rust + E2E ([test-baseline](status/test-baseline.md)) |
| macOS arm64 (WKWebView) | **test edilmedi** | Derleme koşulları kodda var; libmpv gömme yok (P02). Cihaz testi yapılmadı |
| Linux x64 Wayland / X11 (WebKitGTK) | **test edilmedi** | libmpv gömme yok (P03). Cihaz testi yapılmadı |
| Windows ARM64, macOS Intel | hedef değil (henüz) | Ayrı kanıt gelince eklenir |

En düşük OS sürümleri seçilen Tauri/runtime gereksinimleri ve gerçek testlerle sabitlenecektir (P05); bütün eski sürümler vaat edilmez. Bugün yalnızca yukarıdaki Windows 11 makinesi doğrulanmıştır.

## Özellik matrisi

`destekli/testli` = gerçek cihazda otomatik test var · `destekli/test bekliyor` = kod var, cihaz testi yok · `desteklenmiyor` = bu platformda yok.

| Yetenek (`id`) | Windows x64 | macOS arm64 | Linux x64 | Not |
|---|---|---|---|---|
| libmpv motoru (`engine.libmpv`) | destekli/testli | desteklenmiyor | desteklenmiyor | P02/P03 |
| HTML5 yedeği (`engine.html5`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Codec'ler WebView'e bağlı; "geniş codec desteği" sayılmaz |
| Video yüzeyi (`video.surface`) | destekli/testli (sahipli açılır pencere) | desteklenmiyor | desteklenmiyor | ADR 0001; macOS/Linux ADR 0002 bekliyor |
| Donanım çözme (`video.hwdec`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | `hwdec=auto-safe` istenir; başarı ölçülmedi |
| Eski codec dönüştürme (`video.legacyTranscode`) | destekli/testli | desteklenmiyor | desteklenmiyor | Media Foundation |
| FFmpeg eylemleri (`encode.ffmpeg`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Yalnızca LGPL derleme paketlenir |
| HEIC (`photo.heic`) | destekli/test bekliyor | destekli/test bekliyor (`sips`) | destekli/test bekliyor (`heif-convert`) | OS codec'ine bağlı |
| AVIF çözme (`photo.avif`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | S03 yoklaması |
| AVIF yazma (`photo.avifEncode`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Rust `image` |
| RAW (`photo.raw`) | destekli/testli (önizleme) | destekli/test bekliyor | destekli/test bekliyor | Gömülü JPEG önizlemesi; tam RAW geliştirme yok (F04) |
| OCR (`actions.ocr`) | destekli/testli | desteklenmiyor | desteklenmiyor | P04 |
| Paylaş (`actions.share`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | Testte yalnızca günlüğe yazılır |
| Arka plan (`actions.wallpaper`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | Testte uygulanmaz |
| Kilit ekranı (`actions.lockScreen`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | |
| Birlikte aç (`actions.openWith`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | |
| Sistem medya kontrolleri (`system.mediaControls`) | desteklenmiyor | desteklenmiyor | desteklenmiyor | SMTC/MPRIS yok |
| Görüntü filtresi, WebGL2 (`video.gpuFilter`) | destekli/testli (HTML5 motoru) | destekli/test bekliyor | destekli/test bekliyor | libmpv'de yok (`engine-mpv`) |
| A/B karşılaştırma (`video.compare`) | destekli/testli (HTML5 motoru) | destekli/test bekliyor | destekli/test bekliyor | libmpv'de devre dışı + neden |
| Renk filtresi (`video.colorFilter`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | libmpv özellikleri veya CSS |
| %200 ses + sınırlayıcı (`audio.boostLimiter`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | `tests/e2e/audio-limiter.e2e.mjs` |
| Fotoğraf AI (`photo.aiEnhance`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | ONNX Runtime Web; gerçek model kalite testi yok (Q02) |
| Video restorasyonu (`video.aiRestore`) | desteklenmiyor (`not-ready`) | desteklenmiyor | desteklenmiyor | Plan 12 |

## Testler ve platform seçimi

- Rust: `capabilities::tests` (`cargo test --release --lib caps_`) Windows için motor var/yok/kapalı/başarısız, codec var/yok/bozuk, FFmpeg yok ve test koruması senaryolarının farklı yanıt verdiğini; macOS/Linux/Windows ARM64 girdilerinde hiçbir girdinin `verified` olmadığını doğrular. Saf fonksiyondur, her platformda çalışır.
- Birim (Node): `tests/unit/capabilities.test.mjs` ön yüz girdilerini (libmpv/HTML5, WebGL2 var/yok, AI arka ucu yok/WASM/WebGPU) ve birleştirmeyi doğrular.
- E2E (yalnızca Windows/WebView2): `engine.e2e.mjs` gerçek uygulamada libmpv varken ve `VHO_DISABLE_MPV=1` iken `platform_capabilities` yanıtlarını ve arayüzün aynı bilgiyi kullandığını (A/B düğmesi) denetler. E2E başlatıcısı Windows dışı platformda çalıştırılmaz; bu, o platformun desteklendiği anlamına gelmez.
- Bir platformu `verified` yapmak için: `verified_platform()` listesine OS/mimari eklemek, o makinede tüm takımların sonucunu bu belgeye ve [test-baseline](status/test-baseline.md)'a tarih/OS/donanım ile yazmak gerekir.
