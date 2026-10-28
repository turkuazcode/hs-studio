# Modelsiz fotoğraf/video zincirinin ölçümü (denetim D08, 2026-10-28)

Ölçülen: A05 fotoğraf iyileştirme (`src-tauri/src/photo/enhance.rs`, uygulamanın kendi `photo-enhance` kuyruk işiyle, ürünün varsayılan ayarları, ölçek ×4) ve V03 video iyileştirme (filtre zinciri uygulamanın `video_enhance_plan` yanıtından; “Hafif” = varsayılan, “Orta”). Taban: aynı girdinin Lanczos ×4 ölçeklenmesi, **aynı çıktı boyutunda**. Küme: Q02 başlangıç kümesi (15 fotoğraf: 11 kontrollü/sentetik + 4 kamu malı eski tarama; 6 × 3 s üretilmiş klip) — yalnızca kamu malı ve kodla üretilmiş örnekler; kullanıcının özel medyası kullanılmadı ve yayımlanmadı.

**Eski neural ölçümler bu zincirin sonucu değildir.** `vho-x4` / `vho-x4-faces` satırları eski deneysel yapay zekâ yolunu ölçer ve yalnızca karşılaştırma için tabloda durur.

Makine: geliştirici Windows 11 x64 dizüstü (AMD tümleşik GPU, 1 GB ayrılmış). ffmpeg n8.1.3 (LGPL). Komut: `npm run test:quality` (sonuç dosyaları `tests/.results/quality/{photo,video}.json`, raporlar `photo-report.md` / `video-report.md`). Taban dosyasına yeni profiller **eklendi**; önceki profillerin taban değerleri yeniden yazılmadı.

## Fotoğraf (11 kontrollü/sentetik örnek, tam referanslı; ortalama)

| Profil | PSNR | SSIM | GMSD (düşük iyi) | Süre (medyan) | Kırmızı bayrak |
|---|---|---|---|---|---|
| lanczos (taban) | 22,82 | 0,692 | 0,175 | 73 ms | — |
| **classic-x4 (A05)** | 20,63 | **0,701** | 0,182 | 76 ms (iş kuyruğu dahil) | **yok** |
| vho-x4 (eski deneysel) | 20,66 | 0,681 | 0,182 | 11,0 s | 8 (yüz sadakati, griye renk) |
| vho-x4-faces (eski deneysel, 6 yüzlü örnek) | 20,82 | 0,669 | 0,180 | 6,4 s | 5 (yüz sadakati) |

- Gerçek eski taramalar (referanssız, 4 örnek): gürültü σ lanczos 0,30 → classic 0,32; keskinlik 46,5 → 53,0. Gri fotoğraflar gri kaldı.
- Çıktı boyutu (PNG, ×4, küçük test girdileri): ortalama 73 KB. Uygulama ana sürecinin tepe çalışma kümesi en çok 118 MiB (sürecin ömrü boyunca tepe değer).
- **Yorum:** klasik zincir yüz/yazı bölgelerinde bozulma bayrağı üretmiyor ve SSIM'de tabanın biraz üstünde; PSNR'de altında (gölge açma ve detay adımı tonu bilerek değiştiriyor, PSNR bunu hata sayar). Bu ölçütler “daha kaliteli” iddiasını **desteklemez de çürütmez de**; karar kör insan değerlendirmesine kalır.

## Video (6 klip, 75 kare, 320×176, tam referanslı; ortalama)

| Profil | PSNR | SSIM | SSIM en düşük | Zamansal hata (düşük iyi) | Zamansal değişim | Süre | Tepe bellek (ffmpeg) |
|---|---|---|---|---|---|---|---|
| lanczos (taban) | 22,95 | 0,767 | 0,565 | 6,37 | 5,49 | 99 ms | 22 MiB |
| nlmeans-lanczos | 22,94 | 0,774 | 0,550 | 6,22 | 5,03 | 718 ms | 21 MiB |
| **faithful-light (V03 varsayılan)** | 22,91 | 0,766 | 0,559 | 6,35 | 5,40 | 106 ms | 23 MiB |
| **faithful-medium** | 22,90 | 0,769 | 0,556 | **6,23** | 5,05 | 112 ms | 24 MiB |

- Ölçülen zincirler (renk dönüşümü adımı ölçüm dışı; referans etiketsiz):
  `deblock=filter=weak:block=8,atadenoise=s=5,scale=320:176:flags=lanczos,setsar=1,cas=strength=0.3` ve Orta için `deblock=filter=strong…,atadenoise=0a=0.04…,cas=strength=0.55`.
- Ürünün yazdığı boyut (×2, 160×88, h264_mf kalite 65): çıktı kaynağın **1,25–1,69 katı** (6 klip).
- Hareket bozulması: zamansal hata tabana göre Hafif'te aynı, Orta'da %2 düşük; titreşim/hayalet artışı ölçülmedi. Ardışık kare farkının düşmesi tek başına hayalet olmadığını kanıtlamaz (aşırı yumuşatma da düşürür) — kör inceleme gerekir.
- **Yorum:** varsayılan video zinciri bu küçük kümede Lanczos'tan ölçülebilir biçimde farklı değil. Kayıp ayrıntıyı geri getirme iddiası yapılmamalı.

## Kör insan değerlendirmesi — paket hazır, **yapılmadı**

```text
node scripts/quality-ab.mjs sheet                       # fotoğraf: lanczos ↔ classic-x4
node scripts/quality-ab.mjs sheet --kind=video          # video: lanczos ↔ faithful-light, faithful-light ↔ faithful-medium
node scripts/quality-ab.mjs score ratings-*.json        # en az 3 değerlendirici; azsa "ön değerlendirme"
```

Çıktı `tests/.results/quality/blind-ab/index.html` (+ `key.json`, değerlendiricilere gösterilmez). Yöntem adları gizli, taraf ve sıra rastgele, boyut eşit. Bu çalışmada hiçbir insan değerlendirmesi yapılmadı ve sonuç uydurulmadı.

## Bu ölçümün sınırları

- Küme küçük (plan hedefi ~100 fotoğraf / 20 klip); gerçek eski video klibi yok. Ayar geliştirme (`dev`) ve değerlendirme (`eval`) ayrımı manifestte var ama klasik zincirin parametreleri bu kümeye göre ayarlanmadı.
- Tek makine; macOS/Linux kodlayıcıları ölçülmedi. Ticari ürün karşılaştırması yok.
- **Ayrı bulgular:** (1) eski deneysel `vho-x4` yolu bir koşuda WebView'i düşürdü (p05), tekrarda geçti — aralıklı; (2) aynı yolda `p10-alpha` PSNR'si önceki tabana göre 36,95 → 32,89 dB çıktı. Taban yeniden yazılmadı; kalite katmanı bu farkı göstermeye devam eder.
