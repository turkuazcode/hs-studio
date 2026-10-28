# HS Studio — proje denetimi ve Claude için kalan işler

Tarih: 28 Ekim 2026. Son incelenen ana dal: `c09a661` (video birleşmesi `ed818a3`). Bu rapor bir durum fotoğrafıdır; sonraki commitler için yeniden doğrulama gerekir. Kod değişikliği yapılmadı.

## Karar

**Video iyileştirme de artık ana dalda. Windows'taki temel ürün akışları büyük ölçüde uygulanmış; ancak tüm işletim sistemlerinde doğrulanmış, dağıtıma hazır ürün hedefi tamamlanmış değil.**

İnceleme başında ana dal `a39e0b5`, video çalışması ayrı daldı. İnceleme sürerken Claude F4'ü birleştirdi; rapor yeni duruma göre güncellendi. Eski “video UI yok” kayıtları güncel ürün durumunu anlatmıyor.

Üç ayrı bitiş ölçütü kullanın:

1. **Windows önizleme/alfa:** temel oynatma, kütüphane, fotoğraf ve video işlemleri var. Yayın kontrolü, paket doğrulaması ve bilinen sorunların kapsamı netleştirilince kullanıcı denemesine uygun aday.
2. **Üç masaüstü sisteminde beta:** macOS motoru ve paketlemesi, Linux gerçek donanım doğrulaması, platforma özgü işlevler hâlâ gerekli.
3. **İleri restorasyon ürünü:** geniş kalite değerlendirmesi, uzun işlerde devam, gelişmiş format/renk desteği ve isteğe bağlı model araştırmaları ayrı faz. Bunların hepsi ilk Windows alfa için zorunlu değil.

## Nasıl kontrol edildi?

Plan 08 ve ilgili durum/ADR belgeleri, ana dal ve worktree farkları, oynatma/platform kodu, fotoğraf/video iyileştirme, iş kuyruğu, test sonuçları, yayın kapısı ve CI/paketleme akışları karşılaştırıldı. Otomatik testler çalıştırıldı. Gerçek macOS/Linux cihazı, TV, ekran okuyucu, temiz kurulum makinesi veya insanlarla kör kalite değerlendirmesi bu denetimde kullanılmadı.

### Bu denetimde doğrudan çalıştırılanlar

| Kontrol | Sonuç | Kapsam |
|---|---|---|
| Güncel ana dal `npm test` | **231 geçti**, hata/skip/todo yok | JavaScript birim testleri |
| Güncel ana dal Rust `cargo test --release --lib --locked --offline` | **237 geçti, 6 ignored**, hata yok | Normal Windows oturumu; ignored testler başarılı sayılmadı |
| Video `tests/e2e/video-enhance.e2e.mjs` | **6 geçti** | Menü, varsayılanlar, sıfırlama, 10 sn önizleme, tam çıktı/ses/orijinali koruma, iptal |
| Fotoğraf `tests/e2e/photo-enhance.e2e.mjs` | **5 geçti** | Panel, sıfırlama, kuyrukla 2× çıktı, karşılaştırma, kopya kaydetme/orijinali koruma; video birleşmesinden önceki binary |
| Yayın kapısı olumsuz girdi denemeleri | **5 ayrı yetersiz sonucu kabul etti** | todo, başarısız process exitCode, eski exe, sıfır test, commit bilgisiz sonuç |
| Plan ayrıştırıcısı | Güncel V03'ü **ertelendi** okudu | Açıklama eklenmiş kart kimliği tanınmıyor |

İlk kısıtlı oturumda HEIC testi WIC `0x88982F8B` nedeniyle başarısız oldu ve GUI uygulaması açılamadı. Normal Windows oturumunda HEIC tekil testi, tam Rust katmanı ve GUI testleri geçti. **Bunlar mevcut normal Windows ürününde doğrulanmış hata olarak sayılmadı.** Bununla birlikte HEIC testinin yalnızca `codec-missing` kabul etmesi, kodun meşru `codec-failed` dönüşünü kısıtlı ortamda yanlış başarısızlık sayıyor; test ortamı sınıflaması iyileştirilebilir (`photo/heic.rs:545`).

Loglar yerel/ignored `tests/.results/audit-2026-10-28-*.log` altında. Rapor kalıcı kanıt özetidir; logların Git'e otomatik girmesi beklenmez.

### Önceden kaydedilmiş sonuçlar — bu denetimde tam katman tekrar çalıştırılmadı

