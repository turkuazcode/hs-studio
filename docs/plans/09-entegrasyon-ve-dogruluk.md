Plan 09 — Mevcut işleri birleştirme, test tabanı ve doğru özellik anlatımı

Önce [08](08-uygulama-sirasi-ve-durum.md). Bu paket yeni oynatıcı/stüdyo yazmaz; Plan 01–06'nın mevcut çıktısını kullanılabilir tabana getirir.

**S01 — Kaynak ve dal envanterini doğrula**

Ön koşul: yok. Kapsam: Git ve belgeler, uygulama davranışı değişmez.

- `git status --short`, `git worktree list`, `git log -10 --oneline`; `git log main..wave25/d1-eylemler --oneline` ve `git diff main...wave25/d1-eylemler --stat` ile D1 farkını incele. Dal yoksa eşdeğer commit/merge geçmişini bul.
- Aktif kullanıcı değişikliklerini ve yeni Claude çalışmalarını ayır; ana dalda uygulanmış özellikleri 08 tablosuyla karşılaştır.
- `src-tauri/src/actions/`, AI bileşenleri, SQLite, `.github/workflows` gibi alanların gerçekten varlığını kontrol et. Dokümandaki “yapılacak” ifadesinden tek başına eksiklik çıkarma.
- `docs/status/implementation-status.md` oluştur: özellik, özgün plan, kod/dal kanıtı, test kanıtı, platform sınırı, sonraki görev. Mutlak kişisel dosya yolları yayımlanabilir rapora girmez.

Kabul: Plan 01–07'nin her ana alanı `ana dalda`, `ayrı dalda`, `yalnızca plan`, `kısmi/kanıt eksik` olarak ayrılmıştır. Kullanıcı dosyası veya dalı silinmemiştir.

**S02 — D1 medya eylemlerini entegre et**

Ön koşul: S01. Özgün kapsam [06](06-medya-eylemleri.md). Alanlar: D1'deki `src-tauri/src/actions/`, `src/ui/*tools.js`, eylem/dışa aktarma diyalogları, `src/media/actions-logic.js`, `lyrics.js`, `src/main.js`, i18n, `Cargo.*`, testler ve lisanslar.

- D1 zaten birleşmediyse entegrasyon dalında birleştir. Farkı dosya kopyalayarak veya dalı ana dala resetleyerek taşıma.
- Özellikle `README.md`, `docs/plans/00-YOL-HARITASI.md`, `src/main.js`, `src/studio/studio.js`, `src-tauri/src/lib.rs`, `engine/mod.rs`, i18n ve lockfile çakışmalarını davranışa göre çöz. Sonradan eklenen Plan 07 ve 08–14 belgelerini koru.
- Aynı FFmpeg bulma/çalıştırma kodunu yeni AI/video modüllerinde yeniden üretme; bu dalın argüman üreticileri, ilerleme, süreç iptali ve geçici çıktı mantığı ortak temel olsun.
- `VHO_DISABLE_SYSTEM_CHANGES=1` ve `VHO_DISABLE_SYSTEM_SUSPEND=1` korumalarının test başlatıcısında etkin olduğunu doğrula. Kullanıcının açık VHO sürecine dokunma.
- Yeni binary derle; `stage:mpv` ile doğru motor ve varsa FFmpeg araçlarını yerleştir; testin kullandığı exe yolunu raporla. Eski kök `VHO.exe` ile yeni kaynakları doğrulamış gibi raporlama.

Kabul/test: medya eylemleri birim/E2E senaryoları yeni binary ile çalışır; dosya yeniden adlandırma, geri dönüşüm kutusu ve etiket yazma yalnızca geçici fixture'larda denenir. Kesme/dönüştürme/iptalde kaynak hash'i değişmez. macOS/Linux OCR/paylaşım sınırları belgelenir. Plan 07 ve yeni plan dosyaları merge sonunda durur.

**S03 — Test tabanını ve AVIF hatasını düzelt**

Ön koşul: S02; D1 ortam engeli varsa mevcut ana dalın teşhisi yapılabilir. Alanlar: `src-tauri/src/photo/heic.rs`, `decode.rs`, ilgili test/fixture'lar ve test başlatıcıları.

Komutlar, repo kökünden:

```powershell
npm test
cargo test --release --lib --manifest-path src-tauri/Cargo.toml
npm run build:release
npm run stage:mpv
npm run e2e
```

