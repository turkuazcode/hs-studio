# Müzik modu ve ses doğruluğu (Plan 13/L03)

Kod: `src/music/{music-mode,music-logic}.js`, `src/styles/music.css`, `src-tauri/src/music/{mod,controls}.rs`, ReplayGain ölçümü `src-tauri/src/actions/ffmpeg.rs` (`loudness`, `album_loudness`), etiket `actions/tags.rs`, kütüphane görünümleri `src/library/library-view.js`.
Testler: `cargo test --release --lib music` (boşluksuz geçiş ölçümü, albüm ReplayGain, toplu etiket), `cargo test --release --lib capabilities`, `tests/unit/music-logic.test.mjs`, `tests/e2e/music.e2e.mjs`.

## Ekran (sade, yalnızca müzik)

Ses dosyası çalarken müzik düzeni açılır: kapak (gömülü kapak), başlık, sanatçı · albüm, “Karışık” ve “Tekrar: kapalı / tümü / bu parça” düğmeleri, sıradakiler listesi. Video denetimleri (altyazı, en-boy, ekran görüntüsü, PiP, görüntü filtreleri, AI, bölünmüş görünüm) gizlenir; HUD'da oynat/duraklat, ilerleme, ses, hız ve liste kalır. Sözler mevcut “Sözler” panelindedir (LRC satırı oynatma zamanına bağlı: seek ve hız değişiminde doğru satır, `tests/unit/music-logic.test.mjs`).
Kütüphane > Müzik: Tümü / Sanatçılar / Albümler / Türler (gruptan parçalara iner, albüm parça sırasıyla) / son eklenen / en çok çalınan / favoriler / bulunamayanlar. Albümün “⋯” menüsünde “Albüm ReplayGain hesapla”. Kayıtlı listeler L02'deki Listeler sekmesindedir. Görselleştirici bu sürümde yok (düşük öncelik; müziği etkilemesin diye eklenmedi).
Ayarlar > Ses > Müzik: ReplayGain (kapalı/parça/albüm), ön kazanç, kırpılmayı önle, boşluksuz geçiş, Windows medya tuşları, ses cihazı çıkarılınca duraklat. Karışık/tekrar durumu ayarlarda saklanır (yeniden başlatmada kalır).

## Sıra (karışık / tekrar)

`nextIndex` tek kural: “tekrar: bu parça” yalnızca parça kendiliğinden bitince aynı parçayı çalar, elle “sonraki” yine ilerler; “kapalı”da son parçadan sonra durur; karışık sıra o anki parçayla başlayan bir permütasyondur (liste değişince yenilenir). Yalnızca müzik öğelerine uygulanır; video ve fotoğraf eski davranışta kalır.

## Boşluksuz geçiş

Yalnızca libmpv motorunda: sıradaki müzik parçası mpv'nin kendi listesine eklenir (`loadfile … append`, `gapless-audio=yes`, `prefetch-playlist=yes`); mpv ses çıkışını yeniden açmadan geçer ve arayüz parçayı `advanced` olayıyla benimser (yeniden yükleme yok, E2E'de `engine_load` sayısı değişmez). Crossfade ayrı bir özelliktir ve yoktur; boşluksuz geçiş onun eşanlamlısı değildir. HTML5 motorunda her parça yeniden açılır (`audio.gapless` yeteneği `needs-libmpv`).

**Ölçüm** (`music::tests::gapless_boundary_is_measured_flac_exact_aac_trimmed`): tek bir sürekli 441 Hz sinüsün iki yarısı ayrı dosyalara yazılır, libmpv `ao=pcm` ile art arda çalar, PCM çıktısı ideal sinüsle karşılaştırılır (birleşimin ±50 ms çevresinde en uzun sessiz dizi ve en büyük sapma, toplam örnek sayısı).
- FLAC (kayıpsız): tam 96.000 örnek, sessiz dizi ≤ 1 örnek, sapma < 0,001 — örnek kesintisi yok.
- AAC/M4A (encoder delay 1024 + padding, MP4 edit list ile kırpılır): toplam örnek sapması < 1024, sessiz dizi < 48 örnek (1 ms). Ölçülen değerler test çıktısında `[gapless]` satırındadır.
- Sınır: `ao=pcm` zamanlamasızdır; gerçek ses kartında cihaz yeniden açma gecikmesi bu testte görünmez (gapless=yes iken zaten yeniden açılmaz). MP3 için LAME/Xing gecikme bilgisi yazan bir kodlayıcı LGPL derlemede yok; MP3 kesintisi ölçülmedi.

