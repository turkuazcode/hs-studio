# Claude Windows alfa çıktısının bağımsız kontrolü

Tarih: 28 Ekim 2026. İncelenen dal `wave5/windows-alfa`, HEAD `46e8d73`; uygulama değişiklikleri `05775b1`, önceki taban `c09a661`. Bu kontrol uygulama kodunu değiştirmedi, dal birleştirmedi veya yayın yapmadı.

## Sonuç

Claude'un “Windows alfa henüz hazır değil” sonucu doğru. Bildirdiği geliştirmeler ve test sayıları büyük ölçüde kod/kayıtlarla örtüşüyor. Ancak paketleme için yerel native dosyaların bulunmadığı sonucu yanlış; yayın kapısı/paket doğrulaması da tamamen bitmiş sayılmamalı. FFV1 donması bağımsız olarak yeniden üretildi.

## Doğrulananlar

- Dal ve iki commit mevcut; `main`e birleştirilmemiş.
- Kayıtlı tam test sonuçları `05775b1` için: unit 246; Rust 242 + 6 ignored; E2E 288, todo 0; AI 23 + 3 skip; quality 7 başarılı + 1 başarısız. Bunlar bu kontrol sırasında tam katman olarak yeniden çalıştırılmadı.
- Kalite hatası kaydı: `p10-alpha|vho-x4`, PSNR 32.8922, baseline 36.9519, tolerans ±0.3. Eski deneysel AI yolu; yeni klasik fotoğraf zincirinin başarısızlığı olarak sunulmamalı. Kayıtlı farkı sırf yeşil sonuç için değiştirmemesi doğru.
- HLS kodunda `reconnect_streamed` değişikliği, aynalı video ve altyazı uyumluluğu düzeltmeleri, video arayüzü yarış/önizleme kontrolleri mevcut.
- V03 plan kimliği düzeltildi. Yeni yayın kapısı önceki olumsuz sonuçların önemli kısmını reddediyor ve gerçek insan kontrollerini ayrı tutuyor.
- İmza doğrulama testleri gerçek Tauri signer ile geçici anahtar üretiyor; bu, SignPath hizmetinin veya uzak release workflow'unun çalıştırıldığı anlamına gelmiyor.

### Bu kontrolde yeniden çalıştırılanlar

| Kontrol | Sonuç |
|---|---|
| release-gate + video-enhance + updater-signature birim dosyaları | 21 geçti, skip/todo yok |
| network + video-enhance E2E dosyaları | 22 geçti, skip/todo yok |
| Yerel native dosyalar / lisans envanteri SHA-256 karşılaştırması | 40/40 eşleşti; eksik ve farklı dosya yok |
| FFV1 320×240, 25 fps, 3 saniye, yuv420p MKV açma | Başlangıç dosyası olarak açılınca arayüz CDP/JS yanıtları zaman aşımına uğradı |

E2E normal Windows oturumunda, izole geçici profillerle yapıldı. FFV1 dosyası FFmpeg ile üretildi, kişisel medya kullanılmadı. Yalnız testin başlattığı uygulama kapatıldı.

Yerel ignored loglar: `tests/.results/audit-wave5-unit.log`, `audit-wave5-e2e.log`, `audit-wave5-ffv1-detail.log`. FFV1 fixture: `tests/.results/audit-wave5-media/ffv1-8bit.mkv`.

## Düzeltilmesi / netleştirilmesi gereken sonuçlar

### 1. FFV1 donması gerçek ve öncelikli

`launchApp({args:[fixture]})` ile açıldıktan sonra süre bilgisi alınamadı; `Runtime.evaluate`, arayüz heartbeat ve motor durum çağrıları zaman aşımına uğradı. Boş uygulama açılışı çalıştı. Sürükle-bırak denemesinde ise oynatma başlamadı; başlangıç dosyası denemesi arayüz yanıtının da kaybolduğunu gösterdi.

Bu kanıt test edilen 8 bit SDR örneği içindir; “bütün FFV1 dosyaları” evrensel iddiasını tek fixture ile doğrulamıyoruz. Yine de basit bir medya dosyasının arayüzü yanıtsız bırakması yayın engeli sayılmalı.

Claude'a görev: sorunu oynatıcı yükleme, metadata/thumbnail ve UI/native çağrı yollarında ayır; uygulamanın yanıt vermesini koru. FFV1 başlangıç dosyası ve sonradan açma için regresyon testi ekle. Düzeltme kısa sürede mümkün değilse, dosya motoru kilitlemeden önce anlaşılır bir desteklenmiyor hatasıyla reddedilsin. Sadece sürüm notuna yazmak yeterli çözüm değil.

### 2. Paketleme için gerekli yerel dosyalar mevcut

`legal/inventory/native-windows-x64.json` içindeki 40 dosyanın tamamı şu iki yerde bulundu ve SHA-256'ları envanterle birebir eşleşti:

- `src-tauri/target/release`
- `src-tauri/target/package-staging/mpv`

Eksik olan varsayılan `third_party/mpv/_build/dist` klasörü. Paket betiği `-MpvDist` ve `-MpvBin` parametrelerini destekliyor. Dolayısıyla “bu dosyalar için önce CI/GitHub gerekir” gerçek bir bağımlılık değil.

Claude'a görev: envanterdeki dosyaları çalışma alanında ayrı bir native kaynak klasörüne kopyala, SHA-256 eşleşmesini tekrar doğrula, paketlemeye bu klasörü `-MpvDist` ve `-MpvBin` olarak ver. `package-staging` klasörünü doğrudan kaynak verme: betik staging'i yeniden oluştururken siliyor. Derleme çıktısını da aynı anda kaynak/hedef olarak kullanmamak için ayrı klasör kullan.