`--offline` yalnızca bağımlılıklar önbellekteyse eklenir. Gerekli libmpv/FFmpeg eksikse önce paket konumu belirlenir; mpv testlerinin atlanması mpv başarısı sayılmaz.

AVIF teşhis adımları:

- Önceki `photo_avif_encode_then_os_decode` hatasını izole fixture ile yeniden üret. Codec kurulu görünüyor ile gerçekten decode edebiliyor ayrımını yap.
- WIC/COM başlatma, test thread modeli, küçük AVIF'in doğruluğu ve gerçek decode hatasını ayır. Yeni codec veya Store eklentisi yüklemek ilk çözüm olmasın.
- `photo_capabilities` gerekiyorsa küçük bilinen dosyayla çalışabilirlik yoklaması yapıp sonucu önbelleklesin; her fotoğrafta pahalı test yapılmasın.
- Ortamda codec yoksa açıklayıcı `codec-missing`; bileşen var fakat bozuksa doğru tanı ve mümkün olan mevcut fallback. Hata mesajının her durumda kullanıcıya “uzantı kur” demesini önle.
- CI'da ortamdan bağımsız decode/encode mantık testi ve codec hazır runner'da gerçek decode testi ayrı olsun. `assert` silerek veya bütün hataları `skip` yaparak düzeltme kabul edilmez.

Kabul: hata sebebi kanıtla kaydedilmiş; desteklenen ortamda AVIF roundtrip geçer; desteklenmeyen ortam açık capability ve hata testiyle doğrulanır. Başlangıç test sonuçları `docs/status/test-baseline.md` içine tarih/commit/OS ile yazılır. Uzun/perf `ignored` testlerin amacı açıklanır.

**S04 — Özellik adlarını gerçek davranışla eşleştir**

Ön koşul: S01; S02 sonrası metin çakışmaları çözülür. Alanlar: `README.md`, `src/index.html`, `src/ui/panels.js`, `src/media/visual-filters.js`, i18n ve motor özellik gösterimi.

- Kullanıcı dilinde üç ayrım: “Görüntü filtreleri” (oynatma sırasında), “Fotoğrafı AI ile iyileştir” (sinir ağı), “Video restorasyonu” (V06 geçmeden hazır değil/deneysel).
- libmpv'de erişilemeyen WebGL A/B kontrolü çalışıyormuş gibi görünmesin. P01 yetenekleri geldiğinde aynı kaynağa bağla; geçici ikinci kalıcı capability sistemi kurma.
- README'de platform desteği, RAW önizleme, 4x giriş/çıkış sınırlaması ve motorun eksik olmasındaki davranışı doğru anlat. 10 ms açılış, kayıpsız %200 ses, 144p'den gerçek detay kurtarma gibi ölçümsüz ifadeleri kaldır/düzelt.
- EQ/booster gibi ses filtrelerini sinir ağı sayma; duyulabilir kırpılma/limiter davranışını uygun ses fixture'ıyla test et.

Kabul: her görünür iddia için kod veya test kanıtı var. Kullanıcı video filtresini gerçek AI dışa aktarımı sanmıyor. Doğruluk düzeltmesi mevcut çalışan özelliği silmiyor.

**S05 — Mevcut çeviri ve çevrimdışı işlerini tamamla**

Ön koşul: S02. Özgün kapsam Plan 03 §3. Alanlar: `src/index.html`, `src/i18n/*`, `src/ui/*`, `src/media/*`, font kaynakları, CSP.

- Kullanıcıya görünen sabit TR/EN metinleri anahtarlara taşı; teknik logları gereksiz yere çeviri kataloğuna alma. Yeni bütün işler baştan i18n kullanır; sonradan ikinci büyük taşıma yapılmaz.
- Google Fonts çağrılarını uygun lisans/atıfla yerel font dosyalarına taşı; font isteği için gereksiz CSP alanlarını kaldır. Font lisansını notices'a ekle.
- Harita ve dış arama kullanıcı eylemiyle açılır. Ağ kapalıyken yerel dosya oynatma, stüdyo ve önceden indirilmiş AI modelleri çalışır. Model ilk indirme ihtiyacı açıkça anlatılır.
- Model/işlem hata kodlarını metinden ayırmaya yeni modüllerden başla. Tüm eski Rust hata API'sini aynı committe kırma; geçiş adaptörü kullan.

Kabul/test: TR/EN anahtar kontrolü, dil değişimi E2E; ağ kapalı temel dosya akışı; açılışta font isteği yok. Erişilebilirliğin tam testi Q03'tedir; bu görev onu tamamlanmış saymaz.
