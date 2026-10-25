VHO — proje, rekabet ve ürün geliştirme analizi

İnceleme tarihi: 24 Ekim 2026. Ana dal: `a2092b9`. Bu belge öneridir; mevcut yol haritasındaki kararları kendiliğinden değiştirmez.

VHO için önerilen yön: kişisel müzik, fotoğraf ve video arşivini açmayı, bulmayı ve eski kayıtları aslına sadık biçimde iyileştirmeyi kolaylaştıran, önce yerelde çalışan açık kaynak medya uygulaması. Başlangıçta eski dijital kamera/telefon fotoğrafları ve aile videolarına odaklanmak, bütün medya yazılımlarının özelliklerini aynı anda tamamlamaktan daha uygulanabilir bir ürün stratejisidir. Bu konumlandırmanın talebi kullanıcı görüşmeleriyle doğrulanmalıdır.

İnceleme; ana kaynak ağacı, oynatma ve fotoğraf/AI akışları, Rust arka ucu, paketleme ayarları, testler, lisans/derleme belgeleri, yol haritaları ve Git dal/worktree durumunu kapsar. Her satırın güvenlik denetimi veya bütün işletim sistemlerinde çalışma sertifikasyonu değildir. Rakiplerin güncel resmi açıklamaları araştırıldı; ürünleri aynı medya üzerinde çalıştırıp görüntü kalitesi sıralaması yapılmadı. Özel medya dosyaları çevrimiçi bir hizmete gönderilmedi.

**Mevcut durum ve kanıtlar**

| Alan | Gözlem | Ürün açısından anlamı |
|---|---|---|
| Temel mimari | Tauri 2 + Rust, vanilla JS ES modülleri, motor cephesi, libmpv ve HTML5 yedeği | Mevcut mimariyi koruyup geliştirmek mümkün; sırf çok platform hedefi için yeniden yazım gerekmiyor. |
| Video | Kanal/altyazı seçimi, gecikme, EQ, bölüm, yer imi, görüntü kontrolleri mevcut | Oynatıcı için anlamlı bir temel var. |
| Platform | `src-tauri/src/engine/mod.rs:44` içindeki `locate`, Windows dışını reddediyor; `window.rs:205` diğer platformlarda uygulanmamış hata döndürüyor | Tauri kullanılması, libmpv entegrasyonunun bütün sistemlerde çalıştığını göstermiyor. macOS/Linux HTML5 yedeği aynı codec ve davranış garantisini vermez. |
| Fotoğraf stüdyosu | Klasör tarama, sanal ızgara, EXIF, küçük resimler, karşılaştırma, kırpma, toplu işlemler mevcut | Basit bir oynatıcı prototipinden daha ileride. |
| Fotoğraf AI | `src/media/ai-engine.js`: DAT-2 tabanlı 4xRealWebPhoto; isteğe bağlı GFPGAN + YuNet, Web Worker, WebGPU/WASM ve küçük parçalara bölme | Gerçek sinir ağı çıkarımına dayalı bir başlangıç var. Bu incelemede sonuç kalitesi yeniden ölçülmedi. |
| Video AI | `src/media/visual-filters.js:93`: libmpv yolunda kontrast/doygunluk değişimi; HTML5 yolunda WebGL görüntü filtreleri | Fotoğraftaki sinir ağı restorasyonu ile eşdeğer değil. Sinir ağıyla video restorasyonu ve kalıcı AI video dışa aktarma hattı ana dalda görülmedi. |
| Müzik | Ses oynatma/EQ mevcut. `src/core/library.js` son 20 dosya ve en çok 500 devam konumu tutuyor | Bu, albüm/sanatçı/etiket aramalı kalıcı müzik kütüphanesi değil. SQLite kütüphane Plan 05'te. |
| RAW | `src-tauri/src/photo/raw.rs:1`: gömülü JPEG önizleme çıkarma | RAW açma ile sensör verisinden tam RAW geliştirme farklı yetenekler olarak anlatılmalı. |
| Akıllı düzenleme | LaMa, BiRefNet, DDColor Plan 07'de tanımlı | Plan ve önceki deney notları, ana uygulamada tamamlanmış özellik sayılmamalı. |
| Ayrı dal | `wave25/d1-eylemler`, `9ca04e3`; ana dalda olmayan 7 commit | Kesme/dönüştürme, OCR, dosya eylemleri, etiketler ve sözler için çalışma var. Yeniden yazılmadan önce bu dal değerlendirilip entegrasyon testi yapılmalı. |
| Yayın | MIT lisansı, üçüncü taraf bildirimleri, Windows LGPL mpv/FFmpeg derleme kanıtları mevcut. `.github` CI dosyaları ve bağımsız CONTRIBUTING/SECURITY/CHANGELOG dosyaları izlenen ana ağaçta yok | Açık kaynak yayın için iyi hazırlıklar var; sürdürülebilir sürüm ve katkı altyapısı tamamlanmalı. README içinde kısa katkı yönergesi zaten var. |

