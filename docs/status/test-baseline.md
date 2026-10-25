# Test tabanı (S03)

**Tarih:** 2026-10-25 · **OS:** Windows 11 Pro 10.0.26300 (x64, 1 GB dahili AMD GPU) · **Araçlar:** Node 24.20.0, rustc 1.99.1
**Kod:** `main` — D1 birleştirmesi (`35de786`) + AVIF teşhisi ve E2E düzeltmeleri (bu belgeyle aynı commit)

| Komut (repo kökünden) | Sonuç |
|---|---|
| `npm test` | 121 / 121 geçti |
| `cargo test --release --lib --manifest-path src-tauri/Cargo.toml` | 60 geçti, 0 başarısız, 2 yok sayıldı |
| `npm run build:release` | uyarısız |
| `npm run stage:mpv -- -Source <LGPL mpv dist>` | 38 DLL + `ffmpeg.exe`/`ffprobe.exe` |
| `npm run e2e` (`VHO_E2E_PORT_MIN/MAX=10100/10199`) | 129 / 129 geçti, 0 atlandı (`src-tauri/target/release/vho.exe`) |
| `tests/e2e/actions.e2e.mjs`, `VHO_EXE=<kök>/VHO.exe` (exe + `mpv\` alt klasörü yerleşimi) | 29 / 29 geçti, 0 atlandı |

E2E başlatıcısı her zaman `VHO_DATA_DIR` (geçici), `VHO_DISABLE_SYSTEM_SUSPEND=1` ve `VHO_DISABLE_SYSTEM_CHANGES=1` verir. Dosya değiştiren testler yalnızca kendi oluşturduğu geçici kopyalarda çalışır; kesme/dönüştürme/GIF/döndürme/altyazı/iptal sonrası kaynak SHA-256'sı değişmediği doğrulanır.

## Yok sayılan (`#[ignore]`) testler
| Test | Amaç | Çalıştırma |
|---|---|---|
| `photo::thumbs::tests::photo_thumb_bench_500_12mp` | 500 adet 12 MP JPEG ile soğuk/sıcak önbellek küçük resim ölçümü (uzun sürer) | `cargo test --release --lib photo_thumb_bench -- --ignored --nocapture` |
| `transcode::tests::probe_and_transcode_real_file` | Kullanıcının verdiği gerçek dosyada Media Foundation dönüştürmesi (depoya medya konmaz) | `VHO_TEST_MEDIA=<dosya> cargo test --release --lib -- --ignored --nocapture` |

## AVIF teşhisi (`photo_avif_encode_then_os_decode`)
- **24 Ekim analizindeki hata:** `0x88982F8B` = `WINCODEC_ERR_COMPONENTINITIALIZEFAILURE`. AV1 Video Uzantısı WIC'te kayıtlı (listede `.avif` var), fakat bileşen o süreçte başlatılamadı. Store paketli codec'ler kısıtlı/sandbox süreçlerde bu şekilde etkinleşemeyebilir.
- **Bu makinede normal kullanıcı sürecinde:** kodlama → WIC çözme gidiş-dönüşü geçiyor; hata yeniden üretilemedi. Sebep ortama bağlıdır, AVIF desteğinin bozuk olduğu anlamına gelmez.
- **Düzeltme (yanlış "uzantıyı kurun" mesajı):**
  - Yeni hata kodu `[codec-failed]` (`photo::ERR_CODEC_FAILED`). Çözücü kuruluysa (AVIF/RAW) ya da hata `0x88982F8B` ise döner; mesajda Store kurulum önerisi yoktur.
  - HEIC'te kurulum önerisi korunur: HEIF uzantısı varken HEVC uzantısı eksik olabilir.
  - `photo_capabilities.avif_decode` artık uzantı listesine bakmaz. 16×16 bir AVIF'i bir kez gerçekten çözer ve sonucu önbelleğe alır (`heic::avif_works`).
  - Kurulu ama çalışmayan durumda ipucu `AVIF_FAILED_HINT` olur.
- **Test:**
  - Çözme başarılıysa yoklama da "çalışıyor" demeli.
  - Uzantı kurulu ama çözme başarısızsa yoklama "çalışmıyor" demeli ve hata `[codec-failed]` olmalı.
  - Uzantı yoksa hata `[codec-missing]` olmalı.
  - `photo_wic_init_failure_is_codec_failed`, `0x88982F8B` için sınıflandırmayı ortamdan bağımsız doğrular.
- **CI notu:** codec'siz runner'da mantık testleri geçer, gerçek çözme testi `[codec-missing]` dalına girer. Gerçek AVIF çözme kanıtı codec kurulu bir runner/makinede alınmalıdır.

## Q01 katman çalıştırması (2026-10-25, `wave3/e6-test-katmanlari`)
Binary: `src-tauri/target/release/vho.exe` (bu dalda yeniden derlendi, libmpv yerleşik). Ayrıntı: [test-map.md](test-map.md).

| Komut | pass | fail | skip | Not |
|---|---|---|---|---|
| `npm test` | 151 | 0 | 0 | ağ koruması etkin; ~2–5 s |
| `npm run test:rust` | 114 | 0 | 2 ignored | |
| `npm run e2e` (`VHO_E2E_PORT_MIN/MAX=10700/10799`) | 161 | 0 | 0 | |
| `npm run test:ai` | 6 | 0 | 0 | ilk çalıştırma: 76 MB indirme ~10 s; sonraki: önbellek + `ai_verify`; WASM ~27 s, WebGPU (AMD 1 GB iGPU) ~18–36 s |
| `npm run test:quality`, `npm run bench:media` | — | — | — | henüz doldurulmadı (Q02); 0 test, geçti sayılmaz |
