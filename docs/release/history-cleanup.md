# Git geçmişi temizliği — ilk herkese açık push'tan hemen önce

**Karar:** 2026-10-25, kullanıcı onayı ([00-YOL-HARITASI](../plans/00-YOL-HARITASI.md), "Yayın öncesi kararlar").
**Zamanlama:** Tüm ajan dalları `main`'e birleştikten sonra, GitHub deposu açılmadan **hemen önce, bir kez**.
Daha önce çalıştırma: geçmiş yeniden yazılınca commit kimlikleri değişir. O andan sonra eski yerel dallardan
yapılan her iş yeni geçmişle uyuşmaz.
**Araç:** [`scripts/prepare-public-history.ps1`](../../scripts/prepare-public-history.ps1). Varsayılan modu **kuru
çalıştırmadır** (yalnızca rapor üretir). Çalışılan depoya **hiç dokunmaz**: geçici bir klasöre taze bir
`git clone --mirror` alır ve yalnızca o kopyayı yeniden yazar.

## Neler temizlenir

Kapsam, R01 geçmiş taramasına dayanır ([history-scan.md](../status/history-scan.md)):

| Ne | Geçmişteki yer | İşlem |
|---|---|---|
| Fixture üretecinin derleme çıktısı (~70 MiB; `.rlib`/`.rmeta`/DLL/exe, `.d` dosyalarında yerel yol) | `tests/fixtures/gen/target/**`: 144 dosya, commit `329d31d` ile eklendi, `3b8209b` ile silindi | Tüm commit'lerden **kaldırılır** |
| Yerel Windows kullanıcı yolu (`C:\Users\<hesap>\…`, JSON içinde `\\` kaçışlı hâli dahil) | `experiments/mpv-spike/results/*.log.jsonl`: 14 dosya (`default-multitrack`, `diag-bgcolor-noflip`, `diag-owned-noflip`, `diag-transparent-noflip`, `diag-videotop`, `lgpl-h264-bgcolor`, `owned-h264-1080p`, `owned-h264-compat`, `owned-h264-vhoflags`, `owned-hevc-4k`, `owned-hevc-4k-swdec`, `owned-multitrack`, `smoke-gpl-idle`, `smoke-gpl-lavfi`) | Metin, tüm commit'lerde `Users\user` ile **değiştirilir**. Loglar kanıt olarak kalır |
| Yerel yolu **görüntü olarak** içeren ekran görüntüleri (spike'ın dosya alanında yol görünüyor) | `experiments/mpv-spike/results/captures/*.png`: 22 dosya | Varsayılan olarak **kaldırılır**; saklamak için `-KeepCaptures` |
| Commit e-postası (tüm commit'lerde tek kimlik: sahibin adı + kişisel Gmail adresi) | yazar ve commit eden alanları | `-NewEmail` (isteğe bağlı `-NewName`) verilirse **mailmap ile yeniden yazılır**. Adresi kullanıcı seçer; örneğin GitHub "noreply" adresi `<id>+<kullanıcı>@users.noreply.github.com` |
| Ajan dalları (`wave1/*` … `wave3/*`) | ref'ler | Varsayılan olarak yalnızca `main` ve etiketler tutulur (`-Branches`, `-AllBranches`) |

`third_party/mpv/evidence/windows/*` dosyaları zaten temizlenmiş kopyalardır; kullanıcı yolu içermez (tarama ile doğrulandı).
Taramada sır, model ağırlığı veya kişisel medya bulunmadı.

Kaldırılan ekran görüntülerine bir yerden atıf var: [docs/adr/0001-oynatma-motoru.md](../adr/0001-oynatma-motoru.md)
(`results/captures/owned-*.png`). Temizlikten önce normal bir commit ile bu cümleye "ekran görüntüleri yayın
öncesi geçmişten çıkarıldı" notu eklenmelidir. Alternatif: `-KeepCaptures`.

## Gereken araç: git-filter-repo (yalnızca `-Apply` için)

- [git-filter-repo](https://github.com/newren/git-filter-repo) MIT lisanslıdır ve tek bir Python dosyasıdır.
  Uygulamaya girmez, yalnızca yayıncının makinesinde çalışır.
- Sisteme kurulmaz. Silinebilir, geliştiriciye özel bir venv yeterlidir:
  ```powershell
  python -m venv C:\build\tools\filter-repo
  C:\build\tools\filter-repo\Scripts\python.exe -m pip install git-filter-repo==2.47.0
  # sonra: -FilterRepo C:\build\tools\filter-repo\Scripts\git-filter-repo.exe
  # iş bitince: Remove-Item -Recurse C:\build\tools\filter-repo
  ```
- 2026-10-26'da bu tarif geçici bir venv ile denendi (2.47.0, PyPI üst verisinde lisans `MIT`).

## Adımlar

1. Tüm dalların `main`'e birleştiğini, `npm test` ile diğer katmanların geçtiğini doğrula. Betik birleşmemiş
   dalları uyarı olarak listeler.
2. Kuru çalıştırma ile kaldırılacak yolları, değiştirilecek metni ve kimlikleri gözden geçir:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-public-history.ps1
   ```
3. Uygula. Bu adım yalnızca geçici klasördeki ayna kopyayı yeniden yazar:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\prepare-public-history.ps1 -Apply `
     -NewEmail "<seçilen adres>" -FilterRepo C:\build\tools\filter-repo\Scripts\git-filter-repo.exe
   ```
   Betik sonda `scripts/scan-history.mjs`'i temizlenmiş ayna üzerinde yeniden çalıştırır ve önce/sonra tablosunu
   basar. Kullanıcı yolu, sır veya derleme çıktısı kalmışsa çıkış kodu 1 olur.
4. Kontrol için temizlenmiş aynadan klonla, ardından `npm ci` ve `npm test` çalıştır. Yayın derlemesi de bu
   klondan ve kullanıcı adı içermeyen bir yoldan yapılır ([build-path.md](build-path.md)).
5. İlk push **yalnızca temizlenmiş aynadan** yapılır. Bu adım GitHub hesabı gerektirir ve kullanıcı tarafından
   yapılır:
   `git -C <ayna> push <yeni-depo-url> --all` ve `git -C <ayna> push <yeni-depo-url> --tags`.
6. Sonrasında geliştirme **yayınlanan deponun taze klonundan** sürer. Eski çalışma deposu ve worktree'ler eski
   geçmişi taşır. Onlardan push yapılmamalı, gerekirse arşivlenmeli.

## Deneme sonucu (2026-10-26, gerçek depo yerine geçici ayna)

`main` + `-NewEmail test@example.invalid` ile:

| Kontrol | Önce | Sonra |
|---|---|---|
| Kullanıcı yolu bulgusu | 726 | 0 |
| ≥ 1 MiB blob | 9 | 0 |
| İkili/arşiv dosyası | 7 | 0 |
| Medya dosyası | 52 | 30 (ikonlar, fixture'lar) |
| Paket boyutu | 28,3 MiB | 2,4 MiB |
| Kimlik | kişisel adres | yeni adres |

Temizlenmiş `main` klonunda `npm ci` ve `npm test` geçti (164/164). Çalışan depo değişmedi.
