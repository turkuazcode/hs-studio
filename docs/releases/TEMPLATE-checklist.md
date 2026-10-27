# <sürüm> — sürüm kontrol listesi (şablon)

> Plan 14/R03. Her sürüm için bu dosyayı `docs/releases/<sürüm>-checklist.md` olarak kopyala ve doldur.
> Kural: kanıtı olmayan satır **geçti sayılmaz**. Kanıt, ilgili test sonucu, commit veya belge bağlantısıdır.
> Bu makinede yapılamayan işler "ortam bekliyor" olarak yazılır, geçti olarak işaretlenmez.
> Kart durumları ve test sonuçları için önce `node scripts/release-gate.mjs --target <hedef> --markdown out.md`
> çalıştırılır; çıktısı bu dosyanın sonuna eklenir.

- **Sürüm / kanal:** <0.x.y-alpha | beta | stable>
- **Hedef** (plan 08, "Sürüm kapsamları"): <Windows fotoğraf alfa | Masaüstü beta | …>
- **Platform / mimari:** <Windows 11 x64 …>
- **Kaynak commit / etiket:** <sha / vX.Y.Z>
- **Paket:** <dosya adı, SHA-256, imzalı mı?>
- **Karar veren / tarih:** <ad, tarih>

Durum değerleri: ✅ geçti (kanıtlı) · 🟡 kısmi / kanıt eksik · ⏳ ortam bekliyor · ❌ geçmedi / yapılmadı · — kapsam dışı

| # | Kontrol | Çıkış koşulu (plan 14/R03) | Kanıt | Durum |
|---|---|---|---|---|
| 1 | Özellik doğruluğu | README ve arayüz, desteklenen ve deneysel özellikleri ayırır | | |
| 2 | Platform | Yayımlanan her OS/mimari için gerçek cihazda temiz kurulum kanıtı | | |
| 3 | Temel kullanım | Video/ses/fotoğraf açma, altyazı, ayar, tekrar açma, dosya ilişkileri | | |
| 4 | Veri | Orijinal dosyaların hash'i korunur; göç öncesi yedek ve kurtarma çalışır; yol/isim çakışmaları ele alınır | | |
| 5 | AI | Manifest/hash, gerçek inference, iptal, doğru çıktı ve metadata, model kaldırma davranışı | | |
| 6 | Video AI (varsa) | V06 geçer; geçmezse özellik kapalı veya deneysel, sınır açıkça yazılı | | |
| 7 | Testler | İlgili suite'ler geçer; ortam kaynaklı atlamalar ve elle yapılan kanıtlar ayrı listelenir | | |
| 8 | Güvenlik | Yayına engel veri kaybı veya yetki sorunu yok; bağımlılık bulguları ele alınmış | | |
| 9 | Lisans / dağıtım | Notices, NOTICE, SBOM, kaynak/build bilgisi, checksum, imzalama durumu | | |
| 10 | Kullanılabilirlik | Klavye, ölçek ve dil temel akışları çalışır; çökme veya boş ekran gibi kritik sorun yok | | |
| 11 | Kurulum / güncelleme | Kurulum, yükseltme ve kaldırma; veri korunur; bozuk veya yanlış imzalı güncelleme reddedilir | | |
| 12 | Yayın adımları | Geçmiş temizliği (yalnızca ilk push), depo, imza, sürüm notu (CHANGELOG), checksum yayını | | |

**Bilinen sınırlar (sürüm notuna girer):**

-

**Karar:** <yayınlanır / yayınlanmaz> — gerekçe:
