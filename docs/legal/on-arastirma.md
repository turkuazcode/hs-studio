# Hukuki ön araştırma: lisans, marka, logo

> **Bu belge hukuki danışmanlık değildir.** Teknik bir ön araştırmadır. Amacı, kullanıcının avukatla
> yapacağı görüşmeye soru listesi ve kaynak hazırlamaktır. Buradaki hiçbir ifade bir hukuki sonucu
> garanti etmez. Türk hukuku (FSEK, SMK) ve yabancı hukuk açısından son söz avukatındır.
>
> Hazırlanma: 2026-10-26 (E8, R01 eki). İlgili dosyalar: [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), [TRADEMARKS.md](../../TRADEMARKS.md),
> [legal/INVENTORY.md](../../legal/INVENTORY.md), [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## 0. Durum özeti ve lisans kararlarının geçmişi

| Tarih | Karar | Not |
|---|---|---|
| (başlangıç) | MIT | İlk depo lisansı |
| 2026-10-25 | GPL-3.0-only + isim/logo koruması + CLA (Harmony "Option Five") | Amaç: kapalı fork'ları önlemek ve katkıyı ana projeye yönlendirmek |
| 2026-10-26 (sabah) | CLA, Harmony "Option Three"e daraltıldı (yalnızca OSI lisansları) | Gerekçe: SignPath açık kaynak imzalama programı "ticari çift lisans yok" şartı koyuyor |
| **2026-10-26** | **Apache-2.0 + NOTICE**; CLA kaldırıldı, katkılar Apache-2.0 + DCO (inbound = outbound); TRADEMARKS.md kalıyor | **Geçerli karar.** Amaç: her şey açık olsun, ama dağıtanlar projeye atıf yapsın. Basitlik |

GPL-3.0 ve CLA hiçbir sürümde veya dış katkıda kullanılmadı. Herkese açık bir yayın yoktu; dış katkı da
kabul edilmedi. Bu yüzden lisans değişikliği için kimseden izin gerekmiyordu (avukatla teyit edilebilir).

Diğer güncel kararlar:

- Ürün adı **HS Studio** (eski çalışma adı VHO). Ad ve logo TRADEMARKS.md ile korunur.
- Kod imzalama: SignPath Foundation'ın ücretsiz açık kaynak programı (2026-10-26).
- GFPGAN/YuNet modelleri kalıyor. Eğitim verisindeki ticari olmayan kullanım (NC) tartışması bilerek kabul
  edildi (2026-10-25).
- İletişim adresi: turkuazcode@gmail.com.

## 1. Lisans: Apache-2.0'ın sonuçları

- **Atıf yükümlülüğü (NOTICE):** Apache-2.0 §4, yeniden dağıtanların şunları korumasını şart koşar: lisans
  metni, telif bildirimleri ve **NOTICE dosyasındaki atıflar**. §4(d), atıfların dağıtımın en az bir yerinde
  bulunmasını ister: NOTICE dosyasında, kaynakta/belgede ya da eserin ürettiği ekranda (bu tür bildirimlerin
  normalde gösterildiği yerde). "Görünür tut" ricası NOTICE'ın içinde yazılı; bu bir rica olup lisansın
  kendisi değildir.
  - Projenin kendi dağıtımı bu şartı karşılar: NOTICE, uygulamadaki Lisanslar penceresinin en üstünde
    gösterilir ve kurulumda `legal\NOTICE.txt` olarak bulunur.
- **Kapalı fork'lar artık mümkün:** Apache-2.0, değiştirilmiş sürümü kaynak açmadan, ücretli de olsa dağıtmaya
  izin verir. Bunu sınırlayan iki şey kalır:
  - NOTICE ve lisans bildirimi şartı (atıf).
  - **Ad ve logo koruması** (Apache-2.0 §6 marka hakkı vermez; TRADEMARKS.md fork'ların ad değiştirmesini
    ister).
- **Değişiklik bildirimi:** Değiştirilen dosyalarda değişikliğin belirtilmesi gerekir (§4(b)).
- **Patent lisansı ve fesih:** Katkıcılar patent lisansı da verir. Patent davası açan kişinin lisansı sona
  erer (§3).
- **CLA gerekmiyor:** Katkılar §5 gereği aynı lisansla gelir. Köken beyanı DCO (`git commit -s`) ile alınır.
  Yeniden lisanslama ihtiyacı Apache-2.0'ın geniş izinleriyle büyük ölçüde ortadan kalkar.
- **SignPath:** "Ticari çift lisans yok" şartıyla çatışma kalmadı. Tek lisans (Apache-2.0) var, tescilli
  ikinci bir lisans yok.
- **Apple App Store / Microsoft Store:** Uygulamanın kendi kodu için lisans çatışması yok. Apache-2.0'ın ek
  kısıtlama yasağı bulunmuyor.
  - LGPL DLL'lerin (libmpv/FFmpeg) mağaza dağıtımında değiştirilebilirlik şartının nasıl karşılanacağı ayrıca
    incelenmeli. Mac App Store'da libmpv şu an zaten yok (macOS'ta gömülü değil).
