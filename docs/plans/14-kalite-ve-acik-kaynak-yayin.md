Plan 14 — Kalite kanıtı, erişilebilirlik, güvenlik ve açık kaynak yayın

[Plan 03 §5](03-platform-ve-ayarlar.md) yayın hedeflerini tamamlar. Kalite işi geliştirmenin sonunda başlayan bir aşama değildir: Q01/S01 ile, Q02 model seçilmeden, R01/R02 ilk paket hazırlanırken başlar. Her kartın bitirme kanıtı [08](08-uygulama-sirasi-ve-durum.md) durumuna bağlanır.

**Q01 — Test katmanlarını ayır ve gerçek modele erişen test ekle**

Ön koşul: S01; adapter'lar geldikçe A01–A06/V03 testleri eklenir. Alanlar: `tests/unit`, `tests/e2e`, önerilen `tests/integration`, `tests/ai`, `tests/quality`, `package.json`, CI.

| Katman | Ne doğrular? | Çalışma sıklığı |
|---|---|---|
| Birim | Saf dönüşüm, şema, dosya adı, recipe, zamanlama/maske/alpha mantığı | İlgili her değişiklik/PR |
| Rust/entegrasyon | Dosya/DB migration, indirme-hash, IPC, job kurtarma, export | İlgili her değişiklik/PR |
| Uygulama E2E | Yeni binary, gerçek engine, kullanıcının dosya aç/düzenle/kaydet akışı | Windows PR; diğer platformlarda uygun sürücü/manuel kanıt |
| Gerçek AI smoke | Doğrulanmış gerçek modelle küçük input, çıktı boyutu/sonlu değerler/reference toleransı | AI değişikliği ve sürüm adayı; model önbelleğiyle |
| Kalite/perf | Doğallık, yüz/yazı, temporal tutarlılık, hız/bellek | Model/recipe değişikliği ve beta öncesi |

- Önerilen yeni komutlar `test:ai`, `test:quality`, `bench:media`; bunlar şu an mevcut değildir, altyapıyla birlikte oluşturulmalı. Mevcut `npm test` ağsız ve hızlı kalır.
- Büyük modeller hash-sürümlü CI cache'de; download failure ayrı altyapı hatası. Mock inference UI testini hızlı tutabilir ama gerçek AI testinin yerine geçmez.
- Gerçek test fixture'ı paylaşılabilir küçük görüntü/klip; ön/son işleme resmi referansıyla karşılaştırılır. Float/backend farkları için açıklanmış tolerans; tüm GPU çıktısında byte-equality beklenmez.
- Model çıktısının yalnızca boyutunu test etmek yeterli değil: boş/sabit/NaN çıktı, kanal sırası, alpha, orientation ve bilinen küçük referansla fark kontrol edilir.
- Mevcut Windows CDP düzeneğini macOS/Linux için var sayma. Her hedefin destekli otomasyon seçeneği doğrulanır; yoksa motor CLI/entegrasyon testleri + version/device'lı manuel UI listesi. Ekran görüntüsü tek başına oynatma kanıtı değil.
- Test süreçleri geçici profil/veri dizini kullanır. Model smoke veriyi test root'unda tutar; kullanıcı AI cache'ini silmez. Sistem etkili eylemler mock/gated, yalnızca test süreçleri kapatılır.

Kabul: her desteklenen özellik için hangi katmanın kanıt ürettiği test haritasında yazılı; skip/fail/pass ayrı; yeni binary yolu logda; bir gerçek AI smoke fixture'ı referansıyla geçer. Ağsız birim testte model indirme başlamaz.

**Q02 — Restorasyon kalite kümesi ve performans bütçeleri**

Ön koşul: S01; A05/V02'den önce küçük başlangıç kümesi gerekir. Alanlar: önerilen `tests/quality/manifest.json`, `scripts/bench-*`, `docs/benchmarks/*`. Büyük/özel kaynak dosyalar depoya gömülmez.

