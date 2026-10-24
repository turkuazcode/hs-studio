# Plan 06 — Medya Eylemleri (Fotoğraf, Video, Müzik)

Kaynak: Windows Fotoğraflar araç çubuğu (Düzenle, Döndür, Sil, Yazdır, Paylaş, Kopyala, Ayarla, Birlikte aç, metin tanıma) + rakip oynatıcılardaki dosya/kırpma/dönüştürme eylemleri.
**Ön koşul:** B1 (libmpv motoru) ve B3 (fotoğraf arayüzü) birleşmiş olmalı. Ajan: **D1** (gerekirse D1a fotoğraf+ortak, D1b video+müzik olarak bölünür).

## §1 Ortak eylemler (her medya türü)
| Eylem | Uygulama | Platform |
|---|---|---|
| **Sil** → Geri Dönüşüm Kutusu / Çöp | `trash` crate (MIT); onay penceresi; oynatma listesinden de çıkar, sonrakine geç | Win/mac/Linux |
| **Klasörde göster** | `tauri-plugin-opener` `revealItemInDir` | hepsi |
| **Birlikte aç** (başka uygulama) | Windows: `SHOpenWithDialog`; macOS: `NSWorkspace` uygulama seçici; Linux: `xdg-open` / portal | hepsi |
| **Yeniden adlandır** | yerinde düzenleme; çakışma kontrolü; oynatma listesi/son açılanlar güncellenir | hepsi |
| **Kopyala**: dosyayı / dosya yolunu panoya | `tauri-plugin-clipboard-manager` (MIT/Apache) + Windows `CF_HDROP` | hepsi |
| **Paylaş** | Windows: `DataTransferManager` (Share UI); macOS: `NSSharingServicePicker`; Linux: "Klasörde göster" yedeği | Win/mac |
| **Özellikler** | Bilgi paneli (EXIF / codec, bit hızı, süre / etiketler) | hepsi |
| **Favori / yıldız** | kütüphane veritabanı (Plan 05) gelene kadar ayar deposu | hepsi |
| **Oynatma listesine ekle** | mevcut liste + (Plan 05) kayıtlı listeler | hepsi |

## §2 Fotoğraf eylemleri
| Eylem | Uygulama |
|---|---|
| **Görüntüyü panoya kopyala** | clipboard-manager `writeImage` (düzenlenmiş hali dahil) |
| **Yazdır** | Yazdırma önizlemesi: kenar boşluğu, sığdır/doldur, sayfa yönü; WebView `print()` ile yalnızca görüntüyü içeren yazdırma sayfası |
| **Arka plan / kilit ekranı yap** ("Ayarla" menüsü) | Windows: `IDesktopWallpaper` + `LockScreen.SetImageFileAsync`; macOS: `NSWorkspace.setDesktopImageURL`; Linux: GNOME/KDE (gsettings / D-Bus), desteklenmiyorsa gizle |
| **Metin tanıma (OCR)** | Windows: `Windows.Media.Ocr` (yerleşik, Türkçe dil paketi varsa); macOS: Vision; Linux: Tesseract (Apache-2.0, ilk kullanımda indirilir). Metin seçilebilir katman + "Tümünü kopyala" |
| **Farklı kaydet / yeniden boyutlandır / döndür kalıcı** | Plan 04 (B3) ile ortak, burada araç çubuğuna bağlanır |
| **Slayt gösterisi (klasörden)** | mevcut slayt gösterisi + geçiş efekti / süre ayarı |

