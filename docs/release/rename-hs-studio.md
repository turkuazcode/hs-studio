# Ürün adı değişikliği: VHO → HS Studio

> **English summary:** The rename was **applied on 2026-10-28**: identifier `com.turkuazcode.hsstudio`, installed exe
> `HS Studio.exe`. Results are in §5. The procedure, run once at the very end:
> 1. All agent branches are merged into main.
> 2. Run `scripts/rename-product.mjs --apply --identifier <chosen id>`.
> 3. Regenerate notices and the SBOM.
> 4. Run the full check and the installer test.
>
> Today the app already contains everything the rename needs, and none of it does anything yet:
> - `src-tauri/src/identity.rs` copies the old identifier's data folders on the first start of the new identity.
> - The installer hook removes an old per-user "VHO" install.
>
> **The owner must choose the new bundle identifier first** (options below).

## 1. Kullanıcının vermesi gereken karar: yeni paket kimliği (bundle identifier)

Paket kimliği; kullanıcı veri klasörlerinin adını (`%APPDATA%\<id>`, `%LOCALAPPDATA%\<id>`), macOS bundle id'sini ve
ileride Linux/Flatpak uygulama kimliğini belirler. **Pratikte kalıcıdır.** Bir kez daha değişirse bir veri taşıma daha gerekir.
Ters alan adı biçiminde olmalı ve küçük harf kullanılmalı.

| Seçenek | Artıları | Eksileri |
|---|---|---|
| `com.hsstudio.app` | Kısa ve okunur; bugünkü `com.vho.app` ile aynı kalıpta | `hsstudio.com` alan adı projeye ait değil (başkasının olabilir). Ters alan adı kuralına tam uymaz; Flathub gibi mağazalar alan adı sahipliği isteyebilir |
| `com.turkuazcode.hsstudio` | Geliştirici markasına (TurkuazCode) bağlı; çakışma olasılığı düşük | Yalnızca `turkuazcode.com` kullanıcıya aitse kurala uyar (doğrulanmadı). Ürün ileride başka bir yapıya devredilirse kimlikte eski marka kalır |
| `io.github.<kullanıcı>.hsstudio` | Sahiplik GitHub hesabıyla kanıtlanır; Flathub bu biçimi kabul eder | Uzundur; GitHub kullanıcı adı veya organizasyon değişirse kimlik yine kalıcıdır. Depo henüz açılmadı |
| `app.hsstudio.desktop` (veya alınacak bir alan adı) | Ürüne özel bir alan adı alınırsa en temiz seçenek | Alan adı satın alma ve yenileme maliyeti; şu an yok |

Not: Windows kurulum paketi kayıt defterinde **ürün adını** kullanır (`HKCU\…\Uninstall\HS Studio`). Kimlik
yalnızca veri klasörlerini ve iç adları etkiler.

## 2. Bugün uygulamada olanlar (yeniden adlandırma gelene kadar etkisiz)

