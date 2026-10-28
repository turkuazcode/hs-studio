# Q04 — Medya, IPC ve mahremiyet incelemesi

**Tarih:** 2026-10-27 · Kart: [14/Q04](../plans/14-kalite-ve-acik-kaynak-yayin.md) · Dal: `wave3/e6-q03` (E6)

> **English summary:** One review pass over the Tauri IPC surface, media parsing and privacy.
> Fixed: the generic mpv bridge (could start processes via mpv `run`/`subprocess`, load scripts,
> write files, open an IPC pipe) is now an allowlist; images larger than 268 MP are refused from
> the header (decompression bombs); an AppleScript injection in the macOS wallpaper path; a
> thumbnail error was put into markup. Added: cache size/clear controls that keep files in use,
> a privacy/CSP unit test, an OSV dependency audit. Closed later (2026-10-28, `wave4/q04-paths`):
> write/delete/rename/tag/export commands only touch paths the user chose (path grants, §3.6).
> This is a review, not a security certification.

## 1. Tehdit modeli

- Arayüz yerel, paketlenmiş HTML/JS'dir. Capability (`src-tauri/capabilities/default.json`) yalnızca uygulama
  penceresine verilir; `remote` alanı yok, uzak sayfa IPC çağıramaz. CSP: `script-src 'self' 'wasm-unsafe-eval'`
  (satır içi betik ve `eval` yok), `connect-src` yalnızca `self`/IPC/asset. `tests/unit/privacy.test.mjs` bunları denetler.
- Saldırgan girdisi: kullanıcının açtığı medya dosyaları (dosya adı, etiket, EXIF, altyazı, çalma listesi), ağ URL'leri,
  indirilen model arşivleri. Asıl risk: bu girdiden webview'e HTML enjeksiyonu → IPC kötüye kullanımı, ya da Rust/ffmpeg/mpv
  ayrıştırıcılarında bellek/zaman tüketimi.
- Kapsam dışı: yerel yönetici, değiştirilmiş kurulum dosyaları, işletim sistemi codec'lerinin (WIC/Media Foundation) kendi açıkları.

## 2. IPC komut envanteri (117 komut)

Sınıf: **O** okuma · **Y** kullanıcının seçtiği yere yazma/değiştirme · **S** sistem eylemi (`actions::gate`, testte
`VHO_DISABLE_SYSTEM_CHANGES` ile yalnızca günlüğe) · **A** ağ (yalnızca kullanıcı eylemi) · **D** uygulamanın kendi
veri/önbellek klasörü.

