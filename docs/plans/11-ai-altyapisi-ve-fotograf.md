Plan 11 — AI bileşenleri, kalıcı işler ve güvenilir fotoğraf çıktısı

Bu paket mevcut `ai.rs`, `ai-engine.js`, `ai-worker.js`, `photo-ai.js`, `face-restore.js` ve fotoğraf stüdyosunu genişletir. Yeni sinir ağı eğitmek veya çalışan modelleri sırf yeni oldukları için değiştirmek kapsam dışıdır. [Plan 07](07-akilli-duzenleme.md) LaMa/BiRefNet/DDColor işlem tariflerinin kaynağı olmaya devam eder.

**Sahiplik ve kapsam sınırı**

Özgün Plan 07, “Otomatik iyileştir” algoritmasını kullanıcıya ayırmıştır. Claude yeni dal/kullanıcı değişikliği varsa önce S01 envanterine alır ve bu algoritmayı yeniden yazmaz. A01–A04 ortak altyapı ve kaydetme; A05 mevcut modelin ayar/önizleme entegrasyonudur. Bu işlerde mevcut algoritma bir adapter üzerinden çağrılır; aynı adlı ikinci iyileştirme motoru kurulmaz. Geliştirilen özel algoritmanın API'si yoksa belgelenmiş girdi/çıktı sözleşmesi ve test adapter'ı hazırlanır, diğer işler sürdürülür. Yeni model seçimi/eğitimi ayrı araştırma görevidir.

**A01 — Doğrulanabilir ve iptal edilebilir model yönetimi**

Ön koşul: S01/S04; L01 gerekmez. Alanlar: `src-tauri/src/ai.rs` (gerekirse `ai/{manifest,download,cache}.rs`), `src/media/ai-engine.js`, ayar/bileşen paneli, ilgili notices ve testler.

- Mevcut sabit URL/SHA-256/boyut tanımını tek yetkili manifestte sürdür. Önerilen alanlar: `id`, `version`, `task`, `sourceCommit`, `files[{name,url,sha256,bytes}]`, `license`, `author`, `input/output`, `pre/postprocessVersion`, `testedBackends`, `externalData`, `diskBytes`. GPU bellek gereksinimi yalnızca ölçülmüşse değer içerir; model dosya boyutundan türetilmez.
- Önceden indirilmiş dosyanın yalnızca boyutla kabulünü kaldır. Oturumun ilk kullanımında gerçek hash kontrolü; sonraki kullanımda değişim algılama ve doğrulama önbelleği; dosya değişirse tekrar kontrol. Yanlış hash'li dosya inference/runtime import'a verilmez.
- Bileşen kimliği başına indirme kilidi. İki istemci tek indirmeyi izler; biri iptal olduğunda diğer aktif aboneliği bozma veya tek sahip modelini API'de açıkça tanımla.
- `requestId` ile iptal; iptal HTTP stream'e ulaşır. Bağlantı/ilerleme zaman aşımı, sınırlı retry/backoff, disk alanı/izin ve boyut üst sınırı. Hash hatasında sonsuz retry yok.
- `.part` aynı hedef volume'da; indirme ve hash tamamlanmadan nihai ad görünmez. Kalan parçalar sahiplik bilgisiyle temizlenir. Kısmi indirmeyi sürdürme ancak HTTP Range/ETag doğrulanırsa; aksi halde güvenli yeniden başlatma yeterli.
- Plan 07 DDColor zip'i için yalnızca izinli dosya adları; traversal/symlink ve açılmış toplam boyut sınırı; zip ve iç dosya hash'leri ayrı. Kısaltılmış BiRefNet hash'leri tam SHA-256 doğrulanana kadar manifestte kabul edilmez.
- Bileşen paneli: boyut/lisans/kaynak, indiriliyor/doğrulanıyor/hazır/bozuk, yeniden dene/onar/kaldır. Aktif işin kullandığı sürüm kaldırılamaz. Model yükseltmesi çalışan işi değiştirmez.

Önerilen IPC: `ai_status(ids)`, `ai_install(id,requestId)`, `ai_cancel_download(requestId)`, `ai_verify(id)`, `ai_remove(id)`; mevcut tek-id çağrılarına geçiş adapter'ı. Hatalar kodlu: `download-network`, `checksum`, `disk-full`, `cancelled`, `license-unavailable`; kullanıcı metni i18n'de.

