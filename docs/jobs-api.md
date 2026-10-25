# Kalıcı iş kuyruğu ve kurtarma (Plan 11/A02)

Plan: [11-ai-altyapisi-ve-fotograf.md](plans/11-ai-altyapisi-ve-fotograf.md) (A02) · Depolama: [storage-schema.md](storage-schema.md) (L01) · Dışa aktarma: [media-actions.md](media-actions.md)

Kod: `src-tauri/src/jobs/{mod,store,scheduler,adapters}.rs`, `src/core/jobs.js`, `src/ui/jobs-panel.js`.
Testler: `cargo test --release --lib jobs`, `tests/unit/jobs.test.mjs`, `tests/e2e/jobs.e2e.mjs`.

Bu belge şemanın ve IPC sözleşmesinin kaynağıdır; SQL buradan `storage/migrations.rs` içindeki **v2 `jobs`** göçüne aynen kopyalanır (ikinci veritabanı veya göç sistemi yok).

## Kapsam

- Uzun işler (D1 dışa aktarma = `ffmpeg` alt süreci, fotoğraf toplu işlemi) `library.db`'de kalıcı kayıtlıdır; uygulama kapanınca/çökünce kaybolmaz.
- İlk sürümde uzun işler **sırayla** çalışır (tek işçi iş parçacığı). Küçük resim, tarama, oynatma ve düzenleyicinin tek dosya kaydetmesi kuyruğa girmez (ayrı, öncelikli yollar).
- Fotoğraf toplu işi **tamamlanmış dosya sınırında** devam eder; tek dosyanın ortasından devam vaat edilmez. Video kesit (segment) checkpoint'i V05'tedir; `job_checkpoints` tablosu ona hazırdır.
- AI işleri (A03/A05) aynı kuyruğu `kind` + `model` alanıyla kullanır; bu kartta yalnızca doğrulama kancası (model sürümü) vardır.

## Durum makinesi

```
queued ──► running ──► completed
             │  ├────► failed ───────┐
             │  ├────► interrupted ──┤  (uygulama kapandı/çöktü; açılışta)
             │  └─► pausing ─► paused┤
queued/running/paused ─► cancelling ─► cancelled
interrupted / paused / failed ──(devam: doğrulama)──► queued   (yeni attemptId)
interrupted / paused / failed / cancelled ──(baştan)──► queued (tüm öğeler sıfır, yeni parmak izi)
```

- Terminal: `completed`, `cancelled`. `failed`, `interrupted`, `paused` kullanıcı kararı bekler.
- Her `queued → running` geçişi yeni bir **`attemptId`** (UUID) üretir; `attempts` sayacı artar.
- Açılışta: `running`/`pausing` → `interrupted`, `cancelling` → `cancelled`; o işlerin `running` öğeleri `pending`'e (ya da iptalde `cancelled`'a) döner, geçici dizinleri silinir. `queued` işler kuyrukta kalır ve çalışmadan önce aynı doğrulamadan geçer.
- **Otomatik devam yok:** `interrupted` iş kullanıcı "Devam et" demeden çalışmaz. Devam/başlama anında doğrulama (aşağıda) başarısızsa iş `failed` olur, `errorCode` = `sourceChanged` / `sourceMissing` / `modelChanged` / `recipeChanged`, `resumeBlock` dolar ve yalnızca "Baştan başlat" sunulur.

## Doğrulama (devam / başlatma)

