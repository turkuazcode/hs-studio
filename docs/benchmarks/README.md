# Kalite ve performans ölçümleri (Q02)

Kart: [14/Q02](../plans/14-kalite-ve-acik-kaynak-yayin.md) · Katman haritası: [test-map.md](../status/test-map.md) · Son sonuçlar: [2026-10-25-baslangic.md](2026-10-25-baslangic.md)

## Veri kümesi (`tests/quality/manifest.json`)

| | Sayı | Kaynak |
|---|---|---|
| Fotoğraf | 15 (11 kontrollü/sentetik + 4 gerçek eski tarama) | Wikimedia Commons'ta **kamu malı** dosyalar (NASA portreleri, Apollo fotoğrafları, 1863–1936 arası taramalar, 1918 gazete sayfası) + kodla üretilen desenler (testsrc2 yazısı, zone plate, alpha) |
| Klip | 6 × 3 s (referans 320×176 kayıpsız FFV1, girdi 80×44 MPEG-2) | Aynı kamu malı fotoğraflardan kamera hareketi/yakınlaştırma/sahne kesimi + `testsrc2` |
| Yapısal | 3 (alan sırası TFF, VFR, A/V senkron) | Yalnızca kod (V01/V03 için) |

- Her kaynağın URL'si, SHA-256'sı, boyutu, yazarı, tarihi, lisansı ve Commons sayfası manifestte. Lisanslar 2026-10-25'te Commons dosya sayfasından/API'den doğrulandı; yalnızca “Public domain”. Telif hakkı yenilenmemiş olsa da mirasçı hak iddia notu olan bir portre (Einstein) bu yüzden **çıkarıldı**. Kişisel anı fotoğrafı yok; kullanıcının dosyaları/E:\ hiç okunmadı.
- Kaynaklar (~29 MB) bir kez `tests/.cache/quality/src`'ye iner (hash eşleşirse yeniden kullanılır; Wikimedia hız sınırı için yeniden deneme + bekleme, açıklayıcı User-Agent). Örnekler bunlardan uygulamanın LGPL ffmpeg'iyle **deterministik** üretilir; üretilen her dosyanın SHA-256'sı `tests/quality/set-lock.json`'da (ffmpeg sürümüyle). Kilit tutmazsa sonuçlar karşılaştırılamaz sayılır ve test başarısız olur. Depoya büyük dosya girmez.
- `origin`: `controlled` = temiz referans bilerek bozuldu (tam referanslı ölçüm), `real-old` = gerçek eski tarama (referans yok), `synthetic` = desen. `split`: `dev` örnekleri ayar/tuning için kullanılabilir, `eval` örnekleri yalnızca son değerlendirme içindir.
- Kategoriler: yüz (küçük/büyük, farklı ten renkleri), yazı (sentetik + 1918 gazete), düşük ışık, bulanıklık, JPEG blokları, gren/gürültü, çizik/taranmış baskı (sepya + çizgi), doku, alpha, yüksek çözünürlük (192→768), yüksek frekans/aliasing. Klipte kamera hareketi, hızlı hareket, sahne kesimi, düşük ışık + zamansal gürültü, yüz, hareketli yazı.
- Plan hedefi yayın değerlendirmesi için ~100 fotoğraf / 20 klip; bu küme **başlangıç kümesidir**. Gerçek eski video klibi henüz yok (kamu malı aday seçilmedi).

## Protokol

