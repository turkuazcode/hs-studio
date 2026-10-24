//! Text recognition. Windows: the built-in Windows.Media.Ocr engine (uses the installed OCR
//! language packs, e.g. Turkish when the Turkish language is installed). macOS (Vision) and
//! Linux (Tesseract, downloaded on first use) are planned; they report `[unsupported]`.
//!
//! Word boxes are returned in pixels of the upright (EXIF-oriented) image, so the viewer can
//! place a selectable text layer over it.

use std::path::Path;

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    pub words: Vec<OcrWord>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub lines: Vec<OcrLine>,
    /// Size of the (oriented) image the boxes refer to
    pub width: u32,
    pub height: u32,
    pub language: String,
    pub angle: Option<f64>,
}

#[cfg(windows)]
pub fn languages() -> Vec<String> {
    use windows::Media::Ocr::OcrEngine;
    OcrEngine::AvailableRecognizerLanguages()
        .map(|v| v.into_iter().filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string())).collect())
        .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn languages() -> Vec<String> {
    vec![]
}

#[cfg(windows)]
pub fn recognize(path: &Path, language: Option<&str>) -> Result<OcrResult, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    use super::{ERR_OCR_LANGUAGE, ERR_UNSUPPORTED};

    fn e(what: &'static str) -> impl Fn(windows::core::Error) -> String {
        move |err| format!("{what}: {}", err.message())
    }
    let engine = match language.filter(|l| !l.is_empty()) {
        Some(tag) => {
            let lang = Language::CreateLanguage(&HSTRING::from(tag)).map_err(e("Dil"))?;
            if !OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
                return Err(format!("{ERR_OCR_LANGUAGE} Metin tanıma dili yüklü değil: {tag}"));
            }
            OcrEngine::TryCreateFromLanguage(&lang)
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages(),
    }
    .map_err(|_| format!("{ERR_OCR_LANGUAGE} Windows'ta metin tanıma dili yüklü değil"))?;

    let abs = std::fs::canonicalize(path).map_err(|e| format!("Dosya bulunamadı: {e}"))?;
    let abs = abs.to_string_lossy().into_owned();
    let abs = abs.strip_prefix(r"\\?\").unwrap_or(&abs).to_string();
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(abs)).and_then(|o| o.join()).map_err(e("Dosya"))?;
    let stream = file.OpenAsync(FileAccessMode::Read).and_then(|o| o.join()).map_err(e("Dosya"))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|o| o.join())
        .map_err(|err| format!("{ERR_UNSUPPORTED} Görüntü çözülemedi: {}", err.message()))?;
    let (w, h) = (decoder.OrientedPixelWidth().map_err(e("Boyut"))?, decoder.OrientedPixelHeight().map_err(e("Boyut"))?);
    let max = OcrEngine::MaxImageDimension().unwrap_or(2600).max(256);
    let scale = (max as f64 / w.max(h) as f64).min(1.0);
    let transform = BitmapTransform::new().map_err(e("Dönüşüm"))?;
    if scale < 1.0 {
        // ScaledWidth/Height refer to the stored (unoriented) frame
        let (pw, ph) = (decoder.PixelWidth().unwrap_or(w), decoder.PixelHeight().unwrap_or(h));
        transform.SetScaledWidth(((pw as f64 * scale).round() as u32).max(1)).map_err(e("Dönüşüm"))?;
        transform.SetScaledHeight(((ph as f64 * scale).round() as u32).max(1)).map_err(e("Dönüşüm"))?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant).map_err(e("Dönüşüm"))?;
    }
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .and_then(|o| o.join())
        .map_err(e("Görüntü"))?;
    let result = engine.RecognizeAsync(&bitmap).and_then(|o| o.join()).map_err(e("Metin tanıma"))?;
    let back = 1.0 / scale;
    let mut out = OcrResult {
        text: String::new(),
        width: w,
        height: h,
        language: engine.RecognizerLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_default(),
        angle: result.TextAngle().ok().and_then(|a| a.Value().ok()),
        lines: vec![],
    };
    for line in result.Lines().map_err(e("Satırlar"))? {
        let words = line
            .Words()
            .map(|ws| {
                ws.into_iter()
                    .filter_map(|wd| {
                        let r = wd.BoundingRect().ok()?;
                        Some(OcrWord {
                            text: wd.Text().ok()?.to_string(),
                            x: r.X as f64 * back,
                            y: r.Y as f64 * back,
                            w: r.Width as f64 * back,
                            h: r.Height as f64 * back,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.lines.push(OcrLine { text: line.Text().map(|t| t.to_string()).unwrap_or_default(), words });
    }
    out.text = out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
    Ok(out)
}

#[cfg(not(windows))]
pub fn recognize(_path: &Path, _language: Option<&str>) -> Result<OcrResult, String> {
    Err(format!("{} Metin tanıma bu sistemde henüz desteklenmiyor", super::ERR_UNSUPPORTED))
}