| Ne | Nasıl | Hata |
|---|---|---|
| Tarif | `recipe_hash` = SHA-256(kanonik `request` JSON'u, `jobId`/`temp*` gibi oynak alanlar hariç) + `schema_version` == bu derlemenin adapter sürümü | `recipeChanged` |
| Model / araç | `model` = `{id, version}` iş eklenirken sabitlenir (dışa aktarma: `ffmpeg` + sürüm satırı; AI: manifest sürümü). Şimdiki sürüm farklıysa | `modelChanged` |
| Kaynak | Bitmemiş her öğe için: dosya var mı; `size` + `mtime_ns` + **örnek içerik özeti** (aşağıda) eşit mi | `sourceMissing` / `sourceChanged` |

**Kaynak parmak izi (`input_fp`):** `sha256(size ‖ ilk 1 MiB ‖ ortadaki 1 MiB ‖ son 1 MiB)` (3 MiB'tan küçük dosyada tüm dosya), hex. `mtime` tek başına kimlik sayılmaz; ama `mtime` değiştiyse içerik aynı olsa bile **değişti** sayılır (muhafazakâr: dosyanın örneklenmeyen ortası da değişmiş olabilir). Bedel: öğe başına en çok 3 MiB okuma, iş başlarken bir kez.

## Çıktı güvenliği

- **İş başına geçici dizin:** her çıktı klasöründe `.vho-job-<jobId 8 hane>` (yalnızca o işe ait). Yol oluşturulmadan **önce** `job_temp_dirs`'e yazılır. Kısmi dosyalar yalnızca burada oluşur; aynı birimde olduğu için son taşıma atomiktir. Bitiş/iptal/hata ve açılış kurtarmasında yalnızca o işin kayıtlı dizinleri silinir (adı `.vho-job-` + kendi kimliğiyle başlamayan hiçbir şeye dokunulmaz).
- **Ad rezervasyonu:** öğe çalışmaya başlamadan önce son adı seçilir ve `job_items.reserved_path` + `reserved_norm` (tekil indeks) ile kaydedilir; iki öğe/iş aynı adı rezerve edemez. Yerleştirme **üzerine yazmadan** yapılır (`hard_link` → yoksa var-mı denetimi + `rename`); ad bu arada başkası tarafından alındıysa ` (n)` ile yeni ad seçilir — **mevcut dosya asla ezilmez**. Kullanıcının açıkça seçtiği "üzerine yaz" politikası (fotoğraf toplu iş `conflict: overwrite`) bunun tek istisnasıdır.
- **Kısmi ≠ başarı:** öğe yalnızca son ad yerleştikten ve boyutu > 0 doğrulandıktan sonra aynı işlemde `completed` + `artifacts` satırı olur. Kesilen/iptal edilen/başarısız öğenin geçicisi silinir, `artifacts`'a girmez.
- **Disk alanı:** her öğeden önce hedef birimde boş alan ≥ tahmin (fotoğraf: 2 × kaynak + 16 MiB; dışa aktarma: 64 MiB taban; ffmpeg yazarken dolarsa öğe `diskFull` ile düşer). Bilinemiyorsa denetim atlanır.
- **Kaynak hiçbir zaman hedef değildir;** dışa aktarma kaynak = çıktı isteğini reddeder.

## İptal otoritesi

Tek otorite mevcut `photo::JobGuard` kaydıdır (anahtar = `jobId`). Kuyruk işçisi çalışan denemeyi bu kayda kaydeder; `jobs_cancel(id)` ile eski `media_job_cancel(id)` / `photo_cancel(id)` aynı bayrağı kaldırır. D1 runner yalnızca **kendi** `ffmpeg` alt sürecini öldürür (`Child::kill`); başka işin/sürecin bayrağına dokunulmaz. Windows'ta `ffmpeg` alt süreçleri, VHO kapanınca (çökme / zorla kapatma dahil) kapanan bir **iş nesnesine** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) bağlanır; böylece yetim kalan bir dışa aktarma kısmi dosyayı kilitli tutmaz ve açılış kurtarması onu silebilir (silinemeyen geçici dizin kayıtlı kalır, sonraki açılışta yeniden denenir). Duraklatma da aynı bayrağı kullanır, işçi sonucu `paused` olarak kaydeder (fotoğrafta tamamlanan öğeler kalır; dışa aktarmada öğe baştan yapılır).

## SQL (şema v2, göç adı `jobs`)

```sql
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,                -- UUID v4
  kind           TEXT NOT NULL,                   -- 'export' | 'photo-batch' (A03+: 'photo-enhance', V03: 'video-restore')
  schema_version INTEGER NOT NULL,                -- request JSON sürümü (adapter'a göre)
  state          TEXT NOT NULL CHECK (state IN ('queued','running','pausing','paused','cancelling',
                                                 'cancelled','completed','failed','interrupted')),
  title          TEXT NOT NULL DEFAULT '',        -- gösterim (dosya adı / "N fotoğraf"); yol değil
  request        TEXT NOT NULL,                   -- JSON: adapter girdisi (yerel yollar; loglara yazılmaz)
  recipe_hash    TEXT NOT NULL,                   -- SHA-256 hex
  model          TEXT,                            -- JSON {id, version}; NULL = yok
  attempt_id     TEXT,                            -- son/şimdiki deneme (UUID)
  attempts       INTEGER NOT NULL DEFAULT 0,
  seq            INTEGER NOT NULL DEFAULT 0,      -- son olay sıra numarası (artan, denemeler arası da)
  priority       INTEGER NOT NULL DEFAULT 0,      -- büyük önce
  stage          TEXT NOT NULL DEFAULT 'queued',  -- ilerleme aşaması: queued/validating/running/finishing/...
  done           INTEGER NOT NULL DEFAULT 0,      -- biten öğe (completed + skipped)
  total          INTEGER,                         -- öğe sayısı; NULL = bilinmiyor
  fraction       REAL,                            -- şimdiki öğe içinde 0..1; NULL = bilinmiyor (sahte yüzde yok)
  result         TEXT,                            -- JSON özet (bitince)
  error_code     TEXT,
  error_detail   TEXT,
  resume_block   TEXT,                            -- 'sourceChanged' | 'sourceMissing' | 'modelChanged' | 'recipeChanged'
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX jobs_queue ON jobs(state, priority DESC, created_at);

CREATE TABLE job_items (
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,                -- 0.. (ad şablonundaki sayaç bu sıradır)
  input_path     TEXT NOT NULL,
  input_size     INTEGER,
  input_mtime_ns INTEGER,
  input_fp       TEXT,                            -- parmak izi (yukarıda)
  media_id       TEXT REFERENCES media(id) ON DELETE SET NULL,
  state          TEXT NOT NULL CHECK (state IN ('pending','running','completed','skipped','failed','cancelled')),
  attempt_id     TEXT,                            -- öğeyi en son işleyen deneme
  reserved_path  TEXT,                            -- çalışırken rezerve son ad
  reserved_norm  TEXT,                            -- normalize_path(reserved_path); tekil
  output_path    TEXT,                            -- yalnızca completed/skipped
  output_bytes   INTEGER,
  error_code     TEXT,
  error_detail   TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  PRIMARY KEY (job_id, idx)
);
CREATE INDEX job_items_state ON job_items(job_id, state);
CREATE UNIQUE INDEX job_items_reserved ON job_items(reserved_norm) WHERE reserved_norm IS NOT NULL;

-- Devam noktaları. A02: fotoğraf toplu işte öğe sınırı ('item'); V05: video kesitleri ('segment').
CREATE TABLE job_checkpoints (
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,                       -- öğe idx / kesit no
  attempt_id TEXT NOT NULL,
  data       TEXT NOT NULL,                       -- JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, kind, key)
);

-- İşe ait geçici dizinler (oluşturmadan önce yazılır; temizlik yalnızca bunlar).
CREATE TABLE job_temp_dirs (
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, path)
);

-- v1 artifacts: üreten iş (kısmi dosya hiçbir zaman eklenmez).
ALTER TABLE artifacts ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
CREATE INDEX artifacts_job ON artifacts(job_id);
```

Zamanlar Unix ms (UTC). Geçmiş: terminal işlerden en yeni 50'si tutulur (açılışta budanır; çıktı dosyalarına dokunulmaz, `artifacts.job_id` NULL olur).

## IPC

Hepsi `{ code, message }` biçiminde kodlu hata döner: `storageUnavailable`, `notFound`, `invalidState`, `invalidRequest`, `sourceMissing`, `sourceChanged`, `modelChanged`, `recipeChanged`, `diskFull`.

| Komut | Girdi | Dönüş |
|---|---|---|
| `jobs_list` | — | `JobSnapshot[]` (yeni → eski) |
| `jobs_get` | `id` | `{ job: JobSnapshot, items: JobItem[] }` |
| `jobs_submit` | `{ kind, request, title? }` | `JobSnapshot` (`queued`) |
| `jobs_cancel` | `id` | `JobSnapshot` (`cancelling`/`cancelled`) |
| `jobs_pause` | `id` | `JobSnapshot` (`pausing`/`paused`) |
| `jobs_resume` | `id, mode: "continue" \| "restart"` | `JobSnapshot` (`queued`) |
| `jobs_remove` | `id` | `true` (yalnızca terminal/`failed`/`interrupted`/`paused`) |
| `jobs_clear_finished` | — | silinen sayı |

`request` biçimi `kind`'a göre: `export` = D1 `JobRequest` (`media_job` ile aynı; `jobId` yok sayılır), `photo-batch` = `BatchJob` (`photo_batch` ile aynı: `files`, `ops`, `output`).

**JobSnapshot:** `id, kind, state, title, attemptId, attempts, seq, stage, done, total, fraction, failed, skipped, result, errorCode, errorDetail, resumeBlock, createdAt, updatedAt, startedAt, finishedAt`.

**Olay `job-event`:** `{ jobId, attemptId, itemId?, seq, job: JobSnapshot, item?: { idx, state, outputPath?, errorCode? } }`. `seq` iş başına kesin artar ve her olayla birlikte kalıcı kaydedilir; arayüz `seq`'i eldekinden küçük/eşit olayı atar. Arayüz yeniden açıldığında olay beklemez, `jobs_list` anlık görüntüsünü okur. İlerleme olayları en çok ~4/sn.

## Ön yüz

- `src/core/jobs.js`: `createJobs({ invoke, listen })` — anlık görüntü deposu, `applyEvent` (saf; birim testli), `submit / run (bitene kadar bekler) / cancel / pause / resume / remove / clearFinished / subscribe`. Kuyruk açılamazsa (`storageUnavailable`) `run` eski doğrudan komutlara (`media_job`, `photo_batch`) döner.
- `src/ui/jobs-panel.js`: başlık çubuğunda **yalnızca iş varken** görünen küçük gösterge (çalışan sayısı; yarıda kalan/hatalı işte uyarı noktası). Tıklanınca açılan küçük panel: ilerleme, iptal, duraklat, "Devam et" / "Baştan başlat", kaldır, bitenleri temizle. Ayarlar'a yeni seçenek eklenmedi.
- D1 dışa aktarma iletişim kutusu (`action-dialogs.runJob`) ve Fotoğraf Stüdyosu toplu işlem kutusu artık kuyruğa iş ekler; aynı ilerleme/iptal düğmeleri kuyruğu kullanır.

## Test kancaları (yalnızca `VHO_DATA_DIR` ile çalışan test örneğinde)

- `VHO_JOBS_TEST_ITEM_DELAY_MS`: fotoğraf öğesi geçici dosyaya yazıldıktan sonra, son ada taşınmadan önce bekleme (zorla kapatma testinde gerçek bir kısmi dosya bulunur).
- `VHO_JOBS_TEST_MODEL_VERSION`: dışa aktarmanın sabitlenen araç sürümünü değiştirir (`modelChanged` testi).

## Sınırlar

- Çökme, son adın yerleşmesi ile veritabanı işleminin arasındaki milisaniyelik aralığa denk gelirse o öğe devamda yeniden işlenir ve ` (1)` adıyla **ikinci kopya** oluşabilir; veri kaybı olmaz.
- Dışa aktarma tek öğedir: devam = öğeyi baştan yapmak (segment checkpoint V05).
- Ağ sürücüsü / FAT dosya sistemlerinde `hard_link` yoksa var-mı denetimi + `rename` kullanılır (çok kısa yarış penceresi).
- Yalnızca Windows'ta test edildi.