Bu kontrol paket üretiminin kesin başarılı olacağını iddia etmez; NSIS araçları veya başka bağımlılıklar ayrıca engel olabilir. Gerçek yayın URL'si ve temiz VM doğrulaması da ayrı işlerdir.

### 3. Yayın kapısında ve paket betiğinde kalan doğrulama boşlukları

**Gerçek artifact okunmuyor.** `scripts/release-gate.mjs` içindeki `checkArtifact()` manifest alanlarını karşılaştırıyor; CLI da manifesti okuyor fakat kurulum dosyasını bulup hash'ini yeniden hesaplamıyor. Doğru görünümlü test/insan kanıtlarıyla, `installer: does-not-exist.exe` içeren sentetik manifest kapıdan `met=true` geçti. Bu örnek gerçek bir yayın onayı değil, eksik doğrulamanın tekrarıdır.

Görev: CLI seviyesinde artifact dosyasının varlığını ve gerçek SHA-256'sını manifestle karşılaştır. Eksik veya sonradan değişmiş dosya reddedilsin. İmzasız çıktılar `-UNSIGNED` adıyla yeniden adlandırıldığında manifestteki dosya adı ve ilgili checksum dosyaları da güncellensin; şu an toplama adımı yalnız fiziksel adı değiştiriyor.

**Bundle aşamasında native envanter yeniden kontrol edilmiyor.** `scripts/package-windows.ps1` başlangıçta `$mismatch=@()` yapıyor. `-Phase bundle` dalı yalnız staging içinde libmpv'nin varlığını kontrol edip native dosya hash döngüsünü atlıyor; son manifest `nativeHashesMatchInventory = (-not $mismatch)` ile true yazıyor. Build/bundle arasında değişmiş staging içeriği böylece envanterle eşleşiyormuş gibi raporlanabilir.

Görev: bundle öncesinde son paketlenecek native dosyaları tekrar doğrula; farklı/eksik dosyayla release paketi üretme. Normal akışta şu an uyumsuzluk gözlenmedi; bu doğrulama mantığı boşluğudur.

**Rust kısmi koşu sınıflaması eksik.** `scripts/run-rust-tests.mjs` filtresi yalnız `-` ile başlamayan argümanları sayıyor. `-- --skip=restoration` tüm argümanları tireyle başladığı için `filters=[]` kalıyor. Başarılı sonuç satırı varsa kısmi koşu `full:true` kaydedilebilir. Parser da libtest'in `filtered out` sayısını kaydetmiyor.

Görev: libtest filtre seçeneklerini ve `filtered out` sayısını işle; kısmi koşu kapıdan tam katman diye geçmesin. Bu bulgu kaynak/argüman mantığıyla doğrulandı; mevcut tam Rust sonucunun kısmi olduğu iddia edilmiyor.

### 4. HLS düzeltmesi mevcut yerel senaryolar için doğrulandı

İki eski HLS senaryosu yeniden çalıştırıldı ve geçti. Ancak `src-tauri/src/net.rs:is_hls_url` yalnız `.m3u8`/`.m3u` yol sonunu tanıyor. Uzantısız `/live` veya yönlendirmeyle playlist dönen adres hâlâ `reconnect_streamed=1` alabilir.

Görev: uzantısız ve yönlendirmeli playlist için yerel regresyon senaryosu ekle; gerekirse içerik/oynatıcı bilgisine göre politika uygula. Bu akışta aynı takılmanın tekrarlandığı burada ayrıca test edilmedi; mevcut kodun kapsamadığı durum olarak raporlanıyor. “Yerel HLS senaryoları düzeldi” doğru; tüm CDN/canlı yayınların doğrulandığı iddiası yapılmamalı.

## Eski deneysel fotoğraf AI için önerilen karar

Windows alfa kapsamından çıkarılması makul. Varsayılan klasik iyileştirme, nesne silme ve renklendirme korunmalı. Devre dışı bırakma seçilirse yalnız butonu gizlemek yeterli değil: E kısayolu, menü ve ilgili giriş noktaları da kapsamla uyumlu olmalı. Kalite hatası/baseline korunmalı; eski yolun ayrı deneysel test kaydı devam etmeli. Ürün kapsamı daraltılmadan yalnız başarısız teste istisna eklenmemeli.

## Önerilen sonraki sıra

1. FFV1 donmasını düzelt veya güvenli reddet; regresyon testi ekle.
2. Eski deneysel AI için alfa kapsam kararını uygula; yeni klasik ve diğer AI akışlarını koru.
3. Yukarıdaki artifact/bundle/Rust kapı boşluklarını kapat.
4. Mevcut, hash'i doğrulanmış 40 native dosyayla yerel paketlemeye devam et.
5. Son aday artifact üzerinde gerekli testler ve temiz VM/insan oturumlarını tamamla.
6. Doğrulanmış dalı birleştir; uzak yayın ve hesap/anahtar işleri mevcut kullanıcı yetkilendirmesine göre ilerlesin.

Claude'un sonda FFV1 için “şimdi mi düzeltelim?” diye durması teknik olarak gerekli değil: önceden verilen Windows alfa sağlamlaştırma kapsamının parçası. Deneysel AI'ın ürün kapsamından çıkarılması ise ürün kararı olarak açıkça kaydedilmeli.