| Grup | Komutlar | Sınıf | Argüman denetimi / koruma |
|---|---|---|---|
| Oynatma motoru | `engine_status`, `engine_get`, `engine_show`, `engine_thumbnail`, `engine_screenshot` | O / D | Ekran görüntüsü yalnızca uygulamanın klasörüne, sabit ad kalıbıyla |
| Oynatma motoru (genel köprü) | `engine_load`, `engine_command`, `engine_set` | — | **Q04'te izin listesi** (`src-tauri/src/engine/policy.rs`, §3.1) |
| Uygulama | `suspend_system`, `get_compat_mode`, `set_compat_mode`, `prepare_media`, `initial_files`, `probe_media`, `transcode_media`, `cancel_transcode`, `platform_capabilities`, `settings_dir`, `open_default_apps_settings` | S / D / O | Uyku: `VHO_DISABLE_SYSTEM_SUSPEND` + E2E sarmalayıcı; dönüştürme çıktısı önbellekte, hash adı |
| Güncelleme | `updater_check`, `updater_install` | A | Varsayılan kapalı, uç nokta boş, `requireSignedVersion`, minisign imzası (R02) |
| AI bileşenleri | `ai_status`, `ai_status_all`, `ai_install`, `ai_cancel_download`, `ai_verify`, `ai_remove`, `ai_acquire`, `ai_release` | A / D | Yalnızca manifestteki sabit URL'ler; boyut + SHA-256; zip: yol kaçışı/symlink/bomba reddi (`ai::tests::zip_rejects_*`); kullanımdaki model lease ile korunur |
| Fotoğraf | `photo_scan`, `photo_list_dirs`, `photo_thumb(s)`, `photo_info`, `photo_decode`, `photo_capabilities`, `photo_batch`, `photo_cancel` | O / D / Y | Toplu iş: ayrı çıktı, üzerine yazmayan ad; **Q04: 268 MP üstü görüntü başlıktan reddedilir**; `photo_batch` çıktı klasörü (ve taşımada kaynaklar) yol izni ister (§3.6) |
| Dosya eylemleri | `file_trash`, `file_rename`, `file_properties`, `export_dir` | Y / O | Silme yalnızca Geri Dönüşüm Kutusu'na; yeniden adlandırma ayırıcı/ayrılmış ad/çakışma denetimi; kütüphane işlem kaydı; silme/yeniden adlandırma yol izni ister (§3.6) |
| Dosya diyalogları (**yeni**) | `dialog_open`, `dialog_save` | Y (izin kaynağı) | Diyaloğu Rust gösterir; seçilen yollar yol izni olur. Eklentinin JS komutları (`dialog:allow-open/save`) yetenekten kaldırıldı (§3.6) |
| Sistem eylemleri | `file_reveal`, `file_open_with`, `file_share`, `set_wallpaper`, `system_action_allowed`, `actions_system_log`, `actions_capabilities` | S | `actions::gate`; yol `canonicalize` + dosya olmalı; argv ile çağrı (kabuk yok); **Q04: macOS AppleScript tırnaklama düzeltildi** |
| Pano | `clipboard_*` (8) | O / Y | Görüntü verisi boyut sınırlı base64; meşgul pano yeniden deneme + kodlu hata |
| OCR, ffmpeg işleri, etiketler | `ocr_image`, `ocr_languages`, `media_tools`, `media_probe`, `media_job`, `media_job_cancel`, `replaygain_analyze`, `tags_read`, `tags_write`, `tags_save_cover`, `lyrics_read` | Y / O | ffmpeg argv (kabuk yok), `.part` dosyası + yerleştirme, iptalde süreç öldürülür, Windows'ta job object ile uygulama kapanınca alt süreç de kapanır; `media_job` çıktısı, `tags_write`, `replaygain_analyze`/`replaygain_album` yazımı, `tags_save_cover` yol izni ister (§3.6) |
| Kalıcı depolama, işler | `library_load`, `library_save`, `jobs_*` (15) | D / Y | Tek göç sahibi; iş başına geçici klasör, `jobs_output_copy` üzerine yazmaz; `jobs_submit` (`export`, `photo-batch`) ve `jobs_output_copy` hedefi yol izni ister (§3.6) |
| Kütüphane | `library_*` (24) | O / D / Y | Klasör ekleme yalnızca kullanıcı seçimiyle (**Q04: izinli klasör şartı arka uçta denetlenir**); `library_playlist_export` yol izni ister; symlink/junction izlenmez; çalma listesi içe aktarmada yalnızca akış şemaları (`javascript:`, `data:` vb. atlanır), 16 MB / 100.000 öğe sınırı |
| Restorasyon | `restoration_probe`, `restoration_recipe` | O | ffprobe/ffmpeg argv |
| Önbellek (**Q04 yeni**) | `cache_usage`, `cache_clear` | D | Yalnızca 3 sabit tür; kullanımdaki ve yazılmakta olan dosya atlanır |
| Cihaza yayın (**L04**) | `cast_discover`, `cast_start`, `cast_control`, `cast_status` | A | Yalnızca kullanıcı “Cihaza yayınla…” diyaloğunu açınca; SSDP yanıtındaki `LOCATION` ve denetim URL'leri yanıtın geldiği IP'de olmalı; XML 256 KB / 5 s, `<!DOCTYPE` reddedilir; dosya sunucusu tek dosya + 128 bit belirteç, durdurunca kapanır; güvenlik duvarı değiştirilmez ([network.md](../network.md)) |

## 3. Bulgular ve düzeltmeler

### 3.1 Genel mpv köprüsü (yüksek → düzeltildi)

`engine_command` / `engine_set` / `engine_load` webview'den gelen her şeyi libmpv'ye geçiriyordu. mpv'de `run` ve
`subprocess` süreç başlatır; `load-script`, `load-config-file`, `scripts`, `include` betik/yapılandırma yükler;
`screenshot-to-file`, `dump-cache`, `stream-record`, `log-file` dosya yazar; `input-ipc-server` adlandırılmış kanal açar;
lavfi `movie=` / `amovie=` / `sendcmd` dosya okur. Webview'e bir HTML enjeksiyonu bunları tek çağrıyla kullanabilirdi.

