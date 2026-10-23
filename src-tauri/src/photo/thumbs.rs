//! Thumbnails: longest side = `size` (256 px default), orientation applied, cached on
//! disk under `<app cache>/photo/thumbs/<xx>/<key>.jpg|png` where `key` hashes
//! path + file size + mtime + thumbnail size, so edited files get new thumbnails.
//!
//! Cache hit = one `stat` of the source + one small read of the cached file header.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use rayon::prelude::*;
use serde::Serialize;

use super::decode;

pub fn thumb_dir(cache_root: &Path) -> PathBuf {
    cache_root.join("thumbs")
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThumbResult {
    /// Cached thumbnail file (JPEG, or PNG when the image has transparency)
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// True when served from the disk cache
    pub cached: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThumbBatchSummary {
    pub total: usize,
    pub cached: usize,
    pub generated: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

fn cache_base(dir: &Path, src: &Path, meta: &std::fs::Metadata, size: u32) -> PathBuf {
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let key = super::fnv1a(format!("{}|{}|{}|{}", src.to_string_lossy(), meta.len(), mtime_ns, size).as_bytes());
    dir.join(format!("{:02x}", key >> 56)).join(format!("{key:016x}"))
}

fn clamp_size(size: u32) -> u32 {
    size.clamp(16, 2048)
}

/// Cache lookup only (no decoding).
pub fn lookup(dir: &Path, src: &Path, size: u32) -> Option<ThumbResult> {
    let meta = std::fs::metadata(src).ok()?;
    let base = cache_base(dir, src, &meta, clamp_size(size));
    ["jpg", "png"].into_iter().find_map(|ext| {
        let p = base.with_extension(ext);
        let (width, height) = decode::cached_dims(&p)?;
        Some(ThumbResult { path: p.to_string_lossy().into_owned(), width, height, cached: true })
    })
}

/// Returns the cached thumbnail or generates it.
pub fn thumb(dir: &Path, src: &Path, size: u32) -> Result<ThumbResult, String> {
    let size = clamp_size(size);
    let meta = std::fs::metadata(src).map_err(|e| format!("Dosya okunamadı: {e}"))?;
    if !meta.is_file() {
        return Err("Dosya bulunamadı".into());
    }
    let base = cache_base(dir, src, &meta, size);
    for ext in ["jpg", "png"] {
        let p = base.with_extension(ext);
        if let Some((width, height)) = decode::cached_dims(&p) {
            return Ok(ThumbResult { path: p.to_string_lossy().into_owned(), width, height, cached: true });
        }
    }
    let decoded = decode::decode(src, Some(size))?;
    let img = decode::resize_to_fit(decoded.image, size)?;
    let (bytes, ext) = decode::encode_display(&img, 85, None)?;
    let out = base.with_extension(ext);
    super::write_atomic(&out, &bytes)?;
    Ok(ThumbResult { path: out.to_string_lossy().into_owned(), width: img.width(), height: img.height(), cached: false })
}

/// Generates thumbnails for `paths` on all cores. Cache hits are reported first (cheap),
/// then misses are generated; `on_each(index, result)` is called from worker threads.
pub fn thumbs_parallel(
    dir: &Path,
    paths: &[String],
    size: u32,
    cancelled: &(dyn Fn() -> bool + Sync),
    on_each: &(dyn Fn(usize, &Result<ThumbResult, String>) + Sync),
) -> ThumbBatchSummary {
    let started = Instant::now();
    let (cached, generated, failed) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
    let stop = AtomicBool::new(false);

    let misses: Vec<usize> = paths
        .par_iter()
        .enumerate()
        .filter_map(|(i, p)| match lookup(dir, Path::new(p), size) {
            Some(t) => {
                cached.fetch_add(1, Ordering::Relaxed);
                on_each(i, &Ok(t));
                None
            }
            None => Some(i),
        })
        .collect();

    misses.par_iter().for_each(|&i| {
        if stop.load(Ordering::Relaxed) || cancelled() {
            stop.store(true, Ordering::Relaxed);
            return;
        }
        let r = thumb(dir, Path::new(&paths[i]), size);
        match &r {
            Ok(t) if t.cached => cached.fetch_add(1, Ordering::Relaxed),
            Ok(_) => generated.fetch_add(1, Ordering::Relaxed),
            Err(_) => failed.fetch_add(1, Ordering::Relaxed),
        };
        on_each(i, &r);
    });

    ThumbBatchSummary {
        total: paths.len(),
        cached: cached.into_inner(),
        generated: generated.into_inner(),
        failed: failed.into_inner(),
        cancelled: stop.into_inner(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

/// Deletes cached files not modified for `max_age` (called in the background at startup).
pub fn prune(dir: &Path, max_age: std::time::Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            removed += prune(&path, max_age);
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > max_age);
        let tmp = path.extension().is_some_and(|e| e == "tmp");
        if (stale || tmp) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::photo::exif::tests::write_exif_jpeg;
    use crate::photo::testutil::*;
    use std::sync::Mutex;

    #[test]
    fn photo_thumb_cache_hit_miss_and_invalidation() {
        let dir = temp_dir("thumbs");
        let cache = dir.join("cache");
        let src = dir.join("a.jpg");
        write_exif_jpeg(&src, 1200, 800, 6);

        let t1 = thumb(&cache, &src, 256).unwrap();
        assert!(!t1.cached);
        // Orientation 6 applied: portrait thumbnail, longest side 256
        assert_eq!((t1.width, t1.height), (171, 256));
        let img = image::open(&t1.path).unwrap().to_rgb8();
        assert_eq!(quadrant(*img.get_pixel(5, 5)), "blue");

        let t2 = thumb(&cache, &src, 256).unwrap();
        assert!(t2.cached);
        assert_eq!((t2.path.as_str(), t2.width, t2.height), (t1.path.as_str(), 171, 256));
        assert_eq!(lookup(&cache, &src, 256), Some(t2.clone()));
        // Different size = different entry
        assert!(lookup(&cache, &src, 128).is_none());

        // Changing the file invalidates the entry
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_exif_jpeg(&src, 1000, 800, 1);
        assert!(lookup(&cache, &src, 256).is_none());
        let t3 = thumb(&cache, &src, 256).unwrap();
        assert!(!t3.cached);
        assert_eq!((t3.width, t3.height), (256, 205));
    }

    #[test]
    fn photo_thumb_png_alpha_and_small_images() {
        let dir = temp_dir("thumbs_alpha");
        let cache = dir.join("cache");
        let src = dir.join("alpha.png");
        let img = image::RgbaImage::from_fn(600, 300, |x, _| image::Rgba([200, 10, 10, if x < 300 { 0 } else { 255 }]));
        img.save(&src).unwrap();
        let t = thumb(&cache, &src, 256).unwrap();
        assert!(t.path.ends_with(".png"));
        assert_eq!((t.width, t.height), (256, 128));
        // Images smaller than the thumbnail size are not upscaled
        let small = dir.join("small.png");
        pattern(40, 30).save(&small).unwrap();
        let t = thumb(&cache, &small, 256).unwrap();
        assert!(t.path.ends_with(".jpg"));
        assert_eq!((t.width, t.height), (40, 30));
    }

    #[test]
    fn photo_thumbs_parallel_reports_every_item() {
        let dir = temp_dir("thumbs_par");
        let cache = dir.join("cache");
        let mut paths = Vec::new();
        for i in 0..12 {
            let p = dir.join(format!("{i}.jpg"));
            std::fs::write(&p, jpeg_bytes(&pattern(400 + i, 300), 80)).unwrap();
            paths.push(p.to_string_lossy().into_owned());
        }
        paths.push(dir.join("missing.jpg").to_string_lossy().into_owned());
        let seen = Mutex::new(Vec::new());
        let s = thumbs_parallel(&cache, &paths, 128, &|| false, &|i, r| seen.lock().unwrap().push((i, r.is_ok())));
        assert_eq!((s.total, s.generated, s.failed, s.cached), (13, 12, 1, 0));
        let mut seen = seen.into_inner().unwrap();
        seen.sort();
        assert_eq!(seen.len(), 13);
        assert!(!seen[12].1);
        let s = thumbs_parallel(&cache, &paths, 128, &|| false, &|_, _| {});
        assert_eq!((s.cached, s.generated), (12, 0));
        // Cancelled before starting: nothing generated
        let s = thumbs_parallel(&cache, &paths, 64, &|| true, &|_, _| {});
        assert!(s.cancelled);
        assert_eq!(s.generated, 0);
    }

    /// Benchmark: 500 generated 12 MP JPEGs, cold vs warm cache.
    /// `cargo test --release --lib photo_thumb_bench -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn photo_thumb_bench_500_12mp() {
        let dir = std::env::var("VHO_BENCH_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("vho_photo_bench"));
        let src_dir = dir.join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let n = 500;
        let t = Instant::now();
        // 8 distinct 4000x3000 photos-like images (gradients + detail), copied to 500 files
        let variants: Vec<Vec<u8>> = (0..8u32)
            .into_par_iter()
            .map(|v| {
                let img = image::RgbImage::from_fn(4000, 3000, |x, y| {
                    let n = (x.wrapping_mul(2654435761) ^ y.wrapping_mul(40503) ^ v.wrapping_mul(97)) >> 28;
                    image::Rgb([
                        ((x / 16 + v * 30) % 256) as u8,
                        ((y / 12) % 256) as u8,
                        (((x + y) / 24) % 256) as u8 ^ (n as u8 * 3),
                    ])
                });
                jpeg_bytes(&img, 90)
            })
            .collect();
        let paths: Vec<String> = (0..n)
            .into_par_iter()
            .map(|i| {
                let p = src_dir.join(format!("IMG_{i:04}.jpg"));
                if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) != variants[i % 8].len() as u64 {
                    std::fs::write(&p, &variants[i % 8]).unwrap();
                }
                p.to_string_lossy().into_owned()
            })
            .collect();
        let total_mb: f64 = paths.iter().map(|p| std::fs::metadata(p).unwrap().len() as f64).sum::<f64>() / 1e6;
        println!("fixtures: {n} x 4000x3000 JPEG ({total_mb:.0} MB) in {:?}", t.elapsed());

        let cache = dir.join("cache");
        let _ = std::fs::remove_dir_all(&cache);
        let cold = thumbs_parallel(&cache, &paths, 256, &|| false, &|_, _| {});
        let warm = thumbs_parallel(&cache, &paths, 256, &|| false, &|_, _| {});
        println!(
            "cold: {} ms ({:.1} ms/img, {:.0} img/s, generated {}), threads {}",
            cold.elapsed_ms,
            cold.elapsed_ms as f64 / n as f64,
            n as f64 / (cold.elapsed_ms as f64 / 1000.0),
            cold.generated,
            rayon::current_num_threads()
        );
        println!(
            "warm: {} ms ({:.3} ms/img, cached {})",
            warm.elapsed_ms,
            warm.elapsed_ms as f64 / n as f64,
            warm.cached
        );
        // Single-threaded per-image cost, scaled DCT decode vs full decode
        let one = Path::new(&paths[0]);
        let bytes = std::fs::read(one).unwrap();
        let t = Instant::now();
        for _ in 0..5 {
            let img = decode::jpeg_scaled(&bytes, 256).unwrap();
            decode::resize_to_fit(img, 256).unwrap();
        }
        let scaled = t.elapsed() / 5;
        let t = Instant::now();
        for _ in 0..5 {
            let img = image::load_from_memory(&bytes).unwrap();
            decode::resize_to_fit(img, 256).unwrap();
        }
        let full = t.elapsed() / 5;
        println!("single image: DCT-scaled decode+resize {scaled:?} vs full decode+resize {full:?}");
        assert_eq!(cold.generated, n);
        assert_eq!(warm.cached, n);
    }
}