- **Bağımlılıklar:** Hepsi Apache-2.0 ile birlikte dağıtılabilir ([legal/INVENTORY.md](../../legal/INVENTORY.md)).
  Bağımlılık politikası değişmedi: GPL/AGPL kütüphane yok, LGPL yalnızca ayrı dosya olarak.
- **Telif satırı:** 2026-10-28 kullanıcı kararı: "Copyright 2026 TurkuazCode" (NOTICE, bildirim başlığı, TRADEMARKS.md,
  paket bilgileri). Avukat onayı bekliyor.

### 1.1 Avukata sorulacaklar (lisans)

1. GPL-3.0 kararı ve CLA taslağı yayımlanmadan geri alındı. Herhangi bir hak veya taahhüt doğdu mu?
   (Beklenti: hayır. Teyit için.)
2. NOTICE'taki "görünür tutun" ricasının ve TRADEMARKS.md'nin birlikte hukuki etkisi ne? NOTICE'ın zorunlu
   kısmı (§4(d)) ile rica kısmı açıkça ayrılmış mı?
3. Telif sahibi satırı: gerçek kişi adı mı, ileride kurulacak bir tüzel kişi mi?

> Önceki CLA araştırması (Harmony seçenekleri, DCO, Apache ICLA, FSEK md. 52 soruları) bu karar nedeniyle
> artık uygulanmıyor. Geçmiş için bu belgenin git geçmişine bakılabilir (commit 95bfeaf ve öncesi).

## 2. Marka: "HS Studio" adı ve logosu

### 2.1 TRADEMARKS.md'nin tescilsiz yapabildikleri ve yapamadıkları

