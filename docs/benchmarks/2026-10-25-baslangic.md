# Q02 başlangıç ölçümü (2026-10-25/26)

**Makine:** AMD Ryzen 5 7535U (12 iş parçacığı), 31 GB RAM, AMD Radeon tümleşik GPU (1 GB ayrılmış), Windows 11 Pro 10.0.26300 · **Binary:** `wave3/e6-test-katmanlari` release (`src-tauri/target/release/vho.exe`, libmpv yerleşik) · **ffmpeg:** n8.1.3 (LGPL derlemesi) · **Modeller:** photo-x4 `rwp4-95e9cd5`, face-restore `yunet2023mar-gfpgan14w16`, ORT Web 1.30.0.
Protokol ve küme: [README.md](README.md). Makinece okunur taban: [quality-baseline.json](quality-baseline.json), bütçeler: [`tests/quality/budgets.json`](../../tests/quality/budgets.json).

> Kör A/B değerlendirmesi **yapılmadı** (değerlendirici yok). Aşağıdaki sayılar yardımcı ölçütlerdir; “daha keskin” ya da “daha yüksek PSNR” tek başına daha iyi anlamına gelmez. Ticari ürünle karşılaştırma yapılmadı.

## Fotoğraf (×4, eşit çıktı boyutu; WebGPU)

PSNR (dB) / SSIM / GMSD tüm görüntü; “bölge SSIM” yüz/yazı bölgesi; renklilik çıktınındır (gri girdide ~0 olmalı).

| örnek | profil | ms | PSNR / SSIM / GMSD | bölge SSIM | renklilik | kırmızı bayrak |
|---|---|---|---|---|---|---|
| p01-face-jpeg | lanczos | 85 | 27.28 / 0.817 / 0.130 | 0.709 | 63.3 | — |
| p01-face-jpeg | vho-x4 | 15131 | 25.79 / 0.729 / 0.157 | 0.542 | 64.9 | face-fidelity-drop |
| p01-face-jpeg | vho-x4-faces | 8591 | 25.29 / 0.765 / 0.146 | 0.630 | 62.8 | face-fidelity-drop |
| p02-face-lowlight | lanczos | 95 | 10.88 / 0.384 / 0.222 | 0.289 | 9.0 | — |
| p02-face-lowlight | vho-x4 | 20832 | 11.02 / 0.413 / 0.220 | 0.305 | 9.7 | — |
| p02-face-lowlight | vho-x4-faces | 7413 | 10.92 / 0.392 / 0.207 | 0.277 | 11.0 | — |
| p03-face-blur | lanczos | 86 | 24.80 / 0.704 / 0.188 | 0.622 | 0.0 | — |
| p03-face-blur | vho-x4 | 19551 | 25.79 / 0.723 / 0.172 | 0.647 | 2.3 | color-cast-on-greyscale |
| p03-face-blur | vho-x4-faces | 7346 | 22.45 / 0.664 / 0.190 | 0.561 | 0.9 | face-fidelity-drop |
| p04-small-face | lanczos | 117 | 23.05 / 0.764 / 0.183 | 0.806 | 77.8 | — |
| p04-small-face | vho-x4 | 21234 | 21.82 / 0.725 / 0.202 | 0.710 | 83.5 | face-fidelity-drop |
| p04-small-face | vho-x4-faces | 4750 | 21.82 / 0.725 / 0.202 | 0.710 | 83.5 | face-fidelity-drop (yüz bulundu, işlenmedi) |
| p05-scan-scratch | lanczos | 101 | 17.86 / 0.740 / 0.158 | 0.685 | 30.6 | — |
| p05-scan-scratch | vho-x4 | 24829 | 17.51 / 0.741 / 0.166 | 0.682 | 32.9 | — |
| p05-scan-scratch | vho-x4-faces | 6762 | 16.10 / 0.657 / 0.203 | 0.549 | 32.6 | face-fidelity-drop |
| p06-lowlight-space | lanczos | 75 | 17.32 / 0.831 / 0.156 | — | 8.1 | — |
| p06-lowlight-space | vho-x4 | 22931 | 17.34 / 0.874 / 0.155 | — | 8.5 | — |
| p07-texture-noise | lanczos | 89 | 23.02 / 0.676 / 0.210 | — | 3.3 | — |
| p07-texture-noise | vho-x4 | 1537 | 19.58 / 0.638 / 0.214 | — | 6.8 | — |
| p08-text-jpeg | lanczos | 97 | 17.05 / 0.798 / 0.239 | 0.348 | 235.0 | — |
| p08-text-jpeg | vho-x4 | 1501 | 17.07 / 0.783 / 0.245 | 0.391 | 235.6 | — |
| p09-zoneplate | lanczos | 80 | 9.23 / 0.068 / 0.311 | — | 0.0 | — |
| p09-zoneplate | vho-x4 | 1526 | 9.15 / 0.076 / 0.309 | — | 6.7 | color-cast-on-greyscale |
| p10-alpha | lanczos | 71 | 51.38 / 0.998 / 0.001 | — | 148.2 | — |
| p10-alpha | vho-x4 | 1649 | 36.95 / 0.972 / 0.016 | — | 148.5 | alpha-lost |
| p11-highres-face | lanczos | 265 | 29.11 / 0.836 / 0.130 | 0.801 | 47.9 | — |
| p11-highres-face | vho-x4 | 21310 | 29.29 / 0.815 / 0.129 | 0.760 | 48.7 | — |
| p11-highres-face | vho-x4-faces | 26379 | 28.34 / 0.808 / 0.131 | 0.736 | 48.3 | face-fidelity-drop |

