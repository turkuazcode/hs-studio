# VHO Yol Haritası — Çok Platformlu Video & Fotoğraf Stüdyosu

> **25 Ekim 2026 — Claude uygulama devri:** Önce [CLAUDE-DEVIR.md](CLAUDE-DEVIR.md), ardından [08 — Güncel durum ve uygulama sırası](08-uygulama-sirasi-ve-durum.md) okunmalı. 01–07 planları korunur; 08–14 mevcut işleri eşler, eksikleri ve kabul ölçütlerini ekler. Aşağıdaki genel “AI kapsam dışı” ifadesi önceki dalgaya aittir; yeni AI işleri 11–12'de ayrı kapsam olarak planlandı. Plan 07'deki kullanıcının geliştirdiği “Otomatik iyileştir” algoritmasının sahipliği korunur; ayrıntı Plan 11'dedir. Bu ek yalnızca planlamadır, uygulama/tamamlanma kanıtı değildir.

**Hedef:** Windows, macOS ve Linux'ta her video/fotoğraf formatını açan, modern arayüzlü, video + fotoğraf + müzik bir arada medya stüdyosu.
**Rakip analizi:** VLC (format/platform), mpv (görüntü kalitesi), PotPlayer (özellik zenginliği), IINA (macOS), XnView MP / IrfanView / FastStone (fotoğraf), Windows Medya Oynatıcı (kütüphane/müzik).
**Yapay zekâ özellikleri bu yol haritasının dışında** (sonraya bırakıldı; mevcut kod korunur, yeni iş yapılmaz).

## Bağlayıcı kararlar
| Konu | Karar |
|---|---|
| Oynatma motoru | **libmpv, LGPL derlemesi** (`-Dgpl=false`) + **FFmpeg LGPL** (`--enable-gpl` YOK). VHO'nun MIT lisansı korunur. Dinamik bağlama (DLL/dylib/so). |
| Lisans politikası | Kabul: MIT, Apache-2.0, BSD-2/3, ISC, Zlib, BSL-1.0 (2026-10-25 kullanıcı onayı), MPL-2.0, Unicode, CC0, CC-BY-4.0, OFL-1.1 (yalnızca fontlar; font, E1 — Outfit arayüz fontu, 2026-10-25), **LGPL (yalnızca dinamik bağlama)**. Red: GPL, AGPL, ticari olmayan (NC, S-Lab), lisanssız kod. Her yeni bağımlılık `legal/NOTICES_HEADER.txt` + `legal/generate-notices.ps1` ile bildirime eklenir. |
| Eski HTML5 `<video>` yolu | libmpv yüklenemezse **yedek motor** olarak kalır (motor soyutlaması arkasında). |
| Mimari | Ön yüz: vanilla JS **ES modülleri** (çerçeve yok). Arka uç: Rust/Tauri v2. Arayüz motordan bağımsız: `engine` cephesi (facade) üzerinden konuşur. |
| Platform | Geliştirme/test makinesi: Windows 11 (1 GB dahili AMD GPU). macOS/Linux derleme ve testi: CI (GitHub Actions) — uzak depo kararı kullanıcıda (Dalga 3). |

## Arayüz ilkeleri (kullanıcı kararı — bağlayıcı)
1. **Sadelik:** Ana ekranda yalnızca **sık kullanılan** kontroller görünür. Kullanıcı çok ayar görmemeli.
2. **Gerisi gizli ama ulaşılabilir:** Az kullanılan eylemler "⋯" menüsünde / sağ tık menüsünde; seçenekler ve ince ayarlar **Ayarlar** penceresinde (B2'nin `app.settings.register` API'si). Yeni özellik = önce Ayarlar'a, ancak gerçekten sık kullanılıyorsa ana ekrana.
3. **Medya türüne göre ayrı arayüz:** **Video**, **Fotoğraf** ve **Müzik** için ayrı ekran düzenleri (ayrı araç çubukları/kontroller). Bir türün kontrolleri diğerinde görünmez.
4. Görsel tasarım ve ayrıntılı düzenlemeler daha sonra kullanıcıyla birlikte ayrıca yapılacak; şimdilik işlevsel ve sade olsun.

## Dalgalar ve ajan dağılımı
Her ajan **kendi git worktree'sinde** çalışır, kendi dalına commit eder. Entegrasyon (birleştirme, çakışma çözümü, tam test) ana oturum tarafından yapılır.

