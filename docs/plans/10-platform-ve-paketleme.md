Plan 10 — Gerçek çoklu platform desteği ve taşınabilir paketler

Özgün [Plan 02](02-oynatma-motoru.md) motor çalışmasının ve [Plan 03 §5](03-platform-ve-ayarlar.md) yayın hazırlığının tamamlayıcısı. Çatı değişimi yok; mevcut Windows entegrasyonu korunur. Mevcut `third_party/mpv/build-macos.md` ve `build-linux.md` tarifleri başlangıçtır, çalıştırılmış kanıt değildir.

**P01 — Yetenek matrisi ve platform sözleşmesi**

Ön koşul: S01; S04 ile birlikte kullanılacak. Alanlar: `src-tauri/src/platform.rs`, `engine/mod.rs`, `photo/*`, `src/media/engine/*`, `src/ui/platform.js`; önerilen teknik not `docs/platform-support.md`.

- OS/mimari/WebView, etkin motor, donanım decode, video yüzeyi, encoder, fotoğraf codec, OCR, paylaşım, sistem medya kontrolleri ve AI backend yeteneklerini tek sorgu modelinde topla. Mevcut `engine_status`/`photo_capabilities` çıktısını adapter ile birleştir.
- Önerilen alanlar: `available`, `implementation`, `verified`, `reasonCode`; derleme bayrağı, runtime varlığı ve gerçek cihaz testini birbirinden ayır.
- Desteklenmeyen kontroller gizli veya açıklamalı devre dışı; sessizce farklı işlem yapma. HTML5 fallback geniş codec desteği diye sunulmaz.
- Hedef tablo için ilk adaylar Windows x64, macOS arm64, Linux x64 Wayland/X11; macOS Intel/Windows ARM64 desteği ayrıca kanıtlandıkça eklenir. Minimum OS sürümleri seçilen Tauri/runtime ve gerçek testlerle sabitlenir; bütün eski sürümler vaat edilmez.

Kabul: Windows'ta motor yok/var, codec yok/var ve AI backend yok senaryoları farklı yanıtlar verir. UI aynı capability bilgisini kullanır. Fixture testleri platforma göre açıkça seçilir.

**P02 — macOS libmpv entegrasyonu**

Ön koşul: P01, S02. Alanlar: `src-tauri/src/engine/{mod,mpv,window}.rs`, `platform.rs`, `tauri.conf.json`, `third_party/mpv/*`; gerekirse `engine/window/macos.rs`.

- Önce küçük deneyde mevcut LGPL derlemesi + NSView veya Render API yüzeyi + Tauri üst katmanını çalıştır. Native view yaratma/yeniden boyutlandırma işlemlerinin ana thread gereksinimlerini karşıla. Seçim `docs/adr/0002-platform-video-surface.md` içinde ölçümle gerekçelensin.
- `locate` Windows-only koşulunu platform resolver'a ayır; app bundle içindeki dylib ve transitif bağımlılıkların rpath/install name çözümünü düzenle. Geliştirici makinesinin Homebrew PATH'ine bağımlı paket çıkarma.
- Finder'dan açma, tam ekran, Retina ölçek, pencere gizleme, fotoğraf ekranına geçiş, ses cihazı değişimi, uyku/uyanma ve uygulama kapanışını test et.
- VideoToolbox decode/encode varlığı ile başarıyı ayrı ölç. Otomatik donanım yolundan yazılıma geçiş kullanıcı ayarlarını bozmamalı.

Kabul: gerçek macOS cihazında H.264, HEVC ve çok kanallı MKV; altyazı, seek, tam ekran, resize, screenshot, fotoğraf/video geçişi. Temiz bundle sistem mpv'siz çalışır. Cihaz yoksa kod ve derleme çıktısı `kod hazır/ortam bekliyor`; destek `verified=false`.

**P03 — Linux libmpv entegrasyonu**

Ön koşul: P01, S02. Alanlar: P02 ile ortak dosyalar, Linux yüzey/resolver modülü, LGPL derleme tarifi ve paket betikleri.

