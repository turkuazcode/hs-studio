Plan 15 — VLC'den esinlenen özellikler: ilk üç iş ve fikir havuzu

Tarih: 3 Kasım 2026. Durum: **plan ve not**. Hiçbir madde uygulanmadı. Fikir havuzundaki maddeler kullanıcıyla ayrıca değerlendirilecek. Bu belge önceliği kendiliğinden değiştirmez.

**Kaynak:** VLC deposu (code.videolan.org/videolan/vlc), kararlı `3.0.x` dalı (son sürüm 3.0.24) ve geliştirme dalı `master` (4.0.0-dev, yayımlanmadı). Kaynak olarak modül ağacı (`modules/*`) ve iki dalın `NEWS` dosyası kullanıldı. Kod derlenmedi ve çalıştırılmadı. İki program aynı dosyalarla ölçülmedi.

## Bağlayıcı kurallar (kullanıcı kararı 2026-11-03)

1. **Her şey HS Studio'da sıfırdan yazılır.** VLC kodu kopyalanmaz, uyarlanmaz, satır satır "esinlenilerek" yeniden yazılmaz. VLC deposu yalnızca *hangi özelliklerin var olduğunu* görmek için okunur. Uygulama, kütüphanenin veya protokolün kendi belgesine ve standartlarına dayanır.
   - Gerekçe: VLC uygulaması GPLv2+ lisanslıdır (Qt arayüzü, kısayollar, Lua). libVLC ve modüllerin çoğu LGPLv2.1+ lisanslıdır. GPL kod HS Studio'yu GPL yapar. LGPL kod Apache-2.0'a çevrilemez. Ayrıca modüller VLC'nin iç API'sine (`vlc_filter.h`, `vlc_player.h`) bağlıdır ve libmpv ile çalışmaz.
2. **Üçüncü taraf kütüphane** yalnızca 00-YOL-HARITASI'ndaki lisans politikasıyla kullanılır. Kabul: MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 ve yalnızca dinamik bağlanan LGPL. Red: GPL, AGPL, ticari olmayan lisanslar. Eklenen her bağımlılık `legal/inventory`, bildirimler ve SBOM'a girer.
3. **Marka:** "VLC" adı ve koni logosu arayüzde ve tanıtımda kullanılmaz.
4. **Arayüz ilkeleri geçerli:** sık kullanılan ana ekranda, gerisi "⋯" menüsünde ve Ayarlar'da. Her medya türünün kendi ekranı var.
5. Her iş için önce kabul ölçütü ve test yazılır. Gerçek donanım gerektiren işler (GPU, ağ cihazı) "denenmedi" diye işaretlenmeden "çalışıyor" sayılmaz.

---

## Bölüm A — İlk üç iş (ayrıntılı plan)

### V01 — Arşiv içinden fotoğraf / video / müzik açma (ZIP önce)

**Neden:** Aile arşivleri sıkça ZIP olarak paylaşılır ve saklanır. Kullanıcı arşivi açmadan içine bakabilmeli. VLC'de `modules/stream_extractor/archive.c` (libarchive) var.

**Mevcut durum:**
- `src-tauri/src/ai/zip.rs`: model arşivleri için savunmacı bir ZIP okuyucu zaten yazılmış. Desteklediği: stored ve deflate, zip64, yol aşımı (path traversal) koruması, zip bombası sınırı, CRC ve boyut kontrolü. Bu kod HS Studio'nun kendisinin ve temel olarak kullanılabilir.
- libmpv derlemesinde `-Dlibarchive=disabled` (`third_party/mpv/build-windows.sh`).

