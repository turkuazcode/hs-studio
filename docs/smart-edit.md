# Akıllı düzenleme: nesne silme, arka plan, renklendirme (Plan 07 / Plan 11 A06)

Plan: [07-akilli-duzenleme.md](plans/07-akilli-duzenleme.md) (tarifler) · [11 A06](plans/11-ai-altyapisi-ve-fotograf.md) · Altyapı: [ai-runtime.md](ai-runtime.md) (A03), [ai-output.md](ai-output.md) (A04), [jobs-api.md](jobs-api.md) (A02)

Kod: `src/studio/smart-tools.js` (düzenleyicideki "✨ Akıllı" bölümü), `src/studio/editor.js` (taban görüntü + geçmiş), `src/media/smart-edit.js` (ön/son işleme), `src/media/ai-worker.js` (`runSmart`), `src/media/ai-engine.js` (`SMART_MODELS`, `smartEdit`), `src/media/ai-jobs.js` (`smartEditRequest`, iş türleri), `src-tauri/src/ai/manifest.rs` (bileşenler), `src-tauri/src/jobs/external.rs` (`AI_KINDS`).

## Kullanıcının gördüğü

- Fotoğraf **Düzenle** ekranında tek bir **✨ Akıllı** bölümü: *Nesne sil · Arka plan · Renklendir*. Ana ekrana ve video/müzik düzenine bir şey eklenmedi.
- **Renklendir** yalnızca siyah-beyaz veya çok soluk fotoğraflarda görünür (`isColorizeCandidate`: ortalama Lab kroma ≤ 8).
- **Nesne sil:** fırça (boyut kaydırıcısı), silgi, temizle, "Sil". Maske, önizlemenin üstündeki ayrı bir katmana çizilir.
- **Arka plan:** Şeffaf (PNG) · Beyaz · Siyah · Renk (seçici) · Bulanık (yoğunluk). Model varsayılan olarak **Kişi (portre)**. **Nesne ve ürün** modeli Ayarlar > AI modelleri > "Arka plan kaldırma modeli" ile seçilir ve ikinci bir model indirir.
- Döndürme, kırpma veya ayar değişikliği bekliyorsa araçlar kapalıdır ve kısa bir not çıkar: önce kaydet veya sıfırla. Akıllı araçlar dik, kırpılmamış görüntüde çalışır.
- İlk kullanımda mevcut A01 onayı çıkar: model adı, yazar, lisans ve indirme boyutu.
- İş, A02 kuyruğunda kalıcı bir AI işi olarak çalışır (A03 tek ağır iş kuralı, ilerleme, iptal, oynatma sırasında duraklatma). Arayüz donmaz (Web Worker).
- Sonuç düzenleyicinin yeni **taban görüntüsü** olur ve geçmişe bir adım olarak girer: Ctrl+Z ile geri alınır. Bölümde "Uygulanan: nesne silme, arka plan" gibi bir satır, hangi AI işlemlerinin uygulandığını gösterir.
- AI sonucu orijinalin üzerine **yazılmaz**: "Kaydet" bu durumda "Kopya kaydet" gibi davranır ve orijinalin yanına yeni bir dosya yazar (PNG saydamlığı korunur). Orijinali değiştiren bir yol yoktur; arşiv dosyasına kullanıcı seçimi olmadan nesne silme veya renklendirme uygulanmaz.
- Başka bir fotoğraf açılınca maske, paneller ve uygulanan adımlar sıfırlanır.

## Modeller (sabit kaynak + tam SHA-256, `manifest.rs`)

| Bileşen | Kaynak (sabit commit / sürüm) | Dosya | Lisans |
|---|---|---|---|
| `lama` | `Carve/LaMa-ONNX` @ `c3c0c9e…` | `lama_fp32.onnx` (208 MB) | Apache-2.0 |
| `birefnet-portrait` | `onnx-community/BiRefNet-portrait-ONNX` @ `dd7167f…` | `onnx/model_fp16.onnx` → `birefnet_portrait_fp16.onnx` (490 MB) | MIT |
| `birefnet-general` (isteğe bağlı) | `onnx-community/BiRefNet-ONNX` @ `534d3c8…` | `onnx/model_fp16.onnx` → `birefnet_general_fp16.onnx` (490 MB) | MIT |
| `ddcolor` | Qualcomm AI Hub v0.65.0 `ddcolor-onnx-float.zip` (zip özeti doğrulanır) | `ddcolor.onnx` + harici ağırlık `ddcolor.data` (228 MB) | Apache-2.0 |

Boyutlar ve özetler 2026-10-27'de Hugging Face API'sinden (LFS oid) ve yayımlanan zipten doğrulandı. Genel BiRefNet'in özeti Plan 07'deki önekle (`3654c741eb80bd92`) eşleşir. Lisans ve eğitim verisi kayıtları: `legal/inventory/models.json`, `legal/NOTICES_HEADER.txt` §1.5–1.8, `legal/INVENTORY.md`. Eğitim verisi sorusu (Places365, P3M-10k, DIS5K, ImageNet) YuNet/GFPGAN ile aynıdır ve **sahibin kararını bekliyor**.

## Teknik notlar