Gerçek eski taramalar (referans yok; keskinlik = Laplasyen varyansı, gürültü σ):

| örnek | profil | ms | keskinlik / gürültü σ | renklilik | kırmızı bayrak |
|---|---|---|---|---|---|
| r01-lincoln-1863 | lanczos | 125 | 7 / 0.28 | 0.0 | — |
| r01-lincoln-1863 | vho-x4 | 31169 | 336 / 2.09 | 3.1 | color-cast-on-greyscale |
| r01-lincoln-1863 | vho-x4-faces | 16588 | 35 / 0.44 | 0.1 | — |
| r02-douglass-1879 | lanczos | 128 | 9 / 0.29 | 0.0 | — |
| r02-douglass-1879 | vho-x4 | 29996 | 438 / 2.40 | 3.5 | color-cast-on-greyscale |
| r02-douglass-1879 | vho-x4-faces | 16661 | 347 / 1.96 | 1.4 | — |
| r03-migrant-1936 | lanczos | 108 | 8 / 0.28 | 0.0 | — |
| r03-migrant-1936 | vho-x4 | 30465 | 142 / 1.39 | 2.2 | color-cast-on-greyscale |
| r03-migrant-1936 | vho-x4-faces | 17060 | 177 / 1.56 | 2.0 | — |
| r04-newspaper-1918 | lanczos | 134 | 163 / 0.37 | 0.0 | — |
| r04-newspaper-1918 | vho-x4 | 29646 | 3035 / 4.59 | 10.4 | color-cast-on-greyscale |

**Bulgular (A05/A04 için):**

