Plan 08 — Güncel durum, eksiklerin eşlenmesi ve uygulama sırası

Tarih: 25 Ekim 2026. Referans `main=a2092b9`, D1 dalı `wave25/d1-eylemler=9ca04e3`. Bu tarih itibarıyla kaynak/dal incelemesi yenilendi. 24 Ekim testleri referanstır, 25 Ekim'de yeniden çalıştırılmış sayılmaz. Uygulayıcı: Claude; başlangıç [devir talimatı](CLAUDE-DEVIR.md).

Amaç: mevcut 01–07 planlarını tekrar üretmeden eksik ürün, mühendislik ve doğrulama işlerini tamamlamak. İlk hedef güvenilir masaüstü medya uygulaması ve aslına sadık fotoğraf restorasyonu; yüksek kaliteli video restorasyonu ayrı deneysel aşama, mobil sonraki aşamadır. “Tüm sistemler/her format” ifadesinin yerine test edilen sürüm/mimari/codec matrisi konur.

**Mevcut planlara göre durum**

| Özgün plan | Bugünkü kanıt | Kalan iş / yeni plan |
|---|---|---|
| [01 — Temel](01-temel-mimari-ve-test.md) | Modüler JS, Node birim testleri ve Windows E2E düzeneği ana dalda | Baştan refactor yok; regresyon tabanı 09, test katmanları 14. Eski satır sayısı hedefi tek başına dosya bölme gerekçesi olmaz. |
| [02 — Motor](02-oynatma-motoru.md) | LGPL Windows libmpv, motor cephesi ve oynatma özellikleri ana dalda | macOS/Linux gömme ve gerçek platform testi eksik: 10/P01–P04. |
| [03 — Platform](03-platform-ve-ayarlar.md) §1–§4 | Ayar/son açılanlar/kısayol/tema/i18n temeli var | Tüm metinlerin taşınması, erişilebilirlik ve işletim sistemi davranışları: 09/S05, 10/P04, 14/Q03. |
| Plan 03 §5 | Kurulum/CI/imza/güncelleme zaten planlı; ana dalda CI workflow görülmedi | Yeniden bağımsız özellik sayılmaz; paketleme ayrıntısı 10/P05, yayın kapısı 14/R01–R03. |
| [04 — Fotoğraf](04-fotograf-studyosu.md) | Rust fotoğraf altyapısı ve stüdyo ana dalda | AVIF teşhisi 09/S03; metadata/alpha/AI çıktı bağlantısı 11/A04; eksik kütüphane yıldız/etiket bağlantısı 13/L02. |
| [05 — Kütüphane/müzik/ağ](05-kutuphane-muzik-ag.md) | Ayrıntılı hedefler var; ana dalda tam SQLite kütüphane yok | Planın kendisi uygulanacak; veri göçü, kimlik, test ve ağ sınırları 13'te eklenir. |
| [06 — Medya eylemleri](06-medya-eylemleri.md) | D1 dalında ana dalda olmayan 7 commit; Windows odaklı uygulama ve test dosyaları mevcut | İlk iş 09/S02 entegrasyon. Dalın belgelerinde paylaşım/OCR/encoder platform sınırları var; hepsi tamamlandı sayılmaz. |
| [07 — Akıllı düzenleme](07-akilli-duzenleme.md) | LaMa/BiRefNet/DDColor tasarımı ve önceki deney notları mevcut; ana uygulamada entegrasyonu görülmedi | Algoritma tarifi yeniden yazılmaz; model/iş yönetimi ve entegrasyon sırası 11/A01–A03, A06. |
| Mevcut fotoğraf AI | DAT-2/GFPGAN/YuNet, Worker, WebGPU→WASM, tiled inference kodu var | Kalite/çıktı/model yaşam döngüsü eksikleri: 11. |
| Mevcut video “AI” | libmpv'de kontrast/doygunluk; HTML5'te WebGL filtreleri | Doğru adlandırma 09/S04; gerçek video AI 12. |

**Analizdeki yeni öneriler nereye gitti?**

