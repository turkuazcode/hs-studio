# ADR 0002 — Linux video yüzeyi: libmpv render API (OpenGL) + GtkGLArea, WebKitGTK altında

- **Durum:** Kabul edildi (P03, 2026-10-27) — WSLg (sanal, yazılım GL) ortamında denendi (aşağıdaki kayıt); gerçek GPU'lu Linux masaüstünde Wayland + X11 doğrulaması **ortam bekliyor**.
- **İlgili:** [ADR 0001](0001-oynatma-motoru.md) (Windows: sahipli açılır pencere, `wid`), [Plan 10 / P03](../plans/10-platform-ve-paketleme.md), [platform-support](../platform-support.md), [build-linux.md](../../third_party/mpv/build-linux.md)
- **Kod:** `src-tauri/src/engine/linux.rs` (yüzey), `engine/mpv.rs` → `render` modülü (render API bağlaması), `engine/mod.rs` (`surface_options`, `locate`), `engine/smoke.rs` (uygulama içi senaryo), `scripts/linux/*`, `third_party/mpv/build-linux.sh`

## Bağlam

- mpv 0.41'de X11 pencere arka ucu GPL'e bağlı (`x11_opt.require(get_option('gpl'))`). Dağıtacağımız LGPL libmpv'de (`-Dgpl=false`) X11 VO'su ve dolayısıyla `wid` gömme **hiç yok**; Wayland'de zaten yabancı pencere gömme yok. Windows'taki `wid` yolu Linux'a kopyalanamaz.
- Tauri v2 Linux'ta tek bir GTK3 penceresi içinde WebKitGTK 4.1 kullanır (`gtk::ApplicationWindow` → `default_vbox()` → webview).
- Hedef: Wayland ve X11 oturumlarında aynı kod yolu; Linux'u X11'e zorlamak Wayland desteği sayılmaz.

## Karar

**Yol B: mpv render API (`MPV_RENDER_API_TYPE_OPENGL`), VHO'nun sahip olduğu GL bağlamına.**

1. **Yüzey:** Tauri penceresinin `default_vbox()` içindeki webview widget'ı bir `GtkOverlay`'e taşınır: ana çocuk `GtkGLArea` (video), üst katman şeffaf WebKitGTK webview (arayüz). Kompozisyonu GTK kendi penceresi içinde yapar — sistem kompozitörüne, pencere sırasına veya yabancı pencere gömmeye bağlı değildir; Wayland ve X11'de aynı yol. Webview girdiyi almaya devam eder (üst katman), video alanı fare olayı almaz.
2. **libmpv seçenekleri:** `vo=libmpv` (render API), `wid` yok, `hwdec=auto-copy-safe` (aşağıda). Diğer tüm oynatma seçenekleri Windows ile aynıdır (`engine/mod.rs` → `surface_options`).
3. **GL bağlamı ve giriş noktaları:** Bağlam `GtkGLArea`'nındır (GDK: Wayland'de EGL, X11'de GTK 3 varsayılanı GLX). `get_proc_address` GDK arka ucuna göre seçilir: Wayland → `libEGL.so.1` `eglGetProcAddress`; X11 → `libGL.so.1` `glXGetProcAddressARB`, olmazsa EGL. VHO GL kütüphanelerine derleme anında bağlanmaz (`libloading`).

## Thread / bağlam sahipliği

