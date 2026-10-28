# Ağ akışları ve cihaza yayın (Plan 13/L04)

Kod: `src-tauri/src/net.rs` (izinli şemalar, yeniden bağlanma seçenekleri, günlükte sır temizleme), `src-tauri/src/cast/*` (UPnP/DLNA: `ssdp`, `http`, `xml`, `upnp`, `server`), `src/media/net-logic.js`, `src/ui/cast-dialog.js`.
Testler: Rust `net::tests`, `cast::` (sahte renderer ile tam akış dahil), `tests/unit/net-logic.test.mjs`, `tests/e2e/network.e2e.mjs`.

## Ağ akışları

- “URL aç” yalnızca `http://` ve `https://` kabul eder (Rust ve ön yüz aynı liste). URL libmpv'ye veri olarak gider; kabuk komutu yoktur. Yerel ağ adresleri (NAS, 192.168.x.x) bilerek engellenmez.
- Yeniden bağlanma yalnızca ağ URL'sine, o dosya için uygulanır (`loadfile` seçenekleri): `network-timeout=20`, ffmpeg `reconnect` (bağlantı hatası dahil, en çok 6 deneme, en uzun 8 s bekleme). HLS dışındaki akışlarda (radyo vb.) `reconnect_streamed` de açıktır: orada verinin bitmesi bağlantının kopması demektir. HLS'de bağlantısı kopan segment yeniden denenir, olmazsa FFmpeg tarafından atlanır; oynatma durmaz (`seg_max_retry` libmpv'de her segmenti yeniden açtırıp oynatmayı durdurduğu için kullanılmadı). Yerel dosyalar etkilenmez.
- HLS (`.m3u8`/`.m3u`): **düzeltildi (2026-10-28, denetim D02), yalnızca Windows'ta ve yerel test sunucusunda doğrulandı.** Kök neden: HLS demuxer'ı akış seçeneklerini her segmente aktarıyor; `reconnect_streamed=1` açıkken FFmpeg'in http katmanı, uzunluğu bildirilmeyen (chunked) bir segment yanıtının normal sonunu erken kopma sayıp segmenti 1/3/7 s beklemeyle baştan indiriyordu (`Will reconnect at 0 … error=End of file`); ilk segmentten sonra oynatma ~11 s duruyordu. Aynı akış `Content-Length` ile sorunsuzdu. Düzeltme: `.m3u8`/`.m3u` yolları için `reconnect_streamed` verilmiyor (`src-tauri/src/net.rs` `load_options`). E2E'de iki HLS testi artık normal regresyon testidir (chunked segmentler, her segment bir kez istenir, kesilen segment bağlantısından sonra oynatma sürer). Sınır: uzantısı `.m3u8`/`.m3u` olmayan HLS adresleri eski seçenekle açılır; canlı (sürekli güncellenen) HLS, şifreli HLS ve gerçek CDN'ler denenmedi. HTML5 motorunda WebView desteklemiyorsa açık uyarı verilir.
- İnternet radyosu: ICY başlığı (`StreamTitle`) pencere başlığında akış adının yanında gösterilir (`metadata/by-key/icy-title`).
- Sırlar: `kullanıcı:parola@` ve belirteç benzeri sorgu değerleri (`token`, `key`, `sig`, `signature`, `auth`, `password`, `X-Amz-*` …) libmpv günlük satırlarında `***` olur. Böyle bir URL **son açılanlara yazılmaz**, kaldığı yer anahtarı sırsız biçimiyle saklanır; kullanıcıya bir kez bildirilir. E2E, uygulama veri klasöründe sır geçmediğini dosya taramasıyla doğrular.
- SMB: işletim sisteminin bağladığı paylaşım (`\\nas\paylaşım\film.mkv` veya sürücü harfi) normal dosya yolu olarak açılır; uygulama kendi SMB istemcisi içermez.

## Cihaza yayın (UPnP/DLNA)

- “⋯” menüsünde **Cihaza yayınla…** (yalnızca yerel dosyalar). Keşif yalnızca diyalog açılınca veya “Yeniden ara” ile yapılır; arka planda ağ trafiği yoktur, ayar gerekmez.
- Keşif: SSDP M-SEARCH (`MediaRenderer:1`), 3 s pencere, 2 KB'tan büyük yanıt yok sayılır, en çok 32 cihaz. Yanıttaki `LOCATION` yalnızca yanıtın geldiği IP'yi gösterebilir (sahte yanıtla başka adrese istek yaptırılamaz); yalnızca `http://`.
- Cihaz açıklaması ve SOAP yanıtları: 256 KB üst sınır, 5 s zaman aşımı, yönlendirme izlenmez; `<!DOCTYPE` içeren XML reddedilir (dış/özel varlık çözümü yok, yalnızca XML'in beş temel varlığı ve karakter başvuruları). Denetim URL'leri cihazın kendi IP'sinde olmalıdır.
- Dosya sunucusu: yalnızca seçilen tek dosya, `/m/<rastgele 128 bit belirteç>/<ad>`; başka her yol 404, dizin listesi yok, istekten dosya yolu alınmaz. Cihaza giden yerel arabirime bağlanır (rastgele port). GET/HEAD, tek `Range` (206/416), DLNA akış başlıkları, bağlantı başına 20 s zaman aşımı, en çok 8 eşzamanlı bağlantı. **Durdur**, uygulama kapanışı veya yeni yayın: sunucu kapanır, süren aktarım kesilir, URL çalışmaz.
- Güvenlik duvarı değiştirilmez. Cihaz 10 s içinde dosyayı hiç istemezse “güvenlik duvarı engelliyor olabilir” uyarısı gösterilir.
- Biçim: cihaz `GetProtocolInfo` ile desteklediği türleri bildiriyorsa ve dosyanın türü yoksa yayın başlamaz (`[cast-format]`, açık mesaj). Otomatik dönüştürme yoktur (sonraki ayrı iş).
- Denetim: oynat, duraklat, durdur; yayın yerel konumdan başlar (Seek), yerel oynatma duraklatılır. Durum 2 s'de bir okunur (`GetTransportInfo`/`GetPositionInfo`); erişilemeyen cihaz zaman aşımıyla hata verir, arayüz kilitlenmez.
- Chromecast (CASTV2: TLS + protobuf) **uygulanmadı** (`cast.chromecast` = `not-implemented`).
- yt-dlp entegrasyonu **yapılmadı**: isteğe bağlı bileşen, resmi sürüm/hash/lisans doğrulaması ve `load-scripts=no` derlemesine uygun ayrı tasarım gerektirir.

## Test kapsamı ve sınırlar

- Sahte renderer (Rust `cast::tests` ve E2E): keşif, açıklama, biçim kontrolü, URI + Range ile çekme, oynat/duraklat/sar, UPnP hata kodu (711), durdurunca URL'nin kapanması, yanlış belirteç / `..` / kök yol 404, yanıt vermeyen cihazda zaman aşımı.
- XML: XXE / özel varlık / aşırı derinlik reddi; SSDP: başka IP'yi gösteren `LOCATION`, https, NOTIFY reddi.
- Ağ akışı E2E: yerel HTTP sunucusu bir HLS segment bağlantısını keser (oynatma durmaz) ve MP4 aktarımını %40'ta keser; oynatma devam eder (MP4'te Range ile yeniden bağlanma görülür). ICY başlığı. Sır içeren URL.
- **Gerçek cihaz testi yapılmadı**: hiçbir gerçek TV/hoparlör/Chromecast ile denenmedi (`cast.dlna` = `supported-untested`). Bir simülatör gerçek cihaz uyumluluğunun yerine geçmez.
- Elle kontrol (gerçek cihaz bulununca): aynı ağdaki DLNA TV'de MP4/MP3 oynat, duraklat, sar, durdur; durdurduktan sonra TV'nin dosyayı yeniden açamadığını gör; Windows Güvenlik Duvarı ilk kez sorduğunda “İptal” seçilirse uyarının çıktığını gör; Wi-Fi'yi kapatınca uygulamanın donmadığını gör.