Kabul/test: küçük yerel fixture sunucusuyla aynı boyutta bozuk dosya, kesilen bağlantı, yanlış hash, iki eşzamanlı istek, iptal ve yeniden deneme. İptalden sonra eski olay yeni işi etkilemez. Model hazırsa ağ kapalı çalışır. İndirme testi büyük gerçek model indirmesini normal birim test zorunluluğu yapmaz; gerçek model testi Q01'de ayrı katmandır.

**A02 — Kalıcı iş kuyruğu ve kurtarma**

Ön koşul: L01 kalıcı depolama çekirdeği, S02. Alanlar: önerilen `src-tauri/src/jobs/{mod,store,scheduler}.rs`, `src/core/jobs.js`, `src/ui/jobs-panel.js`; D1 export ve fotoğraf batch adapter'ları.

Plan 05'in `library.db` veritabanında ortak migration sahibi kullan; ikinci bağımsız veritabanı/göç mekanizması kurma. Önerilen tablolar: `jobs`, `job_items`, `job_checkpoints`, `artifacts`. SQL kolonları ve indeksler uygulanmadan önce `docs/jobs-api.md` içinde kesinleşir.

Önerilen veri sözleşmesi:

```json
{
  "id": "uuid",
  "kind": "photo-enhance",
  "schemaVersion": 1,
  "state": "queued",
  "inputs": [{"mediaId": "optional-id", "path": "local", "size": 0, "mtimeNs": "string"}],
  "recipe": {"modelId": "photo-x4", "modelVersion": "pinned", "outputScale": 2},
  "outputPolicy": {"overwrite": false, "metadata": "keep", "destination": "chosen-dir"},
  "progress": {"stage": "queued", "done": 0, "total": null},
  "checkpoint": null,
  "error": null
}
```

JSON bir örnektir; `mtime` tek başına kesin dosya kimliği değildir. Resume/son çıktı üretiminde kaynak değişikliği için içerik parmak izi/hash politikası gerekir. Hassas path'ler yerel DB'de tutulur, yayınlanan loglarda maskelenir.

- Durumlar: `queued → running → completed`; `running → pausing → paused`; `queued/running/paused → cancelling → cancelled`; `running → failed/interrupted`. Retry yeni `attemptId` üretir. Her olay `jobId + attemptId + itemId? + sequence` taşır.
- İlerleme aşaması ile işin toplamını ayır. Bilinmeyen toplam için sahte yüzde verme. UI yeniden açılınca olay beklemek yerine kalıcı snapshot'ı okur.
- Uygulama kapanınca `running` işler başlangıçta `interrupted` olur. Kaynak/model/recipe/segment doğrulanmadan otomatik resume yok. Kullanıcıya devam/baştan başlat seçeneği.
- İlk sürüm fotoğraf batch için tamamlanmış dosya sınırında devam eder; tek fotoğraf inference'ını ortadan sürdürme vaat edilmez. Video segment checkpoint'i V05'te eklenir.
- Aktif iş başına ayrı geçici dizin, çıktı ad rezervasyonu, disk alanı kontrolü; yalnızca o işe ait geçiciler temizlenir. İki iş aynı son adı ezemez. Partial dosya başarılı çıktı olarak kütüphaneye girmez.
- D1 dışa aktarma adapter'ı mevcut runner'ı kullanır; fotoğrafın mevcut cancel registry'siyle tek iptal otoritesi tanımla. İlk sürümde uzun işler sırayla; thumbnail/oynatma ayrı öncelikli işlerdir.

Kabul/test: süreç zorla kapatılıp yeniden açıldığında biten işler tekrarlanmaz; hatalı partial başarı sayılmaz; değişen kaynak/modelle devam engellenir; iptal yalnızca kendi alt sürecini durdurur; isim çakışmasında veri kaybı olmaz. DB migration testi L01 ile birlikte. Kaynak medya test öncesi/sonrası hash eşittir.

**A03 — Kaynak bütçesi, backend seçimi ve inference adapter'ı**

Ön koşul: A01/A02, P01. Alanlar: `ai-engine.js`, `ai-worker.js`, job scheduler; ölçüm gerekirse yerel worker deneyi.