| İhtiyaç | Yeni mi? | Görev |
|---|---|---|
| README iddiaları/özellik yetenek matrisi | Eksik ayrıntı | S04, P01 |
| AVIF çalışabilir codec kontrolü | Mevcut kapsamda hata | S03 |
| Model doğrulama/onarım/iptal/sürüm | Yeni sağlamlaştırma | A01 |
| Kalıcı iş kuyruğu ve çökmeden dönüş | Yeni ortak altyapı | A02; kalıcı depolama L01 |
| Orijinal/EXIF/renk/alpha/işlem geçmişi | Fotoğraf planında kısmen var, AI yolunda eksik | A04 |
| Sadakat/önizleme/ölçek seçimi | Yeni ürün ayrıntısı | A05 |
| LaMa/BiRefNet/DDColor | Zaten Plan 07'de | A06 entegrasyonu |
| Video AI, zamansal tutarlılık, kesit önizlemesi | Yeni | V01–V06 |
| Müzik/SQLite/DLNA/Chromecast | Zaten Plan 05'te | L01–L04 ayrıntıları |
| Kalite karşılaştırması ve gerçek model testleri | Yeni | Q01–Q02 |
| Çevrimdışı fontlar, kaynak sınırları, güvenlik | Eksik ayrıntı | S05, Q03–Q04 |
| Açık kaynak belgeleri/imzalı yayın | Zaten kısmen Plan 03'te | R01–R03 |
| Mobil, semantik arama, konuşma dökümü | Sonraki faz | F01–F03; 13 |
| Tam RAW/16 bit/HDR restorasyonu | Sonraki faz | F04; 13 |
| Kullanıcı araştırması/sürdürülebilirlik | Yeni ürün çalışması | R04; 14 |

**İş paketleri**

| Paket | Belge | Somut sonuç |
|---|---|---|
| S | [09 — Entegrasyon ve doğruluk](09-entegrasyon-ve-dogruluk.md) | Mevcut işler birleşmiş, test tabanı ve doğru ürün anlatımı |
| P | [10 — Çoklu platform ve paketleme](10-platform-ve-paketleme.md) | Test edilebilir platform adaptörleri ve temiz kurulum |
| A | [11 — AI altyapısı ve fotoğraf](11-ai-altyapisi-ve-fotograf.md) | Doğrulanmış modeller, kalıcı işler, güvenli ve karşılaştırılabilir fotoğraf sonucu |
| V | [12 — Video restorasyonu](12-video-restorasyonu.md) | Kanıtlanmış model seçimi, kısa kesit önizlemesi, tutarlı dışa aktarma |
| L/F | [13 — Kütüphane ve mevcut planların devamı](13-kutuphane-muzik-ag-ve-sonraki-faz.md) | Plan 05'in veri göçü ve entegrasyon ayrıntıları; sonraki faz sınırları |
| Q/R | [14 — Kalite ve açık kaynak yayın](14-kalite-ve-acik-kaynak-yayin.md) | Gerçek model/medya testleri, kaynak ve lisans paketi, beta çıkış kapıları |

**Uygulama sırası**

Bu sıra tek geliştiriciyle de yürütülebilir. Bir ortam eksik olduğunda bağımsız görevler sürdürülür; tamamlanma durumu uydurulmaz.

1. S01 güncel envanter → S02 D1 entegrasyonu → S03 baseline/AVIF → S04 doğru özellik adları.
2. S05 metin/çevrimdışı temeli; P01 yetenek sözleşmesi ve Q01 test düzeni. P02/P03 için küçük platform denemelerini erken yap; taşınabilirlik belirsizliğini en sona bırakma.
3. L01 kalıcı depolama çekirdeği → A01 model yönetimi → A02 iş kuyruğu → A03 kaynak yönetimi → A04 güvenli çıktı → A05 fotoğraf deneyimi. Q02 ölçüm veri kümesini bu sırada hazırla.
4. A06 Plan 07 entegrasyonu. L02 kütüphane → L03 müzik. P02/P03/P04 uygulama ve doğrulaması, P05 paketleme.
5. V01 kaynak inceleme ve V02 model fizibilitesi → karar kapısı → V03 işlem hattı → V04 önizleme → V05 devam/iptal → V06 regresyon. Fizibilite başarısızsa deneysel kalır; masaüstü beta bundan dolayı durmaz.
6. Q03 erişilebilirlik, Q04 güvenlik/mahremiyet, R01 topluluk/lisans dosyaları, R02 CI/yayın, R03 beta kapıları. Bunların hazırlığı önceki adımlarda başlamalı, sonunda yalnızca doğrulama kalmalı.
7. L04 ağ/yayın, R04 kullanıcı geri bildirimi. F01–F04 sonraki sürüm görevleridir; ilk beta bağımlılığı değildir.