- Son tam E2E kaydı: `ed818a3`, **277 geçti + 2 todo**, `exe.stale=null`. İki todo HLS sorunlarıdır; hepsi başarılı demek değildir. `c09a661` değişikliği durum belgesidir.
- AI son sonuç dosyası: `cbabad6`, seçili akıllı düzenleme testlerinde **6 geçti + 3 skip**. Bu sayı tam AI katmanının sonucu gibi sunulmamalı. BiRefNet bellek sınırı nedeniyle atlananlar başarılı sayılmaz.
- Kurulum: kayıtlı **28/28**, test ürün kimliğiyle. Sonucun commit/artifact kimliği bulunmadığından güncel gerçek dağıtımın kanıtı değildir.
- Kalite: önceki **8/8** yapısal/ölçüm altyapısı testi, yeni klasik iyileştirmenin insan tarafından iyi bulunduğunu kanıtlamaz.

## Yapılanlar ve kalan sınırlar

“Uygulandı” ifadesi burada esas olarak Windows kaynak kodu ve test kanıtını anlatır; üç platformda yayın onayı değildir.

| Alan | Yapılan | Kalan / sınır |
|---|---|---|
| Medya oynatma | Windows libmpv, video/müzik oynatma, iz/altyazı kontrolleri ve uygulama akışları | macOS native video motoru eksik; Linux gerçek cihaz kanıtı yok |
| Fotoğraf stüdyosu | Görüntüleme, küçük resimler, düzenleyici, karşılaştırma, toplu işlemler, metadata altyapısı | HEIC/RAW/16 bit iyileştirme E2E kapsamı tamamlanmamış; sistem kodeklerine bağımlılık |
| Fotoğraf iyileştirme | Guided filter temizlik, Retinex gölge açma, Lanczos büyütme, kontrollü detay, isteğe bağlı gren; kuyruk, iptal, kopya kaydetme | Geniş kör A/B yok; macOS/Linux doğrulanmadı |
| Video iyileştirme | Kaynak analizi; gerekiyorsa deinterlace, deblock, zamansal gürültü azaltma, ölçekleme, hafif keskinlik; 10 sn bölünmüş karşılaştırma; yeni MKV; ses/altyazı kopyalama; ilerleme ve iptal | HDR engelli; çıktı SDR 8 bit; segmentten devam yok; diğer OS kodlayıcıları doğrulanmadı |
| AI akıllı düzenleme | LaMa nesne silme, DDColor renklendirme, geri alınabilir düzenleme ve güvenli çıktı | Renklendirme doğruluğu insan değerlendirmesi bekliyor; BiRefNet referans cihazda çalışmıyor, deneysel/gizli |
| Model yönetimi | Manifest, SHA-256, sürüm, indirme/iptal/devam, onarım ve kilitleme | Donanım/platform çeşitliliğiyle ek doğrulama gerekli |
| İş kuyruğu | SQLite kalıcılığı, durum/attempt takibi, kaynak doğrulama, geçici dosyalar, yeniden başlatma/iptal altyapısı | Video işi tek dosya olarak işleniyor; yarım videonun son segmentinden sürdürme uygulanmamış |
| Kütüphane | SQLite göçleri, yedek/kurtarma, artımlı tarama/izleme, arama, yıldız/etiket, oynatma listeleri | Çok büyük gerçek koleksiyon ve platform çeşitliliğiyle saha testi |
| Müzik | Kuyruk, etiketler, boşluksuz oynatma, ReplayGain, Windows medya kontrolleri | macOS/Linux sistem medya kontrolleri eşdeğer değil |
| Ağ ve cihaza yayın | HTTP/HTTPS, yeniden bağlanma, ICY, UPnP/DLNA ve sahte renderer testleri | HLS bozuk; gerçek TV/hoparlör doğrulaması yok; Chromecast/yt-dlp yok |
| Güvenli dosya işlemleri | Kullanıcının seçtiği yollar için izin, yazma/silme/yeniden adlandırma korumaları, kaynak dosyayı koruyan çıktı | Bu çalışma bağımsız güvenlik denetimi/pentest yerine geçmez |
| Dil/arayüz | TR/EN, yerel fontlar, sadeleştirilmiş medya akışları, diyalog odağı, otomatik erişilebilirlik taraması | Gerçek ekran okuyucu, sistem ölçeği, yüksek kontrast ve kullanıcı testi bekliyor |
| Sistem eylemleri | Paylaş/yazdır/duvar kâğıdı/OCR vb. için yetenek tablosu ve OS yolları | E2E çoğunda gerçek OS etkisi yerine log kullanıyor; elle doğrulama listesi boş |
| Açık kaynak hazırlığı | Apache-2.0, bildirimler, SBOM, bağımlılık/kaynak belgeleri, katkı/yayın altyapısı | Belgelerde çelişen eski lisans/durum satırları; gerçek release içeriği son kez eşleştirilmeli |
| Paket ve güncelleme | Windows paketleme, Linux paket betikleri, CI taslakları, imza doğrulayan updater ve SignPath akışı | Uzak workflow kanıtı yok; gerçek imza/endpoint/anahtar yapılandırması ve gerçek güncelleme kurulumu eksik |
| Mobil/ileri özellikler | Planlarda tanımlı | Android/iOS, anlamsal arama, konuşma dökümü, tam RAW/HDR sonraki faz |

