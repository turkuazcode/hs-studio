# Uygulama durumu (S01)

**Tarih:** 2026-10-25 · **Ana dal:** `main` (D1 birleştirildi: `35de786`). Açık özellik dalı yok; `vho-worktrees/*` altındaki eski dalların (wave1/*, wave2/*, wave25/d1-eylemler) hepsi `main`'e birleşmiş durumda ve korunuyor.
Test kanıtı: [test-baseline.md](test-baseline.md). Durum değerleri: `ana dalda` · `ayrı dalda` · `yalnızca plan` · `kısmi/kanıt eksik`.

| Alan | Özgün plan | Durum | Kod kanıtı | Test kanıtı | Platform sınırı | Sonraki görev |
|---|---|---|---|---|---|---|
| Modüler ön yüz, olay yolu, ayarlar deposu | 01 | ana dalda | `src/core/*`, `src/ui/*` | birim (core, settings, keymap) + E2E smoke | — | — |
| Test düzeni (birim + CDP E2E) | 01 | ana dalda | `tests/unit`, `tests/e2e/lib` | 121 birim, 129 E2E | E2E yalnızca Windows/WebView2 | Q01 |
| libmpv motoru (LGPL), motor cephesi, HTML5 yedeği | 02 | kısmi/kanıt eksik | `src-tauri/src/engine/*`, `src/media/engine/*` | engine E2E (Windows) | macOS/Linux gömme yok (yol B) | P02–P04 |
| Ses/altyazı kanalları, EQ, bölümler, ekran görüntüsü | 02 | ana dalda | `src/ui/playback-menus.js`, `src/media/audio-*` | video/engine E2E | Windows | S04 (adlandırma) |
| Ayarlar, son açılanlar, kısayollar, tema, tek örnek | 03 §1–§4 | ana dalda | `src/ui/settings-*`, `src-tauri/src/platform.rs` | platform E2E | dosya ilişkilendirme yalnızca Windows'ta denendi | P04 |
| i18n altyapısı (TR/EN) | 03 §3 | kısmi/kanıt eksik | `src/core/i18n.js`, `src/i18n/*` | i18n birim testi | eski metinlerin çoğu hâlâ sabit Türkçe | S05 |
| Çevrimdışı fontlar | 03 | yalnızca plan | `src/index.html` Google Fonts kullanıyor, CSP'de izinli | — | — | S05 |
| Kurulum/CI/imza/güncelleme | 03 §5 | yalnızca plan | `.github/` yok | — | — | P05, R02 |
| Fotoğraf arka ucu (çözme, HEIC/AVIF/RAW, EXIF, küçük resim, toplu iş) | 04 | ana dalda | `src-tauri/src/photo/*` | 33 Rust photo testi, photo E2E | HEIC/AVIF işletim sistemi codec'ine bağlı; AVIF yoklaması S03 | A04 |
| Fotoğraf stüdyosu (ızgara, düzenleyici, karşılaştırma, harita) | 04 | ana dalda | `src/studio/*` | photo-studio E2E | Windows | L02 (yıldız/etiket) |
| Ortak SQLite depolama (`library.db`), şema göçleri, yedek/kurtarma, eski verinin göçü | 13/L01 (05) | ana dalda | `src-tauri/src/storage/*`, `src/core/library.js`, `src/core/library-db.js`, [storage-schema.md](../storage-schema.md) | 28 Rust storage testi, `tests/unit/library-db.test.mjs` (6), `tests/e2e/storage.e2e.mjs` (10) | yalnızca Windows'ta test edildi | L02, A02 |
| Kütüphane tarama, müzik modu, M3U, DLNA/yayın | 05 | yalnızca plan | son açılanlar/kaldığı yer/yer imi/favori artık `library.db`'de | — | — | L02–L04 |
| Medya eylemleri (sil/yeniden adlandır/kopyala/yazdır/paylaş/OCR, video kes/dönüştür/GIF, müzik etiket/sözler/ReplayGain) | 06 | ana dalda | `src-tauri/src/actions/*`, `src/ui/media-actions.js`, `docs/media-actions.md` | 21 Rust actions testi, actions E2E (29) | paylaşım/OCR Windows'a özgü; macOS/Linux yolları derleniyor ama test edilmedi; yazdır/paylaş/duvar kâğıdı gerçek ortamda tasarım gereği denenmedi; slayt gösterisi ayarları ve fotoğraf alt şeridi yapılmadı | — |
| Fotoğraf AI (DAT-2 ×4, GFPGAN, YuNet; WebGPU→WASM, parça parça çıkarım) | (önceki dalga) | kısmi/kanıt eksik | `src-tauri/src/ai/*`, `src/media/ai-*`, `face-restore.js` | onnx-patch birim testi; gerçek kalite testi yok | alpha 255'e sabitleniyor, EXIF/ICC korunmuyor | A02–A05 |
| AI model yönetimi (manifest, doğrulama, iptal, sürdürme, onarım, kaldırma, zip) | 11/A01 | ayrı dalda (`wave3/e3-modeller`, kod hazır) | `src-tauri/src/ai/{mod,manifest,download,zip,error}.rs`, `src/media/ai-status.js`, `src/ui/ai-models.js` | Rust `ai::` 21 test (yerel HTTP fixture: aynı boyutta bozuk dosya, kesilen bağlantı + Range, iptal, iki eşzamanlı istek, disk alanı, zip traversal/symlink/bomb/zip64), `tests/unit/ai-status.test.mjs`, `tests/e2e/ai-models.e2e.mjs` | gerçek CDN/HF indirmesi otomatik testte yok (Q01); macOS/Linux `statvfs` yolu derlenmedi/test edilmedi | A06 (Plan 07 modelleri) |
| Akıllı düzenleme (LaMa, BiRefNet, DDColor) | 07 | yalnızca plan | model kaynakları ve özetleri doğrulandı | Python referans denemesi (depo dışı) | — | A06 |
| Video "AI" | — | kısmi/kanıt eksik | libmpv'de kontrast/doygunluk; HTML5'te WebGL filtreleri — sinir ağı değil | — | — | S04, V01–V06 |
| Lisans bildirimleri | politika | ana dalda | `legal/*`, `src/legal/THIRD_PARTY_NOTICES.txt` | — | — | R01 |