- Eşit çözünürlük: her girdi referansın 1/4'ü; her profil ×4 çıktıyı aynı boyutta verir.
- Fotoğraf profilleri: `lanczos` (orijinalin standart ölçeklenmesi, taban), `vho-x4` (mevcut fotoğraf AI'ı, `upscaleImage`, WebGPU → WASM), `vho-x4-faces` (+GFPGAN, yalnızca yüzlü örnekler; A05'teki “Yaratıcı” profile karşılık). Ticari ürün karşılaştırması **yapılmadı** (hesap/ürün yok).
- Video profilleri: `lanczos`, `nlmeans-lanczos` (geleneksel temizlik). V02 model adayları `tests/.cache/quality/candidates/<ad>/<klip>.mkv` olarak bırakılır; aynı ölçütlerle otomatik değerlendirilir.
- Ölçütler (bağımlılıksız, yayınlanmış tanımlardan yazıldı, `tests/quality/lib/metrics.mjs`): PSNR, SSIM, GMSD, keskinlik oranı; referanssızda keskinlik, gürültü σ (Immerkær), renklilik (Hasler–Süsstrunk); videoda kare başı PSNR/SSIM ortalama+min, zamansal hata |Δçıktı − Δreferans|, çıktı zamansal değişimi. Yüz/yazı bölgeleri ayrıca ölçülür. LPIPS gibi öğrenilmiş ölçütler kullanılmadı (ağırlık/lisans/bağımlılık); PSNR/SSIM yalnızca **yardımcıdır**.
- Kırmızı bayraklar (ortalamaya karışmaz, raporda tek tek): yüz/yazı bölgesinde lanczos'a göre SSIM −0,05'ten fazla düşüş veya GMSD +0,05'ten fazla artış (kimlik/yazı değişimi riski), kaybolan alpha, gri fotoğrafa eklenen renk.
- Kör A/B: `npm run quality:ab -- sheet` → `tests/.results/quality/blind-ab/index.html` (rastgele sıra ve taraf, ürün adı yok, aynı boyut; anahtar ayrı dosyada). Değerlendiriciler JSON indirir; `npm run quality:ab -- score <json...>` tercih oranı, rubrik (doğallık/ayrıntı/sadakat/bozulma 1–5) ve bayrak oranını değerlendirici sayısıyla verir. Üçten az değerlendirici varsa sonuç “ön/geliştirici değerlendirmesi” olarak etiketlenir. **Henüz değerlendirme yapılmadı.**
- Kapı (`npm run test:quality`): küme kilidi, doğru boyut/sonlu çıktı, her ölçüt `docs/benchmarks/quality-baseline.json`'a göre toleransta (PSNR ±0,3 dB, SSIM/GMSD ±0,005, referanssız ölçütler %5), yeni kırmızı bayrak yok. Taban `VHO_QUALITY_UPDATE_BASELINE=1` ile yeniden yazılır (diff incelenmeli).

## Performans (`npm run bench:media`)

- Her ölçüm release binary'yi yalıtılmış veri klasörüyle başlatır; vho.exe + WebView2 + ffmpeg **süreç ağacının tamamı** `tests/quality/lib/proc-sampler.ps1` ile örneklenir (çalışma kümesi, özel bellek, CPU saniyesi, Windows “GPU Process Memory” sayaçlarından ayrılmış/paylaşılan GPU belleği).
- Ölçümler: açılış (spawn → ilk uygulama belgesi; her seferinde yeni WebView2 profili = soğuk profil), ilk kare (1080p H.264, libmpv ve HTML5), 5.000 dosyalı ızgara (ilk boyama, tarama, ilk ekran küçük resimleri soğuk önbellekle), 10 s 1080p oynatma (AI kapalı; CPU, RAM, düşen kare), photo-x4 128×128 (soğuk = oturum/gölgelendirici oluşturma dahil, sıcak; WebGPU ve WASM; tepe RAM ve GPU belleği). Varsayılan 3 tekrar; medyan/min/maks.
- Bütçeler `tests/quality/budgets.json`: referans makinede ölçülen medyan × 1,5. Hedef değil, gerileme yakalayıcı; `--check` aşımda çıkış kodu 1. Plan 04 hedefi (5.000 dosyada ilk ızgara < 2 s) ve UI geri bildirim p95 ≤ 200 ms ayrı `targets` alanında. Başka makinede karşılaştırma yalnızca gösterge niteliğindedir.
- VRAM: tümleşik AMD GPU belleğin çoğunu paylaşılan bellek olarak kullanır; bu yüzden ayrılmış ve paylaşılan değer birlikte raporlanır.