| Ne | Hangi thread | Not |
|---|---|---|
| `mpv_create` / `mpv_initialize`, komutlar, özellikler | herhangi (libmpv client API thread-safe) | Değişmedi (Windows ile ortak) |
| `mpv_render_context_create` | GTK ana thread, `GtkGLArea::realize` içinde, `make_current()` sonrası | Bağlam bu GL bağlamına bağlıdır |
| `mpv_render_context_render` | GTK ana thread, `GtkGLArea::render` | Hedef FBO = `GL_DRAW_FRAMEBUFFER_BINDING` (GtkGLArea'nın FBO'su), boyut = ayrılan boyut × `scale_factor` (HiDPI), `FLIP_Y=1`, `BLOCK_FOR_TARGET_TIME=0` (arayüz thread'i hiç bloklanmaz) |
| Güncelleme geri çağrısı (`mpv_render_context_set_update_callback`) | mpv'nin thread'i | Yalnızca `glib::MainContext::invoke` ile ana thread'e `queue_render` gönderir; içinde mpv/GL çağrısı yok |
| `mpv_render_context_free` | GTK ana thread, `unrealize` veya `engine::shutdown` | GL bağlamı `make_current()` ile güncel; geri çağrı önce kaldırılır |
| `mpv_terminate_destroy` | son `Arc<Mpv>` bırakılınca | `RenderContext` çekirdeğin `Arc`'ını tutar: render bağlamı serbest bırakılmadan çekirdek yok edilemez |

## Kare akışı

mpv yeni kare hazır → güncelleme geri çağrısı (mpv thread) → `MainContext::invoke` → `GtkGLArea::queue_render` → GTK çizim döngüsü `render` sinyali → `mpv_render_context_render(FBO)` → GTK, GL alanını ve üstündeki şeffaf webview'i pencereye birleştirir. `auto_render` kapalı: yalnızca mpv istediğinde ve boyut değişince çizilir. Yüzey gizliyken (fotoğraf, boş ekran, HTML5 motoru) `GtkGLArea` görünmez, çizim yapılmaz.

## Kapanış yaşam döngüsü

1. `RunEvent::Exit` → `engine::shutdown` (ana thread): `linux::shutdown()` GL alanını güncel yapar, render bağlamını bırakır (`set_update_callback(NULL)` + `mpv_render_context_free`).
2. Ardından `quit` komutu; olay thread'i `MPV_EVENT_SHUTDOWN` ile biter; son `Arc<Mpv>` düşünce `mpv_terminate_destroy`.
3. Pencere önce yok edilirse `unrealize` aynı serbest bırakmayı yapar; ikinci çağrı boş işlemdir.

## `.so` arama sırası, rpath, lisans

- `libmpv.so.2` yalnızca: `VHO_MPV_DLL` → çalıştırılabilir dosyanın yanı → `<exe>/mpv/` → `<resources>/mpv/`. **Sistem kütüphane yolu kullanılmaz:** dağıtımların `libmpv2`/`libavcodec*` paketleri genelde `--enable-gpl` ile derlenir; bunları sessizce yüklemek lisans politikasını aşar. Kullanıcı isterse `VHO_MPV_DLL` ile kendi sistem kütüphanesini kendi seçimi olarak gösterebilir (dağıtmıyoruz).
- Dağıtılan dosyalar `third_party/mpv/build-linux.sh` ile üretilir: FFmpeg n8.1.3 `--enable-gpl`/`--enable-nonfree` yok; mpv v0.41.0 `-Dgpl=false`. Betik GPL bayraklarını, `meson introspect` ile `gpl=false`'u ve `ldd` ile libmpv'nin **bizim** `libav*` dosyalarımızı çözdüğünü doğrular; aksi halde başarısız olur.
- Hepsi `RUNPATH=$ORIGIN` (patchelf): libmpv kendi FFmpeg'ini kendi klasöründen yükler. Sistem bağımlılıkları (libass, libplacebo, libdav1d, libva, libpulse/pipewire, mesa) dağıtımdan gelir; paketleme (P05) bunları AppImage'a koyarken aynı lisans denetimini yapar (hepsi LGPL/BSD/MIT/ISC).
- `ffmpeg`/`ffprobe` (medya eylemleri) aynı derlemeden ve aynı klasörden gelir.

## Donanım çözme (VAAPI) ve yazılım yedeği

- `hwdec=auto-copy-safe`: VAAPI varsa çözülen kare CPU'ya kopyalanır (render API'ye EGL interop için `MPV_RENDER_PARAM_WL_DISPLAY`/`X11_DISPLAY` verilmez; interop sonraki iş, gerçek donanımla ölçülmeli). VAAPI yoksa/başarısızsa mpv **yazılım çözmeye** düşer — siyah kare yerine çalışan oynatma.
- WSLg'de VAAPI sürücüsü yok (`vainfo` çalışmıyor) → yazılım çözme; bu beklenen davranıştır, performans kanıtı sayılmaz.

