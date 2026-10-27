# Ortak depolama: library.db (Plan 13/L01)

Plan: [13-kutuphane-muzik-ag-ve-sonraki-faz.md](plans/13-kutuphane-muzik-ag-ve-sonraki-faz.md) (L01) · Özgün plan: [05-kutuphane-muzik-ag.md](plans/05-kutuphane-muzik-ag.md)

Kod: `src-tauri/src/storage/{mod,migrations,library,identity}.rs`, `src/core/library.js`, `src/core/library-db.js`.
Testler: `cargo test --release --lib storage`, `tests/unit/library-db.test.mjs`, `tests/e2e/storage.e2e.mjs`.

## Dosyalar ve sorumluluk

| Dosya | İçerik | Sahibi |
|---|---|---|
| `library.db` (+ `-wal`, `-shm`) | Medya kimlikleri, son açılanlar, kaldığı yer, yer imleri, favoriler; ileride kütüphane/müzik/iş kuyruğu | Rust `storage` modülü |
| `settings.json` | Yalnızca ayarlar (değişmedi) | `src/core/settings.js` (tauri-plugin-store) |
| `library.json` | **Eski biçim.** Bir kez içe aktarılır, sonra yazılmaz ve silinmez | yalnızca okuma (göç) / yedek depo |
| `backups/` | `library-v{şema}-{unix ms}-{neden}.db` (son 5), `library.json.{ms}.pre-db.bak`, `settings.json.{ms}.pre-db.bak` | `storage` modülü |
| `library.db.corrupt-{ms}` | Bozuk bulunan veritabanı (silinmez, incelemek için) | `storage` modülü |

Hepsi veri klasöründedir: `platform::data_dir` (uygulama yapılandırma klasörü; testlerde `VHO_DATA_DIR`). Plan 05'teki `app_data_dir/library.db` ile aynı klasör (Windows'ta ikisi aynı yerdir); ayarların yanında olması test izolasyonunu tek değişkenle sağlar. Küçük resim/önbellek dosyaları veritabanına blob olarak konmaz; `artifacts.path` / `media.thumb` yol veya küçük data URL tutar.

## Bağlantı ve iş parçacığı modeli

- Tek okuma/yazma bağlantısı (`Mutex<Connection>`), uygulama durumunda `StorageState` içinde; ilk `library_load` çağrısında açılır (başlangıcı bekletmez). Komutlar `spawn_blocking` ile ana iş parçacığı dışında çalışır.
- `PRAGMA journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5s`.
- API (A02/L02 için):
  - `Storage::read(|conn| ...)` — işlem dışı okuma.
  - `Storage::write(|tx| ...)` — tek **IMMEDIATE** işlem; hata = tamamen geri alma.
  - `Storage::write_batches(items, n, |tx, item| ...)` — büyük tarama/içe aktarmada `n` öğelik kısa işlemler; kesilirse tamamlanan partiler tutarlı kalır.
  - `Storage::open_reader()` — işçi iş parçacığı için ayrı salt okunur bağlantı (WAL sayesinde yazıcıyı engellemez).
  - `Storage::backup_now(neden)` — sürümlü çevrimiçi yedek.
  - `library::upsert_media(conn, path, url, kind, name)` — yol/URL için medya satırı bulur ya da UUID ile oluşturur.
  - `identity::{normalize_path, FileIdentity::of, match_moved, CaptureTime}` — kimlik yardımcıları (aşağıda).
- Ön yüz: `library_load` → `{ doc, report }`, `library_save(doc)` (tek işlem). `library.js` belgeyi bellekte tutar ve 800 ms gecikmeli kaydeder (eski davranış).

## Göçler (tek sahip)

`migrations.rs` içindeki `MIGRATIONS` listesi şemanın tek sahibidir. Her adım kendi IMMEDIATE işleminde `schema_migrations` satırı ve `PRAGMA user_version` ile birlikte uygulanır; yarıda kesilen adım tamamen geri alınır ve sonraki açılışta yeniden çalışır. Uygulanmış adım değiştirilmez; isim/sıra uyuşmazlığı `migrationMismatch` hatası verir.