Önemli bağımlılıklar: S02→A06/L03/V03; L01→A02/L02; A01+A02+A03+A04→A05; A01+A03+A04→A06; V01+V02+A02+S02→V03; V03→V04/V05→V06. P05 temel kurulum S03+P01 ile Windows'ta başlayabilir; macOS/Linux yayımları P02/P03/P04'ün gerçek testlerini bekler. R03, yayımlanacak platformun P05 ve Q/R koşullarını bekler.

**Sürüm kapsamları ve çıkış koşulları**

| Hedef | Zorunlu işler | Zorunlu olmayanlar |
|---|---|---|
| Geliştirici tabanı | S01–S04, yeni binary ile temel testler | Bulut/mobil |
| Windows fotoğraf alfa | S05, A01–A05, Windows P01/P04/P05, Q01–Q04, yerel R01/R02 hazırlığı | Video AI, LaMa/BiRefNet/DDColor, DLNA |
| Masaüstü beta | Üç platformun P02–P05 kanıtları, L01–L03, R01–R03 | Video AI ancak V06 geçerse deneysel açılır; ağ ve Plan 07 özellikleri tamamlandıkları ölçüde etiketlenir |
| Video restorasyon önizlemesi | V01–V06, seçilen cihaz/modelde kalite ve devam testleri | Gerçek zamanlı çalışma iddiası, mobil |
| Sonraki sürümler | L04, A06'nın kalanları, F01–F04 | İlk beta için bekleme gerekçesi olmaz |

Takvim bu belgede taahhüt edilmez. S01 sonrası Claude her kart için S (tek odaklı değişiklik), M (birkaç alt değişiklik), L (ayrı teslimlere bölünecek) tahmini ve dış ortam ihtiyacı yazar. Özellikle platform yüzeyi ve video AI fizibilitesine ölçüm yapılmadan gün/saat tahmini verilmez.

**Canlı durum kaydı — başlangıçta hiçbir yeni görev tamamlandı sayılmaz**

