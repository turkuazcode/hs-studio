# Oynatma motoru (libmpv + HTML5 yedeği)

Karar: [ADR 0001](adr/0001-oynatma-motoru.md) · Plan: [02 §2–§4](plans/02-oynatma-motoru.md)

## Mimari
```
src-tauri/src/engine/
  mod.rs     DLL bulma (VHO_MPV_DLL → exe yanı → exe\mpv\ → resources\mpv\), mpv seçenekleri,
             komutlar engine_status/load/command/set/get/show/screenshot, çıkışta "quit"
  mpv.rs     elle yazılmış FFI (libloading ile ÇALIŞMA ANINDA yükleme; mpv_node <-> JSON)
  window.rs  Windows "A′ sahipli açılır pencere": video ayrı popup'ta, Tauri penceresi onun owned
             penceresi; ana HWND alt sınıflanır (SetWindowSubclass), WM_WINDOWPOSCHANGED /
             WM_SHOWWINDOW / WM_DPICHANGED'de popup eşzamanlı taşınır (sürüklemede gecikme yok),
             simge durumunda gizlenir. Diğer platformlar: Unavailable (yol B ayrı iş paketi).
  events.rs  mpv olay iş parçacığı → engine://property {name,value} (time-pos ≤ 8 Hz, durum
             değişiminde son değer hemen) ve engine://event (file-loaded, end-file, seek, …)
src/media/engine/
  engine.js        cephe (facade) + saf yardımcılar (iz listesi, bölümler, EQ zinciri, …)
  mpv-engine.js    libmpv: Tauri komut/olayları
  html5-engine.js  <video> + Media Foundation dönüştürme + codec tanılama + CORS yeniden deneme
```
Arayüz modülleri (video-player, timeline, HUD, A-B, kaldığın yer, uyku zamanlayıcısı, altyazı,
ekran görüntüsü, oynatma listesi) yalnızca `app.engine` cephesiyle konuşur. Cephe öğe başına seçer:
yol/URL → libmpv, tarayıcı `File` nesnesi → HTML5 (libmpv blob okuyamaz).

Pencere: DLL bulunursa ana pencere `transparent: true` açılır. Sayfa yalnızca libmpv video
gösterirken saydamdır (`html.engine-mpv-video`); fotoğraf, boş ekran ve HTML5 motorunda opak
arka plan geri gelir ve mpv penceresi gizlenir (`engine_show(false)`).

## Ortam değişkenleri
| Değişken | Etki |
|---|---|
| `VHO_DISABLE_MPV=1` | libmpv hiç yüklenmez → HTML5 motoru, opak pencere (E2E yedek testleri) |
| `VHO_MPV_DLL=<yol>` | belirli bir `libmpv-2.dll` |
| `VHO_SCREENSHOT_DIR=<klasör>` | mpv ekran görüntüleri (varsayılan: Resimler\VHO) |

## DLL'ler ve paketleme
* DLL'ler depoya **girmez**. Kaynak: `third_party/mpv/build-windows.sh` çıktısı
  `third_party/mpv/_build/dist` (38 DLL, 67 MB; zip 28 MB).
* Geliştirme: `npm run build:release` sonrası `npm run stage:mpv` (veya
  `powershell -File scripts\stage-mpv.ps1 -Source <dist>`; `VHO_MPV_DIST` de olur) DLL'leri
  `src-tauri\target\release\` (ve varsa `debug\`) içine kopyalar; `-Remove` geri alır.
* Paketleme (sonraki iş paketi, C3): `tauri.conf.json` →
  `"bundle": { "resources": { "../third_party/mpv/_build/dist/*.dll": "mpv/" } }`. Windows'ta
  Tauri kaynakları exe klasörü altına kurar; `engine::locate` `resources\mpv\libmpv-2.dll`'i bulur,
  bağımlı DLL'ler `LOAD_WITH_ALTERED_SEARCH_PATH` ile aynı klasörden çözülür. CI, dist listesini
  `evidence/windows/dist-sizes.tsv` ile karşılaştırmalı (MSYS2 DLL adları sürümle değişebilir).
* Lisanslar: `legal/mpv-notices.py <ffmpeg kaynak> [<msys2 licenses>]` bölümü
  `legal/NOTICES_HEADER.txt` içine yazar, ardından `powershell -File legal\generate-notices.ps1`.

## Özellikler (libmpv)
Ses kanalı menüsü (`aid`), altyazı kanalları CC menüsünde (`sid`; gömülü + `sub-add` ile harici
SRT/VTT/ASS, yol ile açılan/sürüklenen altyazı), altyazı stili (`sub-scale`, `sub-color`,
`sub-pos`; HUD görünürken `sub-margin-y` yükselir), altyazı gecikmesi (`sub-delay`), ses gecikmesi
±50 ms (`audio-delay`), 10 bant ekolayzır + hazır ayarlar + normalizasyon (`af=lavfi=[…]`,
dynaudnorm), AI ses anahtarları lavfi filtresi olarak, %200 ses (`volume-max=200`), bölümler
(zaman çubuğu işaretleri + menü), dosya başına yer imleri (K), kare kare (`.` `,`), ekran görüntüsü
(`screenshot-to-file`, altyazılı), döndür/yansıt (`video-rotate`, `vf=hflip/vflip`), yakınlaştırma
(Ctrl+tekerlek, `video-zoom`) ve kaydırma (Ctrl+sürükle, `video-pan-*`), parlaklık/kontrast/
doygunluk/gama/ton, en-boy (`video-aspect-override`, `keepaspect`), A-B döngü (`ab-loop-a/b`),
`hwdec=auto-safe` (Ayarlar > Gelişmiş), `profile=fast` (dahili GPU'da varsayılan açık),
`deinterlace=auto`, `tone-mapping=auto` (HDR → SDR), HLS URL'leri. PiP yalnızca HTML5 motorunda.