**Yeni tablo ekleme (A02 `jobs/job_items/job_checkpoints`, L02 tarama tabloları):** listeye `Migration { version: <son+1>, name: "jobs", up: MigrationStep::Sql(...) }` ekle. Veri dönüştürmesi gerekiyorsa `MigrationStep::Rust(fn(&Transaction))`. İkinci bir göç sistemi veya liste dışında `CREATE TABLE` yok. İki dal aynı sürüm numarasını alırsa birleştirmede biri yeniden numaralanır (henüz yayımlanmadıysa); yayımlanmış numara değişmez.

Açılış sırası: bütünlük denetimi (`PRAGMA quick_check`) → gerekirse kurtarma → bekleyen göç varsa ve şema ≥ 1 ise **önce sürümlü yedek** → göçler → tek seferlik JSON içe aktarma → (7 günden eski yedek varsa / hiç yoksa ve veri varsa) dönemsel yedek.

### Yeni şema / eski uygulama

- Veritabanının şeması bu derlemenin bildiğinden yeniyse (`schema_migrations` en büyük sürüm > son göç) dosya **açılmaz, yazılmaz, düşürülmez** (`schemaNewer`). Ön yüz bu oturumda JSON depoya (`library.json`) döner ve bir kez bilgi verir (`storage.schemaNewer`). Bu durumda görülen veriler göç öncesi JSON kopyasıdır; yeni sürümde yapılan değişiklikler görünmez ama kaybolmaz.
- L01 öncesi derlemeler `library.db`'yi hiç bilmez ve `library.json`'u okur: göçten sonraki değişiklikleri göremez. Bu bilinçli bir sınırdır (çift yazma yok).

## Tablolar (şema v1)

Şema v2 (`jobs`, Plan 11/A02): `jobs`, `job_items`, `job_checkpoints`, `job_temp_dirs` ve `artifacts.job_id`; ayrıntı [jobs-api.md](jobs-api.md).


| Tablo | Amaç | Notlar |
|---|---|---|
| `schema_migrations` | Uygulanan göçler | `version`, `name`, `applied_at`, `app_version` |
| `meta` | Anahtar/değer | `legacy_json_import` (içe aktarma raporu = tek seferlik işaret), `legacy_localstorage_resume`, `legacy_localstorage_bookmarks` |
| `folders` | Klasörler | L02 izlenen klasör/favori klasör için; şimdilik boş |
| `media` | Her medya öğesi | `id` UUID (kimlik), `path` + `path_norm` (konum), `url` (akışlar), kimlik yardımcıları, çekim zamanı, `favorite`, `rating`, `thumb`, `resume_key`, `status` (`present/missing/offline/deleted`) |
| `recent` | Başlangıç ekranı listesi | `media_id`, `position`, `opened_at` |
| `resume_positions` | Kaldığı yer | `key` = oynatıcının resume anahtarı (ad+boyut veya URL), `seq` = ekleme sırası (en eski önce düşer, en çok 500); bilinen medya varsa `media_id` |
| `bookmarks` | Video yer imleri | `file_key` (= resume anahtarı), `time`, `label`, isteğe bağlı `media_id` |
| `audio_tags` | Müzik etiketleri | L03; ReplayGain etiket değerleri (dB / doğrusal tepe), LUFS ölçümü değil |
| `playlists`, `playlist_items` | Kayıtlı listeler | L02/L03; şimdiki oynatma listesi kalıcı değildi, taşınacak veri yok |
| `artifacts` | Türetilmiş dosyalar | Dışa aktarma/AI çıktısı/yan dosya yolu + JSON parametre |

Zamanlar Unix milisaniyedir (UTC). `media` silinince `recent`/`audio_tags`/`artifacts` silinir, `resume_positions`/`bookmarks`/`playlist_items` bağlantısı `NULL` olur (veri kaybolmaz).

## Dosya kimliği