| Kimlikler | Başlangıç durumu | Kanıt/not |
|---|---|---|
| S01 | doğrulandı | [docs/status/implementation-status.md](../status/implementation-status.md) (2026-10-25) |
| S02 | doğrulandı | D1 `main`'e birleşti (`35de786`); yeni binary ile birim 121/121, Rust 60/60 (+2 ignored), E2E 129/129; kaynak hash kontrolü eklendi |
| S03 | doğrulandı | [docs/status/test-baseline.md](../status/test-baseline.md); AVIF `0x88982F8B` = codec kurulu ama başlatılamadı → `[codec-failed]` + gerçek çözme yoklaması |
| S04 | doğrulandı | `main`e birleşti (`301dfdd`), ana dalda yeniden test: birim 145/145, Rust 114/114 (+2 ignored), E2E 161/161, release uyarısız (2026-10-25); macOS/Linux test edilmedi. Ayrıntı: `wave3/e1-dogruluk` `37ae286` (+ düzeltme `8f04bc5`). Canlı filtreler “Görüntü filtreleri / Ses filtreleri (sinir ağı değil)”, fotoğrafta “Fotoğrafı AI ile iyileştir”, video restorasyonu “hazır değil”; video/fotoğraf düzeni ayrı; A/B libmpv'de veya WebGL2 yokken devre dışı + neden (`video.compare`); libmpv'de %100 üstü ses `volume`+`alimiter` (mpv'nin kübik %200=8× kırpması kaldırıldı), HTML5'te kompresör + yumuşak kırpma güvenlik katmanı; README ölçümsüz iddialar düzeltildi. Test: `tests/unit/capabilities.test.mjs`, `tests/e2e/audio-limiter.e2e.mjs`, video/photo/engine E2E. Sonuçlar: E1 raporu. Kalan: — |
| S05 | doğrulandı | `main`e birleşti (`301dfdd`), ana dalda yeniden test: birim 145/145, Rust 114/114 (+2 ignored), E2E 161/161, release uyarısız (2026-10-25); macOS/Linux test edilmedi. Ayrıntı: `ea956c1`. index.html + media/studio/ui modüllerindeki görünür metinler TR/EN anahtarlarına taşındı (yaklaşık 450 yeni anahtar); Outfit fontu yerel (OFL-1.1, notices 2.8), CSP'den font alanları kaldırıldı; harita/altyazı araması zaten yalnızca kullanıcı eylemiyle. Test: `tests/unit/i18n-coverage.test.mjs` (HTML anahtarları, JS'de Türkçe sabit yok, anahtarlar iki dilde), `tests/e2e/i18n-offline.e2e.mjs` (ana arayüzde dil değişimi, açılışta dış istek yok, ağ kapalı yerel fotoğraf). Kalan: `src/media/ai-engine.js` metinleri A01 (E3) ile; Rust hata metinleri kod/adaptör geçişi (yeni modül `capabilities.rs` yalnızca `reasonCode` kullanır); erişilebilirlik tam testi Q03 |
| P01 | doğrulandı | `main`e birleşti (`301dfdd`), ana dalda yeniden test: birim 145/145, Rust 114/114 (+2 ignored), E2E 161/161, release uyarısız (2026-10-25); macOS/Linux test edilmedi. Ayrıntı: `8f04bc5`. `platform_capabilities` (Rust, `src-tauri/src/capabilities.rs`) mevcut `engine_status` / fotoğraf codec yoklamaları / `actions_capabilities` adaptörü; ön yüz `src/core/capabilities.js` (WebGL2/WebGPU/etkin motor) tek kaynak; alanlar `available/implementation/verified/reasonCode`; [docs/platform-support.md](../platform-support.md). Rust `capabilities::tests` (motor var/yok/kapalı/başarısız, codec var/yok/bozuk, test platformları `verified=false`), engine E2E iki motorla. macOS/Linux: **test edilmedi** (`verified=false`) |
| P02–P05 | bekliyor | Windows motoru mevcut; diğer platformların entegrasyonu eksik |
| A01 | doğrulandı | `main`e birleşti (`3498a42`), ana dalda yeniden test: birim 132/132, Rust 109/109 (+2 ignored), E2E 150/150, release uyarısız (2026-10-25). Ayrıntı: tek manifest (sürüm/görev/lisans/yazar/kaynak, çok dosya, zip + iç dosya hash, ONNX external data), sürüm klasörü + eski düzen göçü, oturum başı SHA-256 + değişim önbelleği, bileşen başına tek iş / requestId iptali, Range+ETag ile sürdürme, zaman aşımı + sınırlı retry, disk alanı kontrolü, lease ile kaldırma koruması, kodlu hatalar (i18n), Ayarlar > AI modelleri. Rust `ai::` 21 test, birim 126/126, E2E 140/140 (yeni `ai-models.e2e` yerel fixture sunucusuyla). Kalan: gerçek ağda büyük model indirmesi Q01; Plan 07 modelleri A06 |
| A02 | kod hazır | Dal `wave3/e4-isler` (E4). Kalıcı iş kuyruğu: `library.db` şema v2 `jobs` göçü (L01 tek göç sahibi), [jobs-api.md](../jobs-api.md); `src-tauri/src/jobs/{mod,store,scheduler,adapters}.rs`, `src/core/jobs.js`, `src/ui/jobs-panel.js` (yalnızca iş varken görünen başlık çubuğu göstergesi). Durum makinesi + attemptId + seq, açılışta `interrupted`, otomatik devam yok; devamda tarif/araç-model sürümü/kaynak parmak izi doğrulaması; iş başına geçici dizin, ad rezervasyonu, üzerine yazmayan yerleştirme; D1 dışa aktarma ve fotoğraf toplu işlem adapter'ları mevcut runner'larla, tek iptal otoritesi (`photo::JobGuard`); Windows'ta ffmpeg alt süreci uygulama ile kapanır (job object). Testler: birim 139/139, Rust 130/130 (+2 ignored; `jobs::` 18, göç v1→v2 2), E2E 159/159 (yeni `jobs.e2e` 9; atlanan 0); release uyarısız. Kalan: video segment checkpoint V05; AI işleri A03+; yalnızca Windows'ta denendi |
| A03–A06 | bekliyor | Mevcut inference kodu korunup genişletilecek |
| V01–V06 | bekliyor | Araştırma kapısı V02 |
| L01 | doğrulandı | `main`e birleşti (`01b38a8`), ana dalda yeniden test: birim 127/127, Rust 88/88 (+2 ignored), E2E 139/139, release uyarısız (2026-10-25). Ayrıntı: `library.db` (rusqlite 0.40.2 + paketli SQLite), tek göç sahibi `src-tauri/src/storage/migrations.rs`, göç öncesi/dönemsel sürümlü yedek, bozulmada karantina + yedekten dönüş / yeniden içe aktarma, yeni şemayı açmama; `library.json` son açılanlar/kaldığı yer + `actions.favorites` + localStorage yer imleri tek seferlik doğrulanmış göç. Birim 127/127, Rust 88/88 (+2 ignored), E2E 139/139 (storage 10). Mimari: [storage-schema.md](../storage-schema.md). Kalan: macOS/Linux'ta platform dosya kimliği denenmedi |
| L02–L04 | bekliyor | Özgün Plan 05 korunuyor; A02 göçü v2 (`jobs`), L02 v3 olarak eklenir |
| Q01 | doğrulandı | `main`e birleşti (`bd53427`), ana dalda yeniden test: birim 151/151, Rust 114/114 (+2 ignored), E2E 161/161, test:ai 6/6, release uyarısız (2026-10-25). Ayrıntı: Dal `wave3/e6-test-katmanlari` (E6). Katmanlar: birim (`npm test`, ağ koruması `tests/lib/no-network.mjs`), Rust (`npm run test:rust`), E2E (`npm run e2e`), gerçek AI (`npm run test:ai`), kalite/perf (`test:quality`, `bench:media` — **henüz doldurulmadı**, Q02). `scripts/run-tests.mjs`: binary yolu/derleme zamanı/eskilik uyarısı + pass/fail/skip/todo/cancelled ayrı, `tests/.results/<katman>.json`, `VHO_TEST_NO_SKIP=1`. Gerçek AI smoke: photo-x4 (DAT-2) + ORT Web 1.30.0 uygulamanın kendi indiricisiyle bir kez (76 MB, ~10 s) test önbelleğine (`tests/.cache/ai-smoke`, kullanıcı önbelleği değil), 44×28 sentetik fixture, boyut/sonlu/sabit değil/kanal/alpha/bilinear PSNR/referans (`tests/ai/fixtures/photo-x4-ref.png`); WASM 0/0/0, WebGPU maks 1 fark. Sonuçlar (2026-10-25, yeni binary): birim 151/151, Rust 114/114 (+2 ignored), E2E 161/161, AI 6/6, 0 skip. Harita: [test-map.md](../status/test-map.md). CI taslağı `.github/workflows/ci.yml` (itilmedi). Kalan: GFPGAN smoke, macOS/Linux sürücüsü, CI'da libmpv artifact'ı (P05) |
| R01 | kod hazır | Dal `wave3/e8-yayin` (E8). **Proje lisansı GPL-3.0-only** (2026-10-25 kullanıcı kararı; LICENSE gnu.org metni, Cargo/package lisans alanları, Hakkında metni, bildirim başlığı + tam metin), `TRADEMARKS.md` (HS Studio adı/logo, tescil iddiası yok), taslak `CLA.md` (Harmony HA-CLA-I v1, CC BY 3.0, Option Five; **avukat incelemesi bekliyor**), `CONTRIBUTING.md` (temiz klon → `npm ci` + `npm test`, katmanlar, mimari, i18n/lisans, CLA + DCO, ilk görevler), `SECURITY.md` (özel kanal **yer tutucu**), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `CHANGELOG.md`, issue/PR şablonları. Envanter: `legal/inventory/` (38 DLL + ffmpeg/ffprobe: sürüm/commit/bayrak/sha256/kaynak; AI: ağırlık ≠ kod lisansı, eğitim verisi; font/ikon/vendored/fixture), `legal/INVENTORY.md` (GPL-3.0 uyumluluk tablosu — uyumsuz yok; LGPL kaynak yükümlülüğü; açık kararlar). SBOM: CycloneDX 1.6, `npm run sbom` (`legal/generate-sbom.mjs`, ek araç yok) → 394 crate, 52 npm (geliştirme), 40 yerel, 8 AI, 10 varlık; red 0, inceleme 12. `tests/unit/legal-inventory.test.mjs` envanter/bildirim/SBOM tutarlılığı. Geçmiş taraması `npm run scan:history` → [history-scan.md](../status/history-scan.md): sır yok, özel medya yok; ~70 MB derleme çıktısı geçmişte, yerel kullanıcı yolu, commit e-postası. Temiz klon (geçici klasör) `npm ci` + `npm test` 157/157, SBOM aynı. Bulunan/düzeltilen: GFPGAN dosya adı ve Material Icons atfı bildirimde eksikti, Google Fonts satırı eskiydi, kullanılmayan şablon SVG'leri silindi. Kalan (kullanıcı): güvenlik kanalı, CLA/marka avukat incelemesi + imza yöntemi + yargı yeri, logo hakları, depo URL'si, DLL kaynak arşivi, eğitim verisi kararı (YuNet/GFPGAN), commit kimliği/geçmiş temizliği **Ek 2026-10-26:** iletişim turkuazcode@gmail.com (SECURITY/CoC/TRADEMARKS/şablonlar); 11/12 inceleme maddesi sahip onaylı (GFPGAN/YuNet kabul edilen risk), açık kalan: logo; hukuki ön araştırma [docs/legal/on-arastirma.md](../legal/on-arastirma.md); geçmiş temizliği aracı `scripts/prepare-public-history.ps1` + [history-cleanup.md](../release/history-cleanup.md) (varsayılan kuru çalıştırma, yalnızca geçici ayna; ayna üzerinde denendi: kullanıcı yolu 726→0, paket 28→2,4 MiB) — **ilk push'tan hemen önce çalıştırılacak, geçmiş henüz yazılmadı**; nötr derleme yolu [build-path.md](../release/build-path.md) |
| Q02–Q04, R02–R04 | bekliyor | 24 Ekim baseline aşağıda |
| F01–F04 | ertelendi | Masaüstü sonrası |