Şimdi yalnızca arayüzün kullandıkları geçer: komutlar `stop`, `seek`, `frame-step`, `frame-back-step`, `sub-add`
(var olan mutlak dosya yolu), `apply-profile fast`; ayarlanabilir özellikler sabit liste; `af` yalnızca
`lavfi=[highpass|lowpass|equalizer|acompressor|dynaudnorm|volume|alimiter]` ve düz sayı/kelime argümanları,
`vf` yalnızca `hflip`/`vflip`; `engine_load` var olan yerel dosya veya çalma listesiyle aynı akış şemaları
(`lavfi://`, `av://`, `memory://`, `edl://`, `ytdl://`, `file://` reddedilir). Okuma (`engine_get`) açık kalır.
Arka ucun kendi çağrıları (ekran görüntüsü, kapatma, başlangıç seçenekleri) bu denetimden geçmez.
Test: Rust `engine::policy::tests` (izinli/izinsiz 50+ durum), E2E `security.e2e`.

### 3.2 Sıkıştırma bombası (orta → düzeltildi)

`image` çözücüsünün tek sınırı 4 GB ayırmaydı: 70 baytlık bir PNG 20000×20000 (1,6 GB) ayırtabiliyordu. Artık başlık
okunur okunmaz 2^28 piksel (268 MP, 16384×16384) üstü `[unsupported]` ile reddedilir; JPEG küçültülmüş çözme yolu da
aynı denetimi yapar. Test: `photo::decode::tests::photo_decode_rejects_decompression_bombs_before_allocating`
(20000², 65535², 1×2^31, başlığı 65000² yapılmış JPEG; < 2 s), E2E `security.e2e`. Bozuk EXIF: 200 rastgele bozulmuş /
kesilmiş EXIF bloğu çökmeden okunur (`photo_decode_survives_truncated_and_corrupt_exif`).

### 3.3 macOS duvar kâğıdı AppleScript enjeksiyonu (yüksek, yalnızca macOS → düzeltildi)