- **Kimlik UUID'dir**; yol yalnızca şu anki konumdur. Yeniden adlandırma/taşıma UUID'yi değiştirmez (L02 bu eşlemeyi yapar).
- `path_norm`: ayraçlar birleşik, `.`/`..` sözcüksel çözülmüş, Windows'ta `\\?\` öneki kaldırılmış ve küçük harf (NTFS büyük/küçük harf duyarsız). macOS'ta Unicode NFC/NFD farkı henüz normalleştirilmiyor (P02 ile ele alınacak).
- Platform kimliği: Windows birim seri no + dosya indeksi (`GetFileInformationByHandle`, yalnızca meta veri erişimi, tüm paylaşım kipleri), Unix `st_dev` + `st_ino`. Aynı birimde taşımayı kanıtlar.
- `size` + `mtime_ns` yalnızca hızlandırıcıdır. `match_moved` sonucu: platform kimliği veya içerik özeti tek adayla eşleşirse `Same`; yalnızca boyut+zaman benzerliği `Ambiguous` döner — **aynı ad/boyutlu farklı dosyalar otomatik birleştirilmez**; özet hesaplama veya kullanıcı seçimi gerekir.
- Çekim zamanı: `taken_local` kameranın yerel saati olarak saklanır; `taken_offset_min` yalnızca dosya bildiriyorsa (EXIF `OffsetTimeOriginal`) dolar; `taken_utc` yalnızca ofset biliniyorsa hesaplanır. Bilinmeyen saat dilimi UTC sayılmaz (`CaptureTime`).

## Eski verinin göçü

| Kaynak | Hedef | Kim, ne zaman |
|---|---|---|
| `library.json` → `recent` | `media` + `recent` | Rust, ilk açılışta, tek işlemde |
| `library.json` → `resume` (sıra korunur), `legacyMigrated` | `resume_positions`, `meta` | Rust, aynı işlem |
| `settings.json` → `actions.favorites.paths` (Plan 06 favorileri) | `media.favorite` | Rust, aynı işlem; ayar değeri dokunulmadan kalır |
| localStorage `vho_file_*` / `vho_url_*` (çok eski kaldığı yer) | `resume_positions` | `library.js` (mevcut göç, değişmedi) |
| localStorage `vho_bm_*` (yer imleri) | `bookmarks` | `library.js` `migrateLegacyBookmarks`, önce depoya yazılır, sonra eski anahtarlar silinir |

Kurallar: içe aktarmadan önce JSON dosyalarının bayt kopyası `backups/` içine alınır; içe aktarma tek işlemdir ve **commit öncesinde doğrulanır** (her eski son açılan, kaldığı yer değeri ve favori veritabanında aynı değerle bulunmalı; aksi halde geri alınır, `importVerify`). İşaret (`meta.legacy_json_import`) aynı işlemde yazılır; bu yüzden yarıda kesilen içe aktarma iz bırakmaz ve sonraki açılışta yeniden çalışır, tamamlanmış olan tekrar çalışmaz. Eski dosyalar silinmez. Okunamayan JSON uyarıyla atlanır (kopyası yine alınır). Fotoğraf Stüdyosu klasör favorileri (`photo.studio.favorites`) şimdilik ayarlarda kalır; L02'de `folders.favorite`'e taşınır.

## Bozulma ve kurtarma

1. Açılışta `quick_check` başarısızsa veya dosya veritabanı değilse dosya (ve `-wal/-shm`) `library.db.corrupt-{ms}` adıyla kenara alınır — silinmez.
2. `backups/` içindeki en yeni **sağlam** yedek (bütünlük denetimi geçen, şeması bilinen) geri yüklenir → `report.recovered = "backup"`.
3. Sağlam yedek yoksa yeni veritabanı oluşturulur; içe aktarma işareti olmadığından `library.json`/favoriler yeniden içe aktarılır (yeniden indeksleme) → `"fresh"`.
4. Ön yüz bir kez bildirir (`storage.recoveredBackup` / `storage.recoveredFresh`). Kilitli dosya, izin hatası gibi bozulma olmayan hatalarda dosyaya dokunulmaz; ön yüz o oturum JSON depoyla çalışır (`storage.unavailable`).

Yedekler SQLite çevrimiçi yedek API'siyle alınır (WAL içeriği dahil tutarlı), `journal_mode=DELETE` ile tek dosya halinde ve bütünlük denetiminden sonra yerine taşınır; en yeni 5 veritabanı yedeği tutulur.

## Lisans

`rusqlite` 0.40.2 (MIT, 2026-08-08 sürümü, sabitlenmiş), `libsqlite3-sys` 0.38.x (MIT) ve paketlenmiş SQLite (kamu malı), `uuid` (MIT OR Apache-2.0). Bildirimler `legal/generate-notices.ps1` ile üretilir.

