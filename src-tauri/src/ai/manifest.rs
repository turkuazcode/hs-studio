//! The single authoritative manifest of downloadable AI components.
//!
//! Every file is pinned to an exact version/commit URL, its byte size and full SHA-256. A
//! download is either a plain file or a zip archive from which only the listed entries are
//! extracted (each with its own size + SHA-256; the archive itself is hashed too and deleted
//! after extraction). Models with ONNX external data list the pair in `external_data`.
//!
//! Test builds of the app (VHO_DATA_DIR set) may add `test-*` components served from a
//! loopback HTTP server via VHO_AI_TEST_MANIFEST (a JSON array in this same format).

use serde::{Deserialize, Serialize};

/// Upper bound of any single file / archive (a corrupted manifest must not fill the disk).
pub const MAX_FILE_BYTES: u64 = 4 << 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: String,
    /// Directory name of this exact file set; a new version installs next to the old one.
    pub version: String,
    /// runtime | photo-upscale | face-restore | ... (UI label key)
    pub task: String,
    pub title: String,
    pub author: String,
    pub license: String,
    /// Where the pinned files come from (repository / commit page)
    pub source: String,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub output: String,
    /// Version of our pre/post-processing code the model was validated with
    #[serde(default)]
    pub process_version: u32,
    /// Backends the model was actually run on (never derived from file size)
    #[serde(default)]
    pub tested_backends: Vec<String>,
    #[serde(default)]
    pub external_data: Vec<ExternalData>,
    pub downloads: Vec<Download>,
}

/// ONNX model whose weights live in a separate file (ORT-Web `externalData`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalData {
    pub model: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    /// Final file name of a plain download (None for an archive)
    #[serde(default)]
    pub name: Option<String>,
    /// Zip entries to extract (empty for a plain download)
    #[serde(default)]
    pub extract: Vec<Extract>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extract {
    /// Exact entry path inside the archive
    pub entry: String,
    /// Flat file name it is stored under
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

/// One file of an installed component.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledFile<'a> {
    pub name: &'a str,
    pub sha256: &'a str,
    pub bytes: u64,
}

impl Download {
    pub fn is_archive(&self) -> bool {
        !self.extract.is_empty()
    }

    /// Name of the temporary file the download is written to.
    pub fn part_name(&self, index: usize) -> String {
        match &self.name {
            Some(n) if !self.is_archive() => format!("{n}.part"),
            _ => format!("archive-{index}.zip.part"),
        }
    }

    /// Files this download produces.
    pub fn outputs(&self) -> Vec<InstalledFile<'_>> {
        if self.is_archive() {
            self.extract.iter().map(|e| InstalledFile { name: &e.name, sha256: &e.sha256, bytes: e.bytes }).collect()
        } else {
            let name = self.name.as_deref().unwrap_or_default();
            vec![InstalledFile { name, sha256: &self.sha256, bytes: self.bytes }]
        }
    }
}