## Ses

mpv `ao` otomatik: PipeWire (`pipewire`), PulseAudio (`pulse`), ALSA sırasıyla; LGPL derlemede üçü de etkin. PipeWire'lı masaüstlerinde `pipewire-pulse` ile `pulse` da çalışır. WSLg PulseAudio sunucusu sağlar (`PULSE_SERVER=unix:/mnt/wslg/PulseServer`) — `current-ao` duman testinde kaydedilir.

## HiDPI, çoklu monitör, pencere yöneticisi

- HiDPI: render boyutu `allocated × scale_factor`; GTK ölçek değişince `size-allocate` → yeniden çizim. Kesirli ölçek (Wayland) GTK 3'te tam sayıya yuvarlanır (bilinen GTK 3 sınırı).
- Çoklu monitör / farklı DPI arası taşıma, dekorasyonsuz pencerenin WM davranışı (GNOME/KDE, X11/Wayland): **gerçek donanımda test edilmedi** (WSLg tek bir sanal masaüstü).

## Değerlendirilen ve reddedilen seçenekler

| Seçenek | Neden reddedildi |
|---|---|
| `wid` ile X11 gömme | LGPL libmpv'de X11 VO yok (GPL); Wayland'de imkânsız |
| Dağıtımın GPL libmpv'sini yüklemek | Lisans politikası (yalnızca LGPL, dinamik) |
| Ayrı alt yüzey (Wayland subsurface) | Tauri/wry penceresine erişim GTK seviyesinde; GTK3'te taşınabilir subsurface API'si yok, X11 için ayrı yol gerekir |
| mpv `vo=gpu-next` + kendi penceresi, uygulama penceresinin altında | İki üst düzey pencereyi hizalamak Wayland'de mümkün değil (konum bilgisi yok) |
| Kareleri yazılımla webview'e aktarmak (canvas) | IPC/kopya maliyeti, HiDPI'de kabul edilemez hız |

## Doğrulama

- Uygulama içi senaryo (`VHO_ENGINE_SMOKE_REPORT`, `scripts/linux/engine-smoke.sh`): ön yüz dosyayı normal yoldan açar (initial_files → libmpv → `engine_show`); ardından GL alanına çizilen kare sayısı, merkez pikselin video olduğu (glReadPixels), oynat/duraklat/ara, ses izi 2, altyazı izi + metin, ses çıkışı ve `current-vo=libmpv` denetlenir; X11 (`GDK_BACKEND=x11`, XWayland) ve Wayland (`GDK_BACKEND=wayland`) oturumlarında ayrı ayrı.
- Sonuçlar ve ortam: aşağıdaki kayıt. WSLg sanal bir ortamdır (GPU sanal/yazılım, tek sanal masaüstü): **GPU kalite/performans kanıtı sayılmaz**, platform `verified` yapılmaz.

## Kayıt

**2026-10-27/28 — WSL2 + WSLg, Ubuntu 24.04, Mesa 25.2.8 llvmpipe (yazılım GL; GPU yok, VAAPI yok).** Uygulama içi
senaryo `scripts/linux/engine-smoke.sh both`, LGPL `libmpv.so.2` (mpv v0.41.0, FFmpeg n8.1.3; `third_party/mpv/evidence/linux/`).

