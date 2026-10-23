<div align="center">

# 🎬 VHO — Video H Oynatıcısı
### Yeni Nesil, Ultra Hafif & Çapraz Platform Açık Kaynak Video Oynatıcı

[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.85+-orange?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)](#-platformlar)
[![Developer](https://img.shields.io/badge/Developer-Halil%20SARITAŞ%20(hsrts)-E11D48?style=for-the-badge)](https://github.com/hsrts)

<br/>

**VHO (Video H Oynatıcısı)**, VLC'nin zengin format desteğini ve mpv'nin güçlü video motorunu; **Tauri 2.0, Rust ve modern cam tasarım (Glassmorphism)** ile birleştiren yüksek performanslı, minimalist bir masaüstü medya oynatıcısıdır.

Geleneksel medya oynatıcıların hantal ve 90'lardan kalma arayüzlerini geride bırakarak, Apple TV ve IINA standartlarında modern bir seyir deneyimi sunar.

</div>

---

## ✨ Öne Çıkan Özellikler

| Özellik | Açıklama |
|---|---|
| ⚡ **Yerel AI Restorasyon (144p Kurtarma)** | 144p/360p eski kamera ve telefon videoları için GPU donanım hızlandırmalı kenar keskinleştirme (Unsharp Mask), dinamik kontrast (CAS) ve diyalog netleştirici DSP ses filtresi. |
| 🔊 **%200 Ses Yükseltici (Audio Boost)** | Web Audio API dinamik kazanç (gain) filtresi ile fısıltılı videoları kaliteden ödün vermeden %200'e kadar yükseltme. |
| 🌐 **Akıllı Altyazı Motoru** | Film adını karmaşık dosya isimlerinden ayıklayıp OpenSubtitles.org aramasını tarayıcıda açar. SRT/VTT, UTF-8 ve Windows-1254 (Türkçe) kodlamalı dosyaları okur. |
| 🎞️ **Canlı Zaman Çubuğu Önizlemesi** | Zaman çubuğunda (seek bar) gezinirken o saniyenin video karesini YouTube tarzı canlı küçük kutuda (thumbnail canvas) gösterme. |
| 🌙 **Akıllı Uyku Zamanlayıcısı & PC Standby** | 15–60 dk veya "Video Bitince" seçenekleriyle sesi 3 saniyede kısıp bilgisayarı uyku moduna (`Windows`, `macOS`, `Linux`) alma. |
| ⚖️ **A/B Karşılaştırma Ekranı** | Eski 144p orijinal görüntü ile AI restore edilmiş görüntüyü gerçek zamanlı yan yana (Split-Screen) kıyaslama. |
| 🔁 **A-B Tekrar Döngüsü (A-B Repeat)** | Eğitim, dil öğrenme veya müzik videolarında iki zaman damgası arasını kesintisiz döngüye alma. |
| 🎨 **Canlı Renk & Filtre Laboratuvarı** | Gerçek zamanlı parlaklık, kontrast ve doygunluk ayarları; milisaniyelik `+/- 100ms` altyazı senkronu. |
| 📸 **4K HD Ekran Görüntüsü (Snapshot)** | Oynatılan karenin tam çözünürlüklü ekran görüntüsünü flaş efektiyle anında kaydetme. |
| 🪟 **Resim İçinde Resim (PiP)** | Çalışırken videoyu ekranın köşesinde küçük pencerede sabit tutarak izleme. |
| 📑 **Akıllı Oynatma Listesi (Playlist)** | Çoklu video dosyalarını sıralı oynatma, otomatik sonraki bölüme geçme ve kaldığı yerden devam etme. |
| 🖥️ **Çapraz Platform & Çerçevesiz Tasarım** | Windows, macOS (Traffic Lights) ve Linux için özel pencere kontrolleri ve donanım hızlandırma. |

---

## 🏗️ Mimari ve Teknoloji Yığını

```
┌─────────────────────────────────────────────────────────────────┐
│                    VHO Media Player (Frontend)                  │
│       HTML5 Canvas · Web Audio API · Obsidian Glassmorphism     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Tauri IPC Bridge
┌────────────────────────────────▼────────────────────────────────┐
│                   Tauri 2.0 Core (Rust Layer)                   │
│   Windows SetSuspendState · macOS pmset · Linux systemctl       │
└────────────────────────────────┬────────────────────────────────┘
                                 │ Native Rendering Loop
┌────────────────────────────────▼────────────────────────────────┐
│               libmpv / Direct3D11 / Metal / Vulkan              │
│       H.264 · HEVC / H.265 · AV1 · VP9 · MKV · MP4 · Subtitles  │
└─────────────────────────────────────────────────────────────────┘
```

* **Arayüz (Frontend):** Vanilla CSS & JavaScript, donanım hızlandırmalı HTML5 Canvas ve Web Audio API. Hiçbir ağır framework bağımlılığı yoktur, 10 milisaniyede açılır.
* **Masaüstü Katmanı:** [Tauri 2.0](https://tauri.app/) (Rust tabanlı güvenli, düşük bellek tüketen çalışma ortamı).
* **Medya Motoru Desteği:** `libmpv` / Chromium Media Core entegrasyonu.

---

## ⌨️ Klavye Kısayolları (Cheatsheet)

| Kısayol | İşlev |
|---|---|
| <kbd>Boşluk</kbd> | Oynat / Duraklat |
| <kbd>←</kbd> / <kbd>→</kbd> | 5 saniye geri / ileri sar (Shift ile 30 saniye) |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Ses seviyesini %5 artır / azalt (%0 - %200) |
| <kbd>M</kbd> | Sesi Kapat / Aç (Mute) |
| <kbd>F</kbd> veya **Çift Tıklama** | Tam Ekran (Fullscreen) Aç / Kapat |
| <kbd>C</kbd> veya <kbd>V</kbd> | Altyazıyı Aç / Gizle (Toggle Subtitles) |
| <kbd>G</kbd> / <kbd>H</kbd> | Altyazı gecikmesini -50ms / +50ms kaydır |
| <kbd>S</kbd> | Anlık Ekran Görüntüsü Kaydet (Snapshot) |
| <kbd>L</kbd> | Oynatma Listesini (Playlist) Aç / Kapat |
| <kbd>P</kbd> | Resim İçinde Resim (PiP) Modu |

---

## 🚀 Kurulum ve Çalıştırma

### Gereksinimler
* [Node.js](https://nodejs.org/) (v18 veya üzeri)
* [Rust](https://rustup.rs/) (Cargo)

### Geliştirme Ortamı (Development)
```bash
# Depoyu klonlayın
git clone https://github.com/hsrts/vho.git
cd vho

# Bağımlılıkları yükleyin
npm install

# Geliştirme sunucusunu başlatın
npm run dev
```

Masaüstü penceresi olarak başlatmak için:
```bash
cargo tauri dev
```

---

## 📦 Dağıtım & Derleme (Production Build)

Tauri çoklu platform desteği sayesinde tek bir komutla işletim sisteminize uygun bağımsız binary çıktısı alabilirsiniz:

### 🪟 Windows (.exe / .msi)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/nsis/vho_0.1.0_x64-setup.exe
```

### 🍎 macOS (.dmg / .app)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/dmg/vho_0.1.0_x64.dmg
```

### 🐧 Linux (.AppImage / .deb)
```bash
npm run tauri build
# Çıktı: src-tauri/target/release/bundle/appimage/vho_0.1.0_amd64.AppImage
```

---

## 🤝 Katkıda Bulunma (Contributing)

Açık kaynak topluluğunun katkılarını memnuniyetle karşılıyoruz!

1. Bu depoyu Fork'layın (`Fork` butonu)
2. Yeni bir özellik dalı oluşturun (`git checkout -b feature/YeniOzellik`)
3. Değişikliklerinizi commit edin (`git commit -m 'feat: Yeni özellik eklendi'`)
4. Dalınıza push edin (`git push origin feature/YeniOzellik`)
5. Bir **Pull Request (PR)** açın.

---

## 📄 Lisans

Bu proje [MIT Lisansı](LICENSE) kapsamında açık kaynak olarak lisanslanmıştır. Özgürce kullanılabilir, değiştirilebilir ve dağıtılabilir.

### Üçüncü taraf bileşenler

VHO yalnızca açık kaynak lisanslı (MIT, Apache-2.0, BSD, CC-BY-4.0 vb.) bileşenler kullanır. Tam liste ve lisans metinleri [src/legal/THIRD_PARTY_NOTICES.txt](src/legal/THIRD_PARTY_NOTICES.txt) dosyasında ve uygulamada **AI Restorasyon → Lisanslar ve Teşekkürler** penceresindedir.

- **Yapay zeka bileşenleri uygulamayla birlikte gelmez.** İlk kullanımda, kullanıcı onayıyla, sabit sürüm/commit adreslerinden indirilir ve SHA-256 ile doğrulanır. Lisans dosyaları da yanlarında saklanır.
  - [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0: Microsoft, MIT
  - [4xRealWebPhoto_v4_dat2](https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2): Philip Hofmann, CC-BY-4.0 (değiştirilmeden kullanılır)
- GPU görüntü iyileştirici, AMD FidelityFX FSR 1.0'ın (MIT) WebGL2 uyarlamasıdır.
- Rust bağımlılıklarının bildirimleri `cargo-about` ile üretilir. Bağımlılık değiştiğinde `powershell -File legal\generate-notices.ps1` çalıştırın.

---

<div align="center">

Geliştirici: **[Halil SARITAŞ](https://github.com/hsrts)** · TurkuazCode  
*Sorularınız veya özellik önerileriniz için [GitHub Issues](https://github.com/hsrts/vho/issues) sekmesini kullanabilirsiniz.*

</div>
