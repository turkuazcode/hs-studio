Plan 12 — Eski kamera videoları için gerçek AI restorasyonu

Yeni kapsam. Mevcut gerçek zamanlı WebGL/kontrast filtrelerini değiştirmekle tamamlanmış sayılmaz. Önce [11](11-ai-altyapisi-ve-fotograf.md) iş/model/çıktı altyapısı ve [06](06-medya-eylemleri.md) FFmpeg dışa aktarma temeli kullanılır. İlk ürün deneysel, yerel, çevrimdışı kısa kesit önizleme + dosyaya dışa aktarmadır; canlı oynatma sırasında gerçek zamanlı AI iddiası yoktur.

İlk hedef veri: düşük çözünürlüklü eski dijital kamera/telefon klipleri, MiniDV/SD ev videoları ve sayısallaştırılmış interlaced örnekler. Fiziksel VHS/Hi8 yakalama cihazı yönetimi bu paketin parçası değildir. Çok bozuk yüz/yazıdaki tahmini ayrıntılar orijinal gerçeklik olarak anlatılmaz.

**V01 — Kaynak inceleme ve restorasyon reçetesi**

Ön koşul: S02, P01. Alanlar: D1 `actions/ffmpeg.rs` probe yardımcısı, önerilen `src-tauri/src/restoration/{probe,recipe}.rs`, sade restorasyon diyaloğu.

- ffprobe ile video/ses/altyazı akışları, süre, timebase, CFR/VFR, SAR/DAR, rotation, field order, bit derinliği, renk primaries/transfer/matrix/range bilgileri alınır. Eksik metadata “bilinmiyor” olur; codec adı veya uzantıdan kesin sonuç çıkarılmaz.
- Alan sırası güvenilmezse kısa örnekle analiz; otomatik tespitin belirsiz olduğu durumda teknik ayrıntıda seçilebilir TFF/BFF/progressive. Kullanılacak deinterlace/temizlik filtrelerinin mevcut LGPL derlemede varlığı ve lisansı doğrulanır.
- Reçete kaynak/akış seçimi, başlangıç-bitiş zamanları, deinterlace, denoise, model sürümü, ölçek, renk dönüşümü, encoder ve ses/altyazı politikasını içerir. Kaynak ölçüleriyle birlikte hashlenir.
- İlk sürüm SDR/8-bit çıkışı açıkça tanımlar. HDR/10-bit girdi varsa doğru ton eşleme destekleniyorsa kullanıcıya bildirir, yoksa işi durdurur. Metadata'yı kopyalayıp SDR pikselleri HDR diye etiketleme.
- 144p kaynağa otomatik 4K varsayma; 1x temizleme/2x/uygun 720p-1080p hedefini ölçümlerle öner. En-boy oranı ve field-rate korunumu için çıkış ölçüsü/fps açık olsun.

Kabul/test: progressive/interlaced TFF/BFF, non-square pixels, rotation, VFR, çoklu ses, eksik renk metadata ve HDR fixture'ları doğru sınıflanır. Yanlış/boş bilgi güvenli biçimde ele alınır; bilinmeyen field order sessiz varsayımla kalıcı bozulmaya dönüşmez.

**V02 — Model ve inference fizibilitesi; zorunlu karar kapısı**

Ön koşul: A01/A03, V01, Q02 başlangıç veri kümesi. Alanlar: `experiments/video-restoration/`, `docs/adr/0003-video-restoration.md`; üretim UI'ı önce yapılmaz.

- En az üç karşılaştırma: basit iyi ölçekleme + uygun geleneksel temizlik; mevcut fotoğraf modeli kare bazlı deney; lisansı/operatörleri uygun en az bir komşu kare kullanan model adayı.
- BasicVSR++ önceki araştırmada bir adaydır, nihai seçim değildir. Kod lisansı, indirilen ağırlığın lisansı, bağımlılık grafiği, ön/son işleme ve ONNX/native export uygulanabilirliği resmi kaynaklardan güncel doğrulanır. Uygun lisans yoksa adayı dağıtma.
- Aynı klipte eşit çıktı çözünürlüğü: yüz/yazı, hızlı hareket, düşük ışık, sahne geçişi, doku ve kameranın hareketini ölç. Tek bir iyi kareyi videonun kalite kanıtı yapma.
- Web adapter ve gerekiyorsa ayrı yerel worker için fps, ilk yükleme, en yüksek bellek, bağımlılık/kurulum boyutu, temporal context ve hata davranışını kaydet. Python yalnızca geliştirme deneyi olabilir; son kullanıcıya gizli Python/PyTorch kurulumu yükleme.
- İlk denemeye ayrılan mühendislik bütçesi uygulama başlangıcında yazılır. Bütçe sonunda karar kaydı üretilir; başarısız modeli sonsuza kadar uyarlamak yerine uygun sonraki aday veya deneysel kapsam seçilir.

