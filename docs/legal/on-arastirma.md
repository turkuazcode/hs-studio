# Hukuki ön araştırma: CLA, marka, logo, GPL-3.0

> **Bu belge hukuki danışmanlık değildir.** Teknik bir ön araştırmadır. Amacı, kullanıcının avukatla
> yapacağı görüşmeye soru listesi ve kaynak hazırlamaktır. Buradaki hiçbir ifade bir hukuki sonucu
> garanti etmez. Türk hukuku (FSEK, SMK) ve yabancı hukuk açısından son söz avukatındır.
>
> Hazırlanma: 2026-10-26 (E8, R01 eki). İlgili dosyalar: [CLA.md](../../CLA.md), [TRADEMARKS.md](../../TRADEMARKS.md),
> [LICENSE](../../LICENSE), [legal/INVENTORY.md](../../legal/INVENTORY.md), [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).

## 0. Durum özeti (kullanıcı kararları, 2026-10-25)

- Proje lisansı **GPL-3.0-only**. Amaç para değil. Kapalı fork'ları önlemek ve iyileştirmelerin ana projeye
  dönmesini sağlamak.
- Ürün adı **HS Studio** (eski çalışma adı VHO). Ad ve logo korunacak. Fork'lar farklı ad kullanmalı.
- Katkılar için CLA olacak. Sahip ileride yeniden lisanslayabilmeli.
- GFPGAN/YuNet modelleri kalıyor. Eğitim verisindeki ticari olmayan kullanım (NC) tartışması bilerek kabul
  edildi.
- İletişim adresi: turkuazcode@gmail.com.

## 1. CLA (katkıcı lisans sözleşmesi)

### 1.1 Seçenekler