**Yaklaşım (sıfırdan, kendi kodumuz):**
1. `zip.rs`'teki okuyucu genel bir modüle çıkarılır, örneğin `src-tauri/src/archive/zip.rs`. AI tarafı aynı modülü kullanır; davranışı değişmez, mevcut AI testleri bunu korur.
2. Yeni komutlar: `archive_list(path)` ve `archive_extract(path, entry)`.
   - Liste yalnızca medya uzantılarını döndürür (`classify.js` ile aynı kurallar).
   - Çıkarma, uygulamanın önbellek klasörüne geçici dosya olarak yapılır (`%LOCALAPPDATA%\com.turkuazcode.hsstudio\archive\<hash>\`). Arşiv içindeki yol hiçbir zaman dosya sistemi yolu olmaz.
   - Fotoğraflar küçük olduğu için tek tek çıkarılır. Video ve müzik ilk aşamada da çıkarılır; doğrudan akış ikinci aşamadır.
3. Arayüz:
   - Bir `.zip` açıldığında (Dosya aç, sürükle-bırak, "Birlikte aç") içindeki medya oynatma listesine girer. Listedeki öğe "arşiv.zip › klasör/foto.jpg" biçiminde görünür.
   - Fotoğraf stüdyosunda ZIP bir klasör gibi gezilebilir. Bu ikinci adım, ızgara kodunun sanal klasör desteği gerektirir.
4. Önbellek temizliği mevcut önbellek ayarlarına bağlanır (`src/ui/cache-settings.js`).
5. **Sonraki aşamalar (ayrı karar):**
   - 7z ve RAR. RAR biçimi kapalıdır. UnRAR lisansı OSI onaylı değildir, politika gereği reddedilir. Seçenekler: libarchive'i (BSD-2) ayrı DLL olarak eklemek ya da RAR'ı desteklememek.
   - Tar ve zstd kendimiz yazılabilir; zstd için `zstd` crate'i BSD/MIT lisanslıdır.

**Kabul ve testler:**
- Birim (Rust): düz, deflate, zip64, Unicode ve CP437 adlar, şifreli öğe (reddedilir ve kullanıcıya söylenir), `../` ile başlayan yol, aynı adlı iki öğe, bozuk merkez dizini, zip bombası.
- E2E: ZIP içindeki 3 fotoğraf açılır ve ‹ › ile gezilir; ZIP içindeki MP3 müzik ekranında çalar; orijinal ZIP'e yazılmaz (değiştirilme zamanı aynı kalır).
- Güvenlik: `docs/security` altındaki inceleme listesine "kullanıcı arşivi" eklenir.

**Risk:** Büyük video arşivlerinde çıkarma süresi ve disk alanı. İlk sürümde boyut sınırı ve ilerleme gösterimi olmalı.

### V02 — Ağ klasöründen / NAS'tan açma

**Neden:** Ev arşivi çoğu zaman NAS'ta (Synology vb.) ya da başka bir bilgisayarın paylaşımında durur. VLC'de `access/smb2.c` (libsmb2), `nfs.c`, `sftp.c`, `webdav.c` ve ağ keşfi modülleri var.

**Önemli bulgu:** Windows, SMB paylaşımlarını zaten normal dosya yolu olarak açar (`\\NAS\Fotoğraflar\2004\…`). `prepare_media` `std::fs::metadata` kullanıyor. Tauri asset kapsamı ve libmpv UNC yolunu açabilir; bu **denenmedi**. Bu yüzden Windows'ta ilk aşama **kütüphane eklemeden** yapılabilir.

**Aşama 1 — Windows, ek bağımlılık yok:**
1. Doğrulama: UNC yolundan video, müzik ve fotoğraf açma; Tauri asset protokolü kapsamı (`scope.allow_file`); fotoğraf stüdyosu klasör taraması; küçük resim önbelleği.
2. Arayüz: Kütüphane ve Fotoğraf Stüdyosu'nda "Ağ klasörü ekle…" seçeneği. Kullanıcı `\\sunucu\paylaşım` yazar ya da Windows klasör seçicisinden "Ağ" altındaki konumu seçer. Bağlı ağ sürücüleri (Z:) zaten normal klasör gibi davranır.
3. Dayanıklılık:
   - Ağ koptuğunda donmama: tarama ve küçük resim işleri zaman aşımıyla arka planda çalışır.
   - Plan 13/L02'deki "disk çevrimdışı" durumu ağ klasörü için de uygulanır.
   - Yavaş ağda küçük resimler önce yerel önbellekten gösterilir.
4. Kimlik bilgisi: Windows, kullanıcı adı ve parolayı kendi Kimlik Bilgisi Yöneticisi'nde tutar. HS Studio parola saklamaz.

**Aşama 2 — kendi ağ istemcimiz (ayrı karar; Linux/macOS ve bağlanmamış paylaşımlar için):**
- Paylaşımı gezmek ve keşfetmek: mDNS/Zeroconf ile NAS bulma (kendi yazımımız; standart RFC 6762/6763), UPnP/DLNA medya sunucularını gezme. Gönderme (cast) kodu `src/media/net-logic.js` içinde zaten var; keşif tarafı genişletilir.
- SMB2/3 istemcisi: sıfırdan yazmak büyük bir iştir (kimlik doğrulama, imzalama, şifreleme). Seçenekler: (a) libsmb2'yi (LGPL-2.1) ayrı DLL olarak eklemek, (b) yalnızca işletim sisteminin bağladığı paylaşımlarla yetinmek. **libsmbclient GPLv3'tür, kullanılamaz.**
- WebDAV ve SFTP: WebDAV HTTP üzerinedir ve kendimiz yazılabilir. SFTP için lisansı uygun bir Rust crate'i araştırılır.

**Kabul ve testler:**
- E2E: CI'da `\\localhost\<paylaşım>` ya da `\\127.0.0.1\C$` benzeri bir test paylaşımı açılabiliyorsa UNC yolundan oynatma ve tarama testi. Açılamıyorsa elle test kanıtı `docs/releases/evidence` altına girer.
- Ağ kopması: tarama sırasında bağlantı kesilir; uygulama donmaz ve veritabanı tutarlı kalır.

**Risk:** NAS'ların SMB sürümleri farklı. Gerçek NAS'ta deneme yapılmadan "NAS desteği" denmez.

### V03 — Oynatırken GPU ile büyütme ve SDR→HDR

**Neden:** Eski, düşük çözünürlüklü videolar büyük ekranda daha temiz görünsün; dosya üretmeden, anlık. VLC 3.0'da `d3d11-upscale-mode=super` var (NVIDIA ve Intel Super Resolution; NEWS'e göre AMD ve Moore Threads da eklendi). NVIDIA TrueHDR ile SDR'den HDR üretimi de var. 4.0'da AMD AMF ile kalite iyileştirme (`amf_vqenhancer`) ve kare hızı artırma (`amf_frc`) var.

**Mevcut durum:**
- libmpv 0.41.0, d3d11 ve libplacebo açık (`third_party/mpv/build-windows.sh`).
- `src-tauri/src/engine/policy.rs` güvenlik amacıyla yalnızca izinli mpv seçeneklerine ve filtrelerine izin veriyor. Video filtrelerinde yalnızca `hflip` ve `vflip` var.

**Yaklaşım:**
1. **Araştırma (önce):** mpv 0.41'in `d3d11vpp` filtresinde ekran kartı üreticisinin büyütme modunun (NVIDIA/Intel "super resolution") ve NVIDIA SDR→HDR seçeneğinin bulunup bulunmadığı ve adları mpv belgesinden doğrulanır. Ayrıca bu derlemede `d3d11vpp`'nin derlenip derlenmediği kontrol edilir. **Bu madde doğrulanmadan uygulamaya geçilmez.**
2. Var ise: `policy.rs` video filtre listesine yalnızca `d3d11vpp` ve yalnızca belirli parametrelerle izin verilir. Serbest metin parametre geçmez; mevcut güvenlik modeli korunur.
3. Arayüz: video ekranında "Filtreler" panelinde "Ekran kartıyla büyüt" ve "SDR'yi HDR'ye çevir" seçenekleri. Kart desteklemiyorsa seçenek gri olur ve nedeni yazılır. Bu bilgi yetenek tablosundan (`src/core/capabilities.js`) gelir.
4. AMD için: mpv'de karşılığı yoksa AMD AMF SDK'sı (MIT) ile **kendi** filtre/işlem yolumuzu yazmak ayrı bir iştir. Geliştirme makinesinde yalnızca 1 GB dahili AMD GPU var; NVIDIA ve Intel özellikleri bu makinede **denenemez**.

**Kabul ve testler:**
- Birim: politika testi. İzinli parametreler geçer; diğer `vf` komutları reddedilir.
- E2E: seçenek açılıp kapanınca mpv filtre zincirinin doğru değiştiği (`engine_get vf`).
- Gerçek donanım: NVIDIA ve Intel kartlarda elle doğrulama. Kanıt yoksa sürüm notunda "denenmedi" yazılır.

**Risk:** Sürücü sürümüne bağlı davranış; dizüstü bilgisayarlarda pil tüketimi. Varsayılan kapalı olur.

**Önerilen sıra:** V02/Aşama 1 (en ucuz, en çok fayda) → V01 (ZIP) → V03 (önce araştırma).

---

## Bölüm B — Fikir havuzu (sonra değerlendirilecek)

Sütunlar: **VLC'de** = gördüğüm modül veya NEWS maddesi. **HS Studio** = bugünkü durum: Var / Kısmen / Yok. **Olası yol** = kendi yazımımız ya da politikaya uygun kütüphane. **Not** = lisans, hukuk veya donanım uyarısı. Öncelik sütunu bilerek boş bırakıldı; değerlendirmede doldurulacak.

### B1. Kaynaklar ve erişim (VLC `modules/access`, 139 dosya)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B1.1 | Arşiv içinden oynatma (ZIP/RAR/7z/tar) | `stream_extractor/archive.c` | Yok | V01 | RAR lisansı | |
| B1.2 | SMB/NAS paylaşımı | `access/smb2.c`, `samba.c` | Yok (UNC denenmedi) | V02 | libsmbclient GPL; kullanılamaz | |
| B1.3 | NFS, FTP, SFTP, WebDAV | `nfs.c`, `ftp.c`, `sftp.c`, `webdav.c` | Yok | Kendi istemcimiz / crate | | |
| B1.4 | Ağdaki NAS ve medya sunucularını bulma (mDNS, UPnP) | `services_discovery/*` | Kısmen (DLNA'ya gönderme var) | Kendi mDNS/SSDP kodumuz | | |
| B1.5 | DVD oynatma (menülü) | `dvdnav.c`, `dvdread*.c` | Yok | Sıfırdan (UDF + IFO ayrıştırma) | libdvdnav/libdvdread GPL; şifreli DVD (CSS) hukuken riskli | |
| B1.6 | Blu-ray (menülü) | `bluray.c` | Yok | libbluray LGPL / sıfırdan | AACS şifreli diskler hukuken riskli | |
| B1.7 | DVD-Audio, DVD-VR (ev kamerası DVD'leri) | `dvdread_audio.c`, `dvdread_vr.c` | Yok | Sıfırdan | Aile arşivi için anlamlı olabilir | |
| B1.8 | Ses CD'si + albüm bilgisi (MusicBrainz) | `cdda.c` | Yok | Windows CD API + MusicBrainz web servisi | Ağ isteği yalnızca kullanıcı isteğiyle | |
| B1.9 | Webcam / yakalama kartı (eski kaset sayısallaştırma) | `dshow`, `v4l2` | Yok | Media Foundation / FFmpeg dshow | VHS/Hi8 sayısallaştırma iş akışıyla birleşebilir | |
| B1.10 | Ekran kaydı | `screen` (DXGI) | Yok | Windows Graphics Capture / DXGI | | |
| B1.11 | TV kartı (DVB), SAT>IP | `dvb`, `dtv`, `satip.c` | Yok | Sıfırdan | Düşük ilgi | |
| B1.12 | Profesyonel giriş (DeckLink/SDI, NDI) | `decklink.cpp`, `sdi.c`, `ndi.c` | Yok | — | NDI SDK lisansı kapalı | |
| B1.13 | RTSP, RTP, SRT, RIST, UDP multicast | `live555.cpp`, `rtp`, `srt.c`, `rist.c`, `udp.c` | Kısmen (FFmpeg üzerinden ne açılıyorsa) | FFmpeg protokolleri / kendi kodumuz | IP kamera kayıtları için anlamlı | |
| B1.14 | YouTube vb. sayfa bağlantısından oynatma | `demux/ytdl.c` | Yok | yt-dlp (Unlicense) ayrı süreç | Site kullanım koşulları ayrıca düşünülmeli | |
| B1.15 | Telefondan (MTP) doğrudan açma | `access/mtp.c` | Yok | Windows Portable Devices API | Fotoğraf aktarımı için değerli | |
| B1.16 | Ağ parolalarını güvenli saklama | `keystore/*` | Yok | Windows Kimlik Bilgisi Yöneticisi | | |
| B1.17 | Podcast aboneliği | `services_discovery/podcast.c` | Yok | RSS ayrıştırıcı (kendi kodumuz) | | |
| B1.18 | İnternet radyosu dizini (Radio Browser) | NEWS 4.0 | Kısmen (ICY radyo çalınıyor, dizin yok) | radio-browser.info API | | |
| B1.19 | zstd ile sıkıştırılmış dosyayı açarak oynatma | NEWS 4.0 | Yok | zstd crate | | |
| B1.20 | Klasörü liste olarak oynatma | `access/directory.c` | Kısmen (stüdyo ve kütüphane) | — | | |

### B2. Biçimler ve kod çözme (`codec`, `demux`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B2.1 | Kapalı altyazı (CEA-608/708), teletekst, DVB altyazı, ARIB, TTML, VobSub | `cc.c`, `cea708.c`, `telx.c`, `zvbi.c`, `dvbsub.c`, `arib`, `ttml` | Kısmen (libmpv ve FFmpeg'in desteklediği kadarı; arayüzde dış dosya olarak SRT/VTT/ASS/SSA) | Dış dosya listesine VobSub, TTML eklenmesi; arayüz testi | | |
| B2.2 | MIDI çalma | `codec/fluidsynth.c` | Yok | Kendi sentezleyicimiz veya ses fontu kütüphanesi | FluidSynth LGPL | |
| B2.3 | Oyun ve tracker müzikleri (MOD, XM, SID, NSF…) | `demux/mod.c`, `sid.cpp`, `gme.c` | Kısmen (FFmpeg/openmpt derlemesine bağlı) | Derleme seçeneği kontrolü | | |
| B2.4 | Güvenlik kamerası kayıt biçimleri (G64, RE4, HXVS) | NEWS 4.0 | Yok | Sıfırdan ayrıştırıcı | Niş | |
| B2.5 | MP3 içinde bölümler ve senkron sözler (ID3 CHAP/SYLT) | NEWS 4.0 | Kısmen (LRC sözleri var) | Kendi ID3 okuyucumuz | | |
| B2.6 | HEIF/AVIF/WebP'yi video zaman çizelgesinde gösterme | NEWS 4.0 | Var (fotoğraf görüntüleyici) | — | HS Studio burada önde | |

### B3. Oynatıcı çekirdeği (`src/player`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B3.1 | İki altyazıyı aynı anda gösterme (dil öğrenme) | NEWS 4.0 "dual subtitles" | Yok | libmpv `secondary-sid` | Politika listesine eklenmeli | |
| B3.2 | Zorunlu (forced) altyazı dili seçimi | NEWS 4.0 | Bilinmiyor | libmpv seçenekleri | | |
| B3.3 | Altyazıyı siyah bantlarda gösterme | NEWS 4.0 | Bilinmiyor | libmpv `sub-use-margins` | | |
| B3.4 | Önceki kareye adım | NEWS 4.0 | Var (`frame-back-step`) | — | | |
| B3.5 | Tekrar sayısı, "oynat ve duraklat", "duraklatılmış başla" | NEWS 4.0 | Kısmen (A-B döngü, tekrar var) | — | | |
| B3.6 | Düşük gecikmeli ses | NEWS 4.0 | Yok | WASAPI ayarları | | |
| B3.7 | Altyazı gecikmesini otomatik düzeltme | `spu/subsdelay.c` | Kısmen (elle gecikme var) | Ses-konuşma eşleştirmesiyle kendi algoritmamız | | |
| B3.8 | Küçük resim ve önizlemeyi ayrı süreçte üretme (güvenlik) | NEWS 4.0 "out-of-process preparser" | Kısmen | Ayrı işçi süreç | Bozuk dosya uygulamayı çökertmesin | |

### B4. Görüntü çıkışı ve filtreler (`video_output`, `video_filter`, 68 dosya)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B4.1 | GPU ile anlık büyütme | `d3d11-upscale-mode=super` | Yok | V03 | NVIDIA/Intel/AMD | |
| B4.2 | SDR→HDR | NVIDIA TrueHDR | Yok | V03 | | |
| B4.3 | AMD kalite iyileştirme ve kare ara değerleme | `amf_vqenhancer.c`, `amf_frc.c` | Yok | AMD AMF SDK (MIT) ile kendi kodumuz | Geliştirme makinesi AMD | |
| B4.4 | ICC profil ile renk yönetimi | NEWS 4.0 | Kısmen (fotoğrafta ICC var; video bilinmiyor) | libmpv `icc-profile-auto` | | |
| B4.5 | 360° video ve stereo 3D (anaglif) | `anaglyph.c`, NEWS | Yok | libmpv/libplacebo gölgelendirici | | |
| B4.6 | Video duvarı / çoklu ekrana bölme | `video_splitter` | Yok | — | Düşük ilgi | |
| B4.7 | Anlık efektler: sepya, film greni, eski film, VHS, bantlaşma giderme, gürültü azaltma, keskinleştirme, ayna, bulanıklık, kenar | `sepia.c`, `grain.c`, `oldmovie.c`, `vhs.c`, `gradfun.c`, `hqdn3d.c`, `sharpen.c`… | Kısmen (HTML5 yolunda WebGL filtreleri; mpv'de yalnızca ayna) | Kendi GLSL gölgelendiricilerimiz | `policy.rs`'e kontrollü ekleme | |
| B4.8 | Logo, yazı ve saat bindirme | `spu/logo.c`, `marq.c` | Yok | Kendi bindirme katmanımız | | |
| B4.9 | Titreme giderme | `antiflicker.c` | Yok | Kendi filtremiz | Eski film taramaları için | |
| B4.10 | Görüntüde nesne seçme (SAM3) | `sam3.cpp` (4.0) | Kısmen (fotoğrafta nesne silme var; seçim ayrı) | Kendi segmentasyon akışımız | Model ağırlığı lisansı kontrol edilmeli | |
| B4.11 | Yapboz oyunu | `puzzle` | Yok | — | Eğlence | |
| B4.12 | Resim içinde resim (PiP) | NEWS 4.0 macOS | Var | — | | |

### B5. Ses (`audio_filter`, 36 dosya; `audio_output`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B5.1 | Konuşma gürültüsü giderme (sinir ağı) | `rnnoise.c` (4.0) | Yok | FFmpeg `arnndn` + kendi modelimiz | RNNoise BSD | |
| B5.2 | Kompresör, genişletici, kapı, tepe limitörü | `compressor.c`, `expander.c`, `gate.c`, `limiter.c` | Kısmen (limitör ve kompresör izinli) | — | | |
| B5.3 | Uzamsal ses, stereo genişletme, merkez kanal oluşturma | `spatializer`, `stereo_widen.c`, `center.c` | Yok | Kendi DSP kodumuz | | |
| B5.4 | Karaoke (vokal azaltma) | `karaoke.c` | Yok | Kendi DSP kodumuz | | |
| B5.5 | Ses yüksekliği ölçer (EBU R128) | `libebur128.c` (4.0) | Kısmen (ReplayGain ölçümü var) | Arayüzde gösterim | | |
| B5.6 | Perde koruyarak hızlandırma | `scaletempo.c` | Var (libmpv varsayılanı) | — | | |
| B5.7 | WASAPI özel mod, 24 bit, HDMI/S/PDIF geçişi | `wasapi.c`, NEWS | Yok | libmpv `audio-exclusive`, `audio-spdif` | Ev sineması kullanıcıları | |
| B5.8 | Ses cihazı seçimi | `mmdevice.c` | Kısmen (cihaz listesi izleniyor) | Arayüzde seçici | | |
| B5.9 | Ambisonik ve çok kanallı ses | NEWS 4.0 | Bilinmiyor | — | | |

### B6. Altyazı ve metin (`text_renderer`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B6.1 | Altyazıyı sesli okuma (görme engelliler) | `sapi.cpp` | Yok | Windows Speech API | Erişilebilirlik için değerli | |
| B6.2 | Ruby (furigana), sağdan sola yazım, yazı tipi yedekleme | NEWS 4.0 freetype | Kısmen (libass) | — | | |
| B6.3 | Altyazı arama ve indirme | VLsub eklentisi | Var (arama penceresi) | — | | |

### B7. Yayın ve dönüştürme (`stream_out`, 55 dosya)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B7.1 | Chromecast'e gönderme | `stream_out/chromecast` | Yok | Cast protokolü (protobuf + TLS) kendi kodumuz | | |
| B7.2 | DLNA cihazına gönderme | `stream_out/dlna` | Var (gerçek TV'de denenmedi) | — | | |
| B7.3 | Kendi arşivini evdeki TV'lere sunma (UPnP sunucu) | `control/upnp_server` (4.0) | Yok | Kendi UPnP/HTTP sunucumuz | Aile arşivi için çok uygun | |
| B7.4 | Ağa canlı yayın (HTTP, HLS, RTSP) | `stream_out/*`, `access_output/*` | Yok | FFmpeg + kendi sunucumuz | | |
| B7.5 | Akışı kaydetme (internet radyosu, IP kamera) | `stream_out/record.c` | Yok | FFmpeg ile kopyalama | | |
| B7.6 | Dönüştürme sihirbazı | `transcode` | Var (medya eylemleri) | — | | |

### B8. Kumanda, entegrasyon ve genişletme (`control`, `lua`, `misc`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B8.1 | Telefondan kumanda (yerel web arayüzü) | `lua/intf` http | Yok | Kendi küçük HTTP sunucumuz + eşleştirme kodu | Yalnızca yerel ağ, parola/QR ile | |
| B8.2 | Komut satırı kumandası | `control/cli` | Kısmen (dosya ile açma var) | — | | |
| B8.3 | Genel kısayol tuşları (pencere arkadayken) | `control/globalhotkeys` | Kısmen (Windows medya tuşları) | — | | |
| B8.4 | Linux medya kontrolü (MPRIS) | `control/dbus` | Yok | Linux sürümüyle birlikte | | |
| B8.5 | Kızılötesi kumanda (LIRC) | `lirc.c` | Yok | — | Düşük ilgi | |
| B8.6 | Fare hareketiyle kumanda | `gestures.c` | Yok | — | | |
| B8.7 | İki cihazda senkron izleme ("birlikte izle") | `control/netsync.c` | Yok | Kendi senkron protokolümüz | | |
| B8.8 | Eklenti sistemi | `lua/*` | Yok | Güvenlik modeli gerektirir | Büyük karar | |
| B8.9 | Last.fm'e dinleme bildirme | `misc/audioscrobbler.c` | Yok | Last.fm API | Ağ ve rıza | |
| B8.10 | Şarkıyı sesinden tanıma (AcoustID) | `misc/fingerprinter.c`, `stream_out/chromaprint.c` | Yok | Kendi parmak izi algoritmamız + AcoustID | Chromaprint LGPL; etiketsiz arşivler için değerli | |
| B8.11 | Kütüphanede geçmiş, favoriler, yer imleri, "filmler" görünümü | NEWS 4.0 medialibrary | Kısmen (son dosyalar, devam et, yer imi var) | Plan 13 ile birleşir | | |
| B8.12 | Eklenti ve tema mağazası | `misc/addons` | Yok | — | | |

### B9. Görselleştirme (`visualization`)

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B9.1 | Spektrum ve dalga biçimi | `glspectrum.c`, `visual` | Yok | Web Audio + Canvas (kendi kodumuz) | Müzik ekranında kapatılabilir | |
| B9.2 | Müzikle dans eden görseller | `goom.c`, `projectm.cpp` | Yok | Kendi gölgelendiricilerimiz | projectM LGPL | |

### B10. Platform, arayüz ve dağıtım

| # | Fikir | VLC'de | HS Studio | Olası yol | Not | Öncelik |
|---|---|---|---|---|---|---|
| B10.1 | macOS, Linux (gerçek test), Windows ARM | NEWS | Linux önizleme, macOS yok | Plan 10 ve `docs/status/platform-plan-macos-linux.md` | | |
| B10.2 | Android, iOS | VLC mobil | Yok | Plan 00 sıralaması | | |
| B10.3 | Kaplama (skin) desteği | `gui/skins2` | Yok | Tema değişkenleri | | |
| B10.4 | Klasik ve sade arayüz modu | NEWS 4.0 QML "classic mode" | Kısmen (medya türüne göre sade ekran) | — | | |
| B10.5 | Koyu ve yüksek kontrast tema, tam klavye ve dokunmatik gezinme | NEWS 4.0 | Kısmen | Erişilebilirlik denetimi (axe testi var) | | |
| B10.6 | 110 dil | `po/` | 2 dil | Topluluk çevirisi altyapısı | | |
| B10.7 | İmzalı kurulum ve otomatik güncelleme | — | Hazırlıkta (SignPath, updater) | `docs/release/signing-and-updates.md` | | |
| B10.8 | Sürekli fuzz testi | OSS-Fuzz | Kısmen (bozuk dosya testleri var) | cargo-fuzz ile ayrıştırıcılar (EXIF, ZIP, altyazı) | V01 ile başlar | |

### B11. HS Studio'nun önde olduğu alanlar (VLC'de yok; korunacak yön)

Fotoğraf görüntüleyici ve stüdyosu; kalıcı (dosya üreten) fotoğraf/video iyileştirme; nesne silme ve renklendirme; kesme, GIF, OCR, etiket ve şarkı sözü düzenleme; kararlı sürümde müzik kütüphanesi, boşluksuz geçiş ve ReplayGain (VLC 3.0'da kütüphane modülü yok, iki dalın NEWS'inde boşluksuz geçiş geçmiyor); orijinal dosyaya hiç dokunmayan işlem modeli. Yeni fikirler bu yönü zayıflatmamalı.

---

## Değerlendirme toplantısı için öneri

1. Her madde için "Öncelik" sütununa kullanıcı karar verir: **Şimdi / Sonra / Hayır**.
2. "Şimdi" seçilenler için Bölüm A'daki biçimde ayrıntılı iş kartı yazılır: neden, mevcut durum, yaklaşım, kabul/test, risk.
3. Aile arşivi odağına (00 ve 2026-10-24 analizi) en çok hizmet eden maddeler: B1.1, B1.2, B1.4, B1.7, B1.9, B1.15, B4.9, B7.3, B8.10.