Fotoğraf ve videoda varsayılan iyileştirmenin **modelsiz olması bilinçli kullanıcı kararıdır**. Yeniden GAN/difüzyon eklemek tamamlanma koşulu yapılmamalı. AI, nesne silme ve renklendirme gibi diğer akışlarda zaten var. Klasik iyileştirme kayıp ayrıntıyı geri getirme garantisi vermez.

## Somut bulgular ve Claude'a uygulanabilir görevler

### D01 — Yayın kapısı eksik sonuçlarla başarılı olabiliyor (önce düzelt)

Kaynak: `scripts/release-gate.mjs:20–32, 68–110`.

- Başarı hesabı yalnızca `fail`, `skip`, `cancelled` sayıyor. `todo`, `exitCode`, `exe.stale`, sıfır test ve eksik commit bilgisi sonucu engellemiyor.
- Beş ayrı sentetik denemede diğer şartlar sağlanırken bu alanların her biri için `met=true` üretildi. Gerçek mevcut E2E'de iki HLS todo bulunduğu için yalnızca teorik bir eksiklik değil.
- Hedef katmanlarında Rust yok; kalite de yok. Mevcut fotoğraf alfa hedefi AI katmanı istemiyor. Hangi AI özellikleri duyurulacaksa onların kanıtı sürüm kapsamına bağlanmalı; gizli deneysel BiRefNet'i zorunlu yapmaya gerek yok.
- Installer JSON dizi biçiminden okununca commit bilgisi `null`; eski kurulum kaydı güncel kabul edilebiliyor.
- `doğrulandı (Windows...)` etiketi tüm masaüstü için de doğrudan kabul ediliyor. Bir platformun kanıtı diğer platformların yerine geçmemeli.

İş: sürüm kapsamına göre gerekli suite/platform/artifact bilgilerini tanımla; başarısız çıkış, eksik/boş/yanlış suite ve eski binary sonuçlarını reddet. İzin verilen deneysel istisnaları açık kimlik, gerekçe ve kapsamla belirt; sessizce todo/skip kabul etme. Rust sonucunu makinece okunabilir kaydet ve kapıya bağla.

Kabul: yukarıdaki beş negatif örnek reddedilir; seçili suite tüm katman sayılmaz; yanlış commit/platform/artifact reddedilir; kapsam dışı açıkça işaretli özellik alfa yayınını gereksiz yere engellemez.

### D02 — HLS iki bilinen senaryoda çalışmıyor (yayın kapsamını belirle)

Kaynak: `tests/e2e/network.e2e.mjs:220–237`, `docs/network.md`, `tests/.results/e2e.json`.

İlk segmentten sonra takılma ve segment bağlantısı kesilince devam sorunu mevcut kayıtlarla doğrulanmış. **277 geçti + 2 todo**, sıfır açık sorun demek değil. `ci.yml` E2E'yi `VHO_TEST_NO_SKIP=1` ile çağırıyor; runner `skip + todo > 0` durumunda başarısız çıkıyor (`scripts/run-tests.mjs:164`). Bu todo'lar kaldığı sürece mevcut katı CI ayarı da yeşil olmayacak.

İş: libmpv HLS sorununu gider ve iki todo'yu gerçek regresyon testine çevir; veya ilk alfa kapsamından HLS'yi açıkça çıkarıp arayüz/destek tablosu ve kapsamlı test kapısını buna göre düzenle. Testleri yalnızca silerek yeşil sonuç üretme.

Kabul: desteklenecekse birden fazla segment, kesinti ve devam senaryoları gerçek oynatıcıda geçer. Kapsam dışıysa kullanıcıya destek vaadi verilmez ve karar belgelenir.