Yol AppleScript dizgesine yalnızca `"` kaçışlanarak konuyordu; `a\" & do shell script "…` gibi bir dosya adı komut
çalıştırabilirdi. Ters bölü önce kaçışlanıyor (`applescript_string`). Test: `actions::system::tests` (Windows'ta da çalışır).
macOS cihazında denenmedi.

### 3.4 Küçük resim hata metni HTML'e konuyordu (düşük → düzeltildi)

`src/studio/grid.js` hata metnini (dosya adı içerebilir) yalnızca `"` kaçışlayarak `title="…"` içine yazıyordu; artık özellik
olarak atanıyor. Diğer `innerHTML` kullanımları (15) yalnızca sabit şablon/ikon içeriyor; kullanıcı verisi `textContent` ile.

### 3.5 Önbellek temizleme (eksikti → eklendi)

Ayarlar > Genel > Önbellek: fotoğraf küçük resimleri/önizlemeleri, video küçük resimleri, dönüştürülmüş videolar için ayrı
boyut ve "Temizle". Yazılmakta olan (`.part.`) ve başka bir tutamacın açık tuttuğu dosya (Windows'ta paylaşımsız açma
denemesi) silinmez; diğer platformlarda son 10 dakikada değişen dosya korunur. AI modelleri önbellek değil: Ayarlar > AI
modelleri'nde, kullanımdaki model lease ile korunarak kaldırılır. Test: Rust `cache::tests`, E2E `security.e2e`.

### 3.6 Yol izinleri: yazma/silme komutları yalnızca kullanıcının seçtiği yerlere (orta → düzeltildi, 2026-10-28)

Önceden `file_trash`, `file_rename`, `tags_write`, `media_job` çıktısı, `library_playlist_export` vb. webview'in gönderdiği
her yolu kabul ediyordu. Artık arka uçta tek bir yol izni kaydı var (`src-tauri/src/grants.rs`). İzin kaynakları yalnızca
webview'in taklit edemeyeceği yerlerdir:
- Rust'ın gösterdiği aç/kaydet/klasör diyalogları (`dialog_open`, `dialog_save`). Eklentinin JS komutları yetenekten
  kaldırıldı; arayüz aynı seçenek ve sonuçlarla bu komutları çağırır.
- İşletim sisteminin verdiği dosyalar: komut satırı / "Birlikte aç" / ikinci örnek / macOS açma olayı (`deliver_files`,
  `initial_files`).
- Pencereye bırakılan dosyalar (Tauri `DragDrop` olayı, Rust'ta).
- Kütüphane klasörleri (`library.db`; yeni klasör eklemek de izinli bir klasör ister).
- Uygulamanın kendi klasörleri (veri, önbellek, `<Videolar|Resimler|Müzik>\HS Studio`).

Kapsam: açılan dosya için dosyanın kendisi ve **bulunduğu klasör** (alt klasörleri değil: fotoğraf/oynatma listesinde
yanındaki dosyalara geçilir, dışa aktarma varsayılanı o klasördür); seçilen klasör ve kütüphane klasörü için **altındaki her
şey**; kaydetme hedefi için dosya ve klasörü. Kullanıcı kaynaklı izinler veri klasöründeki `grants.json`'a yazılır (en çok
2.000; webview'in yazabildiği bir dosya değil), böylece yeniden açılışta korunur. Son açılanlar listesi (`library.json`,
webview yazar) bilerek izin kaynağı **değildir**.

Kayıtta olmayan bir yol için kullanıcıya bir kez **yerel onay penceresi** sorulur (TR/EN, "İzin ver / İptal"): örneğin
Fotoğraf Stüdyosu'nun klasör ağacında gezilen ve diyalogla seçilmemiş bir klasörde ilk silme. "İzin ver" o klasöre bu oturum
boyunca izin verir (kalıcı değil); "İptal" `[path-not-granted]` döner (TR/EN metin; işler için `pathNotGranted`). Pencereyi
Rust gösterir, webview yanıtlayamaz. Testlerde soru gösterilmez: `VHO_GRANT_PROMPT=allow|deny` (E2E varsayılanı `allow`,
güvenlik testi `deny`).

Denetim kanonik yolda yapılır: `..`, sembolik bağ/junction, 8.3 kısa ad, `\\?\` öneki ve (Windows'ta) harf büyüklüğü
hedefi izinden çıkaramaz. Silme/yeniden adlandırma girdinin kendisine bakar (bağın bulunduğu klasör), etiket yazma bağın
hedefine; henüz olmayan çıktı yolunun eksik kısmında `..` reddedilir; göreli yollar reddedilir.

Kapsanan komutlar: `file_trash`, `file_rename`, `tags_write`, `tags_save_cover`, `replaygain_analyze` / `replaygain_album`
(yazarken), `media_job`, `photo_batch` (çıktı klasörü; `removeSource` ile kaynaklar), `jobs_submit` (`export`,
`photo-batch`), `jobs_output_copy`, `library_playlist_export`, `library_add_folder`. Okuma komutları bu kapsamda değildir.
Testler: Rust `grants::tests` (dosya/klasör/ağaç kapsamı, `..`/göreli yol, harf/`\\?\`/eğik çizgi/kısa ad, junction
kaçışı, sürücü kökü); E2E `security.e2e` "path grants" (komut satırıyla açılan dosyanın klasörü dışındaki her yazma reddedilir
ve hiçbir dosya değişmez; junction/`..`/göreli yol; aynı klasörde yeniden adlandırma, toplu iş, liste dışa aktarma çalışır;
izin yeniden açılışta korunur).

## 4. Açık riskler (kabul edilen / sonraki iş)

| Risk | Önem | Durum |
|---|---|---|
| ~~Yazma/silme komutları webview'in gönderdiği her yolu kabul ediyor~~ | Orta | **Kapatıldı** (2026-10-28, §3.6). Kalan: onay penceresinde "İzin ver" denirse o klasör oturum boyunca yazılabilir (bilinçli kullanıcı kararı); okuma komutları (`photo_scan`, `prepare_media` vb.) yol izni istemez ve varlık protokolüne dizin açar |
| Kullanıcının açtığı bir dosyanın klasörü (alt klasörleri değil) kalıcı olarak yazılabilir | Düşük | Kabul: fotoğraf/oynatma listesinde yanındaki dosyalara geçiş ve "kaynak klasöre dışa aktar" bunu gerektirir. `grants.json` silinirse izinler sıfırlanır |
| `img-src`/`media-src` `https:`/`http:` içeriyor (URL ile açılan medya ve harita karoları için) | Düşük (izleme pikseli için HTML enjeksiyonu gerekir) | Kabul. `connect-src` yerel kaldığı için sayfa betikleri uzak sunucuya veri gönderemez |
| mpv/ffmpeg ayrıştırıcıları (LGPL derleme) | Bilinmiyor | Sürümler `legal/inventory` içinde; güncelleme takvimi R02/P05. Bulanık test (fuzzing) eklenmedi |
| `engine_get` açık | Düşük (okuma) | Kabul |

## 5. Mahremiyet

- **Telemetri yok.** Uygulama kaynağındaki her uzak ana bilgisayar `tests/unit/privacy.test.mjs` içinde gerekçesiyle
  listelenir: AI model indirmeleri (Hugging Face, jsDelivr, GitHub raw, Qualcomm AI Hub S3 — A06 DDColor zipi — yalnızca Ayarlar > AI modelleri / ilk kullanım onayı),
  harita karoları (yalnızca kullanıcı haritayı açınca), altyazı arama sayfası (sistem tarayıcısında). Yeni bir ana bilgisayar
  testi düşürür. Açılışta dış istek olmadığını `i18n-offline.e2e` kanıtlar. Medya hiçbir zaman buluta gönderilmez.
- **Ağ akışları ve yayın (L04):** yerel ağ adresleri (RFC 1918) testte kapsam dışıdır (kullanıcının seçtiği UPnP cihazı). Akış
  URL'lerindeki parola/belirteç günlükte `***` olur, son açılanlara yazılmaz, kaldığı yer anahtarında saklanmaz
  (`network.e2e` veri klasörünü tarar). UPnP keşfi yalnızca kullanıcı isteyince; DIDL-Lite/SOAP namespace URI'leri (`purl.org`,
  `schemas.xmlsoap.org`) istek yapılmayan sabitlerdir.
- Güncelleme denetimi varsayılan kapalı, uç nokta boş.
- **Tanı bilgisi:** Ayarlar > AI modelleri yalnızca arka uç, karo boyutu ve hata sınıfını gösterir (yol/görüntü yok). Pano
  hatası tutan uygulamanın yalnızca exe adını verir (tam yol değil). Dışa aktarılan bir tanı raporu yok; eklenirse
  varsayılan olarak yol, GPS, belirteç ve görüntü içermemeli ve gönderilmeden önce önizlenmeli.
- AI çıktısında GPS politikası (koru / GPS'siz / hiç) A04'te.

## 6. Bağımlılık taraması

Araç: `npm run audit:deps` (`scripts/audit-deps.mjs`): `Cargo.lock` + `package-lock.json` paketlerini OSV.dev'de
(RustSec + GitHub advisories) sorgular; yalnızca paket adı ve sürüm gönderilir. Ağ ister, `npm test`e dahil değil.
cargo-audit/cargo-deny kurulmadı (ek araç gerekmedi). 2026-10-27: 684 paket (631 crate, 53 npm), 11 kayıt:

| Paket | Kayıt | Kim getiriyor | Erişilebilirlik / karar |
|---|---|---|---|
| `zip` 4.6.1 | RUSTSEC-2026-0367/0368/0369 (Unix SUID/symlink/izin çıkarma) | `tauri-plugin-updater` | Sorunlar Unix çıkarmada; Windows'ta NSIS kurulum dosyası indirilir ve önce imza doğrulanır. Kendi model arşivlerimiz `src/ai/zip.rs` ile açılır (symlink reddi). Düşük; updater yükseltmesi zip ≥ 9 içerdiğinde güncellenecek |
| `block-buffer` 0.10.4 | GHSA-qwgh-2vcv-g2f7 (geri çağırmada panik sonrası tampon) | `sha2` 0.10 | Panik sonrası aynı hasher yeniden kullanılmıyor. Düşük |
| `glib` 0.18.5 | RUSTSEC-2024-0429 (unsound `VariantStrIter`) | gtk (yalnızca Linux) | Bu API kullanılmıyor; Windows derlemesinde yok. Düşük |
| `paste`, `proc-macro-error` | bakımsız | lofty/rav1e, glib-macros | Yalnızca derleme anı makroları. Bilgi |
| `zbus_names`, `zvariant`, `zvariant_derive` | bakımsız | D-Bus (Linux) | Windows derlemesinde yok. Bilgi |

Erişilebilir kritik/yüksek bulgu yok. npm paketleri yalnızca geliştirme araçları (gönderilmez); kayıt yok.

## 7. Kalan

- Bulanık test altyapısı, altyazı/çalma listesi için ek düşmanca fixture'lar (çalma listesi
  şema reddi L02 testlerinde var).
- macOS/Linux'ta hiçbir Q04 denetimi cihazda çalıştırılmadı (yol izinlerinin yerel onay penceresi ve kanonikleştirme dahil).
