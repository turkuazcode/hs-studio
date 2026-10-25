Plan 13 — Mevcut kütüphane/müzik/ağ planını tamamlayan ayrıntılar

Asıl özellik listesi [Plan 05](05-kutuphane-muzik-ag.md)'tedir. Bu belge ikinci kütüphane veya ikinci müzik araç seti tasarlamaz; veri göçü, dosya kimliği ve Plan 06 ile entegrasyonu kesinleştirir. Etiket/söz/ReplayGain/mini oynatıcı D1 dalından tekrar kullanılır.

**L01 — Ortak SQLite çekirdeği ve güvenli veri göçü**

Ön koşul: S01/S02. Alanlar: önerilen `src-tauri/src/storage/{mod,migrations}.rs`, `src/core/library.js`, mevcut `storage.js`, `settings.js`, `Cargo.*`; mimari not `docs/storage-schema.md`.

- Plan 05'in `library.db` yolunu kullan. Tek migration sahibi ve bağlantı/iş parçacığı modeli; job tabloları A02 tarafından aynı mekanizmaya eklenir. Thumbnail/cache dosyaları DB blob'u olmak zorunda değildir.
- `settings.json` ayarlar için kalır. `library.json` recent/resume ve D1 favorileri yeni şemaya tek seferlik idempotent göç eder; başarılı transaction ve doğrulamadan önce eski veri silinmez. Göç öncesi sürümlü yedek.
- Tabloların ilk seti: `schema_migrations`, `folders`, `media`, `audio_tags`, `playlists`, `playlist_items`, `bookmarks`, `artifacts`; A02 `jobs/job_items/job_checkpoints` ekler. İleri migration ve eski uygulamanın yeni şemayı açma davranışı açık tanımlanır; sessiz downgrade yok.
- Medya kimliği UUID; yol ayrı alan. Normalized path + platform volume/dosya kimliği varsa yardımcı; boyut+mtime hızlandırıcıdır, kesin kimlik değildir. Taşıma eşlemesinde belirsiz durumda hash/ kullanıcı seçimi; aynı ad/boyutlu farklı dosyayı birleştirme.
- Kamera EXIF yerel zamanı ve timezone/offset bilinmiyor ayrımı korunur; bilinmeyen saat dilimi otomatik UTC gerçek zamanı yapılmaz.
- DB yazmaları transaction içinde; büyük taramalar kısa batch transaction'larla. DB bozulmasında mevcut dosyalar korunur, yedekten kurtarma/yeniden indeksleme yolu vardır.

Kabul/test: boş kurulum, eski library/settings göçü, yarıda kesilen göç, tekrar çalışma, yeni şema/eskimiş uygulama, yedek geri dönüşü. Recent/resume/favori/yer imi kaybolmaz. A02 kendi ikinci migration sistemini kurmadan tablo ekleyebilir.

**L02 — Kütüphane, artımlı tarama ve listeler**

Ön koşul: L01, fotoğraf stüdyosu mevcut. Özgün Plan 05 §1–§2 ve Plan 04 yıldız/etiket kapsamı.

- Tek seferlik klasör görüntüleme ile kalıcı “Kütüphaneye ekle” eylemini ayır; her açılan dosya otomatik kalıcı taramaya girmez. Kullanıcının seçmediği tüm diskleri tara davranışı yok.
- İzlenen klasörlerde artımlı tarama; watcher yalnızca hızlandırıcı, periyodik/manuel uzlaştırma doğruluğu sağlar. Dosya kayıp, disk çevrimdışı ve gerçekten silinmiş durumları ayrı.
- Sembolik link döngüsü, erişim reddi, geçici dosyalar, ağ diski kopması, aynı klasörün iki kez eklenmesi ve çok büyük koleksiyon için sınırlar. Tarama iptal edildiğinde tamamlanan sayfalar tutarlı kalır.
- D1 rename/delete/tag/export olayları ortak medya kimliğine bağlanır. Dosya sistemi değişikliği ile SQLite transaction atomik değildir; operasyon kaydı ve yeniden uzlaştırma kullan. Oynatma listesi/resume/favori eski yolda kalmaz.
- Fotoğraf stüdyosu yıldız/etiket, video devam et ve müzik görünümleri ortak sorguyu kullanır. FTS dosya adı/etiket/başlık aramasıdır; semantik AI arama diye adlandırılmaz.
- M3U/M3U8/PLS göreli yollar, Unicode/BOM, eksik dosyalar; sıra korunarak içe/dışa aktar. Liste içe aktarmak uzak URL'leri otomatik indirme/çalıştırma başlatmaz.

