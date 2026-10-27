//! Text recognition, always OFFLINE and only with languages installed on the machine (a missing
//! language is an explicit `[ocr-language]` error, never a silent online service):
//! - Windows: the built-in Windows.Media.Ocr engine (installed OCR language packs, e.g. Turkish
//!   when the Turkish language is installed). Tested.
//! - Linux: the `tesseract` command (Apache-2.0) and the distribution's traineddata packages
//!   (`tesseract-ocr-tur`, `-eng`...; Apache-2.0), run as a separate process. Nothing is
//!   downloaded or bundled by VHO. Code path compiled for Linux only; NOT tested on a device.
//! - macOS: not offered. Apple Vision (`VNRecognizeTextRequest`) is the candidate (system
//!   framework, offline), but its recognition languages do not include Turkish (P04 notes in
//!   docs/platform-support.md); reports `[unsupported]`.
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

#[cfg(target_os = "linux")]
pub fn languages() -> Vec<String> {
    tesseract::installed().map(|l| l.iter().map(|c| tesseract::to_tag(c)).collect()).unwrap_or_default()
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn languages() -> Vec<String> {
    vec![]
}

/// OCR engine usable on this machine (None: OCR not offered).
#[cfg(windows)]
pub fn engine_name() -> Option<&'static str> {
    Some("windows-media-ocr")
}

#[cfg(target_os = "linux")]
pub fn engine_name() -> Option<&'static str> {
    tesseract::installed().is_some().then_some("tesseract")
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn engine_name() -> Option<&'static str> {
    None
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