Çalıştırılan kontroller: `npm test`: 111 geçti, 0 başarısız. `cargo test --release --lib --offline`: 37 geçti, 1 başarısız, 2 atlandı. Başarısız test `photo_avif_encode_then_os_decode`; AV1 uzantısı raporlanmasına rağmen Windows WIC başlatılamıyor (`0x88982F8B`). Bu, bu ortamda gözlenen codec/başlatma sorunudur; tüm Windows makinelerinde AVIF'in bozuk olduğu sonucu çıkarılamaz. Yeni E2E, gerçek AI kalite testi, kurulum paketi testi ve macOS/Linux/mobil testleri yapılmadı.

**Öncelikli teknik eksikler**

1. Platform desteği: macOS ve Linux video yüzeyi, dinamik kütüphane bulma ve paketleme tamamlanmalı. Linux'ta Wayland/X11 ve farklı dağıtım kütüphaneleri ayrı test edilmeli. Mevcut macOS/Linux derleme tarifleri çalıştırılmamış olarak işaretli. Android/iOS için yaşam döngüsü, dosya erişimi, arka planda ses, dokunmatik arayüz ve platform eklentileri ayrı iş paketleri olmalı.
2. Doğru özellik adları: gerçek zamanlı görüntü filtresi, fotoğraf AI restorasyonu ve gelecekteki AI video dışa aktarımı ayrılmalı. README'deki 10 ms açılış ve kaliteden ödün vermeden %200 ses gibi kesin ifadeler ölçümle desteklenmeli veya düzeltilmeli. Açılış ölçümü bütün süreç ağacını ve soğuk/sıcak başlangıcı kapsamalı.
3. Fotoğraf çıktısı: AI yolu Canvas üzerinden PNG kaydediyor; EXIF/ICC koruması fotoğraf stüdyosundaki Rust kaydetme hattıyla birleştirilmeli. Stüdyo tarafında mevcut metadata koruma desteği var; eksik, AI yolunun bu yeteneği kullanmaması. Görsel alpha kanalı `ai-worker.js:135` içinde 255 yapılıyor; şeffaf görsellerin iyileştirilmesinde ayrı alpha işleme gerekir. 8 bit Canvas yolu profesyonel 16 bit/HDR iş akışı olarak sunulmamalı.
4. Büyük fotoğraflar: `photo-ai.js:10–17`, çıktıyı yaklaşık 40 megapiksele sınırlamak için büyük girdileri önce küçültüyor. Dolayısıyla düğmedeki 4x her zaman orijinalin her kenarının dört katı değil. Kullanıcıya gerçek giriş/çıkış boyutu gösterilmeli; 1x temizleme, 2x ve 4x seçenekleri değerlendirilmeli. Sabit piksel sınırı yerine donanıma göre bellek bütçesi ve gerektiğinde diske akış planlanmalı.
5. Yüz sadakati: çağrıdaki `strength: 1` ayarlanabilir olmalı. Yüz restorasyonu kapalı/korumacı varsayılanla, bölgesel önizleme ve kişi bazında reddetme seçeneğiyle sunulmalı. Bir modelin daha keskin yüz üretmesi aynı kişiyi daha doğru yansıttığı anlamına gelmez.
6. Model yönetimi: ilk indirmede SHA-256 doğrulaması iyi. Ancak `ai.rs:120` ve `:178` önceden mevcut dosyaları yalnızca boyuttan kabul ediyor. Bozulma onarımı, yeniden doğrulama, indirme iptali, bağlantı zaman aşımı, aynı bileşenin eşzamanlı indirilmesini önleyen kilit ve sürüm kaydı eklenmeli. Mevcut çıkarım iptali, Rust indirmesini iptal etmiyor.
7. Kalıcı işler: uzun video ve toplu AI işlemleri için veritabanında kuyruk, duraklat/devam et, çökmeden sonra sürdürme, disk alanı kontrolü ve atomik çıktı gerekir. Oynatma ile AI işleri kaynak bütçesini paylaşmalı; AI açıkken video takılmamalı.
8. Test kapsamı: mevcut AI testleri düğmeler, işçi yüklenmesi, boyut hesabı ve ONNX yama mantığını kapsıyor. Bunlar gerçek model çıktısının kalitesini ve bütün donanımlarda çalışmasını kanıtlamaz. Küçük bir gerçek çıkarım testi ile ayrı bir görsel kalite veri kümesi gerekir.
9. Çevrimdışı deneyim: `src/index.html:8–10` Google Fonts kullanıyor. Tam çevrimdışı/gizlilik iddiası için fontlar yerelleştirilmeli; harita ve ağ hizmetleri kullanıcı isteğiyle açılmalı. Yerel çıkarım ile uygulamanın hiç ağ bağlantısı kurmaması farklı özelliklerdir.
10. Güvenli işleme: bozuk medya, çok büyük resimler, kötü biçimlenmiş EXIF/altyazı ve kaynak tüketimi testleri; arka uç dosya yolu/çıktı doğrulaması; mpv komutlarının izinli işlemlerle sınırlandırılması ve üçüncü taraf güncelleme planı yayın öncesinde gözden geçirilmeli. Bu başlıklar doğrulanmış bir istismar iddiası değildir.