## ReplayGain politikası

- Ölçüm: ffmpeg `ebur128=peak=sample+true`, EBU R128 bütünleşik yükseklik. **Referans −18 LUFS (ReplayGain 2.0)**: kazanç = −18 − LUFS. LUFS değeri etikete kazanç diye yazılmaz (D1'in `replaygain_analyze` çıktısı da bu dönüşümü kullanır; birim testi `ebur128_summary_to_replaygain`).
- Tepe: `REPLAYGAIN_*_PEAK` **örnek tepesi** (doğrusal, 1,0 = tam ölçek). Gerçek tepe (4× aşırı örnekleme, dBTP) yalnızca gösterilir; etikete yazılmaz. (Önceki D1 sürümü gerçek tepeyi peak etiketine yazıyordu; düzeltildi.)
- Albüm kazancı: albümün tüm parçaları tek bir R128 ölçerden art arda geçirilir (ffmpeg `concat` + `ebur128`); parça kazançlarının ortalaması değildir. Parçaların kanal sayısı farklıysa süre ağırlıklı enerji ortalamasına düşer (`method: "energy"`). Albüm tepe = parçaların en yüksek örnek tepesi.
- Oynatma: libmpv `replaygain=track|album` (albüm yoksa parça), `replaygain-preamp` (−15…+15 dB), `replaygain-clip=yes` = kırpılmayı önle (çarpan en çok 1/tepe). Etiketsiz dosya: değişmez (fallback 0 dB). HTML5 motoru aynı formülü (`replayGainFactor`) uygular ama `<video>.volume` yalnızca kısabilir (`attenuation-only`).

## Sistem medya kontrolleri

Windows: uygulama penceresinin System Media Transport Controls nesnesi (`ISystemMediaTransportControlsInterop::GetForWindow`). Medya tuşları (oynat, duraklat, durdur, sonraki, önceki) `media-control` olayıyla ön yüze gelir; ön yüz başlık/sanatçı/albüm/kapak ve durum değişince `media_controls_update` gönderir. Döngü yok: OS düğmesi ön yüze bir kez gelir, güncelleme yalnızca özellik yazar ve düğme olayı üretmez; aynı içerik ikinci kez gönderilmez. Kapak: dosyanın gömülü kapağı (önbelleğe yazılır) ya da klasördeki `cover.jpg/folder.jpg`. E2E, OS nesnesinden geri okur (`media_controls_state`) ve tuş basımını `media_controls_simulate` ile aynı yoldan verir (gerçek tuş kullanıcının masaüstüne gider).
macOS Now Playing / Linux MPRIS: uygulanmadı; `system.mediaControls` yeteneği `not-implemented`.
Ses cihazı çıkarılınca (kulaklık, USB DAC): libmpv `audio-device-list` / HTML5 `devicechange` ile önceki listede olup yenisinde olmayan cihaz → çalıyorsa duraklat (ayar). Gerçek cihaz çıkarma otomatik test edilmedi; karar fonksiyonu (`deviceRemoved`) birim testli.

## Etiket yazımı

D1 davranışı korunur: çalan dosya etiket yazımından önce bırakılır ve aynı konumdan devam eder. Toplu etiket düzenleme ve albüm ReplayGain yazımı yalnızca geçici kopyalarda test edilir (`batch_tag_edit_on_copies_round_trips`, `album_replaygain_is_one_joint_measurement_and_tags_round_trip`). Kütüphane tarayıcısı aynı etiketleri sayı olarak okur (`audio_tags`).
