# Plan 07 — Akıllı Düzenleme (Yapay Zekâ ile Fotoğraf Düzenleme)

**Ajan:** D3 · **Ön koşul:** D1 (medya eylemleri, düzenleme ekranına dokunuyor) birleşmiş olmalı.
**Kapsam dışı:** "Otomatik iyileştir" — kullanıcı kendisi geliştiriyor; bu pakette yapılmayacak.
**Kalite kanıtı:** Kullanıcının fotoğraflarıyla yapılan test (2026-10-24) — nesne silme, arka plan kaldırma (portre modeli), portre bulanıklığı ve renklendirme kullanıcı tarafından onaylandı. Test betikleri: scratchpad `aiedit/run_tests.py`, `bg_compare.py`, `colorize.py` (referans uygulama; ön/son işleme buradan alınır).

## §1 Özellikler
| Özellik | Model | Lisans | Kaynak (sabitlenmiş) | Boyut | Ölçülen hız (CPU, Ryzen 5 7535U) |
|---|---|---|---|---|---|
| **Nesne silme** (fırçayla işaretle → doldur) | LaMa (big-lama) ONNX | Apache-2.0 | `huggingface.co/Carve/LaMa-ONNX` commit `c3c0c9e468934d62e79c329e35d82dd09ff8c444`, `lama_fp32.onnx`, SHA-256 `1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6` | 208 MB | 3,6 sn |
| **Arka planı kaldır** (şeffaf PNG / düz renk fon) — insanlar | BiRefNet-portrait ONNX fp16 | MIT | `huggingface.co/onnx-community/BiRefNet-portrait-ONNX` commit `dd7167f6a8b54ff7efc29a4c988938d79866464f`, `onnx/model_fp16.onnx`, SHA-256 öneki `4c05930c0b6f1418` (tam özet indirilerek doğrulanacak) | 490 MB | 30 sn |
| Arka planı kaldır — nesneler/ürünler (isteğe bağlı ikinci model) | BiRefNet (genel) ONNX fp16 | MIT | `onnx-community/BiRefNet-ONNX` commit `534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67`, SHA-256 öneki `3654c741eb80bd92` | 490 MB | 27 sn |
| **Portre bulanıklığı** (arka planı bulanıklaştır, kişi net) | aynı maske | — | — | — | +0,1 sn |
| **Renklendir** (yalnızca siyah-beyaz/soluk fotoğraflarda görünür) | DDColor ONNX — Qualcomm AI Hub resmî dışa aktarımı (v0.65.0, ONNX Runtime 1.30.0) | Apache-2.0 (HF `qualcomm/DDColor` kartı; ajan zip/depo lisansını da doğrular) | `https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/ddcolor/releases/v0.65.0/ddcolor-onnx-float.zip` (zip SHA-256 `512e788cab02db6796ede174af0db2302247130284a3a00eab9aafddafa48a49`, 206 251 342 B) → `ddcolor.onnx` (2 750 675 B, SHA-256 `310d0c66a38cd8cfd7d9d93fdb5500fef79d584fe59e25a417aea5915a6b3733`) + harici ağırlık `ddcolor.data` (225 312 128 B, SHA-256 `5b65cb3eab9fa4ae9ecacd539b148fa51157655732022913b1cf47346f93940c`; boyut resmî `paper_tiny` ile örtüşür) | 228 MB | **0,6 sn** |

Ön/son işleme (test betikleriyle birebir):
- **LaMa:** maskenin etrafından ~2,2× kare kırp → 512×512, giriş `image` [1,3,512,512] 0..1 + `mask` [1,1,512,512] (1 = doldurulacak), çıktı 0..255 → kırpma boyutuna geri ölçekle → yalnızca maskelenmiş alanı yumuşak kenarla (maske 9 px genişlet + 4 px bulanıklaştır) yapıştır. Büyük alanlar için kırpma 512'den büyükse yine tek geçiş; çok büyük maskelerde parçalara böl.
- **BiRefNet:** 1024×1024, ImageNet ortalama/sapma normalizasyonu, çıktı logit → sigmoid → orijinal boyuta bilineer → alfa. Kenar iyileştirme: alfa ≥ 0.98 → 1, ≤ 0.02 → 0.
- **Portre bulanıklığı:** arka plan Gauss bulanıklığı (yarıçap fotoğraf boyutuna oranlı, ayarlanabilir), alfa 1,5 px yumuşatılıp kişi üzerine.
- **DDColor (Qualcomm):** giriş `image` [1,3,256,256] RGB 0..1 (model griye kendi içinde çevirir — gri-RGB ile düz RGB girişi arasındaki fark ort. 0,1/255), çıktı `output` [1,2,256,256] = Lab ab. Orijinal L kanalı tam çözünürlükte korunur, ab orijinal boyuta bilineer ölçeklenip L ile birleşir (resmî `ddcolor/pipeline.py` mantığı). Model harici veri dosyası kullanır: ORT-Web'de `externalData` seçeneğiyle yüklenir (ajan doğrular).
- **Bilinen zayıflık (2026-10-24 testi, scratchpad `aiedit/out/5_renklendirme_qualcomm.jpg`):** büyük konularda ve gökyüzünde çok iyi; fotoğrafta **küçük kalan yüzleri fazla kırmızı** boyuyor (256 çözünürlük etkisi). Ajan hafif düzeltme dener ve ölçer: (a) aşırı ab doygunluğunu yumuşak sıkıştırma, (b) cilt tonu aralığında a kanalını sınırlama. Kalite yetmezse yedek: resmî `piddnad/DDColor-models` (`ddcolor_paper_tiny.pth`, commit `e9e7b527709c8aeb2f5e1bf701e72fd468a13baa`) ağırlıklarından **512 girişli kendi dışa aktarımımız** (5–6 sn; PyTorch için VC++ çalışma zamanı gerekir → kullanıcı onayı veya CI).