İlk kart çalışmaya başladığında aralık satırını tekil kart satırlarına ayır; kimlik, durum, commit, test sonucu, ortam ve kalan iş sütunlarını tut. Bu planın hazırlanmasını uygulama ilerlemesi olarak işaretleme.

24 Ekim referans testleri: `npm test`: 111/111; `cargo test --release --lib --offline`: 37 geçti, 1 AVIF başarısız, 2 ignored. E2E ve diğer platformlar bu analizde çalıştırılmadı. Ayrıntı [analiz raporu](../2026-10-24-proje-ve-rekabet-analizi.md).

**Bütün paketlerde bitirme tanımı**

- Kullanıcı akışı çalışır; hata/iptal/yeniden deneme davranışı tanımlı ve ilgili testlerle kanıtlıdır.
- Test sonuçları gerçek çalıştırmadan gelir; `skip` sonuçları `pass` sayılmaz. Platform/codec eksikliği ve ürün hatası ayrı kaydedilir.
- Yeni uzun iş ana UI'ı bloke etmez; orijinal dosya varsayılan olarak korunur; kaynak ve çıktı yolları çakışmaz.
- Yeni kullanıcı metni TR/EN'dir; ana ekran mevcut sadelik ilkesini korur.
- Bağımlılık ve modellerin lisans/provenans kaydı tamamdır; kabul edilen lisans politikası sessizce değiştirilmez.
- Uygulanmış modüller ve doküman güncellemeleriyle ilgili testler geçer. İlgisiz görsel/metin değişimi için yapay test yazılmaz; veri kaybı, IPC ve medya dönüşümü gibi davranışlar anlamlı test ister.