**Rakipler ve fırsat**

| Rakip | Doğrulanan güçlü alan | VHO için çıkarım |
|---|---|---|
| [VLC](https://github.com/videolan/vlc) | Açık kaynak, geniş medya/codec ve masaüstü/mobil platform desteği | Format kapsamı ve kararlılıkta güçlü referans. Bunları tek başına farklılaşma saymamak gerekir. |
| [mpv](https://mpv.io/) ve [IINA](https://iina.io/) | mpv görüntü çıkışı ve gömülebilir motor; IINA macOS'a uygun arayüz ve eklentiler | Aynı motoru kullanmak görüntü üstünlüğü sağlamaz; arşiv ve iyileştirme iş akışı değer üretmeli. |
| [Topaz Video](https://docs.topazlabs.com/topaz-video/quick-start) ve [Topaz fotoğraf restorasyonu](https://app.topazlabs.com/?intentName=photo-restoration) | Video büyütme/temizleme, kare üretimi, sabitleme; fotoğraf restorasyonu | Eski kamera kayıtlarını iyileştiren doğrudan ticari rakip var. Kalite rakiplerle aynı girdide ölçülmeli. |
| [AVCLabs](https://www.avclabs.com/video-enhancer-ai.html) | Yerel masaüstü video iyileştirme, büyütme, renklendirme; fotoğraf ürünleri de var | Yerel işlem tek başına benzersiz avantaj değil. |
| [Remini](https://remini.ai/photo-restorer) | Eski fotoğraf ve yüz odaklı kolay restorasyon | Az adımlı deneyim için karşılaştırma; yüz sadakati ayrıca değerlendirilir. |
| [DaVinci Resolve Studio](https://www.blackmagicdesign.com/products/davinciresolve/studio) | Zamansal/mekânsal gürültü giderme, SuperScale, renk ve restorasyon araçları | Profesyonel kalite referansı. VHO'nun ilk hedefi daha basit aile arşivi kullanımı olabilir. |
| [Upscayl](https://github.com/upscayl/upscayl) | Açık kaynak fotoğraf büyütme, Windows/macOS/Linux, toplu işlem; Vulkan GPU gereksinimi | Ücretsiz/açık kaynak büyütme de mevcut. Video, sadakat ve arşiv bütünlüğü ek değer sağlamalı. |
| [digiKam](https://www.digikam.org/about/) | Açık kaynak fotoğraf/video yönetimi, RAW, metadata, yerel AI | Fotoğraf arşivi, gizlilik ve açık kaynak birlikteliği de yeni değil. |
| [Immich](https://docs.immich.app/features/searching/) | Fotoğraf/video koleksiyonunda anlamsal arama, metadata filtreleri ve OCR araması | Doğal dille arama güçlü bir özellik; tek başına benzersiz ürün vaadi olmaz. |

Tablo üreticilerin belgelerindeki yetenekleri karşılaştırır. Hiçbir ürünün her dosyada daha iyi sonuç verdiği veya VHO'nun bunlardan üstün olduğu doğrulanmadı. Fiyatlar ve pazarlama çözünürlüğü iddiaları kalite ölçütü olarak kullanılmadı.

**Eski kayıtları iyileştirmek için önerilen yaklaşım**

Kayıtta bulunmayan ayrıntı kesin biçimde geri getirilemez. AI bazı ayrıntıları tahmin eder. Özellikle çok küçük yüz, yazı, arma ve tarih damgalarında görünüşün iyileşmesi gerçeğe uygunluğun artması anlamına gelmeyebilir. Renklendirme de tarihsel renkleri garanti etmez.

Üründe iki anlaşılır tercih öneriyorum: “Aslına sadık” ve “Yaratıcı iyileştirme”. İlkinde düşük müdahale, yüz/yazı koruma, renk ve doğal doku korunumu; ikincisinde daha güçlü yeniden oluşturma ve bunun açık etiketi. Her iki durumda da orijinal saklanmalı, sonuç ayrı dosya olmalı, kullanılan model/sürüm/ayarlar bir işlem kaydında tutulmalı.

Fotoğraf türleri ayrı ele alınmalı: taranmış baskıda toz/çizik/solma; eski dijital kamerada JPEG blokları, renk gürültüsü ve düşük çözünürlük; kötü taramada geometri ve beyaz dengesi; hareketli çekimde bulanıklık. Tek bir 4x modeli tüm bozulmalar için varsayılan yapmak yerine küçük örnekte birkaç aday profil önizlenmeli. Gerçek RAW verisi varsa, gömülü JPEG yerine uygun RAW geliştirme hattını kullanmak potansiyel olarak daha fazla veri korur.

Video için önerilen işlem sırası: kaynağı incele → gerekli ise alan sırasını koruyarak deinterlace → gürültü/sıkıştırma temizliği → komşu karelerden yararlanan iyileştirme → ölçülü ölçekleme/keskinleştirme → renk/ayrıntı kontrolü → sesi ve zaman damgalarını koruyarak dışa aktar. Kaynağın durumuna göre sıralama ve kullanılan adımlar değişebilir. VHS/Hi8 gibi fiziksel kaynaklarda iyi sayısallaştırma, doğru alan sırası ve en-boy oranı AI'dan önce gelir. [FFmpeg'in idet/bwdif belgeleri](https://ffmpeg.org/ffmpeg-filters.html#bwdif) bu temel işlemleri açıklar; seçilecek filtrenin dağıtılan LGPL derlemesinde mevcut ve lisans politikasına uygun olduğu ayrıca doğrulanmalı.

Kareleri birbirinden bağımsız fotoğraf gibi iyileştirmek yüz/doku titreşimi doğurabilir. [BasicVSR++](https://github.com/ckkelvinchan/BasicVSR_PlusPlus), komşu kareleri kullanan yaklaşım için araştırma adayıdır; mevcut WebGPU uygulamasına doğrudan uyumlu olduğu varsayılmamalı. Model ağırlığı, bağımlılık lisansları, operatör desteği ve hedef donanımdaki hız ayrıca doğrulanır. Mevcut [4xRealWebPhoto](https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2), [GFPGAN](https://github.com/TencentARC/GFPGAN) ve [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) fotoğraf karşılaştırmalarında başlangıç adayları olabilir; model sayısından önce hedef medyadaki kalite önemlidir.

Uzun işlem öncesinde 5–10 saniyelik video kesiti veya fotoğraf bölgesi önizlemesi, tahmini süre/disk boyutu ve karşılaştırma sunulmalı. Örneğin 30 fps bir dakikalık videoda 1.800 kare vardır; iyileştirme saniyede 1 kare işliyorsa yalnızca çıkarım yaklaşık 30 dakika sürer. Bu bir performans ölçümü değil, kullanıcıya bekleme süresini anlatan örnek hesaptır. Gerçek zamanlı oynatma ile yüksek kaliteli dışa aktarım ayrı performans hedefleri olmalı.

**En iyi olmayı ölçülebilir hale getirme**

Önce izinli/kamu malı 100 kadar fotoğraf ve 20 kısa video seç: 3GP, MiniDV, eski JPEG, düşük ışık, küçük yüzler, yazılar, hızlı hareket, çizik taramalar. Gerçek eski kaynakları ve bilinen temiz görüntülerin kontrollü bozulmuş sürümlerini ayrı gruplarda tut. İyileştirilmiş görselleri aynı çıktı boyutunda ve aynı yakınlaştırmada göster; video için tek kare değil hareketli sonuç izle.

Karşılaştırmalar: orijinal, basit yüksek kaliteli ölçekleme, mevcut VHO modeli, en az bir açık kaynak alternatif ve erişilebilen ticari referans. Kullanıcıya yazılım adını göstermeden doğallık, kimlik/yazı sadakati, ayrıntı ve genel tercih sor. Referans temiz görüntü olan örneklerde PSNR/SSIM gibi ölçüler yardımcı olabilir; üretken restorasyonda tek başına yeterli değildir. Videoda kareler arası tutarlılık, ses senkronu ve sahne geçişleri ayrıca değerlendirilir.

Her sonuçta cihaz/OS/GPU, model sürümü, ayarlar, süre, en yüksek RAM/VRAM ve çıktı boyutu kaydedilmeli. “En iyi” iddiası yerine “şu test grubunda, şu cihazda, şu ölçütte” şeklinde yayınlanabilir kanıt üretilmeli. Önce bir dar kategoride üstünlük hedeflenmeli.

**Mimari ve ürün kapsamı**

Mevcut Tauri/Rust çekirdeğini koru. Arayüz, kütüphane, oynatma motoru, medya işlem işçisi, AI model yöneticisi ve platform adaptörleri arasında açık sözleşmeler kullan. Ağır video AI için ayrı yerel işlemci süreç; kuyruk/iptal/yeniden başlatma ve oyuncudan bağımsız hata yönetimi önerilir. Mevcut Web Worker fotoğraf yolu korunabilir; yerel ONNX Runtime yolu ancak aynı modelle ölçülmüş uyumluluk/performans ihtiyacı varsa eklenmeli.

[Tauri](https://v2.tauri.app/reference/webview-versions/) farklı sistemlerde farklı WebView'lar kullanır. [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) GPU sağlayıcılarında operatör desteğinin sınırlı olabileceğini belgeler. Bu nedenle “WebGPU var = her model her platformda çalışır” kabulü yapılmamalı. Özellik yetenek matrisi ve gerçek çalışma zamanı kontrolü gerekir.

İlk masaüstü sürümünde video/fotoğraf/müzik için ayrı sade görünümler; ayrıntıları menü ve Ayarlar içinde tut. Müzikte sanatçı/albüm/kapak, kayıtlı listeler, M3U, boşluksuz oynatma, ReplayGain ve sistem medya tuşları ilk değerli işlerdir. AI tarafında öncelik arşiv araması ve konuşma dökümü olabilir. Genel sohbet botu, ses klonlama, kapsamlı müzik üretimi, tam kurgu programı, her TV protokolü ve sosyal ağ ilk sürümü geciktirmemeli.

Platform sırası önerisi: Windows güvenilir alfa → macOS ve Linux beta → Android/iOS oynatma ve arşiv istemcisi → ihtiyaç varsa TV/web. Bu sıralama toplam hedefi daraltmaz; yayın kalitesini aşamalara ayırır. Mobilde ağır restorasyon opsiyonel masaüstü işlemcisine devredilebilir; aktarım kullanıcı denetiminde olmalı. Desteklenen OS sürümleri ve CPU mimarileri test edilmiş bir tabloyla yayınlanmalı.

**Açık kaynak yayın ve sürdürülebilirlik**

Mevcut MIT lisansını korumak makul. Daha sonra lisans değiştirmek düşünülürse katkı sahiplerinin hakları ve üçüncü taraf bileşenler ayrıca değerlendirilir. Uygulama lisansı, model ağırlığı lisansı, kod bağımlılıkları ve eğitim verisi koşulları ayrı envanterlerdir. [FFmpeg](https://www.ffmpeg.org/legal.html) yapılandırmaya göre LGPL/GPL farkını; [mpv](https://github.com/mpv-player/mpv/blob/master/Copyright) kendi koşullarını açıklar. Sadece dinamik bağlama veya sadece upstream bağlantısı vermek bütün yükümlülüklerin karşılandığının kanıtı değildir; dağıtılan binary ile eşleşen kaynak/derleme bilgisi ve ilgili lisans koşulları hazırlanmalı. Linux tarifindeki “sistem GPL kütüphanesi fallback her durumda uygundur” varsayımı yayın öncesinde ayrıca incelenmeli.

[CodeFormer S-Lab lisansı](https://github.com/sczhou/CodeFormer/blob/master/LICENSE) ticari olmayan kullanımla sınırlıdır; bu nedenle mevcut herkese/ticari kullanıma açık lisans politikasına varsayılan bağımlılık olarak uygun sayılmamalı. Upscayl gibi başka bir açık kaynak uygulamadan kod kopyalamak da o uygulamanın lisansını otomatik olarak MIT'ye dönüştürmez. Kütüphane veya modeli kendi uygun lisansı üzerinden entegre etmek gerekir.

Yayın öncesinde İngilizce ve Türkçe README; gerçek özellik/platform tablosu; CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG; issue/PR şablonları; geliştirici kurulumu; mimari ve model kartları hazırlanmalı. Node/Rust sürümleri sabitlenmeli. CI'da üç masaüstü sistemi, birim/entegrasyon kontrolleri, bağımlılık ve lisans kontrolleri; gerçek donanımda medya testleri ayrı tutulmalı. Kurulum paketleri mpv/FFmpeg kaynaklarını gerçekten içermeli; temiz makinede kurulum, yükseltme ve kaldırma denenmeli. İmzalama, macOS notarization, doğrulanmış güncelleme ve SHA-256 dağıtım özetleri planlanmalı.

Kullanıcının özel fotoğrafları, modeller ve büyük binary'ler Git geçmişine eklenmemeli. Yayından önce geçmişte sır/özel dosya taraması yapılmalı; bu inceleme böyle bir geçmiş denetimi yapmadı. Katkı verenler için küçük görevler, başlangıç örnekleri, düzenli sürüm notları ve karar gerekçeleri bakım yükünü azaltır. Model indirme bant genişliği, imzalama, test donanımı ve destek maliyetleri bütçelenmeli.

Gelir seçenekleri: bağış/sponsorluk, ücretli kurumsal destek ve arşiv kurulumu, isteğe bağlı barındırılan işlem hizmeti. Yerel temel işlevler ücretsiz kalabilir. Bulut hizmeti ilk sürüm için zorunlu değildir; işlem maliyeti, saklama/silme ve kullanıcı rızası ayrıca tasarlanmalıdır. Bunlar gelir garantisi değil, test edilecek sürdürülebilirlik seçenekleridir.

**Önerilen uygulama sırası ve çıkış ölçütleri**

| Sıra | İş | Bitirme ölçütü |
|---|---|---|
| 1 | Ana dal/eylemler dalı envanteri, README düzeltme, AVIF sorununun teşhisi | Hangi özelliğin nerede olduğu belli; mevcut test hatası açıklanmış/giderilmiş; iddialar kodla uyumlu. |
| 2 | Windows paketleme ve macOS/Linux motor denemesi | Temiz makinede kurulum, dosya açma, ses/altyazı, pencere/tam ekran çalışıyor; destek sınırları belgeli. |
| 3 | Fotoğraf restorasyonu ilk güvenilir sürüm | Ayrı çıktı, metadata/alpha politikası, ölçülü yüz restorasyonu, karşılaştırma, gerçek model testleri. |
| 4 | Eski video için kısa klip restorasyonu | 5–10 saniye önizleme, tutarlı hareket, doğru alan sırası/renk/ses, kuyruk ve iptal. |
| 5 | Kütüphane ve müzik deneyimi | Artımlı tarama, arama, albümler/listeler, dosya taşıma/yeniden adlandırma tutarlılığı. |
| 6 | Açık beta/topluluk | İndirilebilir sürümler, kaynak ve lisans paketi, katkı belgeleri, kullanıcı geri bildirimi ve yayınlanan karşılaştırmalar. |
| 7 | Mobil ve ileri AI | Masaüstü çekirdek kararlı; gerçek kullanıcı talebi ve donanım sınırlarına göre kapsam belirli. |

Takvim, ekip büyüklüğü ve haftalık kapasite bilinmeden taahhüt edilmemeli. İlk 90 gün için makul odak; yayın altyapısı, masaüstü taşınabilirlik denemesi ve bir dar restorasyon iş akışının kullanıcılarla doğrulanmasıdır. Tüm platformlar, gelişmiş müzik yönetimi ve ticari rakiplerden üstün video AI'ın aynı dönemde biteceği varsayılmamalı.

İlk kullanıcı araştırması önerisi: 10–15 aile arşivi sahibi, eski kamera kullanıcısı veya dijitalleştirme hizmetiyle görüş; en acil problemi ve kullandıkları dosyaları öğren. 5 kişiye aynı üç görevi yardımsız yaptır: arşiv aç, bir fotoğrafı iyileştir, kısa videoyu karşılaştırıp kaydet. İlk başarılı sonuca kadar süre, hatalı sonuç oranı, tekrar kullanım ve cihaz başına başarısızlık ölçülmeli. Bunlar özel dosya toplamadan ve açık rızalı araştırmayla yapılabilir.