1. **Gri fotoğrafa renk ekleniyor.** photo-x4 gri girdilerin (1863–1936 taramaları, gazete, gri portre, zone plate) hepsinde renklilik 0 → 2–10'a çıkıyor (hafif renk sapması). “Aslına sadık” profil için gri girdiyi tespit edip çıktıyı griye geri indirmek (ya da yalnız luma'yı işlemek) gerekir.
2. **Yüz sadakati.** JPEG/küçük yüz örneklerinde photo-x4 yüz bölgesi SSIM'ini lanczos'a göre 0,1–0,17 düşürüyor; GFPGAN (vho-x4-faces) beş kontrollü örneğin beşinde yüz bölgesi bayrağı üretiyor (kimlik/ayrıntı değişimi riski). A05'te yüz restorasyonu “Aslına sadık” profilde kapalı/ölçülü olmalı; kör değerlendirme gerekli.
3. **Küçük yüz:** YuNet yüzü buluyor, GFPGAN işlemiyor (`restored 0`) — beklenen sınır, UI'da açıklanmalı.
4. **Alpha kayboluyor** (bilinen A04 sınırı, `p10-alpha`).
5. **Gerçek eski taramalarda** photo-x4 keskinliği 20–50×, gürültü ölçüsünü 5–12× artırıyor (ayrıntı uydurma ve gren güçlendirme olabilir); GFPGAN geçişi Lincoln'de bunu yumuşatıyor. Yalnızca ölçütle karar verilmez → kör A/B.
6. **Süre:** 64×64 girdi (1 parça) sıcak oturumda ~1,5 s; ancak aynı işte GFPGAN ile dönüşümlü kullanıldığında her seferinde ~11–25 s (1 GB GPU'da iki model aynı anda tutulmuyor, oturum yeniden kuruluyor). 128×128 (4 parça) ~30 s.

## Video tabanı (×4, 320×176, 75 kare)

| klip | profil | PSNR ort. / min | SSIM | zamansal hata |
|---|---|---|---|---|
| c01-pan-texture | lanczos | 25.40 / 22.88 | 0.735 | 10.22 |
| c01-pan-texture | nlmeans-lanczos | 25.45 / 22.87 | 0.763 | 9.86 |
| c02-face-zoom | lanczos | 26.20 / 25.01 | 0.852 | 2.98 |
| c02-face-zoom | nlmeans-lanczos | 26.20 / 24.98 | 0.861 | 2.86 |
| c03-text-motion | lanczos | 17.72 / 17.28 | 0.828 | 4.16 |
| c03-text-motion | nlmeans-lanczos | 17.74 / 17.30 | 0.836 | 3.92 |
| c04-scene-cut | lanczos | 26.91 / 26.20 | 0.780 | 6.05 |
| c04-scene-cut | nlmeans-lanczos | 26.92 / 26.19 | 0.786 | 5.89 |
| c05-lowlight-noise | lanczos | 11.66 / 11.63 | 0.752 | 5.69 |
| c05-lowlight-noise | nlmeans-lanczos | 11.64 / 11.61 | 0.752 | 5.59 |
| c06-fast-motion | lanczos | 29.82 / 26.43 | 0.655 | 9.07 |
| c06-fast-motion | nlmeans-lanczos | 29.70 / 26.31 | 0.646 | 9.22 |

V02 adayları bu tabloya `tests/.cache/quality/candidates/<ad>/` üzerinden eklenir. Yapısal fikstürler (TFF, VFR, A/V senkron ≤ 1 kare) geçti.

## Performans (`npm run bench:media`, 3 tekrar, medyan [min–maks]; ızgara satırları RAM örneklemesi düzeltildikten sonraki ikinci koşudan)

| ölçüm | medyan | aralık | bütçe (×1,5, süre ≥ medyan+100 ms) |
|---|---|---|---|
| Açılış: spawn → ilk uygulama belgesi (soğuk WebView2 profili) | 668 ms | 644–676 | 1003 |
| İlk kare 1080p H.264, HTML5 | 140 ms | 139–168 | 241 |
| İlk kare 1080p H.264, libmpv | 223 ms | 125–248 | 335 |
| 5.000 dosya: ilk ızgara boyaması (Plan 04 hedefi < 2 s) | 36 ms | 29–40 | 136 |
| 5.000 dosya: tarama | 44 ms | 40–48 | 144 |
| 5.000 dosya: ilk ekran küçük resimleri (soğuk önbellek) | 172 ms | 169–187 | 272 |
| 5.000 dosya: tepe ağaç RAM | 531 MB | 529–533 | 797 |
| Oynatma 10 s 1080p, HTML5: CPU (tek çekirdeğin %'si) / tepe RAM / düşen kare | %15,5 / 640 MB / 1 | %12,8–17,2 | |
| Oynatma 10 s 1080p, libmpv: CPU / tepe RAM / düşen kare | %21,5 / 641 MB / 0 | %19,1–25,4 | |
| photo-x4 128×128, WebGPU: soğuk / sıcak | 25,9 s / 11,4 s | 24,6–28,6 / 11,0–11,5 | |
| photo-x4 128×128, WebGPU: tepe RAM / GPU ayrılmış / GPU paylaşılan | 2209 MB / 314 MB / 1050 MB | | |
| photo-x4 128×128, WASM: soğuk / sıcak | 95,6 s / 89,9 s | 60,6–101,4 / 84,6–90,4 | |
| photo-x4 128×128, WASM: tepe RAM / GPU ayrılmış / GPU paylaşılan | 1556 MB / 151 MB / 21 MB | | |

RAM/CPU değerleri vho.exe + WebView2 + ffmpeg süreç ağacının toplamıdır. Oynatma CPU'su bu ölçümde WebView2 dahil tüm ağaçtır.

**Bulgular:**

- 1080p oynatma ağaç başına ~640 MB; bu, “ultra hafif” iddiasının tek exe boyutundan çıkarılamayacağını gösterir (Plan 14 notu).
- AI çıkarımı WebGPU'da 1 GB iGPU'nun ~1 GB paylaşılan belleğini kullanıyor ve ağaç RAM'i 2,2 GB'a çıkıyor. İlk bench denemesinde bir kez WebGPU çıkarımı sırasında sayfa bağlantısı koptu (WebView/GPU süreci düştü); tekrar denemelerde (4 koşu) yeniden üretilemedi. A03 kaynak yönetimi için kayıt altına alındı.
- WASM yedeği aynı iş için ~8× yavaş (128 px'de ~90 s): A05'te süre tahmini ve CPU yedeği uyarısı gerekli.
- UI geri bildirim p95 ≤ 200 ms hedefi bu turda **ölçülmedi** (ayrı etkileşim ölçümü gerekir).