- **Yapabildikleri:** Projenin adı ve logosu için bir **kullanım politikası** ilan eder. Apache-2.0 §6
  zaten marka hakkı vermez (yalnızca kökeni tanımlamak ve NOTICE'ı yeniden üretmek için olağan kullanım hariç). Fork'lara "adı değiştir" çağrısı yapar.
  Topluluk içinde beklentiyi netleştirir. Paket depoları ve mağazalar genelde bu tür politikalara uyar.
  Logo dosyaları ayrıca telif hakkıyla (FSEK) korunabilir.
- **Yapamadıkları (tescil yoksa):** SMK kapsamındaki tescilli marka korumasını sağlamaz. Başka biri aynı veya
  benzer adı kendi adına tescil ettirirse proje zayıf duruma düşebilir. Önceki kullanım ve kötü niyet
  itirazları mümkün olabilir, ama ispat ve süreç gerekir. Tescil yokken ® işareti kullanılamaz. ™ yalnızca
  "marka olarak kullanıyoruz" iddiasıdır. TRADEMARKS.md tek başına bir tazminat davası dayanağı da olmayabilir
  (avukat sorusu).

### 2.2 Türkiye'de tescil: temel bilgiler (TÜRKPATENT)

- **Başvuru:** TÜRKPATENT'e, e-Devlet ile girilen EPATS üzerinden yapılır. Başvuru, Nice sınıflandırmasına
  göre seçilen mal ve hizmet sınıflarını kapsar. Toplam 45 sınıf vardır.
- **Muhtemel sınıflar:**
  - **9:** indirilebilir bilgisayar yazılımı ve uygulamaları.
  - **42:** yazılım tasarımı, geliştirme ve SaaS. İleride bulut veya hizmet olursa önem kazanır.
  - Sınıf seçimi ve emtia listesinin yazımı avukat veya marka vekili işidir.
- **Süreç (kaynaklarda verilen yaklaşık süreler):**
  - Şekli inceleme yaklaşık 1–2 ay sürer. Mutlak ret nedenleri incelemesi yaklaşık 3–4 ay sürer.
  - Ardından Resmî Marka Bülteni'nde ilan yapılır. **İlana itiraz süresi 2 aydır.**
  - İtiraz yoksa tescil gelir. Hukuk bürolarının rehberlerine göre başvurudan tescile itirazsız toplam süre
    yaklaşık **10–18 ay**.
  - Koruma 10 yıldır ve yenilenebilir.
- **Ücretler:** Harç ve sınıf ücretleri her yıl güncellenir. Bu araştırmada sınıf 9 ve 42 için güncel tutar
  doğrulanamadı. Güncel tarife TÜRKPATENT'in resmî sitesinden alınmalı.
- **Yurt dışı:** Madrid Protokolü (WIPO) üzerinden Türk başvurusuna dayanarak başka ülkeler seçilebilir.
  Bu ek maliyet getirir.
- **Ayırt edicilik riski:** "Studio" yazılım için tanımlayıcı bir kelimedir. "HS" iki harfli bir kısaltmadır.
  Kelime markası olarak ayırt ediciliği tartışılabilir. Logo ile birleşik (şekil + kelime) başvuru
  seçeneği avukatla konuşulmalı.

Kaynaklar (hukuk bürosu rehberleri; resmî kaynakla doğrulanmalı):
- <https://www.ffkpartnerhukuk.com.tr/marka-tescili-kac-gunde-alinir-2026-guncel-rehber-marka-basvuru-ve-tescil-suresi/>
- <https://www.hukukihaber.net/turkiyede-marka-tescil-basvurusu-nasil-yapiliyor-iste-adim-adim-surec>
- <https://bilalalyar.av.tr/marka-tescili-rehberi/>
- Resmî: <https://www.turkpatent.gov.tr>

### 2.3 Hızlı çakışma taraması (2026-10-26, genel web araması — marka araştırması DEĞİL)

Genel bir web aramasıyla "HS Studio" adlı bir yazılım ürünü bulunamadı. Bulunan yakın adlar:

| Bulgu | Ne | Bağlantı |
|---|---|---|
| "HS Player – video player" | Android video oynatıcı uygulaması (aynı alan, benzer ad) | <https://m.apkpure.com/hs-player-video-player/com.hs.hs_player> |
| Hughes HS serisi | Dijital tabela medya oynatıcı donanımları (HS860, HS1100, HS1160) | <https://www.hughes.com/wp-content/uploads/2026/02/HS1160_MediaSignage_Player.pdf> |
| "HS" (App Store) | Vladivostok'ta bir esneme/fitness stüdyosunun uygulaması | <https://apps.apple.com/ru/app/hs/id6499468327> |
| Rollei "HS Freeze" | Stüdyo flaşı ve kontrol uygulaması | <https://apps.apple.com/us/app/id1276983046> |
| ABD marka kayıtları | "HS" ibareli birkaç giyim markası ve terk edilmiş "HSZ STUDIO" (giyim). Yazılım sınıfında "HS Studio" görülmedi | <https://trademark.justia.com/760/38/hsz-studio-76038774.html>, <https://trademarks.justia.com/994/65/hs-99465674.html> |
| Adı "PhotoStudio" olan foto editörleri | Ad farklı, alan aynı | <https://apps.apple.com/us/app/id1488727122> |
| GitHub | "hs-studio" / "hsstudio" adlı belirgin bir depo görülmedi | — |

**Sınır:** Bu tarama sonuç vermeyen bir genel aramadır. Resmî sicillerde yapılmalıdır:
- TÜRKPATENT marka araştırması (EPATS).
- EUIPO TMview: <https://www.tmdn.org/tmview/>
- WIPO Global Brand Database: <https://branddb.wipo.int/>
- USPTO.

Benzer adlar ("HS Player" gibi) ve sınıf 9/42 için bir marka vekili araştırma raporu önerilir.

### 2.4 Avukata sorulacaklar

1. "HS Studio" kelime markası mı, logo ile birleşik marka mı tescil edilmeli? Hangi sınıflarda?
2. "HS Player" gibi aynı alandaki benzer adlar risk oluşturur mu?
3. Tescil öncesinde TRADEMARKS.md'deki "HS ile başlayan adlar" yasağı fazla geniş mi, uygulanabilir mi?
4. Logo dosyaları Apache-2.0 kapsamında da sunulursa (telif) marka koruması zayıflar mı? Yoksa logolar ayrı
   bir lisansla mı tutulmalı (ör. "tüm hakları saklıdır", yalnızca projenin kendi dağıtımına izin)?
5. Eski çalışma adı "VHO" için ayrıca bir şey yapmak gerekir mi?

## 3. Logo hakları: kullanıcının netleştirmesi gerekenler

Logo ve ikon dosyaları (`src-tauri/icons/*`, `src/assets/favicon.png`, `src/assets/icon-192.png`) ilk commit'ten
(`2a7f624`) beri depoda. Kimin yaptığı kayıtlı değil. Envanterde **açık** madde olarak duruyor
(`legal/inventory/assets.json`, `app-icons`). Kullanıcının yanıtlaması gerekenler:

1. Logoyu kim yaptı: kullanıcı mı, bir tasarımcı mı, bir arkadaş mı? Bir tasarımcıysa hakların devri veya
   lisansı yazılı mı (FSEK md. 52)?
2. **Yapay zekâ ile mi üretildi?** Öyleyse hangi araçla (Midjourney, DALL·E, Canva AI vb.)? Aracın kullanım
   koşulları ticari ve marka kullanımına izin veriyor mu? Ayrıca yapay zekâ çıktılarının telif koruması pek
   çok ülkede belirsiz veya sınırlı. Bu durum hem telif hem marka koruması açısından avukatla konuşulmalı.
3. Bir **şablon, stok görsel, ikon seti veya font** kullanıldı mı? Kullanıldıysa lisansı nedir? Font, logonun
   içindeki yazıda da önemlidir.
4. Logo başka bir yerde, başka biri tarafından kullanılıyor mu? Ters görsel arama önerilir.
5. Yeni bir HS Studio logosu yapılacaksa bu sorular baştan yanıtlanmalı. Tasarımcı varsa yazılı devir
   sözleşmesi yapılmalı.

## 4. Mağazalar ve dağıtım kanalları

- **Microsoft Store:** Açık kaynak lisanslı uygulamalar dağıtılabiliyor; Apache-2.0 bir engel değil.
  Mağaza koşulları yayın anında yeniden kontrol edilmeli.
- **Apple App Store:** 2010'daki VLC olayı GPL kaynaklıydı (VLC iOS, bir geliştiricinin GPL ihlali bildirimiyle
  kaldırıldı; <https://www.engadget.com/2011-01-09-the-gpl-the-app-store-and-you.html>). Apache-2.0 için
  bu tür bir çatışma yok. Yine de LGPL bileşenler mağaza paketine girecekse ayrıca incelenmeli (§1).
- **Kod imzalama:** SignPath Foundation (ücretsiz, açık kaynak). Ayrıntılar:
  [docs/release/signing-and-updates.md](../release/signing-and-updates.md).

## 5. Contributor Covenant'ın lisansı (açık soru)

- `CODE_OF_CONDUCT.md`, Contributor Covenant **2.1** metninden birebir alındı. Kaynak 2026-10-25'te resmî
  siteden indirildi. Yalnızca iletişim adresi eklendi. Metin sonunda kaynak gösterimi var.
- Contributor Covenant metni geçmişte genel olarak **CC BY 4.0** ile lisanslı biliniyordu. Ancak bugünkü
  GitHub deposunun (EthicalSource/contributor_covenant) `LICENSE.md` dosyası **Hippocratic License 3.0**
  içeriyor. Bu dosya sitenin yazılımı için mi, metin için mi, araştırmada netleştirilemedi.
- Yazarların amacı projelerin metni benimsemesi. SSS bölümü uyarlamayı da öneriyor. Yine de metnin hangi
  lisansla yeniden kullanıldığı avukatla veya doğrudan Organization for Ethical Source ile
  (info@ethicalsource.dev) doğrulanmalı.
- Alternatifler: 2.1'i kaynak göstererek kullanmaya devam etmek, sürüm 3.0'a geçmek (lisansı ayrıca
  doğrulanmalı) veya kısa, kendi yazımımız bir davranış kuralları metni.

## 6. Avukat görüşmesi için kısa liste

1. Lisans: GPL/CLA kararının yayın öncesi geri alınması, NOTICE'ın zorunlu ve rica kısımları, telif sahibi
   satırı (§1.1).
2. Marka: kelime mi şekil mi, sınıf 9/42, benzer adlar, TRADEMARKS.md kapsamı, logo dosyalarının lisansı (§2.4).
3. Logo: kökeni ve hakları (§3). Önce kullanıcı yanıtlamalı.
4. GFPGAN/YuNet eğitim verisi (NC) riski: kullanıcı kabul etti. Risk boyutu ve uyarı metni gerekip gerekmediği
   sorulabilir.
5. Codec patentleri (H.264/HEVC/AAC çözücüler): telif lisansı dışında bir konu.
6. Contributor Covenant metninin lisansı (§5).
7. LGPL DLL'lerin mağaza (Microsoft/Apple) paketlerinde değiştirilebilirlik şartı.