## Sınırlar / sonraki işler

- L02: klasör tarama, `status` güncellemesi, taşıma eşlemesi (`match_moved` + özet), oynatma listeleri, yeniden adlandırma/silmede favori ve kaldığı yerin medya kimliğine bağlanması (şimdilik yol bazlı, eskisi gibi).
- A02: iş kuyruğu tabloları göç listesine eklenir; işçiler `open_reader` + kısa `write` işlemleri kullanır.
- Kaydetme şimdilik belge bazlıdır (son açılanlar ≤20, kaldığı yer ≤500 satır tek işlemde yeniden yazılır); L02'de satır bazlı komutlara geçilebilir.
- macOS/Linux'ta platform kimliği kodu derlenir ama bu dalda yalnızca Windows'ta test edildi.

## Kütüphane (şema v3 `library`, Plan 13/L02)

Kod: `src-tauri/src/library/{mod,scan,watch,ops,folders,query,playlist}.rs`, ön yüz `src/core/library-api.js`, `src/library/*`, Fotoğraf Stüdyosu `src/studio/studio.js`. Testler: `cargo test --release --lib library`, `tests/unit/library-l02.test.mjs`, `tests/e2e/library.e2e.mjs`.

**Birleştirme notu:** v2 A02'nin (`jobs`, ayrı dal). Bu dalda listenin kesintisiz kalması için v2 yerinde `jobs-pending-merge` adlı boş bir yer tutucu var; birleştirmede A02'nin gerçek v2'si onun yerine konur. Yer tutucuyu uygulamış bir test veritabanını birleşik derleme `migrationMismatch` ile reddeder (A02'yi sessizce atlamaz).

| Ek | Amaç |
|---|---|
| `folders.status` (`online/offline/missing`), `file_count`, `scan_error` | Kütüphane klasörü (`watched=1`) ve Fotoğraf Stüdyosu favori klasörü (`favorite=1`) aynı satırda |
| `media.in_library`, `missing_since`, `play_count`, `last_played_at` | Taramada bulunan öğe (bir kez açılan dosya 0), kayıp zamanı, akıllı listeler |
| `media_tags(media_id, tag, tag_norm)` | Kullanıcı etiketleri (büyük/küçük harf duyarsız; ilk yazım korunur) |
| `media_ops` | Dosya sistemi işlemi kaydı (`rename/move/trash`, `pending/done/failed`, eski/yeni yol ve kaldığı yer anahtarı) |
| `media_fts` (FTS5, `unicode61 remove_diacritics 2`) | Ad / başlık / sanatçı / albüm / etiket araması; tetikleyicilerle aynı işlemde güncellenir; Türkçe `ı/İ` → `i` katlanır. Anlamsal (AI) arama değildir |

**Kütüphaneye ekle ≠ göz at:** Yalnızca Kütüphane > Klasör ekle (veya Ayarlar > Kütüphane) kalıcı tarama başlatır. Fotoğraf Stüdyosu'nda klasöre göz atmak veya dosya açmak kütüphaneye eklemez; kullanıcının seçmediği disk taranmaz. Aynı klasör ikinci kez eklenirse `exists`, kütüphane klasörünün alt klasörü `covered`; üst klasör eklenirse alttakiler onunla birleşir.

**Tarama (doğruluk kaynağı):** Dizinler gezilir, `media` satırlarıyla karşılaştırılır, yalnızca farklar 500'lük kısa işlemlerle yazılır (değişmeyen dosyaya yazma yok; 5.200 dosyalık ikinci tarama ~40 ms). Yeni dosya önce kaybolan satırlarla eşleştirilir: aynı birim + dosya kimliği = taşıma/yeniden adlandırma (UUID ve bağlı favori/yıldız/etiket/kaldığı yer korunur, `media_ops`'a `move` yazılır); yalnızca boyut+zaman benzerliği birleştirilmez. Kaybolan dosya `missing` (veri korunur, geri gelirse `present`), Geri Dönüşüm Kutusu'na taşınan `deleted` (yalnızca D1). Kök erişilemezse: birim/paylaşım yoksa klasör ve öğeleri `offline` (asla `missing` değil), birim var ama klasör yoksa `missing`. Sınırlar: sembolik bağlantı/junction izlenmez (döngü yok), derinlik 48, tarama başına 400.000 dosya; kesilen/sınırlanan tarama hiçbir şeyi `missing` yapmaz; erişim reddedilen dizinin öğelerine dokunulmaz; gizli/geçici/yarım dosyalar (`.part`, `~$`, `.crdownload`, 0 bayt) atlanır. İptal edilen taramada tamamlanan partiler tutarlıdır. Ses dosyalarının metin etiketleri (lofty, kapak okunmadan) ikinci aşamada `audio_tags`'e yazılır.