- Ön/son işleme Plan 07 tarifleriyle birebir (`smart-edit.js`, birim testli): LaMa maske etrafında 2,2× kare kırpma → 512, yumuşak kenarlı yapıştırma (9 px genişlet + 4 px bulanıklaştır); BiRefNet 1024, ImageNet normalizasyonu, sigmoid → bilinear → alfa (≥0,98 → 1, ≤0,02 → 0); bulanık arka plan + 1,5 px yumuşatılmış alfa; DDColor 256, orijinal L tam çözünürlükte, ab bilinear büyütülüp birleşir.
- fp16 girişli modeller için tensörler `float16`'ya çevrilir (`toHalf`/`fromHalf`). DDColor'ın harici ağırlığı ORT Web `externalData` seçeneğiyle yüklenir.
- Çıktı her zaman PNG'dir (A04 yolu: sRGB 8 bit, EXIF yönü 1, metadata politikası, alpha). Ad ekleri: `_removed`, `_cutout` (şeffaf), `_background`, `_colorized`.
- Büyük fotoğraflar A03 bellek bütçesine göre küçültülür; küçültmeden önce kullanıcıya sorulur.
- **Renklendirme ve küçük yüzlerde kızarma (Plan 07 bilinen zayıflık):** yalnızca (a) aşırı kromanın yumuşak sıkıştırılması uygulanır (`softChroma`, 45 üstü yarı hızda). Cilt tonu aralığında a kanalını sınırlayan (b) seçeneği, farklı cilt tonlarında değerlendirme verisi olmadığı için **uygulanmadı**. Evrensel bir cilt eşiği konmadı. Renk doğruluğu için Q02 insan incelemesi gerekir; doygunluğun artması doğruluk kanıtı değildir.

## Testler

| Katman | Dosya | Kapsam |
|---|---|---|
| Birim | `tests/unit/smart-edit.test.mjs`, `tests/unit/ai-policy.test.mjs` | maske/kırpma/yapıştırma geometrisi, alfa son işleme, Lab dönüşümleri, float16, iş tarifi (model seçimi, ek, PNG) |
| Rust | `ai::tests::builtin_manifest_is_valid_and_complete`, `jobs::tests::smart_edit_job_kinds_write_a_png_with_alpha_and_keep_the_source` | manifest (zip + iki dosya + external data), iş türleri kuyrukta, `_cutout.png` alpha, kaynak hash'i |
| E2E (modelsiz) | `tests/e2e/smart-edit.e2e.mjs` | görünürlük kuralları, maske paneli, indirme onayı (reddedince iş yok), arka plan seçenekleri, AI sonucu taban görüntü + geri al/yinele + uygulanan adımlar, Kaydet → kopya (orijinal hash'i aynı, saydamlık korunur), fotoğraf değişince sıfırlama |
| Gerçek AI | `tests/ai/smart-edit.ai.mjs` (`npm run test:ai`) | gerçek modeller WASM'de sentetik görüntülerde (nesne çevreyle dolar ve maske dışı değişmez; arka plan şeffaf, kişi korunur; renk eklenir, L korunur) + işlenmiş WASM referansları (`tests/ai/fixtures/smart-*-ref.png`), WebGPU ~ WASM, üç iş türü kuyrukta (ek, kaynak hash'i, şeffaf PNG), çalışan işin iptali |

Plan 07'deki "Python betiğiyle referans eşdeğerlik" testi yapılamadı: önceki scratchpad betikleri yok ve kullanıcı fotoğraflarına erişilmedi. Bunun yerine tarif birim testleri + gerçek modelde özellik kontrolleri + gözden geçirilmiş WASM referansları kullanılır.

## Sınırlamalar

- **Arka plan kaldırma (BiRefNet) test makinesinde çalışmıyor (2026-10-27 ölçümü, AMD 1 GB iGPU, WebView2, ORT Web 1.30.0).**
  Model girişi 1024×1024'te sabit (768/640/512 reddedilir).
  - WASM: `std::bad_alloc`, 32 bit WASM belleği yetmiyor. Bellek arenası ve bellek deseni kapalıyken ve `basic` optimizasyonla da aynı sonuç. Bu ORT sürümünde wasm64 yapısı yok.
  - WebGPU: 16 çıkışlı `Split` ve 16–1024 girişli `Concat` düğümleri gölgelendirici başına 17 depolama tamponu istiyor; cihaz sınırı 16. Bu düğümleri matematiği değiştirmeden bölen deneysel bir grafik yeniden yazımı bu sınırı aştı, ama ardından fp16 model `bad_alloc` verdi, fp32 model çöktü.
  - Sonuç: iş yaklaşık 2 dakika sonra temiz biçimde `memory` hata koduyla biter. Çıktı yazılmaz, kaynak değişmez, kullanıcı hata metnini görür.
  - Çözüm seçenekleri **kullanıcı kararı**:
    1. Yerel ONNX Runtime (Rust tarafında; Plan 07 ölçümü 30 s CPU bu yolla yapılmıştı).
    2. Daha hafif bir arka plan modeli (Plan 07'de onaylanan sonuç değil).
    3. Aracın bu cihazlarda gizlenmesi veya deneysel kalması.
- Nesne silme (LaMa) ve renklendirme (DDColor) aynı makinede WASM'de ve WebGPU'da çalışıyor; WebGPU sonucu WASM ile aynı.
- Yalnızca Windows (WebView2, AMD 1 GB iGPU + WASM) denendi; macOS/Linux denenmedi.
- Çok büyük maskelerde parçalara bölme yok; maske kırpması 512'den büyükse tek geçişte küçültülür.
- Arka plan bulanıklığı kişi/nesne maskesinin kalitesine bağlıdır; saç gibi ince kenarlar sentetik testlerle ölçülmedi.
- Renklendirme kalitesi (özellikle küçük yüzler) için insan incelemesi bekleniyor (Q02).
