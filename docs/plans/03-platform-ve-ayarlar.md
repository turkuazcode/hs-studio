# Plan 03 — Platform Entegrasyonu, Ayarlar, Dil, Sürüm Mühendisliği

## §1 Kalıcı ayarlar ve son açılanlar (Ajan B2)
- `tauri-plugin-store` (MIT/Apache) ile `settings.json`: ses seviyesi, son hız, en-boy, altyazı stili/gecikme, filtreler, tema, dil, uyku zamanlayıcısı tercihi, pencere boyutu/konumu (`tauri-plugin-window-state`).
- **Son açılanlar:** son 20 dosya (yol, ad, tür, süre, kaldığı yer, küçük resim önbelleği). Boş ekranda "Son açılanlar" ızgarası + titlebar menüsü.
- **Ayarlar penceresi** (yeni modal, sekmeler): Genel, Oynatma, Altyazı, Ses, Fotoğraf, Görünüm, Gelişmiş, Hakkında/Lisanslar.
- `localStorage` yalnızca geçici kullanımlarda kalır; kaldığın yer bilgisi store'a taşınır (göç kodu ile).

## §2 Dosya ilişkilendirme, tek örnek, "Birlikte aç"
- `tauri.conf.json > bundle.fileAssociations`: video (mp4, mkv, avi, mov, wmv, webm, flv, ts, m2ts, 3gp, mpg, …), ses (mp3, flac, wav, m4a, ogg, opus, wma), görsel (jpg, png, webp, gif, bmp, avif, heic, tiff, raw türleri), altyazı (srt, vtt, ass).
- `tauri-plugin-single-instance`: zaten açıkken çift tıklanan dosya yeni pencere yerine mevcut pencerede açılır (argümanlar `openPaths`'e iletilir).
- macOS: `RunEvent::Opened` (Finder'dan açma) işlenir.
- Windows: "Varsayılan uygulamalar" ayarına yönlendiren buton (Windows 11'de program kendini varsayılan yapamaz).

## §3 Arayüz dili (TR/EN) ve temalar
- `src/i18n/{tr.json,en.json}` + `data-i18n` öznitelikleri + `t(key, vars)`; dil ayarı store'da; varsayılan sistem dili.
- Tüm sabit metinler (index.html + JS toast'ları) anahtarlara taşınır; eksik anahtar testi (`npm test`: her anahtar her dilde var).
- Temalar: Koyu (mevcut "Obsidian & Ruby"), Açık, Yüksek kontrast; vurgu rengi seçimi. CSS değişkenleri üzerinden.
- Erişilebilirlik: tüm butonlarda `aria-label`, klavye odak göstergesi, ekran okuyucu için canlı bölgeler (toast'lar).

## §4 Klavye ve fare
- Kısayol tablosu tek modülde, Ayarlar'da düzenlenebilir; çakışma denetimi; "Kısayollar" yardım penceresi (`?`).
- Fare: tekerlekle ses (video) / zoom (fotoğraf), orta tık tam ekran, sağ tık bağlam menüsü (Tauri menü API'si).

## §5 Sürüm mühendisliği (Ajan C3, Dalga 3 — kullanıcı kararları gerekir)
| Konu | Plan | Karar gereken |
|---|---|---|
| Kurulum paketleri | Windows: NSIS + MSI; macOS: DMG (universal); Linux: AppImage, .deb, .rpm, Flatpak | — |
| CI | GitHub Actions matris (windows-latest, macos-latest, ubuntu-22.04): derleme + `npm test` + E2E (Windows) + libmpv derlemesi | **GitHub deposu oluşturulsun mu? (herkese açık/özel)** |
| Kod imzalama | Windows: Authenticode (veya Azure Trusted Signing); macOS: Developer ID + notarization | **Sertifika maliyetleri** |
| Otomatik güncelleme | `tauri-plugin-updater` (imzalı güncelleme manifesti, GitHub Releases) | Yayın kanalı |
| Mağazalar | Microsoft Store, Flathub; Mac App Store (sandbox kısıtları nedeniyle sonra) | Hesaplar |

## Testler
- Birim: ayar şeması doğrulama/göç, i18n anahtar eşitliği, kısayol çakışma denetimi.
- E2E: ayar değiştir → uygulamayı yeniden başlat → değer korunmuş; zaten açıkken ikinci `vho.exe dosya.mp4` → aynı pencerede açıldı; dil değiştir → metinler değişti.
