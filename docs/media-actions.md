# Medya eylemleri (Plan 06)

Plan: [06-medya-eylemleri.md](plans/06-medya-eylemleri.md) · Arayüz ilkeleri: [00-YOL-HARITASI.md](plans/00-YOL-HARITASI.md)

## Arayüz (sade, medya türüne göre ayrı)
Başlık çubuğunda dosya adının yanında ince bir araç çubuğu (`#media-actions`, yalnızca yerel dosyalarda):

| Tür | Görünen düğmeler | "⋯" menüsü |
|---|---|---|
| Fotoğraf | Düzenle · Sil · Yazdır · Paylaş · ⋯ | Birlikte aç, Klasörde göster · Görüntüyü/dosyayı/yolu kopyala · Metin tanıma, Arka plan yap, Kilit ekranı yap · Yeniden adlandır, Favori, Listeye ekle, Özellikler · Ayarlar |
| Video | Kes · Kare kaydet · Dönüştür · Paylaş · ⋯ | Birlikte aç, Klasörde göster · Kareyi/dosyayı/yolu kopyala · Dışa aktar: GIF, kısa klip, sesi çıkar, kalıcı döndür, altyazı göm/ayıkla, kontak sayfası · Mini oynatıcı, Her zaman üstte · Yeniden adlandır, Sil, Favori, Listeye ekle, Özellikler · Ayarlar |
| Müzik | Etiketler · Sözler · Paylaş · ⋯ | Birlikte aç, Klasörde göster · Dosyayı/yolu kopyala · Ses dönüştür, Zil sesi/kesit, ReplayGain · Mini oynatıcı, Her zaman üstte · Yeniden adlandır, Sil, Favori, Listeye ekle, Özellikler · Ayarlar |

Sağ tık menüsü (ui/menus.js) aynı türün kopyala / paylaş / birlikte aç / klasörde göster /
yeniden adlandır / sil / özellikler eylemlerini gösterir. Fotoğraf Stüdyosu ızgarasında seçime:
listeye ekle, dosyaları/yolları kopyala, klasörde göster, sil (Del).

