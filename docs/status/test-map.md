# Test haritası (Q01)

**Tarih:** 2026-10-25 · Kart: [14/Q01](../plans/14-kalite-ve-acik-kaynak-yayin.md) · Son çalıştırma sonuçları: [test-baseline.md](test-baseline.md)

Bu belge her desteklenen özelliğin hangi test katmanında kanıtlandığını gösterir. Kanıtı olmayan satırlar açıkça `—` / `kanıt yok` olarak bırakıldı. Bir katmanda `skip` sonucu **geçti sayılmaz**.

## Katmanlar ve komutlar

| Katman | Komut | Dosyalar | Ne doğrular | Ağ | Ne zaman |
|---|---|---|---|---|---|
| Birim | `npm test` | `tests/unit/*.test.mjs` | Saf JS mantığı: dönüşüm, şema, dosya adı, recipe, zamanlama, i18n kapsamı | **Kapalı**: `tests/lib/no-network.mjs` loopback dışı her TCP bağlantısını DNS'ten önce reddeder; `test-layers.test.mjs` bunu ve model URL'sine indirme başlamadığını kanıtlar | Her değişiklik |
| Rust / entegrasyon | `npm run test:rust` (= `cargo test --release --lib --manifest-path src-tauri/Cargo.toml`) | `src-tauri/src/**` içindeki `#[cfg(test)]` modülleri | Dosya/DB göçü, indirme+hash (yerel HTTP fixture), zip güvenliği, fotoğraf codec/EXIF, ffmpeg işleri, yetenek matrisi | Yalnızca loopback | Her değişiklik |
| Uygulama E2E | `npm run e2e` | `tests/e2e/*.e2e.mjs` | **Yeni release binary** + gerçek libmpv/WebView2; kullanıcı akışları CDP ile | Yerel fixture sunucuları; dış istek yok (`i18n-offline` kanıtlar) | Windows PR |
| Gerçek AI smoke | `npm run test:ai` | `tests/ai/*.ai.mjs` | Gerçek, hash doğrulanmış model + ORT Web ile uygulama içinde çıkarım; çıktı referansla karşılaştırılır | İlk çalıştırmada model indirme (bir kez), sonra önbellekten | AI değişikliği, sürüm adayı |
| Kalite / performans | `npm run test:quality`, `npm run bench:media` | `tests/quality/*.quality.mjs` (henüz yok) | Q02: doğallık, yüz/yazı, zamansal tutarlılık, hız/bellek | — | **HENÜZ DOLDURULMADI** (Q02). Komutlar “0 test çalıştı, hiçbir şey geçmedi” yazar |

`scripts/run-tests.mjs` her katmanda:

