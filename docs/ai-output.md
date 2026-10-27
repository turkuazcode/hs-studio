# AI sonucu: orijinal, renk, yön, metadata ve alpha bütünlüğü (Plan 11/A04)

Plan: [11-ai-altyapisi-ve-fotograf.md](plans/11-ai-altyapisi-ve-fotograf.md) (A04) · Çalışma zamanı: [ai-runtime.md](ai-runtime.md) (A03) · Kuyruk: [jobs-api.md](jobs-api.md)

Kod: `src-tauri/src/jobs/external.rs` (`encode_output`, `write_output`), `src-tauri/src/jobs/scheduler.rs` (`complete_item_with`, `copy_output`), `src-tauri/src/photo/ops.rs` (`embed_exif`, `png_with_text`), `src/media/alpha.js`, `src/media/ai-worker.js`, `src/media/ai-jobs.js` (`loadPixels`), `src/media/photo-ai.js`.
Testler: Rust `jobs::tests::ai_output_*`, `tests/unit/alpha.test.mjs`, `tests/e2e/ai-output.e2e.mjs`, `tests/ai/ai-runtime.ai.mjs` (A04 testi), `tests/ai/photo-x4.ai.mjs` (alpha beklentileri).

## Sözleşme

| Konu | Kural |
|---|---|
| Kaynak | Her zaman dosyanın kendisi (`input` yolu); UI'dan gelen başka bir yol çıktı sayılmaz. Orijinal hiçbir zaman yazılmaz; testler kaynak hash'ini karşılaştırır. |
| Piksel okuma | `loadPixels`: `photo_decode` (HEIC/RAW görüntüleme kopyası) → `fetch` → `createImageBitmap(imageOrientation: "from-image", colorSpaceConversion: "default", premultiplyAlpha: "none")` → tuval. EXIF yönü **bir kez** uygulanır; gömülü ICC profili tarayıcı tarafından **sRGB'ye dönüştürülür**; alpha düz (çarpılmamış) okunur. |
| Boyut | Planlanan giriş boyutu (A03 `planInput`, gerekirse kullanıcı onayıyla) iş tarifinde; çıktı = giriş × ölçek (photo-x4: 4). |
| Renk | Piksel sRGB, 8 bit. **Kaynağın ICC profili kopyalanmaz** (sRGB piksellere yanlış etiket olurdu); profil yok = sRGB. Artifact kaydında `colorSpace: "sRGB"`, `iccCopied: false`, `bitDepth: 8` (16 bitlik kaynak 16 bitmiş gibi etiketlenmez; HDR/16 bit F04). |
| Yön | Pikseller dik; çıktı EXIF `Orientation = 1`. |
| Metadata | `blob_for_output`: tarih/kamera/telif vb. korunur, piksel boyutu güncellenir, eski küçük resim atılır; GPS politikası `keep / stripGps / strip` (Ayarlar > AI modelleri, `ai.output.metadata`, varsayılan `keep`). PNG'ye `Software = "VHO <sürüm> AI (<bileşenler>)"` `tEXt` eklenir. |
| Alpha | Model yalnızca RGB görür. Alpha 0 olan piksellerin rengi görünür komşulardan doldurulur (`bleedTransparent`; koyu kenar/halo yok), alpha kanalı ayrı bilinear büyütülür ve çıktıya yazılır; yüz geçişi yalnızca RGB'yi değiştirir. PNG/WebP'de alpha korunur (hiç saydam piksel yoksa RGB yazılır). **JPEG** seçilirse saydam alan açıkça `background` rengiyle (varsayılan beyaz) birleştirilir. |
| Biçim | `output.format`: `png` (varsayılan), `jpeg`, `webp`; `quality` (varsayılan 95). |
| Ad / yer | Varsayılan `<ad>_restored.<uzantı>`, uygulama verisindeki `ai-results/`; çakışmada yeni ad (`(2)`), mevcut dosya asla ezilmez. "Kaydet" = `jobs_output_copy`: kuyruğun kendi kaydındaki çıktıyı fotoğrafın klasörüne geçici dosya + üzerine yazmayan yerleştirme ile kopyalar. Orijinali ezen bir eylem yoktur. |
| Kısmi | İptal, disk dolması (`diskFull`, önce alan denetimi), yazma/yeniden adlandırma hatası: son adda dosya görünmez, geçici dizin işle birlikte silinir. |
| Kayıt | `artifacts.params`: `recipe` (istek), `models` (sabitlenen bileşen sürümleri), `source` (boyut + içerik parmak izi), `output` (boyut, biçim, bit derinliği, renk alanı, alpha, yön, metadata politikası), `app` sürümü. Paylaşılan çıktı dosyasına gizli yerel yol gömülmez (yalnızca yazılım/bileşen adı). |
| Fotoğraf değişimi | Sonuç iş kimliğiyle eşleşir (`jobId` + `loadGen`): başka fotoğrafa geçilince sonuç o fotoğrafa yapışmaz; iş arka planda biter, sonucu İşler panelindedir. |

## Sınırlar

- Düzenleme oturumunda undo/redo: AI sonucu görüntüleyicide "Orijinali göster / İyileştirileni göster" ile geçici uygulanır; stüdyo düzenleyicisinin geri alma yığınına bağlanması A05 akışında.
- WebP/AVIF kaynağın metadata'sı: WebP'ye EXIF yazılır; AVIF/TIFF/BMP çıktı seçeneği yok.
- ICC dönüşümü tarayıcının renk yönetimine bağlıdır (Chromium/WebView2); dönüşümün yapıldığı E2E testinde kanıtlanır, macOS/Linux WebView'lerinde denenmedi.