**İzleme:** `notify` (CC0-1.0) yalnızca hızlandırıcıdır; olaylar 0,7 sn sessizlik (en çok 4 sn) sonra değişen dizinlerin taramasına dönüşür, taşma/hata tam uzlaştırma ister. Kaçan olayları açılıştaki, dönemsel (Ayarlar > Kütüphane: 15/30/60/240 dk, kapalı) ve elle (Şimdi tara) uzlaştırma düzeltir. Çevrimdışı klasörler 20 sn'de bir denetlenir; geri gelince taranır.

**D1 olayları:** `file_rename` / `file_trash` komutları `library::tracked_rename/tracked_trash` ile sarılır: önce `pending` kayıt, sonra disk işlemi, sonra tek işlemde medya satırı + kaldığı yer anahtarı (`vho_file_<ad>_<boyut>`, `video-player.js resumeKey` ile aynı biçim) + yer imleri + kayıt `done`. Arada çökme olursa açılışta `reconcile_pending` diske bakarak tamamlar ya da `failed` yapar. Ön yüz belgesi (`library.js applyMove`) aynı anda güncellenir; geride kalmış bir belge kaydı (`save_doc`) eski yol/anahtarı `media_ops` üzerinden yeni konuma eşler, eski yolda hayalet satır oluşmaz. Tarama sırasında bulunan taşımalar `library-changed` olayıyla ön yüze bildirilir.

**Ortak sorgu (`library_query`):** tür (video/ses/görüntü), görünüm (`all/continue/recentlyAdded/favorites/rated/mostPlayed/missing`), FTS araması, klasör, etiket, en az yıldız, sanatçı/albüm/tür, sıralama, sayfa (≤500). “Devam et” kaldığı yer anahtarını ad+boyuttan hesaplar. L03 için `library_music_groups` (sanatçı/albüm/tür). Fotoğraf Stüdyosu yıldız (0–5 tuşları), etiket (⋯ > Etiketler) ve “en az yıldız” süzgeci aynı tabloları kullanır; favori klasörler `folders.favorite`'e bir kez taşınır (`meta.legacy_studio_favorites`; ayar değeri dokunulmadan kalır).

**Oynatma listeleri:** `playlists/playlist_items` medya kimliğine bağlıdır (yeniden adlandırılan dosya listedeki yerinde kalır). M3U/M3U8/PLS okuma: UTF-8 (BOM'lu/BOM'suz), UTF-16 BOM, aksi halde Windows-1254; göreli yollar listenin klasörüne göre, `file://` URI'leri çözülür; eksik dosyalar sırasıyla kalır ve işaretlenir. Uzak URL'ler yalnızca saklanır — içe aktarma hiçbir şey indirmez/çalıştırmaz; yalnızca akış şemaları (http(s), rtsp, rtmp, mms, srt, udp…) kabul edilir, diğerleri (`javascript:`, `data:`…) atlanıp sayılır. Yazma: `.m3u8` BOM'suz UTF-8, `.m3u` BOM'lu UTF-8, `.pls` UTF-8; aynı birimdeyse göreli yol. 16 MB / 100.000 öğe sınırı.

**Sınırlar:** video süresi/çözünürlüğü taranmaz (oynatınca dolar); EXIF çekim zamanı kütüphaneye yazılmaz (stüdyo kendi okur); belirsiz taşımalar için içerik özeti hesaplanmıyor (eski satır `missing` kalır, yenisi eklenir); macOS NFC/NFD ve Unix çıkarılabilir disk algısı (`/media`, `/mnt`, `/run/media`, `/Volumes`) yalnızca kodda, test edilmedi.