- başlıkta commit, Node sürümü ve (e2e/ai/quality) **test edilen binary'nin mutlak yolu**, boyutu, derleme zamanı, libmpv'nin yerleşik olup olmadığı ve binary kaynak dosyalardan eskiyse `WARNING` yazar; aynı yolu her test dosyasına `VHO_EXE` olarak verir,
- sonda `pass · fail · skip · todo · cancelled` sayılarını **ayrı ayrı** yazar, atlanan ve başarısız testleri nedenleriyle listeler,
- JSON kopyasını `tests/.results/<katman>.json` dosyasına yazar (git dışı; CI artifact'ı için),
- `VHO_TEST_NO_SKIP=1` ise herhangi bir skip/todo çıkış kodunu başarısız yapar (sürüm adayı/CI).

Dosya argümanı verilirse varsayılan liste yerine o dosyalar çalışır (`npm run e2e -- tests/e2e/photo.e2e.mjs`); diğer argümanlar `node --test`e geçer.

## Gerçek AI smoke (`tests/ai/photo-x4.ai.mjs`)

| Konu | Karar |
|---|---|
| Model | `photo-x4` = 4xRealWebPhoto v4 DAT-2 (`rwp4-95e9cd5`, 48.760.847 bayt, SHA-256 `a9a3a909…589e`) + `ort-web` 1.30.0 (5 dosya, 27.240.481 bayt). URL/hash'ler uygulamanın tek manifestinden (`src-tauri/src/ai/manifest.rs`) |
| İndirme | Uygulamanın kendi indiricisi (A01: sabit URL, boyut + tam SHA-256, `.part`, Range) — `ai_install`. İndirme hatası `INFRA:` önekiyle **ayrı bir testte** altyapı hatası olarak raporlanır; çıkarım testleri o durumda `skip` (geçti değil) olur |
| Önbellek | `VHO_TEST_AI_CACHE` (varsayılan `<repo>/tests/.cache/ai-smoke`) `/vho-data/ai/<id>/<sürüm>/`. Bu klasör test uygulamasının `VHO_DATA_DIR`'idir; her çalıştırmada `ai/` dışındaki her şey silinir. Kullanıcının AI önbelleğine (uygulama veri klasörü) hiç dokunulmaz. Önbellekteki dosyalar `ai_verify` (tam SHA-256) ile `ready` olursa yeniden indirilmez; bozuksa uygulama onarır |
| Çevrimdışı | `VHO_AI_OFFLINE=1`: indirme denenmez; önbellek boşsa önbellek testi başarısız, çıkarım testleri `skip` |
| Fixture | `tests/ai/fixtures/smoke-44x28.png` — kodla üretilen sentetik görüntü (`makeFixture()`, kişisel içerik yok, 469 bayt). Kenarlar 16'nın katı değil (dolgu yolu), üstte kırmızı/yeşil/mavi şeritler (kanal sırası), altta gri rampa + sert kenar + dama (ayrıntı), sağ altta alpha 0 ve 128 bölgeleri |
| Referans | `tests/ai/fixtures/photo-x4-ref.png` (176×112) — WASM arka ucunda tek parça çıktı. Yalnızca `VHO_AI_UPDATE_REFERENCE=1` ile yeniden yazılır; değişiklik diff'te incelenmelidir |
| Arka uç | WASM (CPU) zorunlu ve deterministik. Uygulama API'si (`upscaleImage`) varsayılan sırayla çalışır (WebGPU → WASM); hangi arka ucun kullanıldığı loglanır. WebGPU adaptörü yoksa bu not edilir (yalnız WASM kanıtlanmış olur) |
| 1 GB iGPU | Girdi 44×28 (tek 48×32 parça) — VRAM kullanımı birkaç MB |

**Kontroller ve toleranslar** (8 bit RGB, 0..255):

| Kontrol | Ölçüt | Neden |
|---|---|---|
| Boyut | tam 176×112 (×4, dolgu kırpılmış) | Dolgu/kırpma hatası |
| Sonlu değerler | Ham float çıktıda NaN/Inf = 0; aralık −0,25..1,25 | Bayta sıkıştırma NaN'ı 0 olarak gizler; worker ham istatistiği (`stats`) döndürür |
| Sabit değil | Luma std. sapması > 20 | Boş/siyah/sabit çıktı |
| Kanal sırası | Her şeritte kendi kanalı diğerlerinden ≥100 yüksek | RGB/BGR karışması |
| Alpha | Worker çıktısı tamamen opak (255); alpha 0 altındaki RGB korunur (±40) | Bugünkü sözleşme: alpha'yı geri koymak çağıranın işi (A04 bilinen sınır) |
| Bağımsız taban | Bilinear ×4'e göre PSNR ≥ 22 dB (ölçülen 27,55 dB) | Referanstan bağımsız “sadık büyütme” akıl kontrolü (kalite ölçüsü değil) |
| WASM ↔ referans | ortalama ≤0,5, p99,9 ≤3, maks ≤8 (ölçülen 0 / 0 / 0) | Aynı ORT/CPU; yalnızca toplama sırası gürültüsü |
| Parçalı (32 px, 8 px bindirme) ↔ tek parça | ortalama ≤2, p99,9 ≤24, maks ≤48 (ölçülen 1,18 / 15 / 24) | Parça sınırında bağlam farkı (DAT-2'nin alıcı alanı bindirmeden büyük); uygulamanın en küçük parçası 48 px/12 px bindirme, bu test daha sert |
| WebGPU ↔ referans | ortalama ≤1, p99,9 ≤8, maks ≤32 (ölçülen 0,00 / 0 / 1, AMD 1 GB iGPU) | Farklı fp32 çekirdekleri; byte eşitliği beklenmez, başka GPU'lar için pay |

## Özellik → kanıt katmanı

| Özellik | Birim | Rust / entegrasyon | Uygulama E2E | Gerçek AI | Kalite/perf | Not |
|---|---|---|---|---|---|---|
| Uygulama açılışı, boş ekran, lisans penceresi | — | — | `smoke` | — | — | |
| Ayarlar, kısayollar, tema, dil, tek örnek, son açılanlar | `settings`, `i18n-keymap`, `core` | `platform` | `platform` | — | — | Dosya ilişkilendirme yalnızca Windows |
| i18n (TR/EN), çevrimdışı açılış, yerel font | `i18n-coverage`, `i18n-keymap` | — | `i18n-offline` | — | — | |
| libmpv oynatma, izler, altyazı, bölümler, EQ, A-B, ekran görüntüsü | `engine`, `subtitles`, `format` | `engine` | `engine` | — | — | Yalnızca Windows libmpv |
| HTML5 yedek motor | `engine` | — | `engine` (fallback), `video` | — | — | |
| %200 ses + sınırlayıcı | `capabilities` | — | `audio-limiter` | — | — | |
| Görüntü filtreleri (WebGL, sinir ağı değil) | — | — | `video`, `photo` | — | — | |
| Eski codec dönüştürme (WMV9) | — | `transcode` (ignored, gerçek dosya ister) | `legacy` | — | — | |
| Yetenek matrisi (P01) | `capabilities` | `capabilities` | `engine` | — | — | macOS/Linux `verified=false` |
| Oynatma listesi, sınıflandırma, URL/HLS | `playlist`, `classify`, `helpers` | — | `smoke`, `video` | — | — | |
| Fotoğraf görüntüleyici | `studio` | `photo::decode`, `photo::exif` | `photo` | — | — | |
| Fotoğraf stüdyosu (ızgara, düzenleyici, toplu iş, karşılaştırma) | `studio` | `photo::*` (33+) | `photo-studio` | — | `photo-studio` 5.000 dosya ilk ızgara (ölçüm, bütçe değil); `photo_thumb_bench` (ignored) | HEIC/AVIF OS codec'ine bağlı |
| Medya eylemleri (kes/dönüştür/GIF/altyazı/etiket/OCR/sil/yeniden adlandır) | `actions` | `actions::*` | `actions` | — | — | Paylaş/yazdır/duvar kâğıdı tasarım gereği yalnızca loglanır |
| Kalıcı depolama (`library.db`, göç, yedek) | `library-db` | `storage::*` | `storage` | — | — | |
| AI bileşen yönetimi (manifest, indirme, hash, iptal, onarım, zip) | `ai-status` | `ai::tests` (yerel HTTP) | `ai-models` (yerel fixture sunucusu) | **gerçek CDN/HF indirmesi + tam SHA-256** | — | |
| Fotoğraf AI ×4 (DAT-2, WebGPU→WASM, parçalı çıkarım) | `onnx-patch` | — | `smoke` (worker modülü yüklenir) | **`photo-x4.ai`**: boyut/sonlu/sabit değil/kanal/alpha/referans | Q02 (yok) | Alpha 255'e sabit, EXIF/ICC korunmuyor (A04) |
| Yüz iyileştirme (GFPGAN + YuNet) | — | — | — | **kanıt yok** | Q02 (yok) | Sonraki gerçek AI smoke adayı (170 MB model) |
| Video “AI” restorasyonu | — | — | `video` (“hazır değil” etiketi) | — | — | V01–V06 |
| Kalite karşılaştırması, hız/bellek bütçeleri | — | — | — | — | **HENÜZ DOLDURULMADI** | Q02 |
| Lisans envanteri, bildirimler, SBOM (R01) | `legal-inventory` (AI manifest ↔ models.json, yerel DLL listesi ↔ derleme kanıtı, bildirimde her DLL/model, gönderilen varlıklar envanterde, SBOM hash'leri, politika reddi yok) | — | `smoke` (Lisanslar penceresi) | — | — | SBOM üretimi `npm run sbom` (cargo metadata, ağsız) birim testte çalışmaz; commit edilen SBOM denetlenir |
| İş kuyruğu (A02), kütüphane UI (L02) | paralel dallarda ekleniyor | | | | | Testleri kendi katmanına eklenir; bu harita birleştirmede güncellenir |

## Bilinen sınırlar

- E2E ve AI smoke yalnızca Windows/WebView2 (CDP) üzerinde çalışır. macOS/Linux için sürücü seçilmedi; bu platformlar burada **test edilmedi** sayılır.
- WebGPU sonucu cihaz/sürücüye bağlıdır; WASM referansı CPU'ya bağlı küçük farklar gösterebilir (tolerans belgeli). Başka bir ORT sürümüne geçişte referans yeniden üretilip incelenmelidir.
- Gerçek AI smoke tek modeli (photo-x4) kapsar. GFPGAN/YuNet ve Plan 07 modelleri (A06) aynı düzenle eklenecek.
- CI taslağı: `.github/workflows/ci.yml` — itilmedi/çalıştırılmadı. Model önbelleği hash'e bağlı `actions/cache` anahtarıyla tasarlandı; gerçek AI işi yalnızca elle/etiketle tetiklenir.
