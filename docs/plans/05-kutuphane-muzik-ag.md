# Plan 05 — Medya Kütüphanesi, Müzik, Ağ ve Yayın (Dalga 3)

## §1 Kütüphane (Ajan C1)
- **Veritabanı:** SQLite (`rusqlite`, MIT; SQLite kamu malı), `app_data_dir/library.db`, şema sürümlü göçler.
- Tablolar: `folders` (izlenen klasörler), `media` (yol, tür, boyut, mtime, süre, çözünürlük, codec, oluşturma tarihi, kaldığı yer, izlendi, yıldız), `audio_tags` (başlık, sanatçı, albüm, yıl, tür, parça no, kapak), `playlists`, `playlist_items`, `bookmarks`.
- Tarama: arka planda, artımlı (mtime), dosya izleme ile güncel; meta veri: ses için `lofty` (MIT/Apache), video için libmpv/ffprobe (LGPL FFmpeg).
- Görünümler: Videolar (son eklenen, devam et, klasörler), Fotoğraflar (Plan 04 ile ortak), Müzik (sanatçı/albüm/tür/şarkı), Çalma listeleri. Arama (FTS5).

## §2 Çalma listeleri
- Oluştur/düzenle/sırala (sürükle-bırak), karıştır/tekrar (bir/hepsi); **M3U/M3U8 ve PLS içe/dışa aktarma**; "Akıllı" listeler (en çok çalınan, son eklenen, yıldızlı).

## §3 Müzik modu
- Ses dosyası açılınca müzik görünümü: kapak, parça bilgisi, sıradaki şarkılar, dalga biçimi/spektrum görselleştirme (Web Audio AnalyserNode veya mpv `lavfi`), 10 bant ekolayzır (Plan 02), boşluksuz çalma (`gapless-audio`), ReplayGain.
- Sistem medya kontrolleri: Windows SMTC, macOS Now Playing, Linux MPRIS (`souvlaki` crate, MIT) — klavye medya tuşları ve kilit ekranı.
- Mini oynatıcı (küçük, her zaman üstte pencere).

## §4 Ağ akışları (Ajan C2)
- URL: HTTP(S) dosyalar, **HLS/DASH** (libmpv yerel), RTSP/RTMP (FFmpeg); radyo akışları (ICY meta verisi).
- YouTube ve benzeri: `yt-dlp` (Unlicense) **isteğe bağlı**, ilk kullanımda indirilir, kullanım koşulları uyarısı ile; kapalı tutulabilir.
- Ağ paylaşımları: SMB yolları (işletim sistemi bağlı), **DLNA/UPnP medya sunucusu tarama ve gezinme** (UPnP ContentDirectory; crate lisansı doğrulanacak).

## §5 Başka cihaza yayın
- **DLNA/UPnP renderer'a gönder** (akıllı TV'ler): VHO küçük bir HTTP sunucusuyla dosyayı sunar, `AVTransport` ile oynatır; codec uyumsuzsa (TV desteklemiyorsa) uyarı.
- **Chromecast:** `rust-cast` (MIT) — yalnızca TV'nin çözebildiği formatlar; transcode sonraki faz.
- AirPlay: kapalı protokol, kapsam dışı (belgelenir).

## Testler
- Birim: veritabanı göçleri, M3U/PLS ayrıştırıcı (göreli/mutlak yollar, UTF-8/BOM), akıllı liste sorguları.
- E2E: test klasörünü kütüphaneye ekle → sayımlar doğru; çalma listesi oluştur/dışa aktar/içe aktar → aynı sıra; müzik dosyası → müzik modu ve etiketler görüntülendi.
- Ağ: yerel HTTP sunucusundan HLS fixture oynatma; sahte UPnP cihazıyla keşif testi.