### D03 — Release workflow'u ürün kabul kontrollerine bağlanmamış

Kaynak: `.github/workflows/release.yml:71–74` ve `scripts/release-gate.mjs`.

Release workflow unit/Rust çalıştırıyor; E2E, ilgili AI/kalite sonuçları veya release-gate adımı yok. Ayrı CI tanımlı olması tek başına bu workflow'un aynı commit/artifact için onun başarılı sonucunu beklediğini göstermez. Otomatik yayın yapılmıyor olması olumlu; yine de release adayı hazırlama kanıtı eksik.

İş: release adayı ile test edilen binary'yi hash/commit üzerinden bağla; gerekli workflow sonuçları ve düzeltilmiş kapı karşılanmadan dağıtım adayı başarılı sayılmasın. Uzak ortamda ilk gerçek çalıştırma sonuçlarını sakla.

Kabul: gerekli test başarısızken aday onaylanmaz; paketlenen içerik ile test edilen sürüm eşleşir.

### D04 — İmzalı paket yolunda updater ayarı aktarılmıyor

Kaynak: `.github/workflows/release.yml:78–94, 113–119`, `scripts/package-windows.ps1:123–126`, `src-tauri/packaging/updater.conf.json`.

İmzasız yol `UPDATER_ENABLED` için `-Updater` geçiriyor. SignPath yolundaki build/bundle çağrıları bunu geçirmiyor; updater anahtar ortamı da aynı şekilde bağlı değil. Betik `createUpdaterArtifacts` yapılandırmasını yalnızca bu anahtarla ekliyor. Dolayısıyla mevcut imzalı yolun updater için gerekli çıktıları üretmesi garanti değil. Ayrıca şablondaki endpoint/pubkey gerçek değerlerle değiştirilmeyi bekliyor.

İş: imzalı ve imzasız varyantlarda updater konfigürasyonunu doğru aşamaya aktar; son imzalanmış kurulum dosyasıyla updater imzasının birebir eşleşmesini sağla. Özel anahtarları depoya/loga koyma.

Kabul: son dağıtılacak dosya gerçek açık anahtarla doğrulanır; temiz makinede önceki sürümden yükseltme geçer; yanlış anahtar, bozuk dosya ve sürüm düşürme reddedilir. Updater ilk alfada kapalı kalacaksa açıkça belgelenebilir.

### D05 — macOS yalnızca “test cihazı bekliyor” değil, motor uygulaması eksik

Kaynak: `src-tauri/src/engine/window.rs:212–215`, `src-tauri/src/engine/mod.rs:55–65`.

Windows/Linux dışı video embedding açıkça `not implemented` dönüyor; motor yükleme de bu platformları reddediyor. macOS için doğru native yüzey ve dylib paketleme yolu yok. Webview'in bazı dosyaları açabilmesi libmpv özellik eşitliği değildir.

İş: macOS video render yüzeyi, libmpv/FFmpeg dağıtımı, paketleme ve OS entegrasyonlarını uygula; ardından gerçek cihazda doğrula. P02 durumunu “kod eksik + ortam bekliyor” olarak düzelt.

Kabul: hedeflenen mimarilerde native video/ses/altyazı, pencere/tam ekran, GPU, paket kurulumu ve gerekli medya eylemleri kanıtlanır. Bu iş Windows alfa için değil, macOS destek iddiası için zorunludur.

### D06 — Linux uygulaması var, gerçek masaüstü kanıtı eksik

Kaynak: `docs/plans/08-uygulama-sirasi-ve-durum.md` P03, `docs/adr/0002-linux-video-yuzeyi.md`, `src-tauri/src/engine/linux.rs`.

GtkGLArea/mpv render API ve paket betikleri yapılmış. WSLg X11 denemesi var; Wayland/llvmpipe siyah kare bulgusu mpv'nin kendi yolunda da görülmüş. Bu tek başına uygulama hatası diye kesinleştirilmemeli; gerçek GPU kanıtı yerine de sayılmamalı.

İş/kabul: gerçek X11 ve Wayland masaüstlerinde görüntü, VAAPI, ses, alt yazı, ölçek/çoklu monitör, pencere yönetimi, deb/AppImage ve hedeflenen glibc tabanı doğrulansın; donanım/dağıtım/sürücü bilgileri kaydedilsin.

### D07 — Video temel akışı bitti; dayanıklılık ve kalite kapsamı daha dar