- İlk geliştirme için en az 12 fotoğraf/6 kısa kliple başla; yayın değerlendirmesinde hedef yaklaşık 100 fotoğraf/20 klip. Her örneğin lisans/kaynak/izin, bozulma türü, kategori ve hash'i kayıtlı olsun. Kamuya açık test kümesi kişisel anı fotoğraflarından oluşmasın.
- Gerçek eski kaynak ile temiz referanstan kontrollü bozulmuş kaynak ayrı etiketli. Eğitim/tuning için kullanılan örnek ile son değerlendirme kümesi ayrılır; yalnızca iyi sonuçları seçme.
- Fotoğraf kategorileri: JPEG blokları, düşük ışık, bulanıklık, çizik/taranmış baskı, küçük/büyük yüzler, farklı cilt tonları, yazı/tarih, doğal doku, alpha, yüksek çözünürlük. Video: bunlara ek hareket, sahne kesimi, alan sırası, VFR ve ses senkronu.
- Baseline: orijinalin aynı hedef boyuta standart ölçeklemesi, mevcut VHO profili, uygun açık kaynak referans; erişim varsa ticari ürün. Ücretli ürün/hesap yokluğu baseline raporunu durdurmaz, karşılaştırma yapılmadığı açık kalır.
- Eşit çözünürlük ve aynı zoom; ürün adı gizlenmiş A/B sırası rastgele. En az üç değerlendirici hedefi; yalnızca geliştirici değerlendirmesi varsa sonuç bu şekilde etiketlenir.
- Rubrik 1–5: doğallık, ayrıntı, kişi/yazı sadakati, artifakt; videoda flicker/ghosting/süreklilik. Şiddetli kimlik/yazı değişimi ayrıca red bayrağı; ortalama keskinlik skoru bunu örtmez. Renklendirmenin tarihsel doğru renk kanıtı olmadığı belirtilir.
- Temiz referanslı örnekte PSNR/SSIM yardımcı; referanssız veya generatif sonuçlarda tek başına kalite kararı verilmez. Her profil için kritik hata oranı ve kör tercih oranı örnek sayısıyla raporlanır.

Ölçüm kaydı: app commit, OS/WebView, CPU/GPU/RAM/sürücü, model hash'i, recipe, soğuk/sıcak başlangıç, input/output, süre/fps, peak RAM/VRAM, disk geçici/son boyutu, dropped frames. Tauri uygulaması için WebView/worker/FFmpeg dahil süreç ağacı ölçülür; yalnızca ana exe küçük diye “ultra hafif” sonucu çıkarılmaz.

Başlangıç hedefleri (ölçüm sonucu değil; S01 sonrası referans cihazla kesinleşecek):

- Mevcut Plan 04 hedefi 5.000 dosyada ilk ızgara <2 saniye; fixture boyutu, soğuk/warm cache ve disk türü raporda sabit.
- UI tıklama/iptal komutunun alındığına dair geri bildirim için p95 ≤200 ms hedefi. GPU kernel'in tamamen durması ayrı ölçülür; video pause “güvenli segment sonunda” açıkça bildirilir.
- AI kapalı oynatma, aynı cihaz/fixture'da önceki sürümün CPU/bellek/frame-drop baseline'ına karşı değerlendirilir. %10'dan büyük tekrarlanan kaynak regresyonu araştırılır; ölçüm gürültüsü için en az üç karşılaştırılabilir koşu.
- Model başına fps/VRAM hedefi V02/A03 ölçümünden sonra belirlenir; 1 GB iGPU'da tüm modellerin çalışacağı garanti edilmez.

Kabul: makinece okunur sonuç + kullanıcıya anlaşılır rapor; başarısız örnekler de kayıtlı; performans/sadakat takası açık. “Rakipten iyi” ifadesi yalnızca ölçülen kategori, cihaz ve ayarla sınırlıdır.

**Q03 — Kullanılabilirlik ve erişilebilirlik**

Ön koşul: S05, ilgili UI özelliği. Özgün Plan 03 erişilebilirlik kapsamını detaylandırır.