#[cfg(target_os = "linux")]
pub fn recognize(path: &Path, language: Option<&str>) -> Result<OcrResult, String> {
    tesseract::recognize(path, language)
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn recognize(_path: &Path, _language: Option<&str>) -> Result<OcrResult, String> {
    Err(format!("{} Metin tanıma bu sistemde henüz desteklenmiyor", super::ERR_UNSUPPORTED))
}

/// Tesseract CLI adapter. The parsers are platform neutral (unit tested everywhere); the
/// process part is used on Linux only.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub mod tesseract {
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    use super::{OcrLine, OcrResult, OcrWord};
    use crate::actions::{ERR_OCR_LANGUAGE, ERR_UNSUPPORTED};

    /// BCP-47 primary tag <-> Tesseract traineddata code (most common languages).
    const LANGS: &[(&str, &str)] = &[
        ("tr", "tur"), ("en", "eng"), ("de", "deu"), ("fr", "fra"), ("es", "spa"), ("it", "ita"), ("pt", "por"), ("nl", "nld"),
        ("ru", "rus"), ("uk", "ukr"), ("pl", "pol"), ("cs", "ces"), ("sv", "swe"), ("da", "dan"), ("fi", "fin"), ("no", "nor"),
        ("el", "ell"), ("hu", "hun"), ("ro", "ron"), ("bg", "bul"), ("ar", "ara"), ("fa", "fas"), ("he", "heb"), ("az", "aze"),
        ("ja", "jpn"), ("ko", "kor"), ("zh-Hans", "chi_sim"), ("zh-Hant", "chi_tra"), ("hi", "hin"),
    ];

    /// "tr-TR" / "tr" -> "tur"; Tesseract codes pass through; unknown -> None.
    pub fn to_code(tag: &str) -> Option<String> {
        let t = tag.trim();
        if t.is_empty() {
            return None;
        }
        if LANGS.iter().any(|(_, c)| *c == t) {
            return Some(t.to_string());
        }
        if let Some((_, c)) = LANGS.iter().find(|(b, _)| b.eq_ignore_ascii_case(t)) {
            return Some(c.to_string());
        }
        let primary = t.split(['-', '_']).next().unwrap_or(t);
        LANGS.iter().find(|(b, _)| b.eq_ignore_ascii_case(primary)).map(|(_, c)| c.to_string())
    }

    /// "tur" -> "tr" (unknown codes stay as they are).
    pub fn to_tag(code: &str) -> String {
        LANGS.iter().find(|(_, c)| *c == code).map_or_else(|| code.to_string(), |(b, _)| b.to_string())
    }

    /// `tesseract --list-langs` output -> codes (the "osd" script detector is not a language).
    pub fn parse_list_langs(out: &str) -> Vec<String> {
        out.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.contains(' ') && !l.ends_with(':') && *l != "osd" && *l != "equ")
            .map(str::to_string)
            .collect()
    }

    /// `-l` value: the requested language must be installed; without a request, Turkish +
    /// English when installed, else the first installed language.
    pub fn choose(requested: Option<&str>, installed: &[String]) -> Result<String, String> {
        if installed.is_empty() {
            return Err(format!("{ERR_OCR_LANGUAGE} Tesseract dil paketi yüklü değil (ör. tesseract-ocr-tur)"));
        }
        match requested.filter(|r| !r.trim().is_empty()) {
            Some(r) => {
                let code = to_code(r).ok_or_else(|| format!("{ERR_OCR_LANGUAGE} Bilinmeyen metin tanıma dili: {r}"))?;
                if installed.iter().any(|i| *i == code) {
                    Ok(code)
                } else {
                    Err(format!("{ERR_OCR_LANGUAGE} Metin tanıma dili yüklü değil: {r} (tesseract-ocr-{code})"))
                }
            }
            None => {
                let pref: Vec<&str> = ["tur", "eng"].into_iter().filter(|c| installed.iter().any(|i| i == c)).collect();
                Ok(if pref.is_empty() { installed[0].clone() } else { pref.join("+") })
            }
        }
    }

    /// `tesseract img stdout tsv` -> lines of words (pixel boxes of the given image).
    pub fn parse_tsv(tsv: &str, width: u32, height: u32, language: &str) -> OcrResult {
        let mut out = OcrResult { width, height, language: language.to_string(), ..Default::default() };
        let mut current: Option<((u32, u32, u32, u32), OcrLine)> = None;
        for row in tsv.lines().skip(1) {
            let c: Vec<&str> = row.split('\t').collect();
            if c.len() < 12 || c[0] != "5" {
                continue;
            }
            let n = |i: usize| c[i].trim().parse::<u32>().unwrap_or(0);
            let text = c[11..].join("\t").trim().to_string();
            let conf = c[10].trim().parse::<f64>().unwrap_or(-1.0);
            if text.is_empty() || conf < 0.0 {
                continue;
            }
            let key = (n(1), n(2), n(3), n(4));
            if current.as_ref().is_some_and(|(k, _)| *k != key) {
                out.lines.push(current.take().unwrap().1);
            }
            let line = &mut current.get_or_insert_with(|| (key, OcrLine::default())).1;
            if !line.text.is_empty() {
                line.text.push(' ');
            }
            line.text.push_str(&text);
            line.words.push(OcrWord { text, x: n(6) as f64, y: n(7) as f64, w: n(8) as f64, h: n(9) as f64 });
        }
        if let Some((_, l)) = current {
            out.lines.push(l);
        }
        out.text = out.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
        out
    }

    fn exe() -> PathBuf {
        std::env::var_os("VHO_TESSERACT").filter(|v| !v.is_empty()).map_or_else(|| PathBuf::from("tesseract"), PathBuf::from)
    }

    /// Installed language codes, None when the tesseract command is missing (cached).
    pub fn installed() -> Option<Vec<String>> {
        static CACHE: OnceLock<Option<Vec<String>>> = OnceLock::new();
        CACHE
            .get_or_init(|| {
                let out = std::process::Command::new(exe()).arg("--list-langs").stdin(std::process::Stdio::null()).output().ok()?;
                // older versions print the list on stderr
                let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
                out.status.success().then(|| parse_list_langs(&text))
            })
            .clone()
    }

    pub fn recognize(path: &Path, language: Option<&str>) -> Result<OcrResult, String> {
        let installed = installed().ok_or_else(|| format!("{ERR_UNSUPPORTED} tesseract bulunamadı (paket: tesseract-ocr)"))?;
        let lang = choose(language, &installed)?;
        // EXIF orientation applied by VHO's decoder: boxes refer to the upright image
        let img = crate::photo::decode::decode(path, Some(4000))?.image;
        let (w, h) = (img.width(), img.height());
        let tmp = std::env::temp_dir().join(format!("vho-ocr-{}-{}.png", std::process::id(), w ^ h));
        img.save(&tmp).map_err(|e| e.to_string())?;
        let out = std::process::Command::new(exe())
            .arg(&tmp)
            .args(["stdout", "-l", &lang, "tsv"])
            .stdin(std::process::Stdio::null())
            .output();
        let _ = std::fs::remove_file(&tmp);
        let out = out.map_err(|e| format!("tesseract: {e}"))?;
        if !out.status.success() {
            return Err(format!("tesseract: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(parse_tsv(&String::from_utf8_lossy(&out.stdout), w, h, &lang))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn tesseract_languages_and_choice() {
            let langs = parse_list_langs("List of available languages in \"/usr/share/tessdata/\" (3):\neng\nosd\ntur\n");
            assert_eq!(langs, ["eng", "tur"]);
            assert_eq!(to_code("tr-TR").as_deref(), Some("tur"));
            assert_eq!(to_code("en").as_deref(), Some("eng"));
            assert_eq!(to_code("chi_sim").as_deref(), Some("chi_sim"));
            assert_eq!(to_code("xx"), None);
            assert_eq!(to_tag("tur"), "tr");
            assert_eq!(choose(None, &langs).unwrap(), "tur+eng");
            assert_eq!(choose(Some("tr"), &langs).unwrap(), "tur");
            // not installed: explicit language error, never another (online) engine
            let e = choose(Some("de-DE"), &langs).unwrap_err();
            assert!(e.starts_with(ERR_OCR_LANGUAGE) && e.contains("tesseract-ocr-deu"), "{e}");
            assert!(choose(Some("xx"), &langs).unwrap_err().starts_with(ERR_OCR_LANGUAGE));
            assert!(choose(None, &[]).unwrap_err().starts_with(ERR_OCR_LANGUAGE));
            assert_eq!(choose(None, &["deu".to_string()]).unwrap(), "deu");
        }

        #[test]
        fn tesseract_tsv_to_lines_and_boxes() {
            let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                       1\t1\t0\t0\t0\t0\t0\t0\t800\t200\t-1\t\n\
                       5\t1\t1\t1\t1\t1\t10\t20\t100\t30\t95.1\tMerhaba\n\
                       5\t1\t1\t1\t1\t2\t120\t20\t90\t30\t91.0\tdünya\n\
                       5\t1\t1\t1\t2\t1\t10\t60\t60\t30\t88.0\tİkinci\n\
                       5\t1\t1\t1\t2\t2\t80\t60\t10\t30\t-1\t \n";
            let r = parse_tsv(tsv, 800, 200, "tur");
            assert_eq!(r.text, "Merhaba dünya\nİkinci");
            assert_eq!(r.lines.len(), 2);
            let w = &r.lines[0].words[1];
            assert_eq!((w.text.as_str(), w.x, w.y, w.w, w.h), ("dünya", 120.0, 20.0, 90.0, 30.0));
            assert_eq!((r.width, r.height, r.language.as_str()), (800, 200, "tur"));
            assert_eq!(parse_tsv("", 1, 1, "eng").lines.len(), 0);
        }
    }
}
