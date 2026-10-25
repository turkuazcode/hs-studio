# ADR 0003 — Video restorasyonu: model ve çıkarım yolu (TASLAK)

- **Durum:** Taslak — **karar kapısı: bekliyor (A03/Q02)**. Bu belge V02'nin hazırlığıdır; karar değildir.
- **İlgili:** [Plan 12 / V02](../plans/12-video-restorasyonu.md), [Plan 08](../plans/08-uygulama-sirasi-ve-durum.md), lisans politikası [00](../plans/00-YOL-HARITASI.md)
- **Ön koşul durumu (2026-10-25):** V01 kod hazır (`src-tauri/src/restoration/`). A03 (kaynak yönetimi: bellek/GPU bütçesi, iptal) ve Q02 (kalite ölçüm veri kümesi) **yok** → kalite/sadakat ölçümü ve hedef cihazda bellek sınırı kanıtı yapılamaz; karar verilemez.
- **Hazırlayan:** E7 (wave3/e7-video). Kaynaklar 2026-10-25 tarihinde resmi depolardan okundu; dosyalar indirilmedi/çalıştırılmadı (ağırlık indirme ve ONNX dışa aktarma V02 kapısında yapılacak).

## Bağlam

Hedef veri: düşük çözünürlüklü eski kamera/telefon klipleri, MiniDV/SD ev videoları, sayısallaştırılmış interlaced örnekler. Hedef cihaz: Windows 11, 1 GB paylaşımlı AMD iGPU (geliştirme makinesi), WebGPU→WASM ORT Web 1.30 (fotoğraf AI ile aynı yol) veya gerekiyorsa ayrı yerel worker. Python/PyTorch son kullanıcıya **kurulmaz**.

V01 ile her işin girişi sabit: `restoration_probe` ölçümleri (alan sırası, CFR/VFR, SAR/rotation, renk, HDR) + hash'li reçete; çıktı SDR BT.709 8-bit. Model bu reçetede `model: null` (V02 geçene kadar `model-not-ready` engeli).

## Adaylar

Lisans sütunları resmi kaynaktan okundu. “Ağırlık lisansı” ayrı yazılmamışsa **açıkça “belirtilmemiş”** denir; politika gereği belirtilmemiş ağırlık dağıtılmaz — ya yazarından açık lisans/izin alınır ya da politikaya uygun veriyle yeniden eğitilir.