Kaynak: `src/media/video-enhance.js`, `src-tauri/src/restoration/enhance.rs`, `src-tauri/src/jobs/adapters.rs:350–467`, `docs/adr/0003-video-restoration.md`.

Doğrulanan: önizleme, tam dosya, sesin tutulması, kaynak hash'inin değişmemesi, iptal ve çıktı temizliği. İş tek FFmpeg çalıştırmasıdır; kalıcı kuyruk **işin kaldığı kareden devamı** anlamına gelmez.

Kalanlar:

- Alan sırası sorusunun ön seçimi/değiştirilmesi için ayrı UI testi.
- HDR ve dinamik aralık belirsizliği uyarılarının gerçek UI testi; SDR 8 bit çıktı sınırının anlaşılır gösterimi.
- Uzun kaynaklarda kesinti/uygulama kapanması, disk dolması, yazma izni, VFR ses senkronu, çoklu ses/altyazı ve döndürme/ayna metadata'sı için kabul senaryoları. Mevcut kaynak/recipe testlerini yeniden yazmak yerine uçtan uca boşlukları kapat.
- macOS/Linux kodlayıcılarında görüntü kalitesi ve hız; h264_mf Windows ölçümü evrensel performans vaadi değil.
- Segment checkpoint istenirse ayrıca uygula; istenmiyorsa arayüzde yeniden çalıştırmanın baştan başlayacağını anlat.
- Ayar değişince eski önizlemenin güncel reçeteyi temsil etmediğini belirt veya temizle; hızlı ayar değişiminde eski plan yanıtının yeni ayarı ezmediğini test et.

Kabul: sınırlar kullanıcıya açık, orijinal korunuyor, başarısız/kesilen işlem başarılı dosya gibi sunulmuyor; uzun klipte senkron ve çıktı bütünlüğü ölçülmüş.

### D08 — “Daha kaliteli” iddiasının kapsamlı kanıtı henüz yok

Kaynak: `docs/benchmarks/README.md`, `docs/benchmarks/2026-10-25-baslangic.md`, yeni ADR 0003 eki.

Standart küme 15 fotoğraf ve 6 kısa üretilmiş klip; plan hedefi yaklaşık 100 fotoğraf/20 klip. Kör A/B yapılmamış, ticari ürün karşılaştırması yok. Önceki fotoğraf ölçümleri eski neural yol içindir; yeni klasik fotoğraf zincirine doğrudan uygulanamaz. Eski rapordaki alpha/grileşme sorunlarını düzeltilmiş A04/A05'e güncel hata diye taşımayın.

**Yeni video ADR'sinde gerçek 2011 telefon klipleriyle yerel hız/kodlama denemeleri var.** Dolayısıyla “hiç gerçek video denenmedi” demek yanlış olur. Ancak bunlar lisansı/izinleri ve ayrılmış değerlendirme setiyle yürütülmüş geniş kör kalite çalışması değil. Ardışık kare farkının düşmesi tek başına titreşim/ghosting olmadığını kanıtlamaz; aşırı yumuşatma da farkı azaltabilir.

İş: yeni fotoğraf/video profillerini benchmark'a ekle. Ayar geliştirme ve nihai değerlendirme örneklerini ayır; farklı kamera/gürültü/yüz/yazı/hareket/interlaced örnekleriyle karşılaştır. En az üç değerlendiriciyle kör inceleme; kaynak ve basit Lanczos tabanı aynı boyutta gösterilsin. RAM/VRAM, süre, çıktı boyutu ve arayüz gecikmesini de ölç.

Kabul: yeni zincire ait tekrarlanabilir rapor, bozulma örnekleri, kalite tercihi ve donanım sınırları mevcut. “Rakiplerden daha iyi” iddiası yalnızca karşılaştırmalı kanıt varsa kullanılır.

### D09 — Gerçek OS, erişilebilirlik ve kurulum oturumları gerekli

Kaynak: `docs/manual-os-checklist.md`, `tests/e2e/lib/app.mjs:183–209`, Plan 08 Q03/P05/R02.

Testler güvenli şekilde `VHO_DISABLE_SYSTEM_CHANGES=1` kullanıyor; gerçek paylaş/yazdır/duvar kâğıdı etkileri çoğunlukla uygulanmıyor. Manuel listenin kayıt bölümü “Henüz yapılmadı”. Otomatik axe testleri gerçek ekran okuyucu oturumunu karşılamaz. Kurulumun 28 testi de test ürün kimliğiyle yapılmış.