Kabul/test: 5.000+ fixture kayıt, sil/taşı/yeniden adlandır/harici disk çıkar-tak, aynı dosyayı iki kez tarama, watcher olayını kaçırma ve uzlaştırma. Ana ekran sanal/paged render; ilk sayfa ve arama p50/p95 Q02'de tanımlı cihazla ölçülür. Büyük tarama UI'ı bloke etmez.

**L03 — Tam müzik deneyimi ve ses doğruluğu**

Ön koşul: L01/L02, S02. Özgün Plan 05 §3 ve Plan 06 §4. Alanlar: mevcut ses modülleri, D1 `tags/lyrics/music-tools`, library queries; sistem medya kontrol adapter'ları.

- Sanatçı/albüm/parça/tür görünümü, kapak, sıradaki parçalar, shuffle/repeat ve kayıtlı listeler. Görselleştirici düşük öncelikli ve kapatılabilir; sistem yükünde müziği etkilemez.
- Boşluksuz oynatma ses motorunda doğrulanır; sadece mpv seçeneği ayarlamak yeterli değil. PCM/FLAC ve encoder delay/padding içeren destekli kayıplı format örnekleri; crossfade ayrı tercih, gapless eşanlamlısı değil.
- ReplayGain track/album, preamp ve clipping önleme politikası açık olsun. D1 ebur128 LUFS ölçümünü ReplayGain etiketi diye doğrudan yazmadığını doğrula; kullanılan referans/offset dönüşümü belgelenir. Album gain, aynı albümün ortak ölçümüne dayanır. Peak/true-peak alanlarını birbirine karıştırma.
- D1 etiket yazımı sırasında dosya kilidi bırakma/kaldığı yerden dönme davranışını koru. Toplu etiket düzenleme kopya/geçici fixture üzerinde test edilir.
- SMTC/Now Playing/MPRIS destekleri ortak adapter; medya tuşları, kulaklık çıkarma, ses cihazı değişimi, kapak/parça metadata güncellemesi. OS olayları sonsuz karşılıklı event döngüsü üretmez.
- Müzik ekranında video/fotoğraf kontrolleri görünmez. LRC senkronu seek ve hız değişiminde test edilir.

Kabul/test: albüm/listeler restart sonrası durur; gapless sınırındaki örnek kesintisi ölçülür; ReplayGain referans sonucu tolerans içinde; etiket roundtrip; iki parça arasında sistem kontrolleri doğru parçayı gösterir. Desteklenmeyen OS kontrolü capability'de açık.

**L04 — Ağ akışları ve cihaza yayın**

Ön koşul: P01, temel player kararlı; yerel yayın için Q04 kaynak sınırları. Özgün Plan 05 §4–§5 özellikleri korunur; ilk beta zorunluluğu değildir.