| # | Aday | Tür | Kod lisansı (kaynak) | Ağırlık lisansı / kaynak | Eğitim verisi | Bağımlılık grafiği | ONNX/native | Politika sonucu |
|---|---|---|---|---|---|---|---|---|
| 1 | **Taban çizgisi:** `bwdif` + `atadenoise`/`fftdnoiz`/`nlmeans` + `scale=lanczos` + `colorspace` | geleneksel | FFmpeg n8.1.3, LGPL-2.1+ (dosya başlıkları `libavfilter/vf_*.c`; GPL'li `hqdn3d`/`kerndeint`/`mcdeint`/`pp7`/`spp`/`owdenoise`/`tinterlace` bu derlemede **yok**, `configure` `*_filter_deps="gpl"`) | yok (ağırlık yok) | — | mevcut ayrı süreç `ffmpeg.exe` (D1) | gerekmez | **uygun**, zaten dağıtılıyor |
| 2 | **Fotoğraf modeli kare bazlı:** `photo-x4` = 4xRealWebPhoto v4 DAT-2 | tek kare SR | DAT (Apache-2.0) mimarisi; ONNX doğrudan | **CC-BY-4.0** (HF `Phips/4xRealWebPhoto_v4_dat2`, rev `95e9cd5`; uygulama manifestinde zaten) | yazarın RealWebPhoto veri hattı | ORT Web 1.30 (mevcut A01 bileşeni) | ONNX opset 17 hazır (fp32, 48,7 MB) | **uygun**; zamansal tutarlılık garantisi yok (titreme) |
| 3 | **Real-ESRGAN `realesr-general-x4v3`** (SRVGGNetCompact, ~1,2M param) | tek kare SR, hafif | **BSD-3-Clause** ([xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)) | GitHub release v0.2.5.0 eki; ayrı ağırlık lisansı **belirtilmemiş** (depo BSD-3) | yazarın sentetik bozulma hattı (DIV2K/Flickr2K/OST) | PyTorch → ONNX (yalnız Conv/PReLU/PixelShuffle) | ONNX dışa aktarma basit; ORT Web uygun | **koşullu**: ağırlığın repo lisansıyla dağıtıldığının yazılı teyidi gerekir |
| 4 | **BasicVSR++** (c64n7, ~7,3M param) | zamansal, çift yönlü yayılım + ikinci derece ızgara, akış güdümlü **deformable conv** | **Apache-2.0** ([ckkelvinchan/BasicVSR_PlusPlus LICENSE](https://github.com/ckkelvinchan/BasicVSR_PlusPlus), [open-mmlab/mmagic LICENSE](https://github.com/open-mmlab/mmagic)) | `download.openmmlab.com/mmediting/restorers/basicvsr_plusplus/*.pth` ([mmagic configs/basicvsr_pp](https://github.com/open-mmlab/mmagic/tree/main/configs/basicvsr_pp)); ağırlık lisansı **belirtilmemiş** | REDS (CC BY 4.0) veya **Vimeo-90K** (resmi sayfada lisans yok; klipler vimeo.com'dan; ikincil kaynaklar “yalnız ticari olmayan araştırma” diyor) | PyTorch + mmcv (`ModulatedDeformConv2d`) + SPyNet; mmagic/mmengine | DeformConv: ONNX opset 19 `DeformConv`; ORT'ye CPU/CUDA çekirdeği 2026-03-23'te eklendi ([PR #27393](https://github.com/microsoft/onnxruntime/pull/27393)); **WebGPU/DirectML çekirdeği yok** → iGPU'da CPU'ya düşer | **koşullu**: yalnız REDS ağırlığı düşünülebilir; ağırlık lisansı yazılı teyit olmadan dağıtılmaz. Vimeo-90K ağırlıkları **reddedilir** (veri lisansı belirsiz) |
| 5 | **RealBasicVSR** (BasicVSR omurgası + temizleme modülü) | zamansal, gerçek dünya bozulması | **Apache-2.0** ([ckkelvinchan/RealBasicVSR LICENSE](https://github.com/ckkelvinchan/RealBasicVSR)) | Dropbox/Google Drive/OneDrive bağlantısı; ağırlık lisansı **belirtilmemiş** | REDS + sentetik bozulma | PyTorch + mmcv/mmedit; akış SPyNet + `grid_sample` (deformable conv **yok**) | GridSample (opset 16) ORT'de var → ONNX dışa aktarma DCN'siz, WebGPU yolu daha olası | **koşullu**: kod uygun; ağırlık barındırma (kişisel bulut) ve lisans teyidi gerekir; bulunamazsa yeniden eğitim |
| 6 | RVRT / VRT | zamansal transformer | **CC-BY-NC** ([JingyunLiang/RVRT](https://github.com/JingyunLiang/RVRT)) | releases | — | — | — | **reddedildi** (ticari olmayan) |
| 7 | Upscale-A-Video | difüzyon tabanlı | **NTU S-Lab License 1.0** ([sczhou/Upscale-A-Video](https://github.com/sczhou/Upscale-A-Video)) | — | — | — | — | **reddedildi** (S-Lab) |
| 8 | `realesr-animevideov3` | tek kare, anime | BSD-3-Clause | release v0.2.5.0; lisans belirtilmemiş | anime | — | kolay | hedef veriye uygun değil (çizgi film), yalnızca not |

Not: RealBasicVSR ve BasicVSR++ “temporal multi-frame” şartını karşılayan adaylar. ONNX/WebGPU açısından **RealBasicVSR/BasicVSR (DCN'siz)** daha uygulanabilir görünüyor; BasicVSR++ kalite olarak öndedir ama DCN yüzünden iGPU'da CPU'ya düşme riski var. İkisi de ağırlık lisansı yazılı teyidi olmadan **dağıtılamaz**.

## Beklenen bellek / hız (1 GB iGPU) — TAHMİN, ölçüm değil

Aşağıdaki değerler parametre/aktivasyon hesabı ve yayınlanmış referanslardan çıkarılmış **tahmindir**; V02 kapısında aynı klipte ölçülerek değiştirilecektir. Tek gerçek ölçüm aday 1'in CPU hızıdır.

| Aday | Girdi→çıktı | Tepe bellek (tahmin) | Hız (tahmin) | Zamansal bağlam | Hata davranışı |
|---|---|---|---|---|---|
| 1 taban çizgisi | 720×576i → 960×720p50 | < 200 MB RAM | **ölçüldü**, aşağıda | bwdif 3 alan, atadenoise ±4 kare | ffmpeg süreci; iptal = süreç öldürme (D1) |
| 2 photo-x4 DAT-2 | kare başına ×4 sonra ölçek düşürme | 48 px parça ile ~100–300 MB VRAM | iGPU WebGPU'da SD kare başına saniyeler (DAT-2 ağır); 10 s klip dakikalar | yok (titreme beklenir) | mevcut parça/WASM yedeği |
| 3 realesr-general-x4v3 | SD ×2/×4 | ~100–200 MB | DAT-2'den 10× hızlı mertebe (hafif mimari) | yok | WebGPU→WASM |
| 4 BasicVSR++ | 180×320→720×1280 referansı (V100'de ~77 ms/kare, makale) | çift yönlü yayılım bütün dizinin özniteliklerini tutar → **15–30 karelik parçalar** + örtüşme şart; SD girişte parça başına ~0,5–1 GB | iGPU+CPU yedeğinde kare başına saniyeler; DCN CPU'da | çift yönlü, parça içi | parça sınırında state sıfırlama + örtüşme (V03/V05) |
| 5 RealBasicVSR | benzer | benzer (temizleme modülü ek) | BasicVSR++'tan biraz hızlı; WebGPU olasılığı daha yüksek | çift yönlü | aynı |

Bağımlılık/kurulum boyutu: aday 1 = 0 ek bayt; 2 = mevcut 48,7 MB model + 27 MB ORT Web (zaten var); 3 ≈ 5–17 MB; 4/5 ≈ 25–30 MB fp32 ONNX (+ DCN için ORT sürümü ≥ PR #27393 içeren sürüm).

### Ölçülen: aday 1 CPU hızı

`experiments/video-restoration/baseline-speed.ps1` (üretilmiş 10 s 720×576 SAR 16:15 TFF klip, `-threads 2`, çıktı null, kodlama yok). Sonuçlar bu bölümün altındaki “Ölçüm kaydı”nda.

## Değerlendirme yöntemi (V02 kapısında uygulanacak)

- Aynı klip, **eşit çıktı çözünürlüğü** (V01 reçetesinin `scale` hedefi), aynı deinterlace/renk adımları; yalnızca model adımı değişir.
- Kategoriler (Q02 veri kümesi): yüz/yazı, hızlı hareket, düşük ışık, sahne geçişi, doku, kamera hareketi. Tek iyi kare kanıt sayılmaz.
- Ölçümler: fps (ilk yükleme ayrı), tepe bellek (RAM + GPU), kurulum boyutu, zamansal bağlam, titreme (ardışık kare farkı), yüz/yazı değişimi, hata davranışı (GPU kaybı, bellek yetersizliği).
- Python yalnızca depo dışı geçici venv'de ONNX dışa aktarma için; çıktı ONNX dosyası + hash + dışa aktarma betiği `experiments/video-restoration/` altına (ağırlık commit edilmez).

## Mühendislik bütçesi (ilk deneme)

Plan 12'nin “bütçe başta yazılır” kuralı. Bütçe ajan oturumu (≈ bir odaklı çalışma günü) cinsindendir:

| Adım | Bütçe | Bitince |
|---|---|---|
| Aday 1 taban çizgisi + Q02 kliplerinde referans çıktı | 0,5 oturum | referans her aday için karşılaştırma tabanı |
| Aday 2 (photo-x4 kare bazlı) uygulama içi deney | 0,5 oturum | titreme ve hız kaydı |
| Aday 5 (RealBasicVSR) lisans teyidi + ONNX dışa aktarma + ORT Web WASM/WebGPU çalıştırma | 1,5 oturum | çalışmazsa aday 4'e geç |
| Aday 4 (BasicVSR++, yalnız REDS ağırlığı) aynı adımlar | 1,5 oturum | DCN WebGPU'da yoksa “yalnızca güçlü donanımda deneysel” |
| Karar kaydı | 0,5 oturum | bu ADR “Karar” bölümü |

Toplam **4,5 oturum**. Bütçe dolduğunda sonuç ne olursa olsun karar kaydı yazılır; model sonsuza kadar uyarlanmaz. Lisans teyidi gelmeyen aday bütçeden düşülür (bekleme süresi bütçeye sayılmaz ama aday askıya alınır).

## Karar seçenekleri

`üretim adayı` · `yalnızca güçlü donanımda deneysel` · `şimdilik uygun değil`. Üretim adayı için: lisans/provenans tam (kod + **ağırlık** + eğitim verisi), hedef cihazda sonlu bellekle biten çıkarım, yeniden üretilebilir ön/son işleme, Q02'de kabul edilebilir hareket/kimlik sadakati. Kare bazlı yöntem seçilirse “zamansal tutarlılık garantisi yok” sınırı kullanıcıya yazılır.

## Karar

**Bekliyor (A03/Q02).** Hazır olanlar: V01 reçetesi/ölçümleri, aday tablosu ve lisans kaynakları, taban çizgisi CPU ölçümü, bütçe. Kalan: Q02 klipleri, A03 bellek/GPU bütçesi, aday 2–5 ölçümleri, ağırlık lisansı teyitleri (RealBasicVSR, BasicVSR++ REDS, realesr-general-x4v3).

## Ölçüm kaydı