## §2 Arayüz (Arayüz ilkelerine uygun)
- Fotoğraf **Düzenle** ekranında tek bir **"✨ Akıllı"** bölümü/sekme: *Nesne sil · Arka planı kaldır · Arka planı bulanıklaştır · Renklendir*. "Renklendir" yalnızca fotoğraf siyah-beyaz/düşük doygunlukta ise görünür.
- **Nesne sil:** fırça (boyut kaydırıcısı), silgi, geri al; "Sil" düğmesi; birden çok tur uygulanabilir; sonuç düzenleme geçmişine (geri al/yinele) girer.
- **Arka plan:** sonuç seçenekleri — Şeffaf (PNG), Beyaz, Siyah, Özel renk, Bulanık (yoğunluk kaydırıcısı). "Kişi" (portre modeli) varsayılan; "Nesne" modu Ayarlar > Fotoğraf'tan açılır (ikinci modeli indirir).
- İlk kullanımda onay penceresi: indirilecek boyut + model adı + lisans + yazar (mevcut `ai.rs` / `ai-engine.js` altyapısı ile; Plan 06/04 ile aynı akış).
- İlerleme göstergesi + iptal; arayüz donmaz (Web Worker).
- Kaydetme mevcut "Kaydet / Kopya Kaydet / Farklı Kaydet" akışıyla (orijinal onay olmadan ezilmez); şeffaf sonuçlar PNG/WebP.

## §3 Teknik
- Bileşenler `src-tauri/src/ai.rs` `COMPONENTS` listesine (sabit URL + SHA-256 + boyut); Qualcomm DDColor yalnızca zip olarak yayınlanıyor: zip indirilir, özeti doğrulanır, yalnızca `ddcolor.onnx` + `ddcolor.data` çıkarılır (yol geçişine karşı korumalı), iki dosyanın özeti ayrıca doğrulanır, zip silinir.
- Çıkarım: mevcut `src/media/ai-engine.js` + `ai-worker.js` (WebGPU → WASM yedeği, 1 GB iGPU'da bellek: büyük modelleri çalıştırmadan önce diğer oturumları serbest bırak). WebGPU'da sorun çıkarsa (ör. boyut adı uyumsuzluğu — `onnx-patch.js` deneyimi) çözümü testle kanıtla.
- Düşük bellek: 490 MB fp16 BiRefNet WebGPU'da sığmazsa WASM'e düş; ölçüm raporla.
- Lisans bildirimi: her model `legal/NOTICES_HEADER.txt` "AI COMPONENTS" bölümüne (yazar, kaynak, commit, lisans, değişiklik yok); `powershell -NoProfile -ExecutionPolicy Bypass -File legal\generate-notices.ps1`.

## §4 Testler
- Birim: kırpma/maske geometrisi, alfa son işleme, Lab dönüşümleri (bilinen değerler), yapıştırma maskesi.
- Referans eşdeğerlik: aynı girdiyle uygulamanın çıktısı ile Python test betiğinin çıktısı arasındaki fark (ortalama < 3/255) — sabit küçük sentetik görüntülerle (kullanıcı fotoğrafları depoya girmez).
- E2E: sentetik görüntüde (düz arka plan + basit şekil) nesne silme → şekil alanı arka plan rengine yakınsadı; arka plan kaldırma → kenar pikselleri şeffaf; renklendir → çıktı doygunluğu > 0; ilk kullanım onayı ve iptal çalışıyor. Modeller E2E'de gerçekten indirilir ve önbelleğe alınır (ilk koşu yavaş olabilir) — CI için önbellek notu.
- `E:\` ve kullanıcı klasörleri asla okunmaz/değiştirilmez; `suspend_system` ve sistem eylemleri korumaları geçerli.