İş: gerçek yayın kimliğiyle temiz Windows VM kurulum/kaldırma/yükseltme, dosya ilişkilendirmeleri ve standart kullanıcı denemesi; gerçek OS eylemleri; ekran okuyucu, klavye, yüksek kontrast ve gerçek sistem ölçeği oturumu. İşletim sistemi ayarını değiştiren manuel işlemleri kullanıcı kontrollü oturumda yap.

Kabul: sürüm/OS/artifact/tarih/sonuç içeren kayıt; yalnızca test-hook logu gerçek OS başarısı diye işaretlenmez.

### D10 — Plan ve durum belgeleri güncel kodla çelişiyor

Kaynak: Plan 08, `docs/status/implementation-status.md`, `docs/platform-support.md`, `docs/releases/0.1.0-alpha-checklist.md`.

- V03 yeni satırının kimliği `V03 (modelsiz yeniden kapsam)`; `expandIds()` sadece saf kart kimliğini tanıyor. Bu nedenle güncel satır atlanıyor ve `V03–V06 ertelendi` satırı geçerli oluyor. `parseStatus(...).get('V03')` bunu doğrudan gösterdi.
- P02 yalnızca cihaz bekliyor yazıyor; motor eksikliği görünmüyor.
- Bazı giriş/özet tablolarında müzik ve ağ hâlâ ayrı dalda, Linux embedding yok, kurulum yalnız plan olarak görünüyor.
- Eski alfa checklist'i artık yapılmış A04/A05 gibi işleri engel sayıyor. R03'ün “doğrulandı” olması checklist aracının yapıldığını anlatıyor; yayın onayı değil.
- R01 tarihsel notlarında GPL/Apache ifadeleri karışıyor; mevcut LICENSE/package/Cargo Apache-2.0. Tarihsel kararları tarih olarak koruyup güncel durumu tek anlamlı yapın.

İş: V03 kimliğini saf bırakıp kapsamı başka sütuna taşı; V04 önizleme, V05 iptal/segmentten devam ve V06 kalite durumunu ayrı yaz. Eski hedefleri silmeden yeni modelsiz kapsamı açıkça eşleştir. Belgeleri aynı commit için güncelle.

Kabul: ayrıştırıcı V03'ü doğru okur; hiçbir belge tamamlanmış özelliği hâlâ eksik, Windows testini tüm platformlarda testli veya release aracını yayın onayı olarak göstermez.

## Önerilen uygulama sırası

1. D01 + D10: güvenilir yayın kapısı ve tek anlamlı durum tablosu. Önce doğru şekilde neyin eksik olduğunu ölç.
2. D02: HLS'yi düzelt veya Windows alfa kapsamından açıkça çıkar.
3. D07 + D08: yeni video/fotoğraf akışının kritik uç durumları ve güncel kalite raporu.
4. D03 + D04 + D09: gerçek aday paket, uzak CI, seçilen imza/güncelleme kapsamı, temiz makine ve kullanıcı oturumları.
5. Windows alfa geri bildirimi; ardından D05 + D06 ile üç platform beta.
6. Mobil, anlamsal arama, konuşma dökümü, tam RAW/HDR ve yeni modelleri ayrı sürüm hedefi olarak ele al.

İlk alfa için ertelenebilecekler: gizli deneysel arka plan kaldırma, neural video modeli, Chromecast, mobil, tam RAW/HDR ve segmentten devam. Erteleme destek sınırında açıkça yazılmalı. Çalışmayan özelliği tamamlandı saymak ile bilinçli olarak sürüm dışında tutmak ayrı kararlardır.

## Claude'a başlangıç talimatı

> Bu raporu mevcut HEAD ile karşılaştır; sonradan düzeltilmiş bulguları yeniden uygulama. Mevcut fotoğraf/video modelsiz ve aslına sadık yaklaşımını koru. Önce D01/D10, sonra HLS kapsamı ve yeni iyileştirme test boşluklarını ele al. Her görevi küçük, bağımlılıkları net değişikliklerle yap; ilgili gerçek testleri çalıştır. Atlanan/todo/ignored testleri başarılı sayma. Cihaz veya insan oturumu gerektiren işi kod hazır ve doğrulandı olarak ayrı raporla. Başka çalışma dallarını ezme. Sadece burada planlanmış olması uzak yayın, hesap/anahtar oluşturma veya sistem ayarı değiştirme izni değildir; mevcut kullanıcı talimatlarına uy.