- Klavye ile dosya aç/oynat/düzenle/karşılaştır/kaydet; menü, dialog focus trap, Escape, kapatınca odağı geri verme. Kısayol yazı alanı/slider ile çakışmaz.
- Butonların erişilebilir adı, seçili/durum bilgisi, form label, hata bağlama ve ölçülü canlı bölgeler. Her yüzde ilerlemesini ekran okuyucuda sürekli okutma.
- Yüksek kontrast, koyu/açık tema, sistem ölçek %125/%150/%200, küçük pencere, uzun İngilizce/Türkçe metin, reduced motion. Devre dışı özelliğin sebebi erişilebilir.
- Windows ekran okuyucu ve hedef macOS/Linux karşılıklarıyla temel akış; otomatik DOM taraması insan kontrolünün yerini tutmaz.
- Beş kullanıcı için görev senaryosu: arşiv aç, fotoğrafı iyileştir, önce/sonra karşılaştırıp kaydet, parçayı listede bul. Yardımsız tamamlama, süre, yanlış tıklama ve anlaşılmayan metin kaydedilir; görsel tasarım büyük yenilemesi ayrı iş.

Kabul: temel akış klavyeyle tamamlanır, kritik odak kaybı yok, 200% ölçek ana eylemleri saklamıyor. Kullanıcı testi yapılmadıysa raporda `kullanıcı testi bekliyor` yazılır.

**Q04 — Medya, IPC ve mahremiyet sağlamlaştırması**

Ön koşul: S01; A/P/V/L işleriyle birlikte ilerler. Alanlar: Rust komutları, capabilities/CSP, dosya/URL/FFmpeg/model işlemleri, diagnostic loglar.

- Tauri komutlarını izin/argüman açısından envanterle. `engine_command` gibi genel köprülerde gerçekten gereken mpv komut/özellikleri allowlist ile tanımla; mevcut özellik testlerini koru. Tüm pencereye gereksiz yetki açma, uzak içeriğe yerel IPC yetkisi verme.
- Dosya okuma/yazma/silme/rename ve asset scope kullanıcı seçimi/iş sahipliği ile sınırlı; canonical path, symlink, UNC/Unicode ve hedef çakışması politikaları açık. Oynatma için seçilmiş dosyaya izin verilmesi bütün dizine yazma izni anlamına gelmez.
- Shell string yerine argv; dış kaynaktan gelen metadata/path komuta dönüşmez. FFmpeg/mpv/model worker kaynak-zaman limitleri ve yalnızca sahip olunan process tree'nin iptali.
- Bozuk/tampon sınırını aşan EXIF, büyük görüntü/decompression bomb, kötü altyazı, playlist URL, SVG/remote image, zip traversal ve aşırı sayıda thumbnail için küçük adversarial fixture'lar. Lisansa uygun fuzzing araçları isteğe bağlı test altyapısına eklenebilir.
- Kütüphane/thumbnail/transcode/AI cache ayrı temizleme kontrolleri; kullanımda olan artifact silinmez. Tanı raporu özel yol, GPS, erişim token'ı ve görüntü içeriğini varsayılan içermez.
- Varsayılan telemetry yok. İsteğe bağlı hata raporunda gönderilecek veri önizlenir. Model ilk indirmesi ile medya yükleme farklıdır; medya arka planda buluta gönderilmez.
- Paket/runtime/crate/npm güvenlik taraması için uygun mevcut araçlar seçilir. Saptanan açıkların ulaşılabilirliği ve sürümü incelenir; sessiz allowlist veya doğrulanmamış “güvenli” etiketi yok.

Kabul: veri kaybı veya yetkisiz dosya/süreç işlemi üreten bilinen kritik/yüksek sorun açık bırakılarak kararlı yayın yapılmaz; bulunanlar `SECURITY.md` süreciyle ele alınır. Eksiksiz güvenlik sertifikası iddia edilmez. Kaynak sınırı/iptal ve özel veri içermeyen tanı raporu testleri geçer.

**R01 — Açık kaynak ve lisans paketi**

