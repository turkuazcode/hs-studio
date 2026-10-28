# Platform desteği ve yetenek matrisi (P01)

**Tarih:** 2026-10-26 · **Plan:** [10 — Platform ve paketleme](plans/10-platform-ve-paketleme.md) / P01, P04 · **Doğruluk kuralları:** [09 — S04](plans/09-entegrasyon-ve-dogruluk.md)

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
| `experimental-memory` | Deneysel özellik: bazı cihazlarda bellek yetersizliğiyle çalışmayabilir (A06 arka plan kaldırma) |
| `webview-codecs-only` | HTML5 yedeği: codec yelpazesi WebView'inki kadar |
| `success-not-measured` | İstenen yol (ör. `hwdec=auto-safe`) etkin; dosya başına başarı burada ölçülmüyor |
| `codec-missing` / `codec-failed` | OS codec'i yok / kurulu ama çözemiyor (S03, `0x88982F8B`) |
| `raw-preview-only` | RAW'da yalnızca gömülü JPEG önizlemesi |
| `ffmpeg-missing` | `ffmpeg.exe` yerleştirilmemiş: dışa aktarma eylemleri kapalı |
| `unsupported-platform` | Platform bu eylemi sunmuyor / uygulanmadı (başka bir eylemle taklit edilmez) |
| `system-changes-disabled` | `VHO_DISABLE_SYSTEM_CHANGES` (testler): eylem yalnızca günlüğe yazılır |
| `not-implemented` | Hiçbir platformda yok (ör. sistem medya tuşları) |
| `not-ready` | Kalite kapısı geçilmedi (video restorasyonu, Plan 12 / V06) |
| `runtime-probed` | Kodlayıcı çalışma anı denemesinden geçti (`encode.h264`) |
| `h264-unavailable-fallback-mpeg4` | H.264 kodlayıcısı yok/çalışmıyor; dışa aktarma `mpeg4` ile |
| `export-as-jpeg` | Bu biçim görüntülenir ama yazılmaz; JPEG (veya seçilen biçim) olarak dışa aktarılır |
| `os-decoder-icc-dropped` | OS çözücü yolunda ICC profili henüz okunmuyor |
| `installed-languages-only` | OCR yalnızca yüklü dillerle |
| `tesseract-missing` | Linux'ta `tesseract` komutu bulunamadı |
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

`destekli/testli` = gerçek cihazda otomatik test var · `destekli/test bekliyor` = kod var (o OS için derlenir), cihaz testi yok · `desteklenmiyor` = bu platformda sunulmaz (başka bir eylemle taklit edilmez; arayüz gizler).

Arka uç satırlarının tek kaynağı `src-tauri/src/capabilities.rs` → `SUPPORT` tablosudur; her girdi bu değeri `support` alanında taşır (`supported-tested` / `supported-untested` / `unsupported`). Bu tablo ile aşağıdaki satırlar Rust testi `caps_support_table_matches_docs` ile karşılaştırılır; biri değişirse diğeri de değişmelidir. `desteklenmiyor` hücresi çalışma anı yoklaması ne derse desin `available: false` olur.