| Adım | X11 (`GDK_BACKEND=x11`, XWayland, GLX) | Wayland (`GDK_BACKEND=wayland`, EGL) |
|---|---|---|
| libmpv yüklendi (sistem mpv/FFmpeg yok) | geçti | geçti |
| Render bağlamı (GtkGLArea) | geçti (`glx`, GL 4.5 core) | geçti (`egl`, GL 4.5 core) |
| Ön yüzün normal yoluyla dosya açma | geçti | geçti |
| Oynatma / GL alanına kare çizimi | geçti; yük altında yavaş (1,2 s'de 3–26 kare) | geçti (1,2 s'de 14–31 kare) |
| `engine_show` → yüzey görünür | geçti | geçti |
| Duraklat, 1,0 s'ye ara | geçti | geçti |
| Ses izi 2, altyazı izi + metin | geçti | geçti |
| Ses çıkışı | `pulse` (WSLg PulseAudio) | `pulse` |
| `current-vo` | `libmpv` | `libmpv` |
| Birleştirilmiş pencerede arayüz çubuğu videonun üstünde, video alanı şeffaf | geçti (alttaki arayüz satırı görünür, video alanı mpv çıktısı) | geçti |
| FBO / pencere merkez pikseli video rengi | **kurulu deb paketiyle geçti**: 6/6 probe [41,41,255], pencere 5×5 örneği renk şeritlerini gösteriyor; geliştirme derlemesinde bazı koşularda mpv karesi siyah | siyah (her koşuda) |

Siyah kare çözümlemesi: GL durumu temiz (scissor/blend/unpack varsayılan), mpv günlüğünde GL hatası yok (`gpu-debug=yes`),
VO 640×360 yuv420p ile yapılandırılmış, video alanı `(0,71) 1100×618` (merkezi kapsıyor). Aynı sonuç **VHO olmadan**
mpv'nin kendi `--vo=gpu --gpu-context=wayland` çıktısında da çıkıyor (`screenshot window`: 6 denemenin 5'inde siyah,
1'inde doğru renk), oysa aynı dosya `--vo=image` ile doğru çözülüyor. Sonuç: WSLg'nin llvmpipe GL sürücüsünde mpv'nin
GL çiziciyle ilgili ortam sorunu; VHO entegrasyonuna özgü değil. **Gerçek GPU'lu bir Linux masaüstünde (Wayland + X11)
merkez piksel denetimi ortam bekliyor.** Bu nedenle Linux hücreleri `destekli/test bekliyor`, `verified=false` kalır.

Kurulu paket (2026-10-28): `scripts/linux/package.sh` → `VHO_0.1.0_amd64.AppImage` (103,75 MiB) ve
`VHO_0.1.0_amd64.deb` (25,22 MiB); deb, sistemde mpv/FFmpeg paketi **olmayan** dağıtıma `apt` ile kuruldu, `/usr/bin/vho`
libmpv'yi `/usr/lib/VHO/mpv/` altından yükledi, smoke iki oturumda çalıştı (sonuçlar tabloda), paket kaldırıldı.
AppImage çalıştırılarak denenmedi.

Diğer bulgular:
- Ön yüzün saklanan "donanım çözme: otomatik" değeri (`auto-safe`) Linux'ta `auto-copy-safe` seçimini eziyordu;
  `engine_set` artık Linux'ta `auto-copy-safe`'e çeviriyor (Rust testi `engine_hwdec_setting_is_copy_back_on_linux`).
- WSLg'de VAAPI yok (`Could not create a VA display`) → yazılım çözme; beklenen yedek çalıştı.
- `report_swap`, GTK frame clock `after-paint` sinyalinde, mpv karesi çizildiyse çağrılır.
- Tanı için: `VHO_MPV_LOG_LEVEL=v` (mpv günlüğü stderr'e), `VHO_MPV_OPTIONS="gpu-debug=yes"`; smoke raporu FBO
  boyutu/ölçek/viewport, render öncesi GL durumu ve birleştirilmiş pencereden 5×5 örnek içerir.
- HiDPI (ölçek 1), çoklu monitör, GNOME/KDE pencere yöneticisi davranışı: WSLg'de denenemez → ortam bekliyor.