Ön koşul: S01; uygulamayla birlikte güncellenir. Alanlar: README/TR-EN belgeleri, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, issue/PR şablonları, `legal/*`, model manifestleri.

- Mevcut MIT uygulama lisansı korunur. Lisans politikası dışında bağımlılık sessizce eklenmez; LGPL bileşenlerin dağıtım/yeniden bağlama koşulları, GCC runtime exception gibi mevcut istisnalar kendi metinleriyle değerlendirilir.
- Kod, model ağırlığı, runtime binary, font/ikon, fixture ve model kaynak verisi bilgileri ayrı envanter. Kodun açık kaynak olması model ağırlığına otomatik lisans sağlamaz.
- Her dağıtılan native bileşen için sürüm/commit/derleme bayrağı/bağımlılık/sha256 ve kaynak sağlama yolu. FFmpeg/libmpv binary'siyle eşleşen kaynak/patch/build tarifi; sadece genel upstream linkine güvenme. Linux sistem GPL fallback tarifindeki varsayım ayrıca incelenir.
- SPDX veya CycloneDX gibi seçilen bir SBOM formatı; Rust/npm envanteri ve native/model manifestleri birlikte kapsanır. Otomatik notices üretiminin ardından elle eksik binary/model/font kontrolü.
- Katkı rehberinde kurulum, test, mimari, küçük ilk görevler, format/i18n/lisans beklentisi; güvenlik bildirim kanalına kullanıcıya ait olmayan uydurma e-posta yazma. Kanal bilinmiyorsa somut yayın gereksinimi olarak işaretle.
- Git geçmişinde sır/özel medya/büyük dosya taraması; saptananı kullanıcıya raporla. Geçmişi onaysız force-push/rewrite etme; yerel hazırlık ve çıkıştan çıkarma yapılabilir.

Kabul: temiz clone'dan belgelenmiş geliştirme kurulumu ve test; her paket öğesi lisans/envantere izlenebilir; örnekler paylaşılabilir. Plan hazırlanması hukuki uygunluk garantisi sayılmaz.

**R02 — CI, sürüm üretimi, imzalama ve güncelleme**

Ön koşul: P05 platform paket hazırlığı; workflow taslağı S01'den itibaren hazırlanır. Özgün Plan 03 §5'in uygulamasıdır.

- PR işleri: sürüm sabitleme/lockfile ile kurulum, JS/Rust testleri, hedef platform derleme, ilgili E2E; AI/dependency/license değişikliğinde ilgili ilave katman. GPU testleri erişilebilir gerçek runner veya manuel kanıtla ayrılır.
- Release işi otomatik yayın yapmak zorunda değildir: önce artifact + checksum + SBOM + notices + kaynak paketi + değişiklik notu üretir. Yeni/sabitlenmiş CI runner sürümleri uygulama anında resmi durumuna göre doğrulanır.
- İmza anahtarları repo/loglara girmez. CI izinleri en az yetki, dış action'lar güvenilir sabit referans; fork PR'larına yayın sırları verilmez. Windows imza ve macOS notarization hesabı yoksa paket üretimi/yerel test devam eder; imzasız artifact durumu açık.
- Tauri updater seçilen sürümün resmi protokolüyle uygulanır. Güncelleme artifact imzası doğrulanır; manifest de doğrulanmış mekanizma/HTTPS üzerinden gelir. Sadece checksum'a güvenilmez. Yanlış imza, bozuk indirme, ağ kesintisi ve eski sürüm denemeleri test edilir.
- Stable/preview kanalları, kullanıcı kontrolü, aktif iş varken güncelleme erteleme; L01 veri migration ve geri dönüş uyumluluğu. Yeni DB şemasına eski binary'yi sessiz rollback yapma; gerekirse yedek/veri uyumluluğuyla kurtarma.
- GitHub deposu/hesap/sertifika/yayın hedefi eksikse yerel workflow ve artifact hazırlandıktan sonra tam eksik değer listesi verilir. Yayın yetkisi oturumda zaten varsa yeniden istenmez.

