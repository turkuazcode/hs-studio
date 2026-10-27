# AI çalışma zamanı: kaynak bütçesi, backend seçimi, inference adapter'ı (Plan 11/A03)

Plan: [11-ai-altyapisi-ve-fotograf.md](plans/11-ai-altyapisi-ve-fotograf.md) (A03) · Kuyruk: [jobs-api.md](jobs-api.md) (A02) · Model yönetimi: A01 (`src-tauri/src/ai`)

Kod: `src/media/ai-engine.js` (adapter + backend + tanı), `src/media/ai-policy.js` (saf kurallar), `src/media/onnx-tiny.js` (yoklama modeli), `src/media/ai-worker.js` (Web Worker, ONNX Runtime Web), `src/media/ai-jobs.js` (kuyruk koşucusu), `src-tauri/src/jobs/external.rs` (kuyrukta webview'de çalışan iş türü).
Testler: `tests/unit/ai-policy.test.mjs`, Rust `jobs::tests::ai_*`, gerçek model katmanı `tests/ai/ai-runtime.ai.mjs` (`npm run test:ai`).

## Inference adapter'ı

`createInferenceAdapter()` → `probe()`, `prepare(componentIds)`, `run(input, recipe, onProgress, signal)`, `release()`. İlk uygulama mevcut Web Worker'dır (ORT Web 1.30, WebGPU → WASM); fotoğraf (büyütme, yüz) ve ileride video aynı yaşam döngüsünü kullanır. `upscaleImage` / `restoreFacesInImage` bu adapter'ın ince sarmalayıcılarıdır (API değişmedi). Yeni ikinci bir motor (yerel ORT, ayrı süreç) eklenmedi: plana göre ancak aynı fixture/modelle Web yolunun sınırı ölçülürse eklenir.

## Backend seçimi

- Aday: `navigator.gpu` bağdaştırıcısı (yedek/yazılım bağdaştırıcı değil) → `webgpu`; her zaman son çare `wasm`. `localStorage["vho.ai.backend"]="wasm"` WebGPU'yu kapatır (test/sorun giderme).
- **Yoklama = gerçek küçük çıkarım:** bellekte oluşturulan ONNX modeli `y = Add(x, x)` (opset 13, `[1,3,8,8]`) adaydaki EP ile oturum açar, çalışır ve sonucu doğrular. GPU adı veya bildirilen VRAM başarı ölçütü değildir; 1 GB paylaşımlı belleği olan iGPU'lar ad/VRAM'e göre elenmez. Oturum başına bir kez; sonuç tanı kaydında.
- Çalışan karo boyutu cihaz (bağdaştırıcı anahtarı) + model + backend başına `localStorage`'da tutulur; sonraki iş oradan başlar. Ölçülen hız (giriş pikseli/sn) aynı anahtarla saklanır.

## Geri çekilme kuralı (`nextAttempt`)

| Hata sınıfı (`classifyAiError`) | Davranış |
|---|---|
| `memory` (OOM, ayırma, tampon sınırı, wasm bellek) | aynı backend'de daha küçük karo; karolar bitince sonraki backend |
| `device` (cihaz kaybı, işçi çöktü) | taze işçiyle aynı deneme **bir kez**, sonra sonraki backend |
| `backend` (EP yok/başlatılamadı) / `other` | sonraki backend |
| `model` (protobuf/oturum/op), `input` (boyut/şekil), iptal | **dur** — bozuk model veya yanlış giriş CPU'da tekrar tekrar çalıştırılmaz |

Her deneme ve geri çekilme `aiDiagnostics()`'te (backend, karo, sınıf, mesaj) ve Ayarlar > AI modelleri'nde kısa özet olarak görünür. Son hata `code` taşır: `memory`, `modelFailed`, `unsupported`, `failed`.

## Bellek bütçesi (`planInput`)

- Bütçe: `navigator.deviceMemory` × %25 (512 MB – 4 GB; bilinmiyorsa 4 GB varsayımı → 1 GB).
- Sayfa tarafı tahmini: giriş pikseli başına 8 B (kaynak + deneme kopyası), çıkış pikseli başına 16 B (çıktı tamponu, görüntülenen ImageData, yüz geçişi kopyası, yükleme). Üst sınır ayrıca 40 MP çıktı.
- Sığmayan iş **sessizce küçültülmez**: kullanıcıya fotoğraf boyutu, küçültülmüş giriş ve gerçek hedef çözünürlük gösterilir ve onay istenir (`enhance.deepTooLarge`); "hayır" = iş başlamaz. Seçilen giriş boyutu iş tarifine (`inputWidth/Height`) yazılır; devam aynı tarifle yapılır.
- GPU tarafı (karo tensörleri, ağın ara aktivasyonları) tahmin edilmez; bellek hatasında karo küçültülür.

## Tek ağır iş ve kuyruk

- AI işleri A02 kuyruğunda `ai-photo-enhance` türüdür (`external` adapter): kuyruk dışa aktarma/toplu iş ile aynı sırada **tek uzun iş** çalıştırır, iş kalıcıdır, kapanışta `interrupted` olur, devamda bileşen sürümleri (ör. `ort-web+photo-x4`) ve kaynak parmak izi doğrulanır.
- Çıkarım Rust'ta değil webview'dedir: kuyruk işçisi `job-run` olayıyla işi sayfaya verir; sayfa `jobs_ext_begin / progress / fail / done` ve çıktıyı **ham RGBA ikili IPC** (`jobs_ext_output`, base64 yok) ile döndürür. Her çağrı `attemptId` taşır; eski deneme reddedilir. Sayfa yeniden yüklenirse (`jobs_runner_ready`) önceki koşu kaybolur → iş `interrupted`. Koşucu 20 sn içinde hazır değilse iş `runnerUnavailable` ile düşer (devam edilebilir).
- Çıktı PNG'si uygulama verisinde `ai-results/` klasörüne kuyruğun rezervasyon/geçici dizin/üzerine yazmama yoluyla yazılır (kullanıcının klasörüne otomatik dosya yazılmaz; "Kaydet" kopyalar). EXIF/ICC/alpha bütünlüğü A04'tedir.
- Sayfa içinde ayrıca FIFO yuva (`slot`): doğrudan API çağrıları da (önizleme, testler) aynı anda tek ağır çıkarım yapar.
- Kullanılmayan oturumlar: işten sonra işçi (ve GPU belleği) bırakılır; doğrudan çağrılarda 60 sn boşta kalınca.
- **Oynatma sırasında:** `ai.pauseDuringPlayback` (Ayarlar > AI modelleri, varsayılan açık) — video/müzik oynamaya başlayınca çalışan AI işi duraklatılır, oynatma durunca bu kuralın duraklattığı işler doğrulanarak devam eder. Kullanıcının kendi duraklattığı işlere dokunulmaz.

## Süre tahmini

Yalnızca ölçümden: işin kendi ilerlemesi (%5 sonrası, geçen süre / oran) veya bu cihazda daha önce ölçülmüş hız. Ölçüm yoksa süre gösterilmez (sahte tahmin yok). İptal her aşamada mümkündür.

## Ölçümler

`tests/ai/ai-runtime.ai.mjs` son testi: boşta ve WASM çıkarımı sırasında uygulama süreçlerinin (vho.exe + bu örneğin WebView2 süreçleri) çalışma kümesi ve sayfa olay döngüsü gecikmesi (16 ms zamanlayıcı, p95/maks); sonuç `tests/.results/ai/ai-runtime-measurement.json`. VRAM: Windows'ta satıcı aracı olmadan güvenilir süreç başı VRAM ölçümü yok; GPU sürecinin bellek kullanımı WebView2 çalışma kümesine dahildir. Oynatma + AI kare kaybı ölçümü Q02 performans bütçesi ile birlikte yapılacak (bu kartta ölçülmedi).