### Dalga 1 — Temel (paralel)
| Ajan | Plan | Dokunduğu alan | Çakışma riski |
|---|---|---|---|
| **A1 Temel** | [01-temel-mimari-ve-test.md](01-temel-mimari-ve-test.md) | `src/**` (main.js modüllere bölünür), `tests/**`, `package.json` | Yüksek → Dalga 1'de `src/` yalnızca A1'de |
| **A2 Motor denemesi** | [02-oynatma-motoru.md](02-oynatma-motoru.md) §1 | `experiments/mpv-spike/**`, `third_party/mpv/**` (yalnızca yeni dosyalar) | Yok |
| **A3 Fotoğraf arka ucu** | [04-fotograf-studyosu.md](04-fotograf-studyosu.md) §1 | `src-tauri/src/photo/**` (yeni), `Cargo.toml` (bağımlılık ekleme) | Düşük (lib.rs'e yalnızca kayıt satırı) |

### Dalga 2 — Özellikler (A1 birleştikten sonra, paralel)
| Ajan | Plan |
|---|---|
| **B1 Motor entegrasyonu** | [02-oynatma-motoru.md](02-oynatma-motoru.md) §2–§4 |
| **B2 Platform & ayarlar** | [03-platform-ve-ayarlar.md](03-platform-ve-ayarlar.md) §1–§4 |
| **B3 Fotoğraf arayüzü** | [04-fotograf-studyosu.md](04-fotograf-studyosu.md) §2–§5 |

### Dalga 2.5 — Medya eylemleri ve metin çevirisi (B1 + B3 birleştikten sonra)
| Ajan | Plan |
|---|---|
| **D1 Medya eylemleri** | [06-medya-eylemleri.md](06-medya-eylemleri.md) — Windows Fotoğraflar tarzı araç çubuğu; sil/paylaş/yazdır/kopyala/arka plan yap/birlikte aç/metin tanıma; video kesme/dönüştürme/kare kaydetme; müzik etiket düzenleme/sözler |
| **D3 Akıllı düzenleme** | [07-akilli-duzenleme.md](07-akilli-duzenleme.md) — nesne silme (LaMa), arka plan kaldırma/bulanıklaştırma (BiRefNet), siyah-beyaz renklendirme (DDColor); D1'den sonra. "Otomatik iyileştir" kapsam dışı (kullanıcı geliştiriyor) |
| **D2 Metin çevirisi (i18n)** | [03-platform-ve-ayarlar.md](03-platform-ve-ayarlar.md) §3 — mevcut tüm metinlerin TR/EN anahtarlarına taşınması (D1 bittikten sonra, en son) |

### Dalga 3 — Kütüphane, ağ, yayın
| Ajan | Plan |
|---|---|
| **C1 Kütüphane & müzik** | [05-kutuphane-muzik-ag.md](05-kutuphane-muzik-ag.md) §1–§3 |
| **C2 Ağ & yayın** | [05-kutuphane-muzik-ag.md](05-kutuphane-muzik-ag.md) §4–§5 |
| **C3 Sürüm mühendisliği** | [03-platform-ve-ayarlar.md](03-platform-ve-ayarlar.md) §5 (kullanıcı kararı gerektirir: GitHub deposu, imza sertifikası) |

## Birleştirme protokolü (ana oturum)
1. Ajan dalını `git merge --no-ff` ile `main`'e al; çakışmaları çöz.
2. `npm test` (birim testleri) + `cargo test --release` + uçtan uca testler (`npm run e2e`).
3. Release derlemesi + `VHO.exe` güncellemesi + kısa duman testi.
4. Kullanıcıya özet: ne eklendi, test sonuçları, bilinen sorunlar.

## "Bitti" tanımı (her görev için)
- Özellik çalışıyor ve **otomatik testi var** (birim ve/veya uçtan uca).
- Mevcut testlerin hepsi geçiyor; release derlemesi uyarısız.
- Yeni bağımlılıkların lisansı politikaya uygun ve bildirimde.
- Arayüz metinleri Türkçe (Dalga 2'den sonra i18n anahtarları üzerinden).
- Kısa teknik not: ajan raporunda değişen dosyalar, test komutları, bilinen sınırlar.

## Rakiplerden alınan özellik listesi → plan eşlemesi
| # | Özellik | Kaynak rakip | Plan |
|---|---|---|---|
| 1 | Her formatı her platformda açma, HDR, donanım çözme | VLC, mpv | 02 |
| 2 | Çoklu ses/altyazı kanalı, gömülü altyazı, ASS/SSA | VLC, PotPlayer | 02 |
| 3 | Ses gecikmesi, ekolayzır, normalizasyon | PotPlayer | 02 |
| 4 | Bölümler, yer imleri, kare kare, ekran görüntüsü | mpv, PotPlayer | 02 |
| 5 | Kalıcı ayarlar, son açılanlar, dosya ilişkilendirme, tek örnek | hepsi | 03 |
| 6 | Arayüz dili (TR/EN), temalar | VLC, PotPlayer | 03 |
| 7 | Klasör tarayıcı, küçük resim ızgarası | XnView, FastStone | 04 |
| 8 | HEIC/AVIF/RAW, EXIF, harita | XnView | 04 |
| 9 | Toplu yeniden adlandırma/dönüştürme/boyutlandırma | IrfanView | 04 |
| 10 | Kırpma/döndürüp kaydetme/düzeltme, yan yana karşılaştırma | FastStone, Windows Fotoğraflar | 04 |
| 11 | Medya kütüphanesi, çalma listeleri (M3U), müzik modu | WMP | 05 |
| 12 | Ağ akışları (HLS, YouTube linki*), DLNA/UPnP, TV'ye yayın | VLC | 05 |
| 13 | Otomatik güncelleme, imzalı kurulum, mağazalar | hepsi | 03 |
| 14 | Sil, paylaş, yazdır, kopyala, arka plan yap, birlikte aç, metin tanıma (OCR) | Windows Fotoğraflar | 06 |
| 15 | Video kes/dönüştür/GIF/sesi çıkar/kare kaydet, mini oynatıcı | PotPlayer, VLC | 06 |
| 16 | Müzik etiket düzenleyici, kapak, şarkı sözleri (LRC), ReplayGain | WMP, foobar2000 | 06 |

\* YouTube bağlantıları yt-dlp gerektirir (Unlicense); kullanım koşulları nedeniyle kullanıcı onayıyla isteğe bağlı.