| Seçenek | Ne sağlar | Artısı (tek sahipli, yeniden lisanslama isteyen GPL projesi için) | Eksisi |
|---|---|---|---|
| **Harmony HA-CLA-I, Option Five** (taslakta seçilen) | Katkıcı telif hakkını korur. Sahibe süresiz, devredilebilir, alt lisanslanabilir geniş bir lisans verir. Sahip katkıyı **herhangi bir lisansla** (tescilli lisans dahil) dağıtabilir, **ama** katkı tarihindeki proje lisansıyla da sunmak zorundadır | Yeniden lisanslama özgürlüğü tamdır. Katkıcıya "katkın hep GPL ile de açık kalacak" güvencesi verir. Şablon CC BY 3.0 lisanslıdır, uyarlanabilir. Patent lisansı da içerir | Uzun bir metin. Katkıcıyı caydırabilir. 2011 tarihli (v1), güncellenmemiş. Türk hukukuna göre yazılmamıştır (§1.3) |
| Harmony Option One–Four | Dış lisansı katkı tarihindeki lisansla (1), belirli lisanslarla (2), OSI lisanslarıyla (3) veya FSF'nin önerdiği copyleft lisanslarla (4) sınırlar | Katkıcıya daha fazla güvence verir | Option 1–2 ileride lisans değişimini kısıtlar. 3–4 kapalı lisansa izin vermez. "Gerekirse yeniden lisanslama" hedefini kısmen karşılar |
| **Yalnızca DCO** (`Signed-off-by`, Developer Certificate of Origin 1.1) | Katkıcı "bunu yazma/gönderme hakkım var" diye beyan eder. Katkı, projenin kendi lisansıyla (GPL-3.0-only) gelir | En hafif yöntemdir. Linux çekirdeği gibi büyük projeler kullanır. Caydırıcı değildir | Sahibe **yeniden lisanslama hakkı vermez**. Dış katkı girdikten sonra lisans değişikliği tüm katkıcıların onayını ister. GPL-3.0-only olduğu için "v4'e geçiş" bile mümkün olmaz |
| **Apache ICLA** (Apache Software Foundation'ın bireysel CLA'sı) | Geniş telif ve patent lisansı verir. Dış lisans sınırı yoktur | Çok bilinir, katkıcılar tanır. Yeniden lisanslama hakkı verir | ASF için yazılmıştır, uyarlanması gerekir. Metnin kendi yeniden kullanım koşulu bu araştırmada doğrulanamadı (`icla.txt` artık PDF'e yönlendiriyor). Katkıcıya "GPL ile açık kalacak" güvencesi yoktur |
| Telif devri (FSF tipi "copyright assignment") | Mali haklar sahibe devredilir | Hukuki olarak en güçlü konum | En caydırıcı seçenektir. Türk hukukunda manevi haklar devredilemez. Devir sözleşmesi şekil şartlarına bağlıdır (§1.3) |
| CLA + DCO (taslakta seçilen birleşim) | CLA hakları verir, DCO her commit'te kaynağı beyan eder | Commit bazında kanıt olur. CLA kaydı tutulmasa bile köken beyanı kalır | Katkıcı için iki adım vardır |

**Ön değerlendirme (hukuki görüş değil):** Kullanıcının hedefleri yeniden lisanslama özgürlüğü ve fork'ların
kapalı olmaması. Harmony Option Five + DCO bu iki hedefle teknik olarak örtüşüyor. "Yalnızca DCO" seçilirse
yeniden lisanslama hedefi fiilen kaybolur. Apache ICLA da hedefleri karşılar, ama katkıcıya verilen GPL
güvencesi olmadığı için güven açısından daha zayıf.

### 1.2 Avukata sorulacaklar

1. **FSEK md. 52 şekil şartı:** Mali haklara ilişkin sözleşmelerin yazılı olması ve hakların "ayrı ayrı
   gösterilmesi" gerekir. Bu şart lisans veren CLA'lar için de geçerli mi? Tıkla-kabul et, PR açıklamasına
   yazılan beyan veya CLA bot kaydı yazılı şekli karşılar mı? E-imza gerekir mi? Hakların (işleme, çoğaltma,
   yayma, temsil, umuma iletim) ayrı ayrı sayılması gerekir mi? Harmony metni bunları tek tek saymıyor.
2. **Manevi haklar (CLA §2.4):** Feragat maddesi Türk hukukunda geçerli mi, yoksa yalnızca "ileri sürmeme"
   taahhüdü olarak mı yorumlanır?
3. **Uygulanacak hukuk ve yetkili mahkeme (§6.1, şu an `[TO BE SET]`):** Türkiye mi seçilmeli? Yabancı
   katkıcılar için ne anlama gelir?
4. Option Five'ın "tescilli lisansla da dağıtabilir" hakkı katkıcılara açıkça ve anlaşılır biçimde anlatılmış
   mı? Tüketici veya genel işlem şartı denetimine takılabilir mi?
5. Kurumsal katkı için "Entity CLA" (Harmony HA-CLA-E) gerekli mi?
6. Reşit olmayan katkıcılar (§3c) için veli onayı nasıl alınır?
7. Kayıt tutma: hangi katkıcının hangi tarihte hangi sürümü kabul ettiği nasıl saklanmalı?

### 1.3 Kaynaklar

- Harmony Agreements: <https://www.harmonyagreements.org/agreements.html> (şablonlar). İçerik lisansı
  sitenin altbilgisinde "Creative Commons Attribution 3.0 Unported" olarak yazıyor. Taslak bu şablondan
  alıntı ve değişiklik listesiyle türetildi.
- DCO 1.1: <https://developercertificate.org/>
- Apache CLA'ları: <https://www.apache.org/licenses/contributor-agreements.html>, ICLA: <https://www.apache.org/licenses/icla.pdf>

## 2. Marka: "HS Studio" adı ve logosu

### 2.1 TRADEMARKS.md'nin tescilsiz yapabildikleri ve yapamadıkları

- **Yapabildikleri:** Projenin adı ve logosu için bir **kullanım politikası** ilan eder. GPL-3.0 §7(e)
  lisansçının marka haklarını vermeyi reddetmesine izin verir. Fork'lara "adı değiştir" çağrısı yapar.
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
4. Logo dosyaları GPL-3.0 kapsamında da sunulursa (telif) marka koruması zayıflar mı? Yoksa logolar ayrı bir
   lisansla mı tutulmalı?
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

## 4. GPL-3.0'ın pratik sonuçları

- **Kaynak kod yükümlülüğü:** İkili (exe ve kurulum paketi) dağıtılan herkes "karşılık gelen kaynak kodu"
  sağlamalıdır (GPL-3.0 §6). Pratikte yapılacaklar:
  - Her sürüm için tam etiketli kaynağı aynı yerde yayınlamak.
  - Kurulum paketine LICENSE dosyasını koymak.
  - Uygulamadaki "Lisanslar" penceresini korumak.
  - LGPL DLL'lerin kaynağını da saklamak ([legal/INVENTORY.md](../../legal/INVENTORY.md)).
- **"Kapalı fork'u önleme" hedefinin sınırı:** GPL, değiştirilmiş sürümü **dağıtanı** kaynağı açmaya zorlar.
  - Yalnızca kendi içinde kullanan veya ağ hizmeti olarak sunan biri GPL-3.0 ile buna zorlanmaz. Ağ
    hizmetini kapsayan lisans AGPL-3.0'dır; masaüstü uygulama için genelde gerekmez.
  - GPL, fork'ların **para alarak dağıtmasını** da engellemez. Ad ve logo koruması bu boşluğu kısmen kapatır.
- **GPL-3.0-only ("or later" değil):** İleride GPL v4'e geçmek yalnızca CLA sayesinde mümkündür.
- **Microsoft Store:** GPL-3.0 uygulamalar dağıtılabiliyor. Örnek: GIMP (GPL-3.0-or-later) 2022'den beri
  GIMP ekibi tarafından resmî olarak Microsoft Store'da.
  <https://www.gimp.org/news/2022/06/18/gimp-2-10-32-on-microsoft-store/>. Mağaza koşulları yayın anında
  yeniden kontrol edilmeli.
- **Apple App Store:** Uyumsuzluk yaygın olarak kabul edilir. App Store kullanım koşulları, GPL'nin "ek
  kısıtlama getirmeme" şartıyla çatışır.
  - 2010'da VLC iOS sürümü bir VLC geliştiricisinin GPL ihlali bildirimi üzerine App Store'dan kaldırıldı.
    FSF de benzer bir tutum açıkladı.
    <https://www.engadget.com/2011-01-09-the-gpl-the-app-store-and-you.html>,
    <https://www.techdirt.com/2010/11/01/apple-prefers-to-keep-gpl-d-software-out-of-app-store-so-it-can-keep-drm-on-all-apps/>.
  - Bu tartışma GPLv2 dönemine ait. GPLv3'te §10'daki "ek kısıtlama yok" ilkesi devam ediyor.
  - Mac App Store dağıtımı da aynı sorunu taşır. macOS için mağaza dışı (notarize edilmiş DMG) dağıtım
    planlanmalı.
  - CLA sayesinde sahip, yalnızca App Store sürümü için ayrı bir lisans verebilir (avukat sorusu).
- **Bağımlılıklar:** Tüm bağımlılıklar GPL-3.0 ile uyumlu ([legal/INVENTORY.md](../../legal/INVENTORY.md)).
  FreeType yalnızca GPL-2.0-or-later seçeneğiyle uyumlu. OFL font ayrı dosya olarak paketlendiği sürece sorun
  yok.

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

1. CLA: FSEK md. 52 şekli, manevi haklar, uygulanacak hukuk, imza yöntemi, Entity CLA (§1.2).
2. Marka: kelime mi şekil mi, sınıf 9/42, benzer adlar, TRADEMARKS.md kapsamı (§2.4).
3. Logo: kökeni ve hakları (§3). Önce kullanıcı yanıtlamalı.
4. GFPGAN/YuNet eğitim verisi (NC) riski: kullanıcı kabul etti. Risk boyutu ve uyarı metni gerekip gerekmediği
   sorulabilir.
5. Codec patentleri (H.264/HEVC/AAC çözücüler): telif lisansı dışında bir konu.
6. Contributor Covenant metninin lisansı (§5).
7. Apple App Store gerekirse: CLA'ya dayalı ayrı lisans seçeneği.
