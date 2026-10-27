# Sistem etkili eylemler — kontrollü elle doğrulama listesi (P04)

**Neden elle:** Otomatik testler (`VHO_DISABLE_SYSTEM_CHANGES=1`, E2E başlatıcısı her zaman ayarlar) paylaşma, yazdırma, birlikte aç, klasörde göster, arka plan ve kilit ekranı eylemlerini **yalnızca günlüğe yazar** (`actions_system_log`); gerçek sistemi değiştirmez. Bu liste o eylemlerin gerçek masaüstünde bir kez, kontrollü olarak doğrulanması içindir. Sonuç [platform-support.md](platform-support.md) matrisine ve `capabilities.rs` → `SUPPORT` tablosuna **ancak** bu liste o OS'te tamamlandıktan sonra `destekli/testli` olarak işlenir.

## Kurallar

- Kullanıcının kendi dosyalarına dokunulmaz. Yalnızca aşağıdaki **üretilmiş** test dosyaları kullanılır; her biri yeni, boş bir klasöre yazılır (ör. `%TEMP%\vho-manual-<tarih>`).
- Uygulama izole veri klasörüyle başlatılır: `VHO_DATA_DIR=<yeni boş klasör>`. `VHO_DISABLE_SYSTEM_CHANGES` **ayarlanmaz** (bu listenin amacı gerçek eylemdir), `VHO_DISABLE_SYSTEM_SUSPEND=1` ayarlanır.
- Arka plan ve kilit ekranından önce mevcut görüntü not edilir/yedeklenir (Windows: Ayarlar > Kişiselleştirme; GNOME: `gsettings get org.gnome.desktop.background picture-uri`; macOS: Sistem Ayarları > Duvar Kâğıdı) ve test sonunda geri yüklenir.
- Yazdırmada fiziksel yazıcı yerine **PDF'ye yazdır** (Windows “Microsoft Print to PDF”, Linux “Print to File”) seçilir.
- Paylaşımda yalnızca paylaşım penceresinin açıldığı ve hedef listesinin göründüğü doğrulanır; **hiçbir hedefe gönderilmez** (pencere kapatılır).
- Her adımın sonucu tarih, OS sürümü, mimari ve VHO commit'iyle aşağıdaki kayıt tablosuna yazılır. Başarısız adım “desteklenmiyor” ya da hata olarak kaydedilir; tahminle “testli” yazılmaz.

## Hazırlık (üretilmiş dosyalar)

```text
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25 -frames:v 1 manual-photo.jpg
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440 -t 3 -c:v mpeg4 -c:a aac manual-video.mp4
```

OCR için: düz beyaz zemin üzerine büyük harflerle “VHO METIN 123” yazılı bir PNG (herhangi bir çizim aracıyla, kişisel içerik yok).

## Adımlar

| # | Eylem (`id`) | Adım | Beklenen | Windows | macOS | Linux |
|---|---|---|---|---|---|---|
| 1 | Paylaş (`actions.share`) | Fotoğrafı aç → Paylaş | Sistem paylaşım penceresi açılır; kapatılınca uygulama donmaz | | gizli olmalı | gizli olmalı |
| 2 | Birlikte aç (`actions.openWith`) | ⋯ → Birlikte aç | OS uygulama seçicisi; iptal edilince hiçbir şey açılmaz | | gizli olmalı | portal seçicisi (GNOME/KDE) ya da varsayılan uygulama |
| 3 | Klasörde göster (`actions.reveal`) | ⋯ → Klasörde göster | Dosya yöneticisi açılır, dosya seçili | | | |
| 4 | Yazdır (`actions.print`) | Fotoğraf → Yazdır → PDF'ye yazdır | Önizleme sayfa/kenar boşluğu ayarına uyar, PDF tek sayfa | | gizli olmalı | |
| 5 | Arka plan (`actions.wallpaper`) | ⋯ → Arka plan yap → eski görüntüyü geri yükle | Masaüstü değişir; Linux GNOME dışı masaüstünde açık hata | | | |
| 6 | Kilit ekranı (`actions.lockScreen`) | ⋯ → Kilit ekranı yap → geri yükle | Kilit ekranı görüntüsü değişir ya da açık hata (paketlenmemiş uygulama) | | gizli olmalı | gizli olmalı |
| 7 | Pano: metin/dosya/görüntü (`actions.clipboard*`) | Yolu kopyala → metin düzenleyiciye yapıştır; dosyayı kopyala → dosya yöneticisine yapıştır; görüntüyü kopyala → çizim uygulamasına yapıştır | Üçü de doğru içerik | (otomatik testli) | | Wayland'de XWayland gerekir |
| 8 | OCR (`actions.ocr`) | Metin PNG'si → Metin tanıma | “VHO METIN 123” bulunur; yüklü olmayan dil seçilince açık “dil yüklü değil” hatası | (otomatik testli) | gizli olmalı | `tesseract-ocr-tur`/`-eng` kuruluyken ve kaldırılmışken |
| 9 | H.264 dışa aktarma (`encode.h264`) | Video → Dönüştür → 720p | Ayarlar > Gelişmiş'te seçilen kodlayıcı; çıktı oynar | (otomatik testli) | `h264_videotoolbox` | `libopenh264` veya “yedek kodlayıcı” notu |
| 10 | HEIC/AVIF + renk profili (`photo.heic`, `photo.colorProfile`) | Kendi ürettiğiniz/telifsiz bir P3 HEIC örneği aç → JPEG olarak dışa aktar | Renkler soluk değil; çıktı JPEG'de ICC var | | | |

## Kayıt

| Tarih | OS / sürüm / mimari | VHO commit | Adımlar | Sonuç | Kişi |
|---|---|---|---|---|---|
| — | — | — | — | Henüz yapılmadı | — |