- İlk teslim yerel HTTP HLS/DASH fixture + ağ kopması/yeniden bağlanma; sonra radyo metadata, OS üzerinden bağlanmış SMB, ardından UPnP keşif ve renderer, son olarak Chromecast.
- URL şeması/protokolü izinli listeden seçilir; kullanıcı URL'si shell komutuna dönüştürülmez. Kullanıcı/parola/token loglardan temizlenir. Yerel ağ oynatma için özel IP'leri toptan engelleme; arka planda uzak içerikten keyfi URL takip etmeyi kısıtla.
- UPnP/XML yanıtları boyut/zaman sınırına sahip; dış entity çözümü kapalı. Keşif yalnızca kullanıcı istediğinde veya ayar açıkken başlar.
- Cast HTTP sunucusu yalnızca seçilen medyayı kısa ömürlü erişim belirteciyle sunar; dizin gezintisi yok, path traversal yok. Gerekli ağ arayüzüne bind, Range desteği, timeout, stop sonrası erişim kapanışı. Yerel ağ güvenlik duvarını sessizce değiştirme.
- Codec uyumsuzluğunda anlaşılır hata; otomatik transcode sonraki ayrı iş. DLNA/Chromecast başarı simülatörü gerçek cihaz uyumluluğunun yerine geçmez.
- yt-dlp isteğe bağlı bileşen; resmi dağıtım/sürüm/hash/lisans doğrulanır, kullanıcı indirmeyi seçer. `load-scripts=no` olan mevcut mpv derlemesinde entegrasyon ayrıca tasarlanır; mpv'nin otomatik çözmesini varsayma. Giriş gerektiren veya DRM korumalı hizmetleri aşma kapsamı yok.

Kabul/test: fake UPnP/renderer ile komut akışı; gerçek en az bir desteklenecek cihazda oynat/durdur/seek. Yayın kapandığında medya URL'si çalışmaz. Ağ kesintisi uygulamayı kilitlemez; sırlar logda bulunmaz.

**Sonraki fazlar — ilk masaüstü sürümünü bekletmez**

| Kimlik | Ön koşul | İlk teslim | Kabul ölçütü |
|---|---|---|---|
| F01 Mobil Android/iOS | Masaüstü veri/engine API kararlı; P01 matrisi | Ayrı ADR + küçük oynatma/fotoğraf denemesi, storage izinleri, background audio, yaşam döngüsü ve dokunmatik düzen | Her hedef gerçek cihazda dosya seç/oynat/arka plan/yeniden aç testi; desktop DLL mimarisinin mobilde çalıştığı varsayılmaz. Mağaza/lisans/codec dağıtımı doğrulanır. |
| F02 Yerel semantik arama | L02 ve model yönetimi A01 | Çok dilli embedding modeli aday testi, yerel indeks; örnek TR/EN arama kümesi | Önceden tanımlı ilgili sonuçlarla recall@k ve gecikme ölçümü; klasör silinince indeks/embedding de silinir. Yüz gruplama ayrı opsiyonel alt özellik, varsayılan zorunlu değil. |
| F03 Konuşma dökümü/altyazı | A01/A02, D1 altyazı işlemleri | Lisansı uygun yerel ASR adayıyla kısa klip, SRT/VTT kaydetme | Türkçe/İngilizce örneklerde sözcük hatası ve zamanlama raporu; sessizlikte uydurma metin kontrolü; konuşma çevirisi ayrı özellik. |
| F04 Tam RAW ve yüksek bit derinliği | A04 renk/çıktı sözleşmesi, kullanıcı talebi | Dinamik ve lisansa uygun decoder deneyi; 16 bit lineer/ICC/HDR çıktı ADR'si | Gömülü JPEG yerine sensör verisinden decode kanıtı; renk chart/ton rampasıyla clipping/banding testi; 8 bit model yüksek bit derinliği restorasyonu diye sunulmaz. |

Mobilin ilk sürümü ağır restorasyonu zorunlu tutmaz. İsteğe bağlı masaüstüne iş gönderme daha sonra ayrı kimlik doğrulama/eşleştirme ve mahremiyet tasarımı ister. Bulut, sosyal ağ, tam video kurgu ve kendi büyük modelini sıfırdan eğitme bu fazlara otomatik eklenmez.