- Önerilen adapter: `probe()`, `prepare(modelVersion)`, `run(input,recipe,onProgress,signal)`, `release()`; fotoğraf ve gelecekte video aynı yaşam döngüsünü kullanır. Mevcut Web Worker ilk adapter'dır.
- WebGPU yok/uyumsuzsa WASM yolu; gerçek küçük inference ile backend çalışabilirliğini doğrula. GPU adı veya ayrılmış VRAM tek başına başarı ölçütü olmasın; paylaşımlı belleği olan iGPU'ları yanlış sınıflandırma.
- Tile boyutu düşürme sadece uygun bellek/resource hatalarında yapılır. Model biçimi, yanlış giriş ve bozuk ağırlık hatası CPU'da tekrar tekrar çalıştırılmaz. Her geri çekilme tanı kaydında görünür.
- Aynı anda varsayılan bir ağır AI işi; kullanılmayan oturumları bırak; oynatma sırasında düşük öncelik/pause-on-play ayarı. UI kaynak ölçümleriyle çelişen “her zaman çalışır” iddiası yok.
- Piksel/bellek sınırını çıktı boyutu, geçici tensör ve kopyalarla hesapla. Çok büyük işi sessizce küçültme; hedef çözünürlüğü göster, uygun alternatif sun. CPU yedeği çok yavaşsa iptal edilebilir süre tahmini.
- Yerel ONNX Runtime/ayrı süreç ancak aynı fixture/modelle Web yolunun sınırı ölçülünce eklenir. Sırf varsayılan teknoloji tercihi için iki eşdeğer motorun bakımını üstlenme.

Kabul/test: WebGPU zorla kapalı, küçük bellek, model yükleme hatası, worker kapanması ve iki iş yarışında doğru sonuç. Kuyruk/iptal kontrolleri kullanılabilir kalır; boşta ve oynatma+AI durumlarında RAM/VRAM, frame drop ve UI gecikmesi ölçülür. Q02 performans bütçesiyle karşılaştırılır.

**A04 — Fotoğraf sonucu, orijinal ve metadata bütünlüğü**

Ön koşul: A02; Plan 04 kaydetme altyapısı mevcut. Alanlar: `photo-ai.js`, `ai-worker.js`, `src/studio/editor.js`, `src-tauri/src/photo/{ops,decode,exif}.rs`; önerilen `photo/artifacts.rs`.

- AI sonucunu yalnızca Canvas download'a bırakma; stüdyonun çıktı seçenekleri, atomik yazma ve metadata politikasıyla birleştir. IPC üzerinden büyük base64 yerine sınırlandırılmış binary veya backend'in verdiği job-scoped geçici dosya kullan; UI'dan gelen rasgele dosya yolunu yetkili çıktı sayma.
- Sözleşme: kaynak referansı, piksel yönü, genişlik/yükseklik, renk alanı, bit derinliği, alpha davranışı, recipe/model sürümü. Kaydetmeden önce boyut/format/iş sahipliği doğrulanır.
- Varsayılan ayrı `_restored` çıktı, çakışmada yeni ad. Orijinali ezme ayrı açık kullanıcı eylemi olur; otomatik/batch varsayılanı olamaz. İptal, disk dolması veya rename hatasında yarım çıktı final adla görünmez.
- Orientation bir kez uygulanır; çıktı EXIF yönü normalize edilir. Tarih/kamera/telif gibi metadata korunur; GPS için `keep/stripGps/strip` politikası. AI değişiklik kaydı eklenir.
- Renk alanı kritik: Canvas sRGB ürettiyse orijinalin farklı ICC profilini körlemesine kopyalama. Önce doğru renk dönüşümü, sonra çıktıyla eşleşen profil. 8 bit çıktı 16 bit orijinalmiş gibi etiketlenmez. HDR/16 bit gelişmiş işlem F04'te.
- Alpha ayrı taşınır; RGB modeline uygun kompozitleme/kenar işlemi ve alpha ölçeklemesi yapılır. Şeffaf piksellerin rengi halo üretmemeli. JPEG seçilirse arka plan rengi kullanıcıya açıkça uygulanır.
- Yanında sürümlü `.vho.json` recipe veya DB artifact kaydı: kaynak parmak izi, app/model sürümü, ayarlar, yapılan işlemler, tarih, gerçek çözünürlük ve renk bilgisi. Bu kayıt gizli dosya yolunu paylaşılacak çıktıya gereksiz yere gömmez; geçmiş geri alınabilirlik ile orijinal kopya saklama birbirinden ayrıdır.
- AI sonucu düzenleme oturumunda undo/redo ile geçici olarak uygulanır; kaydetmeden fotoğraf değiştirildiğinde başka dosyaya yanlış sonuç yapışmaz (`loadGen/jobId`).