- Wayland ve X11 için gerçek küçük yüzey denemesi yap. LGPL mpv derlemesinde gereken VO/yüzey özelliğinin gerçekten bulunduğunu kontrol et; Windows `wid` yolunu kopyalayıp çalışır sayma.
- Render API/EGL/OpenGL veya kanıtlanmış yerel yüzey yolunu seç; thread/context sahipliğini, frame callback ve kapanış yaşam döngüsünü ADR 0002'ye yaz. Linux'u zorla yalnızca X11'e düşürmek Wayland desteği olarak raporlanmaz.
- `.so` arama sırası, paket rpath'i ve bağımlılık çözümü açık olsun. Dağıtılan libmpv/FFmpeg'in lisansını derlemeden doğrula; sistem GPL paketlerini sessizce yükleyerek mevcut politikayı aşma.
- PipeWire/PulseAudio ortamları, HiDPI, çok monitör ve pencere yöneticisi davranışlarını kaydet. VAAPI kullanılabiliyorsa doğrula; yoksa çalışabilir software fallback tanımla.

Kabul: seçilen en az bir gerçek Wayland ve bir X11 ortamında aynı temel medya senaryosu geçer. Sistem mpv kurulu olmayan temiz pakette motor yüklenir. Sanal CI cihazı GPU kalite/perf kanıtı sayılmaz.

**P04 — İşletim sistemi eylemleri ve fotoğraf codec eşitliği**

Ön koşul: S02/S03, P01. Özgün Plan 03/04/06 kapsamını tamamlar.

- D1 belgesindeki platform boşluklarını tek tek matrise geçir: macOS/Linux OCR, paylaşım, birlikte aç, pano, yazdırma, arka plan/lockscreen; platformun desteklemediği özelliği zorunlu taklit etme.
- macOS Vision/Linux Tesseract adaylarını uygulama zamanı lisans/dağıtım ve offline dil paketi açısından doğrula. Yüklü olmayan OCR dili açık hata versin; sessiz çevrimiçi OCR ekleme.
- HEIC/AVIF decode, EXIF yönü ve renk profili; RAW için `rawPreview` açık etiketi. Görüntülenebilen codec'in dışa aktarılabilir olduğunu varsayma.
- D1 FFmpeg encoder seçimini sadece derleme zamanı sabiti yerine runtime deneme/uygun fallback ile güçlendir. Her donanım encoder'ının piksel biçimi, boyut ve renk alanı kısıtları hesaba katılsın.

Kabul: özellik başına `destekli/testli`, `destekli/test bekliyor`, `desteklenmiyor` tablosu. Sistem etkili eylemler CI'da mock; gerçek masaüstü doğrulaması kontrollü manuel listeyle yapılır. Kullanıcı dosyalarına test uygulanmaz.

**P05 — Paketleme ve temiz kurulum**

Ön koşul: hedef platform için S03/P01; macOS için P02, Linux için P03. İleri OS eylemleri P04 matrisiyle sınırlandırılır. Alanlar: `src-tauri/tauri.conf.json`, `scripts/stage-mpv.ps1`, yeni platform betikleri, `third_party/mpv/*`, CI (R02 ile ortak).

- `build:release` şu an `--no-bundle`; geliştirici binary üretimiyle kurulum paketi üretimini ayrı script yap. Tüm ikon ve resource yolları gerçek dosyalara işaret etsin.
- Hedefte gerekli mpv/FFmpeg/ffprobe ve transitif runtime kütüphanelerini, lisans bildirimlerini paketle. “Stage” scriptinin geliştirici dizininde başarılı olması paket testinin yerine geçmez.
- İlk paket kapsamı: Windows NSIS, macOS test edilmiş mimariye DMG/app, Linux AppImage ve bir dağıtım paketi. MSI/rpm/Flatpak özgün planda durur, her birinin temiz kurulum testi yapılana kadar ayrıca yayımlanmaz.
- Node/Rust/runtime sürümleri güncel bağımlılık gereksinimleriyle sabitlenir. README'deki Node 18 iddiasını mevcut Vite ve test çalıştırıcısı gereksinimleriyle eşleştir. Kilit dosyaları kullanılır.
- Her platform için kurulum → dosya aç → motor doğrula → yükselt → ayar/kütüphane korunumu → kaldır senaryosu. Boşluk/Türkçe karakterli kurulum ve medya yolları test edilir.
- Kullanıcının model/veri dizinleri ile uygulama binary kaynakları ayrılır. Güncelleme öncesi veri şeması yedeği ve uyumluluk davranışı R02/L01 ile ortak tasarlanır.

Kabul: temiz makine/VM'de geliştirici PATH'i veya yerel kaynak ağacı olmadan temel oynatma çalışır; paket dosya envanteri ve SHA-256 üretilir; motor eksikse açık hata/fallback vardır. İmzalama/yayın işleri R02'de; test edilmemiş platform paketi kararlı sürüm sayılmaz.