impl Component {
    pub fn files(&self) -> Vec<InstalledFile<'_>> {
        self.downloads.iter().flat_map(|d| d.outputs()).collect()
    }

    pub fn download_bytes(&self) -> u64 {
        self.downloads.iter().map(|d| d.bytes).sum()
    }

    pub fn disk_bytes(&self) -> u64 {
        self.files().iter().map(|f| f.bytes).sum()
    }
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// [A-Za-z0-9._-], not starting with '.', no "..": safe as one path component everywhere.
pub fn is_safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('.')
        && !s.contains("..")
        && !s.ends_with(".part")
        && !s.ends_with(".part.json")
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// A relative zip entry path: '/'-separated safe-ish segments, no traversal, no drive/root.
fn is_safe_entry(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && !s.contains('\\')
        && !s.contains(':')
        && s.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn is_loopback_http(url: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:", "http://127.0.0.1/", "http://localhost/"].iter().any(|p| url.starts_with(p))
}

/// Rejects anything that could escape the component folder, an abbreviated hash, a missing
/// license/author or an unbounded size. `test` components may use loopback http URLs.
pub fn validate(c: &Component, test: bool) -> Result<(), String> {
    let id_ok = is_safe_name(&c.id) && (c.id.starts_with("test-") == test);
    if !id_ok {
        return Err(format!("invalid component id {:?}", c.id));
    }
    if !is_safe_name(&c.version) {
        return Err(format!("{}: invalid version {:?}", c.id, c.version));
    }
    if c.downloads.is_empty() {
        return Err(format!("{}: no downloads", c.id));
    }
    let mut names = std::collections::HashSet::new();
    for d in &c.downloads {
        let url_ok = d.url.starts_with("https://") || (test && is_loopback_http(&d.url));
        if !url_ok {
            return Err(format!("{}: url not allowed {}", c.id, d.url));
        }
        if !is_sha256(&d.sha256) {
            return Err(format!("{}: sha256 must be the full lowercase hex digest ({})", c.id, d.url));
        }
        if d.bytes == 0 || d.bytes > MAX_FILE_BYTES {
            return Err(format!("{}: size out of range ({})", c.id, d.url));
        }
        if d.is_archive() == d.name.is_some() {
            return Err(format!("{}: a download is either a named file or an archive with entries", c.id));
        }
        let mut entries = std::collections::HashSet::new();
        for e in &d.extract {
            if !is_safe_entry(&e.entry) || !entries.insert(e.entry.as_str()) {
                return Err(format!("{}: invalid archive entry {:?}", c.id, e.entry));
            }
            if !is_sha256(&e.sha256) || e.bytes == 0 || e.bytes > MAX_FILE_BYTES {
                return Err(format!("{}: entry {:?} needs a full sha256 and a bounded size", c.id, e.entry));
            }
        }
        for f in d.outputs() {
            if !is_safe_name(f.name) || !names.insert(f.name.to_ascii_lowercase()) {
                return Err(format!("{}: invalid or duplicate file name {:?}", c.id, f.name));
            }
        }
    }
    for x in &c.external_data {
        if !names.contains(&x.model.to_ascii_lowercase()) || !names.contains(&x.data.to_ascii_lowercase()) {
            return Err(format!("{}: external data refers to unknown files", c.id));
        }
    }
    if c.license.trim().is_empty() || c.author.trim().is_empty() || c.source.trim().is_empty() {
        return Err(format!("{}: license-unavailable", c.id));
    }
    Ok(())
}

fn file(url: &str, name: &str, sha256: &str, bytes: u64) -> Download {
    Download { url: url.into(), sha256: sha256.into(), bytes, name: Some(name.into()), extract: vec![] }
}

const ORT_WEB: &str = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const HF_RWP: &str = "https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2/resolve/95e9cd50553951c27d86bafbdc1bc27ca8e750d2/";

/// Components shipped in the app's manifest (Plan 07 smart-editing models: A06).
pub fn builtin() -> Vec<Component> {
    let webgpu_wasm = vec!["webgpu".to_string(), "wasm".to_string()];
    vec![
        Component {
            id: "ort-web".into(),
            version: "1.30.0".into(),
            task: "runtime".into(),
            title: "ONNX Runtime Web 1.30.0".into(),
            author: "Microsoft".into(),
            license: "MIT".into(),
            source: "https://github.com/microsoft/onnxruntime/releases/tag/v1.30.0".into(),
            input: String::new(),
            output: String::new(),
            process_version: 0,
            tested_backends: webgpu_wasm.clone(),
            external_data: vec![],
            downloads: vec![
                file(&format!("{ORT_WEB}ort.webgpu.min.mjs"), "ort.webgpu.min.mjs",
                    "3dffff71811bc13a3a3d9591c57ca5ee5735b8f5f3eaf789510b02bb040ae3a0", 66_349),
                file(&format!("{ORT_WEB}ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs",
                    "3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28", 53_057),
                file(&format!("{ORT_WEB}ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm",
                    "39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da", 26_781_914),
                // License + third-party notices travel with the binaries the user downloads
                file("https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE", "LICENSE",
                    "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c", 1_073),
                file("https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt", "ThirdPartyNotices.txt",
                    "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3", 338_088),
            ],
        },
        Component {
            id: "photo-x4".into(),
            version: "rwp4-95e9cd5".into(),
            task: "photo-upscale".into(),
            title: "4xRealWebPhoto v4 (DAT-2)".into(),
            author: "Philip Hofmann".into(),
            license: "CC-BY-4.0".into(),
            source: "https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2/tree/95e9cd50553951c27d86bafbdc1bc27ca8e750d2".into(),
            input: "RGB 0..1 [1,3,H,W], H/W multiple of 16".into(),
            output: "RGB 0..1 [1,3,4H,4W]".into(),
            process_version: 1,
            tested_backends: webgpu_wasm.clone(),
            external_data: vec![],
            downloads: vec![file(&format!("{HF_RWP}4xRealWebPhoto_v4_fp32_opset17.onnx"), "4xRealWebPhoto_v4_fp32_opset17.onnx",
                "a9a3a9099e0108b793556ed9cf2123a61a727bbc611dd8d93475f7144596589e", 48_760_847)],
        },
        // GFPGAN export: fp16-stored weights cast to fp32 at load (same output, half the download)
        Component {
            id: "face-restore".into(),
            version: "yunet2023mar-gfpgan14w16".into(),
            task: "face-restore".into(),
            title: "GFPGAN v1.4 + YuNet".into(),
            author: "Tencent ARC (GFPGAN), Shiqi Yu / OpenCV (YuNet)".into(),
            license: "Apache-2.0 (GFPGAN), MIT (YuNet)".into(),
            source: "https://huggingface.co/opiumuseless/gfpgan-v1.4-w16/tree/996691710925f8f44f0896490b8ff3d7a559398a".into(),
            input: "YuNet BGR 640x640; GFPGAN RGB -1..1 [1,3,512,512]".into(),
            output: "faces + landmarks; RGB -1..1 [1,3,512,512]".into(),
            process_version: 1,
            tested_backends: webgpu_wasm.clone(),
            external_data: vec![],
            downloads: vec![
                file("https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
                    "face_detection_yunet_2023mar.onnx",
                    "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", 232_589),
                file("https://huggingface.co/opiumuseless/gfpgan-v1.4-w16/resolve/996691710925f8f44f0896490b8ff3d7a559398a/GFPGANv1.4-w16.onnx",
                    "GFPGANv1.4-w16.onnx",
                    "1704d227d3a0ca73618137f55e1a124d3953a68a990ecd0e7e2e039b2823eb11", 170_289_207),
            ],
        },
        // ---- Plan 07 smart editing (A06). Sizes / full SHA-256 checked against the Hugging Face
        // API (LFS oid) and the published zip on 2026-10-27; the zip entries from its directory.
        Component {
            id: "lama".into(),
            version: "lama-fp32-c3c0c9e".into(),
            task: "inpaint".into(),
            title: "LaMa (big-lama) inpainting".into(),
            author: "Samsung AI Center Moscow (LaMa); ONNX export: Carve".into(),
            license: "Apache-2.0".into(),
            source: "https://huggingface.co/Carve/LaMa-ONNX/tree/c3c0c9e468934d62e79c329e35d82dd09ff8c444".into(),
            input: "image RGB 0..1 [1,3,512,512] + mask [1,1,512,512] (1 = fill)".into(),
            output: "RGB 0..255 [1,3,512,512]".into(),
            process_version: 1,
            tested_backends: vec![],
            external_data: vec![],
            downloads: vec![file("https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
                "lama_fp32.onnx", "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6", 208_044_816)],
        },
        Component {
            id: "birefnet-portrait".into(),
            version: "portrait-fp16-dd7167f".into(),
            task: "matting".into(),
            title: "BiRefNet portrait (background removal)".into(),
            author: "Peng Zheng et al. (BiRefNet); ONNX export: onnx-community".into(),
            license: "MIT".into(),
            source: "https://huggingface.co/onnx-community/BiRefNet-portrait-ONNX/tree/dd7167f6a8b54ff7efc29a4c988938d79866464f".into(),
            input: "RGB ImageNet-normalized [1,3,1024,1024]".into(),
            output: "mask logits [1,1,1024,1024]".into(),
            process_version: 1,
            tested_backends: vec![],
            external_data: vec![],
            downloads: vec![file(
                "https://huggingface.co/onnx-community/BiRefNet-portrait-ONNX/resolve/dd7167f6a8b54ff7efc29a4c988938d79866464f/onnx/model_fp16.onnx",
                "birefnet_portrait_fp16.onnx", "4c05930c0b6f1418d02eb1de81c46fe37638ba54f5a93adeb5c674521db10110", 489_666_272)],
        },
        // Optional "objects / products" background model (Settings > AI models). Full SHA-256 and
        // size from the Hugging Face API (LFS oid) at the pinned commit on 2026-10-27.
        Component {
            id: "birefnet-general".into(),
            version: "general-fp16-534d3c8".into(),
            task: "matting".into(),
            title: "BiRefNet general (background removal, objects)".into(),
            author: "Peng Zheng et al. (BiRefNet); ONNX export: onnx-community".into(),
            license: "MIT".into(),
            source: "https://huggingface.co/onnx-community/BiRefNet-ONNX/tree/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67".into(),
            input: "RGB ImageNet-normalized [1,3,1024,1024]".into(),
            output: "mask logits [1,1,1024,1024]".into(),
            process_version: 1,
            tested_backends: vec![],
            external_data: vec![],
            downloads: vec![file(
                "https://huggingface.co/onnx-community/BiRefNet-ONNX/resolve/534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67/onnx/model_fp16.onnx",
                "birefnet_general_fp16.onnx", "3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09", 489_666_272)],
        },
        Component {
            id: "ddcolor".into(),
            version: "qaihub-0.65.0-float".into(),
            task: "colorize".into(),
            title: "DDColor (paper_tiny) colorization".into(),
            author: "Xiaoyang Kang et al. (DDColor); ONNX export: Qualcomm AI Hub".into(),
            license: "Apache-2.0".into(),
            source: "https://huggingface.co/qualcomm/DDColor (qai-hub-models v0.65.0)".into(),
            input: "RGB 0..1 [1,3,256,256]".into(),
            output: "Lab ab [1,2,256,256]".into(),
            process_version: 1,
            tested_backends: vec![],
            external_data: vec![ExternalData { model: "ddcolor.onnx".into(), data: "ddcolor.data".into() }],
            downloads: vec![Download {
                url: "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/ddcolor/releases/v0.65.0/ddcolor-onnx-float.zip".into(),
                sha256: "512e788cab02db6796ede174af0db2302247130284a3a00eab9aafddafa48a49".into(),
                bytes: 206_251_342,
                name: None,
                extract: vec![
                    Extract { entry: "ddcolor-onnx-float/ddcolor.onnx".into(), name: "ddcolor.onnx".into(),
                        sha256: "310d0c66a38cd8cfd7d9d93fdb5500fef79d584fe59e25a417aea5915a6b3733".into(), bytes: 2_750_675 },
                    Extract { entry: "ddcolor-onnx-float/ddcolor.data".into(), name: "ddcolor.data".into(),
                        sha256: "5b65cb3eab9fa4ae9ecacd539b148fa51157655732022913b1cf47346f93940c".into(), bytes: 225_312_128 },
                ],
            }],
        },
    ]
}

/// Built-in manifest plus valid `test-*` entries from `test_json` (invalid ones are reported).
pub fn load(test_json: Option<&str>) -> (Vec<Component>, Vec<String>) {
    let mut all = builtin();
    let mut problems = vec![];
    if let Some(json) = test_json {
        match serde_json::from_str::<Vec<Component>>(json) {
            Ok(list) => {
                for c in list {
                    match validate(&c, true) {
                        Ok(()) if !all.iter().any(|x| x.id == c.id) => all.push(c),
                        Ok(()) => problems.push(format!("duplicate id {}", c.id)),
                        Err(e) => problems.push(e),
                    }
                }
            }
            Err(e) => problems.push(format!("test manifest: {e}")),
        }
    }
    (all, problems)
}