Kabul/test: EXIF yönü 1–8, ICC'li kaynak, şeffaf kenarlı PNG, çok büyük fotoğraf, Unicode yol, hedef çakışması, disk/yazma hatası, iptal ve fotoğraf değiştirme. Çıktı boyutu doğru, tarih/GPS politikası doğru, orijinal hash değişmemiş, alpha kaybolmamış. ICC renk dönüşümü ve sadece profil kopyalama ayrı test edilir.

**A05 — Fotoğraf restorasyonu kullanıcı akışı ve sadakat**

Ön koşul: A01–A04, Q02'nin küçük başlangıç veri kümesi. Alanlar: mevcut fotoğraf AI paneli/stüdyo karşılaştırma, i18n, ayar şeması.

- Ana akış: fotoğraf aç → “İyileştir” → hedef/önizleme → karşılaştır → kopya kaydet. Gelişmiş parametreler Ayarlar veya açılır ayrıntıda; ana ekrana model listesi yığma.
- Profiller: “Aslına sadık” ve “Yaratıcı iyileştirme”. Birincisi generatif yüz restorasyonunu varsayılan kapalı/ölçülü tutar; renklendirme/nesne silme ayrıca seçilir. Bu profiller doğruluk garantisi gibi sunulmaz.
- Ölçek 1x/2x/4x; gerçek kaynak/çıkış boyutu ve gerekiyorsa küçültme gösterilir. Kullanılan model 4x çalışıp 2x'e indiriyorsa bunu teknik kayıtta açıkla; 1x işlemi otomatik doğal-denoise kalitesi garantisi sayma. Profil bazında Q02 karşılaştırması gerekir.
- Yüz müdahale gücü ayarlanabilir; küçük yüzlerde kimlik değişimi ihtimali için kısa bağlamsal açıklama. Önce/sonra aynı zoom/pan ve aynı örnekleme boyutunda karşılaştırılır.
- Önizleme bölgesinin context padding'iyle işlenmesi ve tam görüntüyle farkı hesaba katılır. Önizleme küçük piksel/memory bütçesine sahip; sonuç recipe değişince geçersizleşir.
- Tahmini süre ölçülmüş örnekten türetilir; model derleme/ilk yükleme ayrı gösterilir. İptal ve geri dönme her aşamada mevcut.

Kabul/test: aynı çözünürlükte A/B karşılaştırma, hedef boyut doğruluğu, recipe değişiminde eski preview kullanılmaması, yüz seçeneği değişince sonuç yenilenmesi, CPU yedeği ve metadata ile kaydetme. Özel kullanıcı algoritmasına dokunulmadan adapter entegrasyonu kanıtlanır. Kalite tercihi kör değerlendirme Q02 ile raporlanır; yalnızca daha fazla keskinlik başarı sayılmaz.

**A06 — Plan 07 akıllı düzenlemeyi ortak altyapıya bağla**

Ön koşul: S02, A01/A03/A04; uzun batch için A02. Plan 07'nin algoritma tariflerini referans al, tekrar tasarlama.

- LaMa fırça/maske → BiRefNet portre arka planı → bulanıklık → DDColor sırasıyla küçük teslimler. Genel nesne BiRefNet ayrı opsiyonel indirme.
- Manifestler tam hash/lisanslarla A01'de; DDColor external data ve ONNX Web operatörleri gerçek inference ile test edilir. Önceki scratchpad dosyaları yoksa özel dosyalara erişerek arama yapma; resmi işlem tarifinden sentetik referans oluştur.
- Çıktılar A04 kaydetme/undo/metadata/alpha yolunu kullanır; ayrı indirme/ilerleme/çıktı sistemi eklenmez.
- Renklendirmede küçük yüz kızarması için Plan 07'deki düzeltme adaylarını çeşitli cilt tonları ve sahnelerde değerlendir; bütün ciltleri aynı renk aralığına zorlayan evrensel eşik koyma. Başarısızsa deneysel seçenek olarak kalır veya profil devre dışı tutulur.
- Nesne silme ve renklendirme “aslına sadık arşiv” çıktısına kullanıcı seçimi olmadan uygulanmaz. Önizleme ve geçmişte hangi işlem olduğu görünür.

Kabul/test: Plan 07'deki mask/alpha/Lab ve referans eşdeğerlik testleri; gerçek model çıkarımı ayrı AI test komutunda; işlem iptal/undo/fotoğraf değiştirme; şeffaf çıktı ve orijinal hash korunumu. Yalnızca doygunluğun artması renk doğruluğu kanıtı değildir; Q02 insan incelemesi gerekir.
