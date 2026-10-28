# Paketleme (P05)

> **English summary:** The Windows package is a per-user NSIS installer. It needs no admin rights and
> installs to `%LOCALAPPDATA%\<productName>`. It is built by `npm run package:windows` and ships the
> LGPL libmpv/FFmpeg set in `<install>\mpv\`. License files, the source offer and the SBOM go in
> `<install>\legal\`. User data lives outside the install folder: uninstall keeps it unless the user
> ticks "delete app data", and upgrades never touch it. `scripts/test-installer.ps1` tests the package
> safely with a separate test identity. macOS and Linux have configs and recipes but no device to test
> on yet (**ortam bekliyor**).

## Windows: neden NSIS?

| | NSIS (seçilen) | MSI (WiX) |
|---|---|---|
| Yönetici izni | Gerekmez: `installMode: currentUser`, `%LOCALAPPDATA%\VHO` | Tauri'nin WiX şablonu makine geneli kurar ve UAC ister |
| Tek kullanıcı + güncelleme | Tauri updater (R02) NSIS'i doğrudan destekler. `/UPDATE` ve `/P` (pasif) bayrakları var | Desteklenir ama makine geneli kurulum gerekir |
| Kaldırırken veriyi koruma | Kaldırıcıda "uygulama verilerini sil" kutusu vardır, **varsayılan olarak işaretsizdir** | Ayrıca yazılması gerekir |
| Dil | Türkçe + İngilizce kurulum ekranları | WiX'te dil başına ayrı MSI |
| Kurumsal dağıtım (GPO/Intune) | Sessiz kurulum: `/S` | MSI daha alışılmış. Gerekirse ileride ikincil paket olur |

MSI, temiz kurulum testi yapılana kadar yayımlanmaz (Plan 10 kararı).

## Paket içeriği

| Yol (kurulum klasörü) | Ne | Kaynak |
|---|---|---|
| `vho.exe` | Uygulama (Apache-2.0) | `cargo build --release` (Tauri) |
| `mpv\libmpv-2.dll` + 37 DLL | LGPL libmpv + FFmpeg ve bağımlılıkları; çalışma anında yüklenir, değiştirilebilir | `third_party/mpv/build-windows.sh` çıktısı (`_build/dist`) |
| `mpv\ffmpeg.exe`, `mpv\ffprobe.exe` | Aynı LGPL FFmpeg derlemesi; ayrı süreç olarak çalışır | `_build/prefix/bin` |
| `legal\LICENSE.txt`, `legal\NOTICE.txt` | Apache-2.0 metni ve atıf bildirimi (NOTICE ayrıca Lisanslar penceresinin en üstünde) | `LICENSE`, `NOTICE` |
| `legal\THIRD_PARTY_NOTICES.txt` | Bildirimler + tam lisans metinleri (uygulama içindeki Lisanslar penceresiyle aynı) | `src/legal/` |
| `legal\SOURCE-OFFER.txt` | LGPL bileşenler (libmpv/FFmpeg ve LGPL DLL'ler) için kaynak kod teklifi (3 yıl, turkuazcode@gmail.com) | `legal/SOURCE-OFFER.txt` (sürüm/commit dolduruluyor) |
| `legal\native-inventory.json`, `legal\sbom.cdx.json` | DLL sürüm/commit/SHA-256 listesi; bu paketin SBOM'u | `legal/inventory/`, `legal/generate-sbom.mjs` |
| `legal\TRADEMARKS.md` | Ad ve logo politikası | `TRADEMARKS.md` |
| `uninstall.exe` | NSIS kaldırıcısı | Tauri |

`engine/mod.rs`, `libmpv-2.dll` dosyasını `<exe>\mpv\` ve `<resources>\mpv\` altında arar. `actions/ffmpeg.rs`, ffmpeg için
`<exe>\mpv\` klasörüne bakar. Kurulum klasöründe her ikisi de bulunur ve ek PATH gerekmez. Bağımlı DLL'ler
`LOAD_WITH_ALTERED_SEARCH_PATH` ile aynı klasörden çözülür.

Kurulum paketinin yanında şunlar da üretilir: `*.exe.sha256` ve `package-manifest-<variant>-<version>.json`. Manifest,
pakete giren her dosyanın boyutunu ve SHA-256 değerini içerir.

## Komutlar

```powershell
# Yayın paketi. Nötr bir yoldan çalıştır (docs/release/build-path.md); DLL'ler envanterle birebir aynı olmalı.
npm run package:windows -- -MpvDist C:\build\hs-studio\third_party\mpv\_build\dist -SourceUrl https://<repo>/tree/v0.1.0
# Test kimliğiyle ("VHO PackageTest", com.vho.app.packagetest, dosya ilişkilendirmesi yok)
powershell -File scripts\package-windows.ps1 -Variant test -MpvDist <dist> [-Version 0.1.1]
# Güvenli kurulum testi (yalnızca test kimliği)
powershell -File scripts\test-installer.ps1 -Installer "src-tauri\target\release\bundle\nsis\VHO PackageTest_0.1.0_x64-setup.exe" [-UpgradeInstaller ...0.1.1...]
```

Yapılandırma: `src-tauri/packaging/windows/nsis.conf.json`. Bu dosya `tauri build --config` ile birleştirilir. Ana
`tauri.conf.json` dosyasındaki `resources` boş kalır, böylece `npm run build:release` ve geliştirici derlemeleri
DLL'siz de çalışır. Ürün adının değişmesi (HS Studio) için `tauri.conf.json` içindeki `productName`, `identifier`
ve pencere başlığı ile bu dosyalardaki `publisher` ve `copyright` alanlarını güncellemek yeterlidir.

İlk `tauri build --bundles nsis` çalıştırması NSIS araç takımını ve `nsis_tauri_utils` eklentisini
`%LOCALAPPDATA%\tauri\` altına indirir. Bu, Tauri'nin kullanıcı düzeyindeki önbelleğidir; sisteme kurulum yapılmaz.

## Kullanıcı verisi, yükseltme, kaldırma

- Ayarlar, `library.db` ve AI modelleri uygulamanın veri klasöründedir (Tauri uygulama dizinleri ya da `VHO_DATA_DIR`).
  Kurulum klasöründe değildir.
- **Yükseltme:** yeni kurulum paketi aynı klasöre yazar; veri klasörüne dokunmaz. Şema göçünü L01 üstlenir
  (yedek alıp göç eder).
- **Kaldırma:** "Uygulama verilerini sil" kutusu varsayılan olarak işaretsizdir; veri kalır. Kutu işaretlenirse
  `%APPDATA%\<identifier>` ve `%LOCALAPPDATA%\<identifier>` silinir. Bunlara AI modelleri ve kütüphane de dahildir.
- Tauri, kaldırma sırasında "verileri sil" seçilmediyse `HKCU\Software\<publisher>\<productName>` anahtarını
  (kurulum dili ve klasörü) bırakır. Bu, Tauri'nin tasarımıdır; sonraki kurulum aynı klasörü önerir.

## Güvenli kurulum testi (bu makinede)

`scripts/test-installer.ps1` gerçek bir kurulumu ve gerçek kullanıcı ortamını değiştirmemek için şunları uygular:

- Yalnızca `-Variant test` paketini kabul eder. Bu pakette ürün adı, kimlik ve kayıt defteri anahtarları farklıdır;
  dosya ilişkilendirmesi yoktur.
- Kurulum sessiz yapılır (`/S`), kısayol oluşturulmaz (`/NS`). Hedef, adında boşluk ve Türkçe karakter bulunan bir
  geçici klasördür. Kurulum kullanıcı düzeyindedir (HKCU) ve yönetici izni istemez.
- Önce ve sonra anlık görüntü alınıp karşılaştırılır: HKCU Uninstall, HKCU\Software\Classes, HKCU Run, Başlat menüsü
  ve masaüstü.
- E2E testleri (smoke + engine) **kurulan exe** ile çalışır (`VHO_EXE`). PATH en aza indirilir (System32 + node),
  yani MSYS2 veya geliştirici araçları görünmez. Veri ve WebView2 profili ayrıdır. Portlar 10900–10999 aralığındadır.
- Yükseltmede veri dosyalarının özetleri karşılaştırılır. Kaldırmadan sonra kayıt defteri anahtarı ve klasör kontrol
  edilir; verinin kaldığı doğrulanır. Ardından yalnızca test kimliğine ait artıklar temizlenir.

Sonuçlar: [aşağıda](#test-sonuçları-windows-11-x64).

## macOS ve Linux: ortam bekliyor

Bu makinede Mac veya Linux yok. Yapılandırmalar ve tarifler hazırdır ama **test edilmedi**:

- **macOS:** `src-tauri/packaging/macos/dmg.conf.json` (`app` + `dmg`, en düşük macOS 11).
  - Derleme: `npx tauri build --bundles app,dmg --config src-tauri/packaging/macos/dmg.conf.json`. Gerekenler:
    Xcode komut satırı araçları, Rust hedefi `aarch64-apple-darwin` ve/veya `x86_64-apple-darwin`.
  - libmpv macOS'ta henüz gömülmüyor (Plan 02 yol B). ffmpeg kullanıcının sistemindekiyle çalışır.
  - İmza ve notarization R02'de; hesap bekliyor.
- **Linux (P03):** `src-tauri/packaging/linux/appimage-deb.conf.json` (AppImage + deb).
  - Geliştirme ortamı `sudo bash scripts/linux/setup-dev.sh` (Ubuntu 24.04), LGPL libmpv/FFmpeg
    `bash third_party/mpv/build-linux.sh`, paket `bash scripts/linux/package.sh`.
  - Paket betiği LGPL dosya setini `legal/inventory/native-linux-x64.json` ile karşılaştırır, sistem FFmpeg'ine
    bağlanan dosya varsa durur, seti `<resources>/mpv/` altına (RUNPATH=$ORIGIN) ve `legal/` klasörünü (LICENSE, NOTICE,
    bildirimler, kaynak teklifi, envanter, SBOM) pakete koyar, SHA-256 manifesti yazar.
  - deb bağımlılıkları Ubuntu 24.04 paket adlarıdır (`libgtk-3-0t64`, `libasound2t64`, `libpipewire-0.3-0t64`, libass,
    libplacebo338, libva, wayland, …); dağıtımın mpv/FFmpeg paketlerine bağımlılık **bilerek yok**
    (bağımlılık politikası; [legal/INVENTORY.md](../../legal/INVENTORY.md)). Daha eski glibc tabanı (AppImage taşınabilirliği)
    R02 CI koşucusu bekliyor.
  - WSLg sonuçları: aşağıda "Linux (WSLg)". Gerçek Linux masaüstünde temiz kurulum: ortam bekliyor.
- İki platformda da `legal/` klasörünün hazırlanması `package-windows.ps1` içindeki adımla aynıdır (LICENSE,
  bildirimler, kaynak teklifi, SBOM). Bunun platformdan bağımsız bir betiğe taşınması P02/P03 gerçek testleriyle
  birlikte yapılacak.

## Linux (WSLg)

**2026-10-28**, WSL2 + WSLg, Ubuntu 24.04 (sanal ortam, yazılım GL; **gerçek Linux masaüstü kanıtı sayılmaz**):

| Adım | Sonuç |
|---|---|
| Paketler | `VHO_0.1.0_amd64.AppImage` (103,75 MiB, SHA-256 `549c0154…045a`), `VHO_0.1.0_amd64.deb` (25,22 MiB, SHA-256 `04bfa211…04f5`) |
| deb içeriği | `usr/bin/vho`, `usr/lib/VHO/mpv/` (libmpv + 7 FFmpeg `.so` + ffmpeg/ffprobe, envanterle aynı set), `usr/lib/VHO/legal/` (LICENSE, NOTICE, bildirimler, kaynak teklifi, envanter, SBOM) |
| Kurulum | `apt install ./VHO_0.1.0_amd64.deb`; dağıtımda mpv/FFmpeg paketi yok (0) |
| Kurulan uygulama | libmpv `/usr/lib/VHO/mpv/` altından yüklendi; motor smoke X11 ve Wayland'de: açma, oynatma, duraklat/ara, ses/altyazı izleri, `pulse` çıkışı geçti; X11'de video görüntüsü pencerede doğrulandı; Wayland'de llvmpipe kaynaklı siyah kare (ADR 0002 kaydı) |
| Kaldırma | `apt remove` sonrası paket kurulu değil |

Test edilmeyenler: AppImage'ın çalıştırılması, eski glibc dağıtımları, gerçek GPU/VAAPI, HiDPI ve çoklu monitör,
GNOME/KDE oturumu, kullanıcı verisinin yükseltmede korunması. Bunlar gerçek Linux masaüstünde **ortam bekliyor**.

## Test sonuçları (Windows 11 x64)

**2026-10-26** tarihinde bu makinede (Windows 11 x64, AMD 1 GB iGPU) `scripts/test-installer.ps1` ile **28/28 kontrol geçti**.
Komutlar `..\with-lock.ps1` kuyruğundan çalıştırıldı. Sonuç dosyası `tests/.results/installer.json`.

| Adım | Sonuç |
|---|---|
| Paketler | `VHO PackageTest_0.1.0_x64-setup.exe` (28,05 MB, SHA-256 `61d9da02…4b15`) ve `…_0.1.1_x64-setup.exe` (SHA-256 `db666875…15c1`); manifestte 48 dosya. NSIS 3.13 ve nsis_tauri_utils 0.5.3, Tauri tarafından `%LOCALAPPDATA%\tauri` altına indirildi |
| Kurulum | Sessiz kurulum (`/S /NS`), yönetici izni yok, hedef `%TEMP%\…\Kurulum Dizini ğüşıöç`. Yalnızca HKCU'ya kayıt yapıldı (HKLM'ye değil). `vho.exe`, `mpv\` (38 DLL + ffmpeg/ffprobe) ve `legal\` (LICENSE, NOTICE, THIRD_PARTY_NOTICES, SOURCE-OFFER, SBOM) yerinde; manifestle SHA-256 olarak birebir aynı |
| Ortam | Dosya ilişkilendirmesi, kısayol veya autostart oluşmadı (HKCU Classes, Run, Başlat menüsü ve masaüstü anlık görüntüleri aynı) |
| E2E (kurulan exe) | `smoke` + `engine`: **39/39 geçti, 0 atlandı**. PATH yalnızca System32 + node; ayrı veri ve WebView2 profili, portlar 10900–10999. libmpv, kurulum klasöründeki `mpv\` altından yüklendi |
| Veri | Kurulan uygulama yalıtılmış veri klasöründe `settings.json` ve `library.db` (+ WAL) oluşturdu |
| Yükseltme | 0.1.0 → 0.1.1 aynı klasöre kuruldu. Veri dosyalarının SHA-256 değerleri değişmedi; yükseltilmiş uygulama mevcut `library.db` ile açıldı |
| Kaldırma | HKCU kaldırma anahtarı ve kurulum klasörü silindi. **Kullanıcı verisi kaldı** (varsayılan). Test kimliğine ait artıklar betik tarafından temizlendi: `HKCU\Software\<publisher>\VHO PackageTest` (Tauri tasarımı) ve uygulamanın `VHO_DATA_DIR` ile oluşturduğu `%APPDATA%`/`%LOCALAPPDATA%\com.vho.app.packagetest.test*` klasörleri. Ortam anlık görüntüsü test öncesiyle aynı |

**Test edilmeyenler:**

- `release` varyantı: gerçek kimlik ve dosya ilişkilendirmeleri. Bilinçli olarak bu makinede kurulmadı, çünkü dosya
  ilişkilendirmeleri kullanıcının ortamını değiştirir. Temiz bir VM veya Windows Sandbox'ta denenmeli.
- Kurulum ekranları (Türkçe/İngilizce, lisans sayfası, "uygulama verilerini sil" kutusu). Yalnızca sessiz kurulum
  test edildi.
- WebView2 olmayan makine (bootstrapper indirmesi).
- İmzalı paket (R02/SignPath) ve updater.
- macOS ve Linux: **ortam bekliyor**.
