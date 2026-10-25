VHO — Claude için uygulama devri

Hazırlanma: 25 Ekim 2026. Kullanıcı mevcut planları tekrar etmeden eksiklerin ayrıntılı planlanmasını ve uygulamanın Claude tarafından yapılmasını istiyor. Bu dosya uygulama başlangıç talimatıdır; paketin hazırlanması sırasında uygulama kodu değiştirilmedi.

**Başlangıçta oku**

1. [08 — Durum, bağımlılıklar ve uygulama sırası](08-uygulama-sirasi-ve-durum.md).
2. [00 — Mevcut yol haritası](00-YOL-HARITASI.md): lisans, sade arayüz ve medya türüne göre ayrı ekran ilkeleri.
3. Çalışacağın görev kartının 09–14 dosyası ve atıf verdiği özgün 01–07 planı.

**Çalışma yöntemi**

- Önce `git status --short`, `git log -10 --oneline`, `git worktree list` ve güncel kaynakları kontrol et. Bu belgelerdeki commitler anlık referanstır; yeni çalışma varsa mevcut kodu esas alıp durum tablosunu güncelle.
- Mevcut özelliği veya ayrı dalda geliştirilmiş modülü yeniden yazma. İlk paket 09/S01–S03'tür. Aynı dal zaten birleştirilmişse tekrar birleştirme.
- Kirli çalışma ağacını temizleme/resetleme; kullanıcının değişikliklerini koru. Gerekirse izole dal/worktree kullan. Eski worktree'leri silme. Uygulama görevi kapsamında yerel entegrasyon ve test için tekrar onay isteme.
- Varsayılan tek uygulama akışıyla ilerle. Eski belgelerdeki A1/B1/D1 adları tarihsel iş etiketleridir; bu devir kendi başına yeni ajanlar başlatma talimatı değildir.
- Bir görev kartını küçük, incelenebilir değişikliklerle bitir. Gereken test/kanıt, TR/EN metinleri, lisans bildirimi ve ilgili teknik not aynı teslimatta olsun.
- Görev durumlarını 08'de güncelle: `bekliyor`, `çalışılıyor`, `kod hazır`, `doğrulandı`, `ortam bekliyor`, `ertelendi`. Derlenen veya belgelenen işi doğrudan `doğrulandı` sayma.
- Mevcut ayarlar/engine/photo/actions API'lerini kullan. Framework değişimi ve kapsamlı yeniden yazım bu planın parçası değil.
- Kullanıcının özel medya dosyalarını, AI ağırlıklarını, sertifikaları veya anahtarları Git'e ekleme. Testler kendi sentetik/geçici dosyalarını kullansın.
- Sistem değişikliği test korumalarını koru. Uyku, duvar kâğıdı, yazdırma/paylaşım gibi eylemleri test sırasında gerçek kullanıcı ortamına uygulama.
- macOS/Linux/mobil gerçek testi yapılamıyorsa bunu açıkça kaydet; Windows testinden taşınabilirlik sonucu çıkarma. Yapılabilen kod/CI/fixture işlerini tamamlamaya devam et.
- Model sürümü, lisansı veya teknik platform yeteneği gibi dış bağımlılıkları eklemeden önce resmi kaynaktan güncel olarak doğrula. Belgelerdeki model adları entegrasyon garantisi değil.
- GitHub'a yayın, dış hesaba yazma, sertifika satın alma, ücretli hizmet ve mağaza hesabı gibi kullanıcı hesabını/maliyetini ilgilendiren işlemlerin yerel hazırlığını tamamla; oturumdaki mevcut yetki yeterli değilse yalnızca somut dış adım için bilgi/onay iste. Bu hazırlıkları hesap bilgisi yok diye erteleme.

**İlk oturumda somut çıktı**

S01 güncel durum kaydı → S02 mevcut D1 dalının korunarak entegrasyonu → S03 test/AVIF teşhisi. Zaman veya ortam nedeniyle kalan iş olursa tam olarak hangi adım kaldığını yaz; bütün proje tamamlandı deme. Ardından 08'deki bağımlılık sırasını izle.

**Her teslimatın raporu**

```text
Görev kimliği:
Başlangıç/bitiş commitleri veya çalışma ağacı durumu:
Kullanıcının gördüğü değişiklik:
Dokunulan ana dosyalar:
Çalıştırılan testler ve sonuçları:
Atlanan/yapılamayan kontroller ve nedeni:
Platform/model/lisans sınırlamaları:
Orijinal dosyaların korunduğuna dair ilgili test:
08'de güncellenen durum:
Bir sonraki hazır görev:
```

**Kullanıcının yapıştırabileceği kısa talimat**

```text
VHO için docs/plans/CLAUDE-DEVIR.md ve docs/plans/08-uygulama-sirasi-ve-durum.md dosyalarını oku. Mevcut kodu ve dalları yeniden doğrula; tamamlanan işleri yeniden yazma. 09'daki S01–S03 entegrasyon ve test görevlerinden başlayarak bağımlılık sırasına göre uygula. Her pakette kabul ölçütlerini doğrula, testleri raporla ve 08'deki durum tablosunu güncelle. Kullanıcı değişikliklerini, MIT/LGPL politikasını ve mevcut sade arayüzü koru. Otomatik iyileştir algoritmasının mevcut sahipliğini Plan 11'e göre koru. Gerçek cihazda test edilmeyen platformları çalışıyor olarak işaretleme. Yerel hazırlık ve geliştirmeyi tamamla; yalnızca gerekli dış hesap/yayın/maliyet adımlarında somut ihtiyaç bildir.
```