## §3 Video eylemleri
FFmpeg CLI: libmpv ile birlikte derlenen **LGPL ffmpeg.exe** (ayrı süreç olarak çalıştırılır; x264/x265 YOK → H.264 kodlama için Windows'ta `h264_mf`, macOS'ta `h264_videotoolbox`, Linux'ta `h264_vaapi`/yazılım için LGPL uyumlu `libopenh264` (BSD-2) değerlendirilecek).
| Eylem | Uygulama |
|---|---|
| **Kareyi kaydet / panoya kopyala** | mpv `screenshot-raw` → PNG / pano |
| **Kes (kırp) — kayıpsız** | A-B noktaları veya zaman çubuğu seçimiyle; `ffmpeg -ss -to -c copy` (anahtar kareye hizalama uyarısı) |
| **Kes — kare hassasiyetli** | yeniden kodlama (yukarıdaki LGPL kodlayıcılar) |
| **GIF / kısa klip dışa aktar** | seçili aralıktan GIF (palette) veya WebP/MP4 |
| **Sesi çıkar** | `-vn -c:a copy` (orijinal) veya AAC/Opus/FLAC'a dönüştür |
| **Dönüştür / küçült** | hazır ayarlar: "WhatsApp için", "E-posta için (< 25 MB)", "720p", "1080p", "Yalnızca ses"; ilerleme + iptal |
| **Kalıcı döndür** | `-metadata:s:v rotate` (kayıpsız) veya yeniden kodlama |
| **Altyazıyı göm / ayıkla** | MKV'ye altyazı ekle (`-c copy`), gömülü altyazıyı SRT/ASS olarak dışa aktar |
| **Her zaman üstte / mini oynatıcı** | pencere API'si (Plan 05 müzik mini oynatıcısıyla ortak) |
| **Ekran görüntüsü serisi** | N kareyi kontak sayfası (contact sheet) olarak kaydet |

## §4 Müzik eylemleri
| Eylem | Uygulama |
|---|---|
| **Etiket düzenleyici** | başlık, sanatçı, albüm, yıl, tür, parça no, kapak ekle/değiştir — `lofty` (MIT/Apache) |
| **Albüm kapağını kaydet / değiştir** | lofty + görüntü seçici |
| **Şarkı sözleri** | gömülü sözler (USLT) ve yanındaki `.lrc` dosyası; LRC zaman eşlemeli gösterim |
| **Ses dönüştür** | FLAC/Opus/AAC/WAV (LGPL ffmpeg; MP3 kodlama için LAME LGPL — yalnızca dinamik/ayrı süreç) |
| **Ses seviyesi eşitle (ReplayGain hesapla)** | `ffmpeg -af ebur128` → etikete yaz |
| **Zil sesi / kısa kesit** | seçili aralığı dışa aktar |

## §5 Arayüz
- **Üst araç çubuğu** (Windows Fotoğraflar düzeni): solda bağlama göre değişen eylemler (Fotoğraf: Düzenle · Döndür · Sil · Yazdır · Paylaş · ⋯ / Video: Kes · Kare kaydet · Dönüştür · Paylaş · ⋯ / Müzik: Etiketler · Sözler · Paylaş · ⋯), ortada dosya adı, sağda "Birlikte aç ▾" ve pencere düğmeleri.
- **"⋯" menüsü:** Farklı kaydet, Kopyala, Yeniden boyutlandır/Dönüştür, Ayarla ▸ (arka plan / kilit ekranı), Klasörde göster, Yeniden adlandır, Özellikler, Ayarlar.
- **Alt bilgi şeridi** (fotoğraf): filmstrip aç/kapat, slayt gösterisi, biçim · çözünürlük · boyut, bilgi, metin tanıma, sığdır, % zoom seçici, zoom kaydırıcı, tam ekran.
- **Sağ tık menüsü** (B2'nin bağlam menüsü) aynı eylemleri gösterir; **kısayollar** B2'nin kısayol tablosuna eklenir (Del, Ctrl+C, Ctrl+Shift+C, Ctrl+P, Ctrl+S, F2, Ctrl+E…).
- Tüm metinler i18n anahtarlarıyla (TR/EN).

## §6 Güvenlik ve testler
- **Sistem değişikliği yapan eylemler testlerde asla gerçekten çalışmaz:** arka plan/kilit ekranı, paylaşım, yazdırma, "Birlikte aç" — `VHO_DISABLE_SYSTEM_CHANGES=1` ortam değişkeni ile arka uç bunları yalnızca günlüğe yazar; E2E başlatıcı bunu her zaman ayarlar.
- **Silme testleri** yalnızca test sırasında oluşturulan geçici kopyalar üzerinde; kullanıcı dosyalarına asla.
- Birim: dosya adı/çakışma mantığı, FFmpeg argüman üreticileri (kesme, dönüştürme hazır ayarları), LRC ayrıştırıcı, etiket eşleme.
- E2E: kopyala→pano içeriği doğru; sil→geçici dosya çöpte ve listeden çıktı; video kes (kayıpsız)→çıktı süresi ±1 sn; sesi çıkar→çıktı yalnızca ses; dönüştür "720p"→çözünürlük doğru; etiket düzenle→yeniden okununca aynı; OCR (Windows) bilinen metinli üretilmiş görselde tanındı; sistem eylemlerinin günlüğe yazıldığı ama uygulanmadığı doğrulanır.