| Yetenek (`id`) | Windows x64 | macOS arm64 | Linux x64 | Not |
|---|---|---|---|---|
| libmpv motoru (`engine.libmpv`) | destekli/testli | desteklenmiyor | desteklenmiyor | P02/P03 |
| HTML5 yedeği (`engine.html5`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Codec'ler WebView'e bağlı; "geniş codec desteği" sayılmaz |
| Video yüzeyi (`video.surface`) | destekli/testli (sahipli açılır pencere) | desteklenmiyor | desteklenmiyor | ADR 0001; macOS/Linux ADR 0002 bekliyor |
| Donanım çözme (`video.hwdec`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | `hwdec=auto-safe` istenir; başarı ölçülmedi |
| Eski codec dönüştürme (`video.legacyTranscode`) | destekli/testli | desteklenmiyor | desteklenmiyor | Media Foundation |
| FFmpeg eylemleri (`encode.ffmpeg`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Yalnızca LGPL derleme paketlenir |
| H.264 dışa aktarma (`encode.h264`) | destekli/testli (`h264_mf`, çalışma anı yoklaması) | destekli/test bekliyor (`h264_videotoolbox`) | destekli/test bekliyor (`libopenh264`, ffmpeg onunla derlenmişse) | Aşağıda “Kodlayıcı seçimi”; H.264 çalışmazsa `mpeg4` yedeği + `h264-unavailable-fallback-mpeg4` |
| HEIC görüntüleme (`photo.heic`) | destekli/test bekliyor | destekli/test bekliyor (`sips`) | destekli/test bekliyor (`heif-dec`) | OS codec'ine bağlı (Windows: HEIF + HEVC uzantıları gerekir) |
| AVIF görüntüleme (`photo.avif`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | S03 yoklaması |
| AVIF yazma (`photo.avifEncode`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Rust `image` (ravif) |
| HEIC yazma (`photo.heicEncode`) | desteklenmiyor | desteklenmiyor | desteklenmiyor | Görüntülenebilir ≠ dışa aktarılabilir: HEIC kaynak JPEG (veya seçilen biçim) olarak yazılır (`export-as-jpeg`) |
| RAW (`photo.raw`) | destekli/testli (önizleme) | destekli/test bekliyor | destekli/test bekliyor | Gömülü JPEG önizlemesi, kaynak etiketi `rawPreview`; tam RAW geliştirme yok (F04) |
| RAW yazma (`photo.rawEncode`) | desteklenmiyor | desteklenmiyor | desteklenmiyor | RAW dışa aktarımı JPEG (`export-as-jpeg`) |
| EXIF yönü (`photo.exifOrientation`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Yerel çözücülerde VHO uygular; WIC/libheif HEIF dönüşünü (irot/imir) kendisi uygular, tekrar uygulanmaz |
| Renk profili (`photo.colorProfile`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | ICC: yerel çözücüler + Windows'ta WIC (HEIC/AVIF/RAW) görüntüleme kopyasına ve dışa aktarıma taşınır; macOS/Linux OS çözücü yolunda ICC henüz okunmuyor (`os-decoder-icc-dropped`) |
| OCR (`actions.ocr`) | destekli/testli | desteklenmiyor | destekli/test bekliyor | Windows.Media.Ocr / Linux `tesseract` + dağıtım dil paketleri; yalnızca yüklü dil, aksi `[ocr-language]`; çevrimiçi OCR yok. macOS aşağıda |
| Paylaş (`actions.share`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | Windows Share UI; testte yalnızca günlüğe yazılır. Diğerlerinde “klasörde göster” ile taklit edilmez |
| Birlikte aç (`actions.openWith`) | destekli/test bekliyor | desteklenmiyor | destekli/test bekliyor | Windows `SHOpenWithDialog`; Linux xdg-desktop-portal (`ask`) → `xdg-open`; macOS seçici AppKit ister (yok) |
| Klasörde göster (`actions.reveal`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | `tauri-plugin-opener`; testte yalnızca günlük |
| Pano: metin (`actions.clipboardText`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | `arboard` |
| Pano: dosyalar (`actions.clipboardFiles`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Windows `CF_HDROP`; Linux X11/XWayland (`wayland-data-control` özelliği kapalı) |
| Pano: görüntü (`actions.clipboardImage`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | RGBA |
| Yazdır (`actions.print`) | destekli/test bekliyor | desteklenmiyor | destekli/test bekliyor | WebView `window.print()`; WKWebView'de sessizce hiçbir şey yapmıyor (bilinen Tauri sorunu) → macOS'ta gizli |
| Arka plan (`actions.wallpaper`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | Linux yalnızca GNOME (`gsettings`), başka masaüstünde açık hata; testte uygulanmaz |
| Kilit ekranı (`actions.lockScreen`) | destekli/test bekliyor | desteklenmiyor | desteklenmiyor | Paketlenmemiş uygulamada Windows reddedebilir |
| Sistem medya kontrolleri (`system.mediaControls`) | destekli/testli | desteklenmiyor | desteklenmiyor | Windows SMTC (medya tuşları, ses kaplaması/kilit ekranı kartı: başlık, sanatçı, albüm, kapak); E2E işletim sistemi nesnesinden geri okur. macOS Now Playing / Linux MPRIS uygulanmadı (`not-implemented`) |
| Boşluksuz geçiş (`audio.gapless`) | destekli/testli | desteklenmiyor | desteklenmiyor | libmpv iç listesi + `gapless-audio`; sınırdaki kesinti Rust testinde PCM çıktısında ölçülür (docs/music.md). HTML5 motorunda her parça yeniden açılır |
| ReplayGain uygulama (`audio.replayGain`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | libmpv `replaygain`/`replaygain-preamp`/`replaygain-clip`; HTML5 yalnızca kısabilir (`attenuation-only`) |
| Ağ akışları (`net.streams`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | Yalnızca http/https; libmpv bağlantı koparsa sınırlı yeniden bağlanır; ICY radyo başlığı. HLS libmpv'de açık sorun (docs/network.md). Yerel HLS sunucusuyla E2E (kopma + yeniden bağlanma); parola/belirteç günlükte `***` (docs/network.md) |
| Cihaza yayın: UPnP/DLNA (`cast.dlna`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | Keşif yalnızca kullanıcı isteyince; tek dosya, belirteçli kısa ömürlü HTTP sunucusu. Yalnızca sahte renderer ile test edildi; gerçek TV/hoparlör denenmedi |
| Cihaza yayın: Chromecast (`cast.chromecast`) | desteklenmiyor | desteklenmiyor | desteklenmiyor | Uygulanmadı (`not-implemented`) |
| Görüntü filtresi, WebGL2 (`video.gpuFilter`) | destekli/testli (HTML5 motoru) | destekli/test bekliyor | destekli/test bekliyor | libmpv'de yok (`engine-mpv`); ön yüz girdisi |
| A/B karşılaştırma (`video.compare`) | destekli/testli (HTML5 motoru) | destekli/test bekliyor | destekli/test bekliyor | libmpv'de devre dışı + neden; ön yüz girdisi |
| Renk filtresi (`video.colorFilter`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | libmpv özellikleri veya CSS |
| %200 ses + sınırlayıcı (`audio.boostLimiter`) | destekli/testli | destekli/test bekliyor | destekli/test bekliyor | `tests/e2e/audio-limiter.e2e.mjs` |
| Fotoğraf AI (`photo.aiEnhance`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | ONNX Runtime Web; gerçek model kalite testi yok (Q02) |
| Nesne silme (`photo.aiInpaint`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | LaMa, ONNX Runtime Web; Windows'ta gerçek model testi var (`smart-edit.ai`), renk/kalite insan incelemesi yok |
| Renklendirme (`photo.aiColorize`) | destekli/test bekliyor | destekli/test bekliyor | destekli/test bekliyor | DDColor (harici ağırlık); Windows'ta gerçek model testi var; renk doğruluğu Q02 incelemesi bekliyor |
| Arka plan kaldırma (`photo.aiBackground`) | **deneysel** (`experimental-memory`; test makinesinde bellek yetersiz) | deneysel | deneysel | BiRefNet 1024²; varsayılan gizli, Ayarlar > AI modelleri > "Deneysel: arka plan kaldırma" ile açılır ([smart-edit.md](smart-edit.md)) |
| Video restorasyonu (`video.aiRestore`) | desteklenmiyor (`not-ready`) | desteklenmiyor | desteklenmiyor | Plan 12 |

### Kodlayıcı seçimi (P04)

Dışa aktarma kodlayıcısı derleme sabiti değil, **çalışma anında** seçilir (`actions/ffmpeg.rs` → `select_encoder` / `probe_encoder`, sonuç önbellekte, `media_tools.videoEncoder` ve `encode.h264` girdisinde görünür):

1. Platform adayları sırayla: Windows `h264_mf` → `h264_amf` → `h264_qsv` → `h264_nvenc` → `libopenh264`; macOS `h264_videotoolbox` → `libopenh264`; Linux `libopenh264`. Aday `ffmpeg -encoders` listesinde **ve** gerçek kısa kodlamada (8 kare 640×360 → MP4) başarılı olmalı. Listede olup çalışmayan (ör. H.264 MFT'si bozuk makine) atlanır, denemeler `attempts` içinde kaydedilir.
2. Hiçbiri çalışmazsa ffmpeg'in kendi LGPL `mpeg4` kodlayıcısı (MPEG-4 Part 2) yedektir; Ayarlar > Gelişmiş “(H.264 yok, yedek kodlayıcı)” yazar.
3. Kısıtlar işe uygulanır: piksel biçimi (`nv12` donanım/OS kodlayıcıları, `yuv420p` yazılım), en büyük kare (`h264_mf`/AMF/QSV 4096×2160, NVENC 4096×4096, OpenH264 3840×2160, yatay/dikey yöne göre) — aşan veya tek sayılı boyut `scale` ile sığdırılır, en-boy korunur. HDR (PQ/HLG) kaynak yeniden kodlanmaz (`[unsupported]`; ton eşleme yok), kayıpsız kesim/döndürme açık kalır.
4. `h264_d3d12va` / `h264_vulkan` derlemede var ama referans AMD iGPU'da filtre biçimi hatası verdi ve hwupload grafiği ister: aday değil. VAAPI aynı nedenle henüz aday değil.

Bu makinede (AMD 1 GB iGPU, ffmpeg n8.1.3 LGPL): `h264_mf` yoklamayı geçer (Rust `encoder_runtime_probe_real_ffmpeg`, E2E `engine` ve `actions`).

### OCR adayları (P04)

| Platform | Aday | Lisans / dağıtım | Çevrimdışı dil | Durum |
|---|---|---|---|---|
| Windows | Windows.Media.Ocr | İşletim sistemi bileşeni | Windows dil paketleri (Türkçe dil yüklüyse) | uygulandı, testli |
| Linux | Tesseract CLI (`tesseract`) | Apache-2.0; dağıtım paketi (`tesseract-ocr`), VHO paketlemez/indirmez, ayrı süreç | `tesseract-ocr-tur`, `-eng` … traineddata (Apache-2.0) | kod yolu yazıldı (`actions/ocr.rs` `tesseract`), ayrıştırıcılar Windows'ta birim testli; cihazda test edilmedi |
| macOS | Apple Vision (`VNRecognizeTextRequest`) | Sistem çerçevesi, ek dağıtım yok | OS'e gömülü; **Türkçe tanıma dilleri arasında görünmüyor** (Apple `supportedRecognitionLanguages` çıktısı, topluluk raporları) | uygulanmadı: hedef dil desteklenmeden açılmıyor; macOS cihazında `supportedRecognitionLanguages` yeniden kontrol edilmeli |

Yüklü olmayan dil her yerde `[ocr-language]` hatasıdır (ör. Linux'ta `tesseract-ocr-deu` paketi adıyla); hiçbir platformda sessiz çevrimiçi OCR yoktur.

Gerçek masaüstünde sistem etkili eylemlerin elle doğrulanması: [manual-os-checklist.md](manual-os-checklist.md).

## Testler ve platform seçimi

- Rust: `capabilities::tests` (`cargo test --release --lib caps_`) Windows için motor var/yok/kapalı/başarısız, codec var/yok/bozuk, FFmpeg yok ve test koruması senaryolarının farklı yanıt verdiğini; macOS/Linux/Windows ARM64 girdilerinde hiçbir girdinin `verified` olmadığını doğrular. Saf fonksiyondur, her platformda çalışır.
- Birim (Node): `tests/unit/capabilities.test.mjs` ön yüz girdilerini (libmpv/HTML5, WebGL2 var/yok, AI arka ucu yok/WASM/WebGPU) ve birleştirmeyi doğrular.
- E2E (yalnızca Windows/WebView2): `engine.e2e.mjs` gerçek uygulamada libmpv varken ve `VHO_DISABLE_MPV=1` iken `platform_capabilities` yanıtlarını ve arayüzün aynı bilgiyi kullandığını (A/B düğmesi) denetler. E2E başlatıcısı Windows dışı platformda çalıştırılmaz; bu, o platformun desteklendiği anlamına gelmez.
- Bir platformu `verified` yapmak için: `verified_platform()` listesine OS/mimari eklemek, o makinede tüm takımların sonucunu bu belgeye ve [test-baseline](status/test-baseline.md)'a tarih/OS/donanım ile yazmak gerekir.
