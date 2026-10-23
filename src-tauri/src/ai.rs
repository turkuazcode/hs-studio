//! On-demand AI components (inference runtime + models).
//!
//! Nothing is bundled with the app: each component is downloaded the first time a
//! feature needs it, from a URL pinned to an exact version/commit, verified against
//! a SHA-256 hash, and stored under `<app data>/ai/<component>/`. Only open-source
//! licensed components are listed here; see THIRD_PARTY_NOTICES.md.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

struct FileSpec {
    url: &'static str,
    name: &'static str,
    sha256: &'static str,
    size: u64,
}

struct Component {
    id: &'static str,
    files: &'static [FileSpec],
}

// URLs pinned to an exact npm version / Hugging Face commit
macro_rules! ort_web {
    ($file:literal) => {
        concat!("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/", $file)
    };
}
macro_rules! hf_rwp {
    ($file:literal) => {
        concat!(
            "https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2/resolve/95e9cd50553951c27d86bafbdc1bc27ca8e750d2/",
            $file
        )
    };
}

const COMPONENTS: &[Component] = &[
    // ONNX Runtime Web 1.30.0 (MIT) - WebGPU + WebAssembly inference engine
    Component {
        id: "ort-web",
        files: &[
            FileSpec {
                url: ort_web!("ort.webgpu.min.mjs"),
                name: "ort.webgpu.min.mjs",
                sha256: "3dffff71811bc13a3a3d9591c57ca5ee5735b8f5f3eaf789510b02bb040ae3a0",
                size: 66_349,
            },
            FileSpec {
                url: ort_web!("ort-wasm-simd-threaded.asyncify.mjs"),
                name: "ort-wasm-simd-threaded.asyncify.mjs",
                sha256: "3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28",
                size: 53_057,
            },
            FileSpec {
                url: ort_web!("ort-wasm-simd-threaded.asyncify.wasm"),
                name: "ort-wasm-simd-threaded.asyncify.wasm",
                sha256: "39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da",
                size: 26_781_914,
            },
            // License + third-party notices travel with the binaries we make the user download
            FileSpec {
                url: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE",
                name: "LICENSE",
                sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c",
                size: 1_073,
            },
            FileSpec {
                url: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/ThirdPartyNotices.txt",
                name: "ThirdPartyNotices.txt",
                sha256: "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3",
                size: 338_088,
            },
        ],
    },
    // 4xRealWebPhoto_v4_dat2 by Philip Hofmann (CC-BY-4.0) - photo restoration + 4x upscale
    Component {
        id: "photo-x4",
        files: &[FileSpec {
            url: hf_rwp!("4xRealWebPhoto_v4_fp32_opset17.onnx"),
            name: "4xRealWebPhoto_v4_fp32_opset17.onnx",
            sha256: "a9a3a9099e0108b793556ed9cf2123a61a727bbc611dd8d93475f7144596589e",
            size: 48_760_847,
        }],
    },
    // Face restoration: YuNet detector (MIT, Shiqi Yu / OpenCV) + GFPGAN v1.4 (Apache-2.0, Tencent ARC).
    // GFPGAN export: fp16-stored weights cast to fp32 at load (same output, half the download).
    Component {
        id: "face-restore",
        files: &[
            FileSpec {
                url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
                name: "face_detection_yunet_2023mar.onnx",
                sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
                size: 232_589,
            },
            FileSpec {
                url: "https://huggingface.co/opiumuseless/gfpgan-v1.4-w16/resolve/996691710925f8f44f0896490b8ff3d7a559398a/GFPGANv1.4-w16.onnx",
                name: "GFPGANv1.4-w16.onnx",
                sha256: "1704d227d3a0ca73618137f55e1a124d3953a68a990ecd0e7e2e039b2823eb11",
                size: 170_289_207,
            },
        ],
    },
];

fn find(id: &str) -> Result<&'static Component, String> {
    COMPONENTS.iter().find(|c| c.id == id).ok_or_else(|| format!("Bilinmeyen bileşen: {id}"))
}

pub fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn is_installed(dir: &Path, c: &Component) -> bool {
    c.files.iter().all(|f| {
        std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    id: &'static str,
    installed: bool,
    download_bytes: u64,
    /// Directory the files live in (only meaningful when installed)
    dir: String,
}

pub fn status(app: &AppHandle, id: &str) -> Result<ComponentStatus, String> {
    let c = find(id)?;
    let dir = root_dir(app)?.join(c.id);
    let installed = is_installed(&dir, c);
    if installed {
        allow_dir(app, &dir)?;
    }
    Ok(ComponentStatus {
        id: c.id,
        installed,
        download_bytes: c.files.iter().map(|f| f.size).sum(),
        dir: dir.to_string_lossy().into_owned(),
    })
}

fn allow_dir(app: &AppHandle, dir: &Path) -> Result<(), String> {
    app.asset_protocol_scope().allow_directory(dir, true).map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: &'static str,
    done: u64,
    total: u64,
}

/// Downloads every missing file of a component, verifying sizes and SHA-256 hashes.
pub async fn install(app: &AppHandle, id: &str) -> Result<ComponentStatus, String> {
    let c = find(id)?;
    let dir = root_dir(app)?.join(c.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let total: u64 = c.files.iter().map(|f| f.size).sum();
    let mut done = 0u64;
    let client = reqwest::Client::builder()
        .user_agent(concat!("VHO/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;

    for f in c.files {
        let target = dir.join(f.name);
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == f.size) {
            done += f.size;
            continue;
        }
        let partial = dir.join(format!("{}.part", f.name));
        let mut resp = client
            .get(f.url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("İndirme başarısız ({}): {e}", f.name))?;

        let mut file = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut last_emit = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Bağlantı koptu: {e}"))? {
            use std::io::Write;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            hasher.update(&chunk);
            written += chunk.len() as u64;
            if written - last_emit > 512 * 1024 {
                last_emit = written;
                let _ = app.emit("ai-download", DownloadProgress { id: c.id, done: done + written, total });
            }
        }
        drop(file);

        let digest = hex(&hasher.finalize());
        if written != f.size || digest != f.sha256 {
            let _ = std::fs::remove_file(&partial);
            return Err(format!(
                "{} doğrulanamadı (beklenen {} bayt / {}, gelen {} bayt / {})",
                f.name, f.size, f.sha256, written, digest
            ));
        }
        std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        done += f.size;
        let _ = app.emit("ai-download", DownloadProgress { id: c.id, done, total });
    }

    status(app, id)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