**Veri taşıma** (`src-tauri/src/identity.rs`):
- Yeni kimlikle ilk açılışta, eski kimliğin klasörleri yeni kimliğin klasörlerine **kopyalanır**. Kapsam: Roaming
  (`settings.json`, `library.db` + yedekler, `ai\` modelleri, pencere durumu) ve Local (WebView2 profili; yerel depolama dahil).
- Kurallar:
  - Yeni klasör zaten varsa hiçbir şey yapılmaz.
  - Eski klasör **silinmez ve değiştirilmez**.
  - Kopya önce `<yeni>.migrating-<pid>` klasörüne yazılır, sonra yeniden adlandırılır. Yarıda kalan bir kopya bir
    sonraki açılışta silinir ve iş baştan yapılır.
  - Yeniden üretilebilen önbellekler kopyalanmaz: küçük resimler, dönüştürme önbelleği, WebView2 HTTP/GPU önbellekleri.
- Taşıma tablosu (`MIGRATIONS`) şu an **boş**. Yalnızca birebir kimlik eşleşmesi taşır. Bu yüzden test kimlikleri
  (`com.vho.app.packagetest`, `<id>.test<hash>`) kullanıcının gerçek verisine dokunamaz. `VHO_DATA_DIR` ile çalışan
  test örnekleri de atlanır.
- Testler: Rust `identity::tests`, geçici klasörlerde ve sahte bir kimlik çiftiyle (`com.vho.test-old` →
  `com.hsstudio.test-new`) çalışır. Kontrol edilenler: önbellekler hariç her şeyin kopyalanması, eski klasörün korunması,
  ikinci çalıştırmanın hiçbir şey yapmaması, yeni kimliğin üzerine yazılmaması, yarıda kalan kopyanın temizlenip
  yeniden yapılması, taşıma tablosunun bugün boş olması.

**Kurulum paketi** (`src-tauri/packaging/windows/legacy-install.nsh.in`):
- NSIS kurulum öncesi kancası. Kurulumdan önce önceki ürün adıyla yapılmış kullanıcı başına kurulumu kendi kaldırıcısıyla,
  sessizce kaldırır. Kullanıcı verisi kalır; eski dosya ilişkilendirmeleri ve kısayollar kalkar. Böylece uygulama iki kez
  kurulu kalmaz.
- `package-windows.ps1` kancayı önceki adla üretir (yayında `VHO`, testte `VHO PackageTest`). Ürün adı aynı kaldıkça
  kanca boş derlenir.
- Prova: `package-windows.ps1 -Variant test-renamed` ("HS Studio PackageTest", `com.hsstudio.app.packagetest`) ve
  `test-installer.ps1 -RenamedInstaller`. Sonuçlar §5'te.

## 3. Betik: `scripts/rename-product.mjs`

- Varsayılan modu **kuru çalıştırmadır**: hangi dosyada kaç değişiklik olacağını ve neyin bilerek değişmediğini listeler.
- `--apply --identifier <id>` değişiklikleri yazar, sonra doğrulama yapar: kullanıcıya görünen dosyalarda "formerly VHO"
  dışında `VHO` kalmamalıdır.
- `--verify` yalnızca bu kontrolü yapar.
- `--exe-name "<ad>"` isteğe bağlıdır; kurulan exe'nin adını değiştirir (Tauri `mainBinaryName`). Verilmezse `vho.exe` kalır.
- Kendi testi: `tests/unit/rename-product.test.mjs`. Betik deponun **geçici bir kopyasında** uygulanır. Kontrol edilenler:
  JSON geçerliliği, yeni ad/kimlik/başlık/dosya ilişkilendirme adları, taşıma kaydı, Türkçe ek ("HS Studio'yu"), ortam
  değişkenlerinin değişmemesi, temiz doğrulama, ikinci çalıştırmanın hiçbir şey değiştirmemesi. Ayrıca gerçek depoda
  kuru çalıştırmanın hiçbir dosyayı değiştirmediği doğrulanır.

**Değişenler (kuru çalıştırmayla 21 dosya):**

| Alan | Dosyalar |
|---|---|
| Uygulama kimliği | `tauri.conf.json` (`productName`, `identifier`, pencere başlığı, dosya ilişkilendirme adları, isteğe bağlı `mainBinaryName`); `Cargo.toml` `description` |
| Veri taşıma kaydı | `identity.rs`: `("<id>", &["com.vho.app"])` |
| Kullanıcıya görünen metinler | `src/index.html`; `src/i18n/tr.json` ve `en.json` (6+6); Hakkında kutusu (`settings-modal.js`); varsayılan dosya adları (`photo-ai.js`, `snapshot.js`) |
| Dışa aktarma ve ekran görüntüsü klasörleri | `Videos\HS Studio`, `Pictures\HS Studio`; eski `VHO` klasörlerine dokunulmaz |
| HTTP user agent | `HS-Studio/<sürüm>` (AI indirmeleri) |
| Belgeler | README, CONTRIBUTING, SECURITY; bildirimlerin başlığı; SBOM ürün adı; LGPL kaynak teklifi; CHANGELOG'a bir satır |
| Testler | Görünen metni kontrol eden iki test (`i18n-coverage`, `storage.e2e`) |

**Bilerek değişmeyenler** (betik çıktısında da listelenir):

- `VHO_*` ortam değişkenleri: geliştirici ve test anahtarlarıdır.
- Crate/paket adları (`vho`, `vho_lib`), derleme çıktısı `vho.exe` ve dosya adları: kod tanımlayıcılarıdır.
- Test kimlikleri ve sentetik test verisi ("VHO Test" EXIF, OCR örnek metni).
- Git geçmişi; CHANGELOG'un eski kayıtları; `docs/plans`, `docs/status`, `docs/adr`: tarihsel kayıtlardır.
- "formerly VHO" / "eski adı VHO" ifadeleri.
- Kod yorumları ve `[VHO]` log önekleri: kullanıcı görmez.
- Taşıma ve kaldırma için gereken eski adlar (`com.vho.app`, NSIS kancasındaki `VHO`).

## 4. Sıra (entegratör; yalnızca bir kez)

1. Tüm ajan dallarını `main`'e birleştir. Açık dal kalmamalı; aksi halde çakışma çıkar.
2. Kullanıcıdan **kimlik kararını** al (§1). Gerekirse kurulan exe adını da (`--exe-name`) sor.
3. `node scripts/rename-product.mjs` (kuru çalıştırma) çıktısını gözden geçir.
4. `node scripts/rename-product.mjs --apply --identifier <id> [--exe-name "HS Studio"]`. Doğrulama "no leftover"
   demeli.
5. `powershell -File legal\generate-notices.ps1` ve `npm run sbom`.
6. `npm test`, ardından tam kontrol (`build:release`, `stage:mpv`, `test:rust`, `e2e`, `test:ai`) kilit kuyruğundan.
7. Kurulum testi:
   - Önce eski adlı bir test kurulumu kurulur (yeniden adlandırmadan önce üretilmiş `VHO PackageTest` paketi).
   - Ardından `test-installer.ps1 -RenamedInstaller` ile yeni adlı test paketi kurulur.
   - Yeni adın kendi kurulum testi de yapılır (`-Installer` + `-UpgradeInstaller`).
   - Gerçek veri taşıması, gerçek kimlikle temiz bir VM'de denenir: eski VHO kurulup kullanılır, yeni sürüm kurulur.
8. Tek commit ("Rename VHO → HS Studio"). Ardından logo ve ikon değişikliği (ayrı iş), geçmiş temizliği ve ilk push.

## 5. Prova sonuçları

**Uygulandı: 2026-10-28** (`rename/hs-studio` dalı, `main`e birleşti). Komut:
`node scripts/rename-product.mjs --apply --identifier com.turkuazcode.hsstudio --exe-name "HS Studio"`.

- Kimlik `com.turkuazcode.hsstudio` (kullanıcı kararı 2026-10-27). Kurulan program `HS Studio.exe`; Linux paketinde
  boşluksuz `hs-studio` (`packaging/linux/appimage-deb.conf.json`).
- Derleme çıktısı artık `target/release/HS Studio.exe`. Testler, `bench:media`, `package-windows.ps1` ve `release.yml`
  ikili adını `tauri.conf.json` `mainBinaryName`'den okur (`tests/e2e/lib/app.mjs` `appBinaryName()`).
- Test kimlikleri: `com.turkuazcode.hsstudio.test<hash>`; `clean-test-artifacts` eski (`com.vho.app.test…`) ve yeni
  önekleri tanır, gerçek uygulama klasörlerini (`com.turkuazcode.hsstudio`, `com.vho.app`) asla.
- Kurulum kancası (`legacy-install.nsh.in`): eski kaldırıcı başarısız olursa (eski uygulama hâlâ kapanıyorsa çıkış kodu 2)
  3 s arayla 3 kez daha dener, sonra kullanıcıdan eski uygulamayı kapatmasını ister (TR/EN, Yeniden Dene / İptal);
  İptal veya sessiz kurulumda kurulum **iptal edilir**, iki ürün yan yana kurulu kalmaz.

Testler (2026-10-28, `HS Studio.exe` ile):
- Tam kontrol: birim 225/225, Rust 223/223 (+2 ignored), E2E 256/256 (+2 todo: HLS), test:ai 23 geçti + 3 ortam
  atlaması (BiRefNet), release uyarısız. (İlk koşuda `test-isolation.e2e` eski test kimliği desenini sabit bekliyordu;
  düzeltildi, yeniden 1/1.)
- Kurulum testi (`test-installer.ps1`, yeni kodla `VHO PackageTest` 0.1.0 → 0.1.1): 28/28 (kurulum, kurulan exe ile E2E,
  yükseltme, kaldırma, ortam değişmedi).
- Ad değişikliği provası (`-RenamedInstaller`: yeniden adlandırmadan önce üretilmiş `VHO PackageTest` 0.1.0 → yeni
  `HS Studio PackageTest` 0.2.0): 3 ardışık koşu, her biri 28/28 — eski ürün kanca ile kaldırıldı (çıkış kodu 0), kullanıcı
  verisi değişmedi, yeni uygulama mevcut veriyle açıldı, göç öncesi yedek eklendi (`backups/library-v2-…-pre-migration.db`),
  kaldırmada hiçbir kullanıcı dosyası silinmedi.
- Prova sırasında bulunan: (1) eski uygulama henüz kapanırken eski kaldırıcı iptal ediyordu → kanca düzeltildi;
  (2) testin "veri korundu" denetimi yalnızca dosya sayısına bakıyordu (yeni sürümün yedeği sayıyı artırıyor) → artık
  kaldırmadan önceki her dosyanın sonra da var olduğunu denetler; (3) test, uygulamayı kapattıktan hemen sonra
  kaldırıyordu → uygulamanın çıkmasını bekler, kaldırmayı en fazla 3 kez dener.

Denenmedi (ortam bekliyor): gerçek kimlikle temiz VM'de gerçek veri taşıması (eski VHO kur, kullan, HS Studio kur);
eski uygulama **açıkken** kurulumun kullanıcıya sorması (kanca kodu var, etkileşimli olarak denenmedi); Linux paketinin
yeni adla üretilmesi (`hs-studio`, WSL); imzalı paket.
