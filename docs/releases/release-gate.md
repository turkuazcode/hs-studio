# Yayın kapısı kuralları (`scripts/release-gate.mjs`, denetim D01)

Kapı hiçbir şeye kendisi “doğrulandı” demez: plan 08'in durum tablosunu, test katmanlarının sonuç dosyalarını, yayın paketinin manifestini ve elle doğrulama kanıt dosyasını okur. Testi: `tests/unit/release-gate.test.mjs`.

```text
node scripts/release-gate.mjs [--target windows-alpha|desktop-beta] [--stage candidate|release]
     [--manifest <package-manifest-release-*.json>] [--results <platform-arch>=<dir> ...]
     [--evidence docs/releases/evidence/<hedef>.json] [--markdown out.md] [--json out.json] [--plan-ref main]
```

## Kartlar

- Kart yalnızca plan 08 hedefin **her platformu** için “doğrulandı” diyorsa geçer. Platform belirtmeyen “doğrulandı” **yalnızca Windows** kanıtı sayılır (projede bütün testler Windows'ta koştu). “Windows: doğrulandı; macOS/Linux: ortam bekliyor” üç platformlu hedefte geçmez.
- Hedefin açıkça izin verdiği kısmi durumlar (`partialOk`, ör. alfada yerel R02) raporda görünür.
- Kimlik hücresi yalnızca kart kimliği olmalı (`V03`, `P02–P05`). “V03 (açıklama)” gibi okunamayan satır kapıyı **başarısız** yapar; eski bir aralık satırı sessizce geçerli olmaz.

## Test katmanları

Katmanlar: `unit`, `rust` (`npm run test:rust` → `scripts/run-rust-tests.mjs`), `e2e`, `ai`, `quality`, `installer`. Bir sonuç ancak şunların hepsi doğruysa geçer:

1. Dosyadaki katman adı beklenen katman.
2. Commit kayıtlı ve HEAD ile aynı; çalışma ağacında commitlenmemiş değişiklik yoktu (`dirty: false`).
3. Platform kayıtlı ve hedef platformla aynı (`win32-x64` …).
4. Katmanın tamamı çalıştı (`full: true`: dosya listesi ya da ad filtresi yok).
5. Süreç çıkış kodu 0; en az bir test geçti; iptal 0; başarısız 0. Tek ayrık durum: her başarısız test adıyla listelenmiş ve hedefin `fail` türü bir kapsam istisnasıyla (yalnızca kapsam dışına alınmış bir özelliğin kendi testi) eşleşiyorsa çıkış kodu 1 kabul edilir.
6. **skip / todo / ignored hiçbir zaman geçti sayılmaz.** Her biri adıyla listelenmiş olmalı ve hedefin bir **kapsam istisnasına** uymalı. Uymayan tek bir skip/todo kapıyı kapatır. Sayı ile liste uyuşmazsa kapı kapanır.
7. Uygulamayı başlatan katmanlarda (`e2e`, `ai`, `quality`) binary kaydı var, kaynaklardan eski değil, SHA-256'sı kayıtlı; `--manifest` verilince paketteki ana binary ile **aynı**.

### Kapsam istisnaları (`TARGETS.<hedef>.exceptions`)

Her istisnanın kimliği, katmanı, türü (`skip`/`todo`), test adı deseni, gerekçesi ve kapsamı vardır; kullanılan istisnalar raporda yazılır. `windows-alpha` için:

| Kimlik | Katman | Neden |
|---|---|---|
| `rust-manual-tools` | rust, skip | Altı adı belli `#[ignore]` testi elle çalıştırılan araç/ölçüm; yeni bir `#[ignore]` listede yoksa kapı reddeder |
| `birefnet-experimental` | ai, skip | Arka plan kaldırma deneysel ve gizli; referans cihazda WASM bellek sınırı. Nesne silme ve renklendirme testleri zorunlu |
| `legacy-photo-ai-out-of-scope` | quality, **fail** | Eski nöral fotoğraf AI bu sürümde kapalı (giriş noktası yok). Yalnızca kendi ayrı testi (`legacy experimental photo AI …`) için; başarısız kaydı silinmez ve raporda görünür. Lanczos ve klasik profillerin taban testi zorunlu |

HLS için istisna yoktur: iki HLS testi düzeltildi ve normal testtir (D02). Ürünün vaat etmediği özellikler (`outOfScope`: L04 ağ/DLNA vaadi, V02/V04–V06) raporda ayrıca listelenir.

## Paket ve elle doğrulamalar

- `--manifest`: `release` türünde, HEAD'den üretilmiş, yerel DLL seti envanterle eşleşen paket. Kapı manifestin adını verdiği kurulum dosyasını **diskte** bulur ve SHA-256'sını yeniden hesaplar; dosya yoksa, hash manifestle ya da `.sha256` dosyasıyla uyuşmazsa reddeder. Yoksa kapı karşılanmaz.
- `--stage candidate` (release workflow): elle doğrulamalar henüz istenmez ama “açık” olarak listelenir. Aday, elle oturumların yapılacağı pakettir.
- `--stage release` (varsayılan): kanıt dosyasındaki her elle kontrol `pass`, tarih/kişi/OS dolu ve `artifactSha256` test edilen kurulum dosyasıyla aynı olmalı.
- `installer` katmanı test kimliğiyle yapılır (`identity: "test"`); gerçek kimlik yalnızca `win-clean-install` elle kontrolüyle kanıtlanır.