Karar seçenekleri: `üretim adayı`, `yalnızca güçlü donanımda deneysel`, `şimdilik uygun değil`. Üretim adayı için lisans/provenans tam, hedef cihazda sonlu bellekle biten inference, yeniden üretilebilir ön/son işleme ve Q02'de kabul edilebilir hareket/kimlik sadakati gerekir. Bunlar yoksa V03 üretim entegrasyonuna geçme; diğer masaüstü işleri devam eder. Fotogram başına yöntem kullanılacaksa sınırlama açıkça yayınlanır, zamansal tutarlılık garantisi verilmez.

**V03 — Video işlem hattı ve doğru zamanlama**

Ön koşul: V01/V02 başarılı karar, A02/A03/A04, S02. Alanlar: `restoration/{pipeline,frames,encode}.rs` veya seçilmiş worker adapter'ı; mevcut FFmpeg süreç runner'ı.

- İş sırası kaynağa göre seçilir: decode → gerekiyorsa deinterlace → ölçülmüş temizlik → model → ölçek/renk → encode → mux → doğrula → atomik final. Orijinal ses varsayılan korunur; AI görüntü için sesi sessizce yeniden işleme.
- UI büyük frame dizisini taşımaz; bounded queue/pipe ve arka basınç kullan. Bir saatlik videoyu tüm kareleriyle RAM'e veya kontrolsüz PNG dizisine açma. Disk tamponu gerekiyorsa iş kotası ve temizleme sahibi tanımlı olsun.
- Frame kimliği sadece ardışık sayı değildir: PTS + timebase + duration saklanır. VFR korunur veya kullanıcıya açık CFR dönüşümü uygulanır; süre değişimi ve ses drift'i engellenir.
- Temporal modelin ön/son context kareleri, sahne kesiminde state reset'i ve segment overlap'i tanımlanır. Overlap kareleri final çıktıda çift sayılmaz.
- Deinterlace sonrası frame-rate değişimi (ör. field-rate çıkış) açık hesaplanır. Yanlış alan sırasıyla tarak/geri-ileri hareket üretilmez. Rotation ve SAR normalize ediliyorsa DAR korunur.
- D1 encoder seçimini kullan; yalnızca encoder listesinde bulunması yerine küçük gerçek encode probe'u. Hedef format desteklemiyorsa ses/altyazı/metadata dönüşümü kullanıcıya gösterilir. Çoklu ses/altyazı kaybı sessizce olmaz; görüntü tabanlı altyazıyı metin gibi dönüştürme.
- Çıktı probe'u: stream listesi, boyut, süre, zaman damgaları, beklenen frame sayısı/toleransı; bozuksa partial final adı alamaz. Model ve tarif artifact kaydına bağlanır.

Kabul/test: 3–10 saniyelik CFR/VFR/interlaced fixtures; korunacak ses/altyazı akışları, doğru en-boy, frame sırası ve süre. Kontrollü fixture'da ek A/V kayması hedefi en fazla bir çıkış karesi; ölçüm yöntemi ve codec gecikmesi toleransı kaydedilir. Gerçek klipte baş/orta/son senkron da incelenir. Bu sayısal hedef ölçülmüş mevcut performans değildir.

**V04 — Önizleme ve dışa aktarma deneyimi**

Ön koşul: V03; A05 karşılaştırma yaklaşımı yeniden kullanılır. Alanlar: `src/ui/restoration-dialog.js`, `src/media/restoration.js` gibi önerilen modüller; engine facade, i18n.

