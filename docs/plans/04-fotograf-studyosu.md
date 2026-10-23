# Plan 04 — Fotoğraf Stüdyosu

Hedef: XnView MP / FastStone düzeyinde göz atma + IrfanView düzeyinde toplu işlem, VHO'nun modern arayüzüyle; tüm platformlarda.

## §1 Fotoğraf arka ucu (Ajan A3, Dalga 1) — `src-tauri/src/photo/`
| Modül | İçerik | Aday kütüphane (lisans doğrulanacak) |
|---|---|---|
| `decode.rs` | JPEG/PNG/WebP/GIF/BMP/TIFF/AVIF çözme | `image` (MIT/Apache), `avif` için `dav1d` bağlaması veya `image` avif-native özelliği |
| `heic.rs` | HEIC/HEIF | Windows: **WIC** (HEIF Image Extensions yüklüyse); macOS: ImageIO; Linux: `libheif` (LGPL, dinamik) |
| `raw.rs` | RAW (CR2/CR3/NEF/ARW/DNG/ORF/RW2…) önizleme | Önce gömülü JPEG önizlemesi (EXIF/TIFF içinden, hızlı); tam çözme için `rawler` (LGPL-2.1 → yalnızca uygunsa) |
| `exif.rs` | EXIF/IPTC/XMP okuma: kamera, lens, pozlama, tarih, GPS, yönlendirme | `kamadak-exif` (BSD-2) |
| `thumbs.rs` | Küçük resim üretimi (256 px), disk önbelleği (`app_cache_dir/thumbs`, içerik+mtime anahtarı), paralel üretim (rayon) | `image`, `fast_image_resize` (MIT/Apache) |
| `scan.rs` | Klasör tarama (alt klasör opsiyonel), sıralama (ad/tarih/boyut/EXIF tarihi), dosya izleme | `notify` (CC0/Artistic) — lisans kontrol |
| `ops.rs` | Döndür/yansıt (JPEG için kayıpsız döndürme mümkünse), kırp, yeniden boyutlandır, format dönüştür, kalite; EXIF koruma | `image`, `jpeg-encoder`/`mozjpeg` (lisans kontrol) |

Tauri komutları: `photo_scan(dir, opts)`, `photo_thumb(path, size)` (asset yolu döner), `photo_info(path)` (EXIF JSON), `photo_decode(path)` (tarayıcının açamadığı formatlar için PNG/JPEG önbellek kopyası), `photo_batch(job)` (ilerleme olaylı, iptal edilebilir).
Testler: `cargo test` — her format için küçük fixture (telifsiz, üretilmiş); EXIF örnek dosyası; küçük resim önbelleği isabet/iskalama; toplu işlemde EXIF korunuyor.

## §2 Klasör tarayıcı (Ajan B3)
- Sol panel: klasör ağacı + favoriler; orta: **sanal kaydırmalı küçük resim ızgarası** (10.000+ dosyada akıcı); üst: sıralama, filtre (tür, tarih, yıldız), arama.
- Fotoğrafa çift tık → mevcut görüntüleyici; ←/→ klasör içinde gezinme; görüntüleyicide alt şeritte küçük resimler (filmstrip).
- Videolar da ızgarada (ilk kare küçük resmi; Plan 02 sonrası mpv ile).

## §3 Bilgi, EXIF, harita
- Bilgi paneli: EXIF ayrıntıları, histogram (canvas), dosya bilgisi.
- GPS varsa harita: **Leaflet (BSD-2)** + OpenStreetMap karoları (ODbL atfı + OSM kullanım politikasına uygun; çevrimdışıyken gizlenir).

## §4 Düzenleme ve karşılaştırma
- Kırp (oran ön ayarları), döndür/yansıt, parlaklık/kontrast/doygunluk/sıcaklık, keskinlik; "Kaydet / Farklı kaydet" (orijinali koru seçeneği); geri al/yinele.
- Yan yana / üst üste karşılaştırma (2–4 fotoğraf, senkron zoom/pan).
- Yıldız/etiket (XMP sidecar veya kütüphane veritabanı — Plan 05 ile ortak).

## §5 Toplu işlem
- Seçili dosyalar: yeniden adlandır (desen: `{tarih}_{sayaç}`), dönüştür (JPEG/PNG/WebP/AVIF), boyutlandır, döndür, EXIF temizle; önizleme + ilerleme + iptal.

## Testler (B3)
- E2E: test klasörünü aç → ızgarada N küçük resim; sıralama değişince sıra doğru; fotoğraf aç → ←/→ gezinme; kırp + kaydet → çıktı boyutu doğru; toplu dönüştürme → dosyalar oluştu, EXIF tarih korundu.
- Performans: 5.000 dosyalık klasörde ilk ızgara < 2 sn (önbellek soğukken ilerleyici yükleme).