Kısayollar merkezî tabloda (`ACTION_SHORTCUTS`, Ayarlar > Kısayollar'dan değiştirilebilir):
Del sil · F2 yeniden adlandır · Ctrl+C görüntüyü (fotoğraf) / dosyayı (video, müzik) kopyala ·
Ctrl+Shift+C yolu kopyala · Ctrl+P yazdır · Ctrl+S kareyi kaydet · Ctrl+X kes · Ctrl+E dönüştür ·
Alt+Enter özellikler · Ctrl+D favori · Ctrl+T her zaman üstte · Ctrl+M mini oynatıcı ·
Ctrl+Shift+T metin tanıma. OCR katmanında metin seçiliyken Ctrl+C seçili metni kopyalar.

Ayarlar: Genel (silmeden önce sor, dışa aktarım klasörü: kaynağın yanı / Videolar-Müzik-Resimler\VHO,
favoriler), Oynatma (GIF genişliği / kare hızı), Ses (sözleri otomatik göster), Fotoğraf (OCR dili,
yazdırma varsayılanları), Gelişmiş (ffmpeg sürümü ve H.264 kodlayıcısı).

## Arka uç (`src-tauri/src/actions/`)
| Modül | İçerik |
|---|---|
| `mod.rs` | Komutlar, `VHO_DISABLE_SYSTEM_CHANGES` kapısı + `actions_system_log` |
| `files.rs` | Ad doğrulama (Windows kuralları), çakışma (`[exists]`, büyük/küçük harf değişimi serbest), benzersiz çıktı adı, Geri Dönüşüm Kutusu (`trash`), özellikler; açık dosya için kısa yeniden deneme |
| `clipboard.rs` | `arboard`: metin, dosya listesi (Windows `CF_HDROP`), görüntü |
| `ffmpeg.rs` | ffmpeg/ffprobe bulma, ffprobe JSON → `MediaInfo`, **saf argüman üreticileri** (`plan()`), `-progress pipe:1` ilerleme, iptal (süreç öldürülür), yarım dosya → yeniden adlandırma, ebur128 |
| `tags.rs` | `lofty`: etiket okuma/yazma, kapak (ekle/kaldır/kaydet), gömülü söz, `.lrc` arama (UTF-8 / Windows-1254), ReplayGain etiketleri |
| `system.rs` | Arka plan (`IDesktopWallpaper`), kilit ekranı (`LockScreen.SetImageFileAsync`), paylaşım (`DataTransferManager` + `IDataTransferManagerInterop`), `SHOpenWithDialog`; macOS/Linux karşılıkları (derlenir ama burada test edilmedi) |
| `ocr.rs` | `Windows.Media.Ocr`: EXIF yönü uygulanmış görüntüde kelime kutuları (piksel); dil yoksa `[ocr-language]` |

Oynatılan dosya libmpv tarafından açık tutulur (Windows'ta paylaşımlı silmeye izin vermez):
yeniden adlandırma, silme ve etiket yazma önce dosyayı bırakır (`engine.unload`), işlem bitince
aynı konumdan yeniden açar (`withReleased`).

## FFmpeg (LGPL, ayrı süreç)
`ffmpeg.exe` / `ffprobe.exe`, libmpv ile aynı LGPL FFmpeg n8.1.3 derlemesidir (`--enable-gpl`
yok). Bulma sırası (libmpv DLL'leri gibi): `VHO_FFMPEG` (dosya ya da klasör) → exe'nin yanı →
`<exe>\mpv\` → `<exe>\resources\mpv\` (macOS/Linux'ta ayrıca `PATH`). `npm run stage:mpv` bunları DLL'lerle birlikte kopyalar.

### Kodlayıcı bulguları (`ffmpeg -encoders`, bu derleme)
| Amaç | Var | Not |
|---|---|---|
| H.264 | `h264_mf` ✔ (çalıştı), `h264_d3d12va` (bu GPU'da filtre biçimi hatası), `h264_vulkan` | x264 yok. VHO Windows'ta `h264_mf` kullanır (`-pix_fmt nv12`, `-rate_control u_vbr`; e-posta ön ayarında `cbr`) |
| HEVC / AV1 | `hevc_mf`, `av1_mf`, d3d12va/vulkan | Kullanılmıyor |
| AAC | `aac` (yerleşik) ✔, `aac_mf` | `aac` kullanılır |
| MP3 | `mp3_mf` ✔ | LAME yok |
| Opus | `opus` (yerleşik, deneysel → `-strict -2`, 48 kHz) ✔ | libopus yok |
| FLAC / ALAC / WAV | ✔ | |
| GIF / PNG | ✔ | palet üretimiyle GIF |
| WebP (animasyonlu) | ✘ | libwebp yok → kısa klip MP4 olarak |
| Altyazı | `srt`, `ass`, `webvtt`, `mov_text` ✔ | görüntü tabanlı (PGS/DVD) metne aktarılamaz |

### macOS / Linux (belgelendi, uygulanmadı)
`H264_ENCODER` derleme anında seçilir: macOS `h264_videotoolbox` (sistem çerçevesi; ffmpeg'in
LGPL derlemesinde mevcut), Linux `libopenh264` (Cisco OpenH264, BSD-2; ffmpeg `--enable-libopenh264`
ile derlenmeli, ikili Cisco'dan indirilirse patent lisansı Cisco'da kalır) ya da donanım varsa
`h264_vaapi` (`-vaapi_device` + `format=nv12,hwupload` filtresi gerekir). MP3 için `libmp3lame`
(LGPL, yalnızca ayrı süreç/dinamik). Bulunamayan kodlayıcı `[unsupported]` hatası verir.

### Hazır ayarlar
| Ön ayar | Çıktı |
|---|---|
| WhatsApp için | H.264 1,5 Mb/s, kısa kenar ≤ 720, ≤ 30 fps, AAC 128k, `+faststart` |
| E-posta için (< 25 MB) | 24 MiB × %92 bütçe / süre → video + AAC (96k/48k), CBR; çözünürlük bütçeye göre 720/480/360; sığmazsa hata |
| 720p / 1080p | H.264 2,5 / 5 Mb/s, AAC 160/192k; büyütme yapılmaz, döndürülmüş (dikey) videolarda kısa kenar |
| Yalnızca ses | AAC 192k M4A |
| Kayıpsız kesim | `-ss A -to B` (girdi), `-c copy`, `-avoid_negative_ts make_zero` (anahtar kareye hizalanır) |
| Kare hassasiyetli kesim | H.264 (kaynak bit hızı) + AAC → MP4; müzikte FLAC/AAC |
| Kalıcı döndürme | MP4/MOV: `-display_rotation` + `-c copy` (kayıpsız); diğerleri `transpose` + yeniden kodlama |

## Güvenlik
`VHO_DISABLE_SYSTEM_CHANGES=1` (E2E başlatıcısı her zaman ayarlar): arka plan, kilit ekranı,
paylaşım, yazdırma (ön yüz `system_action_allowed` ile sorar), birlikte aç ve klasörde göster
yalnızca günlüğe yazılır. Silme her zaman Geri Dönüşüm Kutusu'na taşır (kalıcı silme yok).

## Bilinen sınırlar
- Paylaşım yalnızca Windows'ta; diğer sistemlerde "Klasörde göster" yedeği. macOS "Birlikte aç"
  Finder'da seçili gösterir (AppKit seçicisi henüz yok).
- Kilit ekranı: paketlenmemiş masaüstü uygulamalarında bazı Windows sürümleri erişimi
  reddedebilir (hata mesajı gösterilir).
- OCR: Windows dışında `[unsupported]` (macOS Vision / Linux Tesseract sonraki iş).
- Favoriler `library.db`'de (L01); yeniden adlandırma/silme L02 işlem kaydıyla medya kimliğine bağlıdır (favori, kaldığı yer, yer imleri ve kayıtlı listeler yeni yolu izler; ayrıntı [storage-schema.md](storage-schema.md#kütüphane-şema-v3-library-plan-13l02)). "Listeye ekle" o anki oynatma listesine ekler; kayıtlı listeler oynatma listesi ⋯ menüsünde.
