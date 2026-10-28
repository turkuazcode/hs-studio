# macOS ve Linux — uygulanabilir görev listesi (denetim D05 + D06)

Tarih: 2026-10-28 · Taban: `c09a661` + `wave5/windows-alfa`. Bu belge Windows alfadan **ayrı** takip edilir; Windows alfa bu işleri beklemez. Kart durumları [plan 08](../plans/08-uygulama-sirasi-ve-durum.md) P02/P03'te; kapı `node scripts/release-gate.mjs --target desktop-beta` (Windows kanıtı macOS/Linux yerine geçmez).

Her satırda **tür**: `kod` = yazılması gereken kod/paketleme var · `cihaz` = kod var, yalnızca gerçek donanım/OS'te doğrulama eksik · `hesap` = hesap, sertifika ya da anahtar gerekir (kullanıcı kararı/izni).

## macOS (P02) — kod eksik + cihaz yok

Bugünkü kod gerçeği: `src-tauri/src/engine/window.rs` Windows/Linux dışında video gömmeyi “not implemented” ile reddediyor; `engine/mod.rs::locate` libmpv'yi bu platformlarda hiç aramıyor (HTML5 motoruna düşer). macOS'a özel yollar yalnızca eylemlerde (`actions/system.rs`, `actions/ffmpeg.rs` `h264_videotoolbox`), HEIC (`photo/heic.rs`, ImageIO) ve kimlikte (`identity.rs`) var; hiçbiri derlenip çalıştırılmadı. `src-tauri/packaging/macos/dmg.conf.json` yalnızca taslak.