- Video menüsü → İyileştir → kaynak/çıktı bilgisi → 5–10 saniyelik seçili aralık → önizleme → dışa aktar. Varsayılan tüm videoyu işleme başlamaz.
- Orijinal/işlenmiş karşılaştırma zaman senkronludur. Aynı görüntü boyutu/zoom ve oynatma aralığı; ikinci görüntü motoru cihazı zorlayacaksa eş zamanlı karşılaştırma yerine zaman korunarak A/B geçişi. Ekranda oynayan iki bağımsız zaman çizgisi yanlış kıyas üretmesin.
- Preview önbellek anahtarı kaynak parmak izi, aralık, model/recipe sürümü ve renk/ölçek içerir. Tarif değişince yanlış preview kullanılmaz.
- Önizlemede ölçülen steady-state hızdan süre tahmini; model hazırlama ve encode/mux maliyetleri ayrıca. Çıktı boyutu yaklaşık olarak etiketlenir. Donanım, disk ve kaynak kısıtları işlemi başlatmadan görünür.
- Oynatma, önizleme üretimi ve export ayrı durumlar; kullanıcı videoyu kapatsa bile kalıcı kuyruk işi görünür. Çıkışta aktif iş uyarısı ve kontrollü durdurma.

Kabul/test: seçim sınırları, tarif değişimi, eski preview, iptal, uygulama yeniden açılınca job görünümü ve kaydetme yolu. İleri ayarlar ana oynatma HUD'unu doldurmaz.

**V05 — Segment checkpoint, duraklatma ve çökmeden dönüş**

Ön koşul: V03, A02. Alanlar: job checkpoint store ve pipeline.

- Resume stratejisi ADR'de kesinleşir: doğrulanmış segment dosyaları veya seçilmiş encode/checkpoint mekanizması. Codec GOP, zaman damgası ve temporal model state/context'i birlikte tasarlanır.
- Checkpoint'te son tamamlanmış segment, input zaman aralığı, gerekli overlap, model/recipe sürümü ve segment hash'i. Sadece çıktı dosyası var diye tamamlandı sayma.
- Pause güvenli segment sınırında; cancel mevcut işi durdurup kendi partial'larını temizler. GPU kaybında yeniden deneme aynı segmentten kontrollü olur.
- Kaynak taşınmış/değişmiş, model sürümü yok, disk dolu, output hedefi erişilemez senaryolarında açık kurtarma. Başka işe ait dosyaya dokunma.
- Birleştirmede sınırdaki kare, ses sürekliliği ve encoder parametreleri doğrulanır. Kesintisiz referans çıktıyla eşdeğerlik kalite/zamanlama düzeyinde ölçülür; codec bitstream'inin birebir aynı olması zorunlu değildir.

Kabul/test: ortada süreç kapatma → yeniden aç → devam; pause/resume; segment bozulması; kaynak değişimi; iki işin isim çakışması. Sınırda tekrar/kayıp kare, ses boşluğu ve görüntü sıçraması yok. Geçici disk kullanımı hesaplanan sınır içinde.

**V06 — Deneysel video özelliğini yayımlama kapısı**

Ön koşul: V03–V05, Q01/Q02/Q04, hedef platform P05.

- En az 20 kısa kliplik kategorili değerlendirme; mümkünse farklı desteklenen GPU aileleri ve CPU fallback. Çalıştırılamayan kombinasyonlar açıkça listelenir.
- Her profil için kalite, flicker/ghosting, yüz/yazı değişimi, ses senkronu, işleme süresi, bellek ve disk raporu. Reklam demosu ile test kümesi ayrı tutulur.
- Düşük donanımda mümkün değilse kullanıcıya desteklenmeyen profil bildirimi; “her cihazda gerçek zamanlı” iddiası yok.
- Kaynak/çıktı/recipe ve model atıflı örnekler yalnızca paylaşılabilir medya ile hazırlanır. Sonuç başarısızsa otomatik iyi sayılan skor yerine kullanıcıya orijinal seçeneği korunur.

Kabul: `docs/benchmarks/video-restoration.md` ve destek matrisi var; seçilen profilin tüm doğruluk/iptal/kurtarma testleri geçiyor. Kullanıcı etiketinde deneysel durum ve destek sınırları görünür. Topaz veya başka üründen üstünlük yalnızca aynı veri/koşullarda ölçülmüş spesifik sonuç için söylenir.