Kabul: temiz build artifact'ları CI/yerelde doğrulanmış; gerçek hedefte install/upgrade/uninstall; bozuk/yanlış imzalı update uygulanmıyor; aktif iş ve kullanıcı verisi korunuyor. Dış yayın ayrı somut son adımdır.

**R03 — Beta ve kararlı sürüm kapıları**

Ön koşul: hedef kapsamın P05/Q/R işleri. Her release için `docs/releases/<version>-checklist.md` oluştur.

| Kontrol | Çıkış koşulu |
|---|---|
| Özellik doğruluğu | README/UI desteklenen ve deneysel özellikleri ayırır |
| Platform | Yayımlanan her OS/mimari için gerçek cihaz/temiz kurulum kanıtı |
| Temel kullanım | Video/ses/fotoğraf açma, altyazı, ayar, tekrar açma, dosya ilişkileri |
| Veri | Orijinal hash korunumu, migration yedeği/kurtarma, path/isim çakışması |
| AI | Manifest/hash, gerçek inference, iptal, doğru çıktı/metadata, model kaldırma davranışı |
| Video AI varsa | V06 geçer; geçmezse özelliği kapalı/deneysel tut ve açık sınır yaz |
| Testler | İlgili suite'ler geçer; ortam skip'leri ve manuel kanıtlar ayrı |
| Güvenlik | Bilinen yayıma engel veri kaybı/yetki sorunu yok; dependency bulguları ele alınmış |
| Lisans/dağıtım | Notices/SBOM/kaynak/build bilgisi, checksum, mevcut imzalama durumu |
| Kullanılabilirlik | Klavye/ölçek/dil temel akışları; crash/boş ekran gibi kritik sorun yok |

Bir platformun hazır olmaması doğrulanmış diğer platform için açıkça etiketli alfa çıkarmayı engellemez; “üç platform kararlı” sürümü için üçünün de kanıtı gerekir. Mağaza yayınları ek sandbox/paket koşulları doğrulanınca ayrı teslim edilir.

**R04 — Kullanıcı geri bildirimi, bakım ve sürdürülebilirlik**

Ön koşul: yerel alfa kullanılabilir. Bu kartın görüşme/hesap kısmı ürün sahibinin katılımı gerektirir; Claude araştırma materyali ve kod ölçüm araçlarını hazırlar, insan sonuçları uydurmaz.

- 10–15 aile arşivi sahibi/eski kamera kullanıcısı/dijitalleştirme hizmeti için görüşme formu: bugün hangi problem, hangi format/donanım, hangi sonuçtan rahatsız, ne sıklıkla kullanır. İlk 5 kullanıcı görev testi Q03 ile ortak.
- Başarı ölçüleri: ilk başarılı sonuca süre, tamamlanma/hata oranı, aynı kullanıcıda tekrar kullanım isteği, veri kaybı sıfır hedefi, destek talebi türü. Ölçüm varsayılan telemetry gerektirmez; rızalı araştırma ve anonim yerel rapor yeterli.
- Bakım: issue etiketleri, doğrulanabilir bug şablonu, küçük katkı görevleri, sürüm notları, model/codec güncelleme takvimi ve güvenlik yanıt sorumlusu. İş sahipleri bilinmiyorsa belgeye atanacak rol yaz, kişi uydurma.
- Bütçe taslağı: imza/mağaza hesapları, CI/donanım, model indirme bant genişliği, destek zamanı. Fiyatlar satın alma aşamasında doğrulanır; gelir garantisi verilmez.
- Gelir denemeleri: bağış/sponsorluk, kurumsal destek/kurulum, isteğe bağlı işlem hizmeti. Yerel çekirdek ücretsiz kalabilir. Bulut eklenecekse maliyet, silme politikası, açık kullanıcı aktarımı ve hesap güvenliği ayrı tasarım ister.

Kabul: `docs/product/validation-plan.md` ve bakım/bütçe taslağı; gerçekleşen görüşmelerin anonim bulguları, gerçekleşmeyenler için açık durum. Sonraki faz sırası gerçek talep ve kalite sonuçlarıyla güncellenir.