| # | Görev | Tür | Kabul |
|---|---|---|---|
| M1 | Video yüzeyi: mpv render API (OpenGL ya da `libmpv` + `CAOpenGLLayer`/Metal köprüsü) ile Tauri penceresine gömme; ADR 0002'nin macOS eşi olarak bir ADR | kod | Yeni ADR; pencere taşıma/boyutlandırma/tam ekran/Retina ölçeğinde görüntü |
| M2 | `engine/mod.rs::locate`: `libmpv.2.dylib` için paket içi yol (`Contents/Frameworks` ya da `Resources/mpv`), sistem kütüphanesine düşmeme | kod | Birim testi + paketli uygulamada motor `mpv` |
| M3 | LGPL libmpv/FFmpeg dylib derlemesi (arm64 + x86_64 ya da universal), GPL koruması, envanter (`legal/inventory/native-macos-*.json`) ve bildirimler | kod | `native-macos.yml` (yeni) + envanter hash'leri; GPL bayrağı varsa derleme başarısız |
| M4 | Paket: `.app` + DMG, dylib'lerin `install_name_tool`/`@rpath` düzeltmesi, hardened runtime yetkileri | kod | `package-macos.sh` + paket manifesti (Windows'taki gibi dosya + SHA-256) |
| M5 | Kod imzalama ve notarization | hesap | Apple Developer hesabı (ücretli) ya da imzasız/ad-hoc dağıtım kararı; kullanıcı karar verir |
| M6 | Medya tuşları / Şimdi Çalıyor (`MPNowPlayingInfoCenter`) — Windows SMTC eşi | kod | Müzik modunda kontrol merkezi |
| M7 | Paylaş / birlikte aç / kilit ekranı: bugün “desteklenmiyor” ve gizli (`capabilities.rs`); istenirse NSSharingService | kod (isteğe bağlı) | Yetenek tablosu güncel; gizli kalırsa sorun değil |
| M8 | Video iyileştirme kodlayıcısı `h264_videotoolbox`: kalite kipi ölçümü (Windows'taki h264_mf gibi) | cihaz | `enhance_speed_one_minute_480p` + kalite örnekleri macOS'ta |
| M9 | Testler: birim + Rust + E2E (WKWebView'de CDP yok: E2E sürücüsü için `safaridriver`/WebDriver ya da Tauri WebDriver değerlendirmesi) | kod | `desktop-beta` kapısının `macos` katmanları sonuç dosyası üretir |
| M10 | Gerçek cihaz oturumları: Apple Silicon + Intel, temiz kurulum, Gatekeeper, VoiceOver, ölçek | cihaz | `docs/releases/evidence/desktop-beta.json` `mac-*` kayıtları |

**Gerekli dış kaynaklar:** en az bir Apple Silicon Mac (Intel desteklenecekse bir Intel Mac ya da universal derlemenin Intel'de denenmesi), Apple Developer hesabı ya da imzasız dağıtım kararı. **Tahmin:** M1–M4 büyük iş (L, ayrı teslimlere bölünmeli); ölçülmeden süre verilmez.

## Linux (P03) — kod hazır, gerçek cihaz yok

Bugünkü kod gerçeği: GtkGLArea + mpv render API (OpenGL) gömme `engine/linux.rs` ([ADR 0002](../adr/0002-linux-video-yuzeyi.md)); `scripts/linux/{setup-dev,stage-mpv,package,engine-smoke}.sh`; deb/AppImage yapılandırması `src-tauri/packaging/linux/appimage-deb.conf.json`. Tek kanıt WSLg (X11) — Wayland/llvmpipe'ta siyah kare mpv'nin kendi yolunda da görüldü, uygulama hatası diye kesinleşmedi.

| # | Görev | Tür | Kabul |
|---|---|---|---|
| L1 | Gerçek GPU'lu X11 masaüstü (ör. Ubuntu 24.04 GNOME on Xorg): görüntü, ses, altyazı, ölçek, çoklu monitör, tam ekran | cihaz | `linux-x11` kaydı (dağıtım, masaüstü, GPU, sürücü, mesa sürümü) |
| L2 | Gerçek GPU'lu Wayland (GNOME + KDE): aynı liste + VAAPI kopya-geri çözme (`auto-copy-safe`) | cihaz | `linux-wayland` kaydı; siyah kare görülürse ayrı hata kaydı |
| L3 | deb + AppImage: temiz kurulum/kaldırma, hedef glibc tabanının en eski sürümde açılması, yeni ad (`hs-studio`) ile paket | cihaz (paket betiği var) | `linux-packages` kaydı + paket manifesti |
| L4 | Linux paketinin ad değişikliğinden sonra yeniden üretilmesi (bugüne kadar yalnızca eski adla WSL'de) | kod/derleme | `scripts/linux/package.sh` çıktısı + `legal/inventory` Linux envanteri |
| L5 | OS eylemleri: portal (birlikte aç), GNOME duvar kâğıdı, PDF'ye yazdır, `tesseract` OCR | cihaz | `docs/manual-os-checklist.md` Linux sütunu |
| L6 | Medya tuşları (MPRIS) — Windows SMTC eşi yok | kod | Müzik modunda MPRIS kontrolü |
| L7 | Video iyileştirme kodlayıcısı (`libopenh264` ya da yedek) kalite/hız ölçümü | cihaz | `enhance_speed_*` + kalite örnekleri Linux'ta |
| L8 | E2E sürücüsü: WebKitGTK'da CDP yok; `WebKitWebDriver` ile E2E'nin Linux'ta koşması | kod | `desktop-beta` kapısının `linux` katmanları sonuç dosyası üretir |
| L9 | Ekran okuyucu (Orca), klavye, yüksek kontrast | cihaz | kanıt dosyasına kayıt |

**Gerekli dış kaynaklar:** gerçek GPU'lu bir Linux makinesi (Intel/AMD tümleşik yeterli; NVIDIA ayrı denenirse daha iyi), X11 ve Wayland oturumları. Hesap gerekmez. WSL dağıtımı (`Ubuntu-24.04`) yalnızca derleme için yeterli, doğrulama için değil.

## Ortak

- `desktop-beta` hedefi her platform için ayrı sonuç klasörü ister: `--results darwin-arm64=<dir> --results linux-x64=<dir>`. Bir platformun sonucu diğerinin yerine geçmez; düz “doğrulandı” yalnızca Windows kanıtı sayılır.
- Bu listedeki hiçbir satır, cihazda çalıştırılmadan “doğrulandı” yazılmaz.
