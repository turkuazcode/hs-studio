# Windows alfa — elle doğrulama oturumları (denetim D09)

Bu oturumlar otomatik testlerin **yerine geçmez, onlara eklenir**. Otomatik testler gerçek sistemi değiştirmez (`VHO_DISABLE_SYSTEM_CHANGES=1`) ve kurulum testi yalnızca test kimliğiyle (“VHO PackageTest”) yapılır. Sonuçlar yalnızca [evidence/windows-alpha.json](evidence/windows-alpha.json) dosyasına yazılır; `scripts/release-gate.mjs --stage release` bu kayıtları **test edilen kurulum dosyasının SHA-256'sıyla** eşleştirir. Otomatik bir sonuç bu dosyaya yazılmaz.

## Ön koşul: aday paket

1. `release.yml` aday kapısından geçmiş paket (`release-windows-x64-<sürüm>` artifact'ı) ya da yerelde `scripts/package-windows.ps1` (`-Variant release`) çıktısı.
2. Kurulum dosyasının SHA-256'sı: paket manifestindeki `sha256` (ya da `Get-FileHash`). Her kayıtta `artifactSha256` olarak yazılır.
3. Oturumlar **temiz bir Windows VM'de** (Windows 11 ve mümkünse Windows 10 22H2, x64) ya da Windows Sandbox'ta yapılır; kullanıcının günlük makinesinde gerçek kimlikle kurulum yapılmaz. VM anlık görüntüsü her oturumdan önce geri yüklenir.

Kayıt biçimi (her kontrol için): `result` = `pass` / `fail`, `os` (sürüm + derleme + mimari), `date`, `tester`, `artifactSha256`, `notes` (sorunlar, ekran görüntüsü yolu).

## 1. Temiz kurulum (`win-clean-install`)

- Yönetici olmayan standart kullanıcıyla kurulum dosyasını çift tıkla. SmartScreen/imza davranışını not et (imzasız pakette “Bilinmeyen yayıncı” beklenir; imzalıysa yayıncı adı).
- Kurulum dizini `%LOCALAPPDATA%\Programs\HS Studio` (ya da seçilen), Başlat menüsü kısayolu, ilk açılışta TR/EN dil, boş durum ekranı.
- `HS Studio.exe` ile bir video (H.264 MP4), bir müzik (MP3/FLAC), bir fotoğraf (JPEG + HEIC varsa) aç: oynatma, altyazı, ses izi değişimi, fotoğraf düzenleyici.
- Video iyileştirme (10 sn önizleme + tam çıktı) ve fotoğraf iyileştirme bir kez; sonuç ayrı dosya, orijinal değişmemiş (`Get-FileHash` önce/sonra).
- Veri klasörü `%APPDATA%\com.turkuazcode.hsstudio` oluştu; başka kimlik klasörü oluşmadı.

## 2. Kaldırma (`win-uninstall`)

- Ayarlar > Uygulamalar'dan kaldır. Program klasörü, Başlat kısayolu, `HKCU\…\Uninstall\HS Studio` gider; kullanıcı verisi seçeneğe göre kalır/silinir. Dosya ilişkilendirmeleri geri alınır (bir `.mkv` artık HS Studio ile açılmaz).

## 3. Yükseltme (`win-upgrade`)

- Aynı kimliğin önceki bir derlemesini (ör. aynı commit'ten sürümü düşürülmüş bir prova paketi ya da bir önceki aday) kur, kütüphaneye klasör ekle, yıldız/etiket ver, bir iş kuyruğu kaydı bırak; sonra yeni adayı üzerine kur. Kütüphane, ayarlar, iş geçmişi korunur; şema göçünden önce yedek alınır (`library.db` yedeği).
- Eski “VHO” kurulumu olan bir VM'de: yeni kurulum eskisini kaldırır, veri taşınır (ad değişikliği provası; [rename-hs-studio.md](../release/rename-hs-studio.md)).

## 4. Dosya ilişkilendirme (`win-file-associations`)

- Bir `.mp4`, `.mp3`, `.jpg`, `.srt` dosyasına sağ tık > Birlikte aç: HS Studio listede. “Her zaman” seçilince çift tık doğru ekranda açar (video/müzik/fotoğraf). Uygulama varsayılanları kendiliğinden değiştirmez.

## 5. OS eylemleri (`win-os-actions`)

- [manual-os-checklist.md](../manual-os-checklist.md) Windows sütunu: paylaş, birlikte aç, klasörde göster, PDF'ye yazdır, arka plan, kilit ekranı, HEIC renk profili. Arka plan/kilit ekranı önceki görüntü geri yüklenir.

## 6. Erişilebilirlik (`win-screen-reader`)

- Ekran okuyucu: Narrator ve NVDA (ücretsiz). Boş ekran → dosya aç → oynatma çubuğu → ⋯ menüsü → video iyileştirme diyaloğu → fotoğraf iyileştirme paneli → ayarlar. Her denetimin adı okunuyor, odak sırası mantıklı, diyalog açılınca odak içeride, Esc kapatıyor.
- Yalnız klavye: aynı akış fare olmadan.
- Yüksek kontrast teması (Ayarlar > Erişilebilirlik > Kontrast temaları) ve sistem ölçeği %150 / %200: metin kesilmiyor, denetimler görünür.

## Somut eksikler (kullanıcının sağlaması gerekenler)

| Eksik | Ne için | Not |
|---|---|---|
| Temiz Windows VM (Hyper-V/VirtualBox) ya da Windows Sandbox | 1–4 | Windows 11 Pro'da Sandbox özelliği açılabilir; açmak sistem ayarıdır, kullanıcı yapar |
| Bir test kişisi (tercihen ekran okuyucu kullanan biri) | 6 | Geliştiricinin kendi denemesi ön değerlendirme sayılır |
| GitHub deposu (genel) | `release.yml`'nin uzakta ilk çalışması, SignPath başvurusu, updater uç noktası | Hesap/depo açmak kullanıcı kararı; bu çalışmada yapılmadı |
| SignPath Foundation kabulü + `SIGNPATH_*` sırları/değişkenleri | İmzalı paket | İlk sürüm imzasız (`-UNSIGNED`) çıkabilir; [signing-and-updates.md](../release/signing-and-updates.md) |
| Updater anahtar çifti (`tauri signer generate`) ve `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` sırları; `updater.conf.json`'a gerçek açık anahtar + uç nokta | Otomatik güncelleme | Özel anahtar yalnızca kullanıcıda/CI sırrında kalır; bu çalışmada üretilmedi. Updater ilk alfada kapalı kalabilir (varsayılan) |
| Geçmiş temizliği + commit e-postası kararı | İlk push | [history-cleanup.md](../release/history-cleanup.md) |
| Logo hakları | Yayın | Açık madde ([legal/INVENTORY.md](../../legal/INVENTORY.md)) |
