# CI, kod imzalama ve güncelleme (R02 yerel hazırlık)

> **Durum:** Workflow'lar yazıldı ama **hiç push edilmedi ve uzakta çalıştırılmadı**. İmzalama adımı kapalı:
> SignPath projeyi kabul edene kadar `vars.SIGNPATH_ENABLED` tanımsız kalır. Güncelleme (updater) için
> yapılandırma şablonu ve anahtar talimatı hazır; uygulamaya updater eklentisi **henüz eklenmedi**.
> Fiyat ve koşul bilgileri 2026-10-26 araştırmasıdır. Satın alma veya başvuru öncesinde resmî sayfalardan
> yeniden doğrulanmalıdır.

## Workflow'lar (`.github/workflows/`)

| Dosya | Tetik | Ne yapar |
|---|---|---|
| `ci.yml` | push `main`, PR, elle | `unit` (`npm test`, skip yok), `rust` (`cargo test --locked`), `native` (aşağıdaki), `e2e` (release exe + LGPL DLL seti, `npm run e2e`), istenirse gerçek AI smoke (model önbelleği manifest hash'iyle) |
| `native-windows.yml` | çağrılır / elle | `third_party/mpv/build-windows.sh` MSYS2 UCRT64'te çalışır. Önbellek anahtarı: betik + paket listesi hash'i. LGPL koruması: `--enable-gpl/version3/nonfree` ya da mpv `gpl=true` varsa adım başarısız olur. Çıktı artifact'ı `mpv-windows-x64` |
| `release.yml` | elle (sürüm girdisi) / `v*` etiketi | Sürüm kontrolü, `npm test`, `cargo test` ve `scripts/package-windows.ps1` çalışır. Çıktılar: kurulum paketi, `.sha256`, paket manifesti, SBOM, bildirimler, kaynak teklifi, LICENSE, `SHA256SUMS.txt`. **Yayımlama yapmaz**; yalnızca artifact üretir. İmzasız çıktının dosya adında `-UNSIGNED` bulunur |

Güvenlik kuralları:

- Tüm dış action'lar tam commit SHA'sına sabitlendi; etiket adı yorumda yazılı:
  checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, download-artifact v8.0.2, cache v6.1.0,
  Swatinem/rust-cache v2.9.3, dtolnay/rust-toolchain (master 2026-10), msys2/setup-msys2 v2.33.0,
  signpath/github-action-submit-signing-request v3.0.
- SHA'lar `git ls-remote` ile bulundu. Güncellenecekse yine SHA'ya güncellenir.
- Varsayılan izin `contents: read`. Release'te SignPath artifact'ı okuyabilsin diye ek olarak `actions: read`
  verildi. `checkout`, `persist-credentials: false` ile çalışır.
- Fork PR'larına sır verilmez (GitHub varsayılanı). İmza ve updater sırları yalnızca release workflow'unda
  kullanılır.
- Release derlemesinde Rust önbelleği kullanılmaz. Runner yolu kullanıcı adı içermez
  ([build-path.md](build-path.md)).
- Rust `1.99.1`, Node `24` olarak sabitlendi (workflow `env`). `npm ci` ve `--locked` ile kilit dosyalarına uyulur.

Bilinen sınır: MSYS2'nin `pacman`'ı **güncel** paketleri kurar. CI'daki yeni bir DLL derlemesi, envanterdekinden
farklı sürümler içerebilir. Bu durumda release, `package-windows.ps1` hash kontrolünde durur. Envanter ve bildirimler
bilerek güncellenmeden yayın çıkmaz. Kalıcı çözüm olarak DLL setinin tek bir doğrulanmış artifact olarak saklanması
veya MSYS2 paketlerinin sürüme sabitlenmesi P05/R02 sonrası iştir.

## Kod imzalama: SignPath Foundation (kullanıcı kararı 2026-10-26)

SignPath, açık kaynak projelere ücretsiz kod imzalama sağlar. Sertifika SignPath Foundation adına çıkar;
Windows'ta yayıncı olarak "SignPath Foundation" görünür.

**Başvuru koşulları** (<https://signpath.org/>, <https://signpath.org/terms>,
<https://about.signpath.io/product/open-source>; başvuru sırasında güncel hâli kontrol edilmeli):

1. OSI onaylı bir lisans kullanılmalı. Apache-2.0 bu şartı karşılar (2026-10-26'dan beri proje lisansı).
2. **Hiçbir bileşen için ticari çift lisans olmamalı.** Proje tek lisanslıdır (Apache-2.0), CLA yoktur ve katkılar
   aynı lisansla gelir. Bu yüzden çatışma yoktur.
3. Tescilli bileşen olmamalı. Sistem kütüphaneleri hariçtir. LGPL DLL'ler açık kaynaktır. Uygulama içindeki
   bağımlılıkların tamamı açık kaynak ([legal/INVENTORY.md](../../legal/INVENTORY.md)).
4. Proje aktif olmalı ve imzalanacak biçimde **zaten yayımlanmış** olmalı. İndirme sayfasında özellikler anlatılmalı.
   Pratikte ilk sürüm imzasız (`-UNSIGNED`) yayımlanır, sonra başvurulur.
5. Derleme tamamen otomatik olmalı ve kaynak depodan SignPath'e bağlanmalı. Bunu GitHub Actions + "trusted build
   system" sağlar; `release.yml` buna göre yazıldı.
6. Proje sayfasında bir **kod imzalama politikası** yayımlanmalı (kim onaylar, ne imzalanır).
7. Kötü amaçlı yazılım veya istenmeyen program içermemeli.

**Kullanıcının yapacakları (hesap gerektiren adımlar):**

- Depoyu GitHub'da yayımla.
- İlk imzasız sürümü çıkar.
- signpath.org üzerinden başvur.
- Kabul gelince SignPath'te şunları oluştur: proje, "GitHub.com" trusted build system bağlantısı, imzalama
  politikası, iki artifact yapılandırması.
  - Bir yapılandırma `vho.exe` içindir. `upload-artifact` ZIP ürettiği için kök öğe `<zip-file>` olur.
  - Diğeri NSIS kurulum paketi içindir.
- GitHub deposuna `SIGNPATH_API_TOKEN` sırrını ve şu değişkenleri ekle: `SIGNPATH_ORGANIZATION_ID`,
  `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`, `SIGNPATH_EXE_CONFIG`, `SIGNPATH_INSTALLER_CONFIG`.
  Ardından `SIGNPATH_ENABLED=true` yap.

**Akış (`release.yml`):**

1. `package-windows.ps1 -Phase build`
2. `vho.exe` SignPath'te imzalanır.
3. İmzalı exe ile `-Phase bundle` çalışır.
4. Kurulum paketi SignPath'te imzalanır.
5. `.sha256` ve `SHA256SUMS.txt` yeniden hesaplanır.

Üçüncü taraf DLL'ler (MSYS2/FFmpeg) imzalanmaz; kendi derlenmiş halleriyle dağıtılır.

### Diğer seçenekler (yalnızca bilgi; satın alma yok)

| Seçenek | Maliyet (araştırma, 2026-10) | Koşul / not | Kaynak |
|---|---|---|---|
| Azure Artifact Signing (eski adı Trusted Signing) | Basic: aylık 9,99 USD, 5.000 imza; fazlası imza başına 0,005 USD | Microsoft'un hızlı başlangıç sayfasına göre genel güven için ABD/Kanada/AB/BK'daki kuruluşlar ve ABD/Kanada'daki bireyler. Bir Microsoft Q&A yanıtı ve bir blog, bireysel kaydın kısıtlandığını yazıyor. Türkiye'deki birey için şu an uygun görünmüyor | <https://azure.microsoft.com/en-gb/products/artifact-signing>, <https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart>, <https://learn.microsoft.com/en-us/answers/questions/2245291/identity-validation-individual-add-new-identity-op> |
| Klasik OV sertifika (Sectigo/Certum/DigiCert…) | Sectigo OV yılda yaklaşık 220 USD, DigiCert yılda yaklaşık 439 USD. Certum bulut OV için tek bir blog yılda yaklaşık 116 USD veriyor (doğrulanmadı) | 2023-06-01'den beri anahtar FIPS 140-2 donanımda (USB token veya bulut HSM) olmalı. Bir kaynağa göre 2026-03-01'den itibaren azami geçerlilik 460 gün (CSC-31). Tek kaynak, doğrulanmalı | <https://www.ssldragon.com/ssl-certificates/code-signing/>, <https://www.ssl.com/guide/esigner-pricing-for-code-signing/>, <https://sslinsights.com/sectigo-code-signing-certificate-guide/>, <https://gabrielmoraru.com/obtaining-cheap-ev-ov-certificates-singing-your-application/> |
| İmzasız | 0 | SmartScreen "tanınmayan yayıncı" uyarısı gösterir. Kullanıcı "yine de çalıştır" demek zorunda kalır | — |

Hiçbir imza anahtarı veya sertifika depoya ya da loglara girmez. Tauri'nin `bundle.windows.signCommand` ayarı
kullanılmadı; imzalama yalnızca CI'da SignPath üzerinden yapılır.

## Tauri updater (yapılandırma hazır, eklenti bekliyor)

- Şablon `src-tauri/packaging/updater.conf.json`: `bundle.createUpdaterArtifacts`,
  `plugins.updater.pubkey/endpoints`, `windows.installMode: passive`. `package-windows.ps1 -Updater` ile
  birleştirilir. Workflow'da `vars.UPDATER_ENABLED == 'true'` iken etkinleşir.
- **Uygulamaya henüz eklenmedi:** `tauri-plugin-updater` (Rust) ve `@tauri-apps/plugin-updater` (JS). Eklenti
  Rust 1.90+ gerektirir. Eklemeden önce kullanıcı kontrolü planlanmalı: kanal (stable/preview), etkin iş
  varken ertelenmesi, L01 veri yedeği.
- Test edilmesi gerekenler: yanlış imza, bozuk indirme, ağ kesintisi, eski sürüme düşürme denemesi (Plan 14/R02).
  Bu testler eklentiyle birlikte yazılacak. Kaynak: <https://v2.tauri.app/plugin/updater/>.

**Anahtar üretimi (kullanıcı, kendi makinesinde, bir kez):**

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\hs-studio-updater.key"
# parola sorulur; parola ve dosya bir parola yöneticisinde ve çevrimdışı bir yedekte saklanır
```

- **Özel anahtar** (`…updater.key`) ve parolası **asla** depoya, loglara, issue'lara veya bu belgeye girmez.
  Yalnızca şu iki yerde tutulur:
  1. Kullanıcının parola yöneticisi ve şifreli çevrimdışı yedek.
  2. GitHub depo sırları `TAURI_SIGNING_PRIVATE_KEY` (dosya içeriği) ve `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **Açık anahtar** (`…updater.key.pub` içeriği) `updater.conf.json` içindeki `pubkey` alanına yazılır. Gizli değildir.
- Anahtar kaybolursa mevcut kurulumlar yeni imzalı güncellemeleri kabul etmez. Kullanıcılar yeni sürümü elle
  kurmak zorunda kalır. Bu yüzden yedek şarttır.
- Bu çalışmada **hiçbir anahtar üretilmedi**.

## Yayın öncesi yapılacaklar (kullanıcı)

1. GitHub deposunu aç ve geçmişi temizle ([history-cleanup.md](history-cleanup.md)).
2. Action SHA'larını gözden geçir, `ci.yml` ile ilk çalıştırmayı yap. Windows runner'da `native-windows.yml`
   yaklaşık 30–60 dakika sürer; önbellekten sonra hızlanır.
3. İlk imzasız sürümü yayımla, SignPath'e başvur, imzalama politikası sayfasını ekle.
4. Updater anahtarını üret ve sakla. Eklenti entegrasyonu ayrı bir iş kartıdır.
