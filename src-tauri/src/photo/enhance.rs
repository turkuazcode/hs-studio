//! Faithful photo enhancement (A05, user decision 2026-10-28): classical, non-generative.
//! No model invents faces or texture; every step only redistributes the photo's own signal.
//!
//! Chain (prototype: the A05 trial, `enhance.py`):
//! 1. light clean-up: luma guided filter (self-guided, small radius) + chroma guided by luma
//!    (colour noise of old JPEGs goes, edges stay);
//! 2. shadow lift: Multi-Scale Retinex illumination estimated on a small copy (long side 512,
//!    sigmas 15/80/250 scaled), brought back to full size and edge-aligned with a guided filter;
//!    gain = illum^-shadow (≤ 2.2), mixed `(1-shadow)·Y + shadow·clip(Y·gain)`;
//! 3. upscale: Lanczos3 on all channels (alpha too);
//! 4. halo-free sharpening: guided-filter base/detail split, `detail = tanh(detail·k·8)/8`
//!    (strong edges are soft-limited instead of overshooting);
//! 5. optional film grain (off by default; fixed seed: the same photo gives the same result).
//!
//! Works on Y'CbCr (BT.601, full range) of the encoded values: a grey photo stays exactly grey.
//! Pixels stay in the source's colour space (the caller keeps its ICC profile).

use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, Rgba32FImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// User settings (the panel's sliders map onto these; see `src/media/photo-enhance.js`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EnhanceParams {
    /// 1 | 2 | 4
    pub scale: u32,
    /// 0 = off .. 0.6
    pub shadow: f32,
    /// 1 = unchanged, > 1 sharper (default 1.6)
    pub sharpness: f32,
    /// 0 = off, 1 = light (default)
    pub denoise: f32,
    /// film grain (off by default)
    pub grain: bool,
}

impl Default for EnhanceParams {
    fn default() -> Self {
        EnhanceParams { scale: 2, shadow: 0.2, sharpness: 1.6, denoise: 1.0, grain: false }
    }
}

impl EnhanceParams {
    pub fn validated(self) -> Result<Self, String> {
        if ![1, 2, 4].contains(&self.scale) {
            return Err(format!("scale must be 1, 2 or 4 (got {})", self.scale));
        }
        let ok = |v: f32, lo: f32, hi: f32| v.is_finite() && (lo..=hi).contains(&v);
        if !ok(self.shadow, 0.0, 0.6) || !ok(self.sharpness, 0.5, 3.0) || !ok(self.denoise, 0.0, 2.0) {
            return Err("enhance parameters out of range".into());
        }
        Ok(self)
    }
}

/// Planes of one image (row-major, `w*h` each).
struct Planes {
    w: usize,
    h: usize,
    y: Vec<f32>,
    cb: Vec<f32>,
    cr: Vec<f32>,
    a: Vec<f32>,
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/// Mean over a (2r+1)² window, borders by clamping the window (O(1) per pixel, two passes).
pub fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0f32; w * h];
    // horizontal: running sum per row
    tmp.par_chunks_mut(w).zip(src.par_chunks(w)).for_each(|(out, row)| {
        let mut prefix = vec![0f64; w + 1];
        for x in 0..w {
            prefix[x + 1] = prefix[x] + row[x] as f64;
        }
        for x in 0..w {
            let lo = x.saturating_sub(r);
            let hi = (x + r + 1).min(w);
            out[x] = ((prefix[hi] - prefix[lo]) / (hi - lo) as f64) as f32;
        }
    });
    // vertical: per column via prefix sums over rows (columns processed in parallel blocks)
    let mut out = vec![0f32; w * h];
    let cols: Vec<usize> = (0..w).collect();
    let results: Vec<(usize, Vec<f32>)> = cols
        .par_chunks(64)
        .flat_map_iter(|chunk| {
            chunk.iter().map(|&x| {
                let mut prefix = vec![0f64; h + 1];
                for y in 0..h {
                    prefix[y + 1] = prefix[y] + tmp[y * w + x] as f64;
                }
                let col: Vec<f32> = (0..h)
                    .map(|y| {
                        let lo = y.saturating_sub(r);
                        let hi = (y + r + 1).min(h);
                        ((prefix[hi] - prefix[lo]) / (hi - lo) as f64) as f32
                    })
                    .collect();
                (x, col)
            })
        })
        .collect();
    for (x, col) in results {
        for (y, v) in col.into_iter().enumerate() {
            out[y * w + x] = v;
        }
    }
    out
}

/// He et al. guided filter: output follows the edges of `guide` while smoothing `p`.
pub fn guided(guide: &[f32], p: &[f32], w: usize, h: usize, r: usize, eps: f32) -> Vec<f32> {
    let mul = |a: &[f32], b: &[f32]| a.par_iter().zip(b).map(|(x, y)| x * y).collect::<Vec<f32>>();
    let m_i = box_mean(guide, w, h, r);
    let m_p = box_mean(p, w, h, r);
    let m_ip = box_mean(&mul(guide, p), w, h, r);
    let m_ii = box_mean(&mul(guide, guide), w, h, r);
    let (a, b): (Vec<f32>, Vec<f32>) = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let cov = m_ip[i] - m_i[i] * m_p[i];
            let var = m_ii[i] - m_i[i] * m_i[i];
            let a = cov / (var + eps);
            (a, m_p[i] - a * m_i[i])
        })
        .unzip();
    let m_a = box_mean(&a, w, h, r);
    let m_b = box_mean(&b, w, h, r);
    (0..w * h).into_par_iter().map(|i| m_a[i] * guide[i] + m_b[i]).collect()
}

/// Separable Gaussian blur, borders clamped.
fn gaussian(src: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let sigma = sigma.max(0.5);
    let r = (sigma * 3.0).ceil() as isize;
    let k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    let k: Vec<f32> = k.iter().map(|v| v / sum).collect();
    let mut tmp = vec![0f32; w * h];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut acc = 0f32;
            for (j, kv) in k.iter().enumerate() {
                let xx = (x as isize + j as isize - r).clamp(0, w as isize - 1) as usize;
                acc += kv * src[y * w + xx];
            }
            row[x] = acc;
        }
    });
    let mut out = vec![0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let mut acc = 0f32;
            for (j, kv) in k.iter().enumerate() {
                let yy = (y as isize + j as isize - r).clamp(0, h as isize - 1) as usize;
                acc += kv * tmp[yy * w + x];
            }
            row[x] = acc;
        }
    });
    out
}

/// Resizes planes packed as Rgba32F (Lanczos3).
fn resize_rgba32f(img: &Rgba32FImage, nw: u32, nh: u32) -> Result<Rgba32FImage, String> {
    if (img.width(), img.height()) == (nw, nh) {
        return Ok(img.clone());
    }
    let src = DynamicImage::ImageRgba32F(img.clone());
    let mut dst = DynamicImage::ImageRgba32F(Rgba32FImage::new(nw, nh));
    Resizer::new()
        .resize(&src, &mut dst, &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)))
        .map_err(|e| format!("Yeniden boyutlandırılamadı: {e}"))?;
    Ok(dst.into_rgba32f())
}

fn pack(p: &Planes) -> Rgba32FImage {
    let mut img = Rgba32FImage::new(p.w as u32, p.h as u32);
    img.as_mut().par_chunks_mut(4).enumerate().for_each(|(i, px)| {
        px[0] = p.y[i];
        px[1] = p.cb[i];
        px[2] = p.cr[i];
        px[3] = p.a[i];
    });
    img
}

fn unpack(img: &Rgba32FImage) -> Planes {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let raw = img.as_raw();
    let ch = |c: usize| raw.par_chunks(4).map(|px| px[c]).collect::<Vec<f32>>();
    Planes { w, h, y: ch(0), cb: ch(1), cr: ch(2), a: ch(3) }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

fn to_planes(img: &Rgba32FImage) -> (Planes, bool) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let raw = img.as_raw();
    let grey = raw.par_chunks(4).all(|p| (p[0] - p[1]).abs() < 1.0 / 512.0 && (p[1] - p[2]).abs() < 1.0 / 512.0);
    let mut y = vec![0f32; w * h];
    let mut cb = vec![0f32; w * h];
    let mut cr = vec![0f32; w * h];
    let mut a = vec![0f32; w * h];
    y.par_iter_mut()
        .zip(cb.par_iter_mut())
        .zip(cr.par_iter_mut().zip(a.par_iter_mut()))
        .zip(raw.par_chunks(4))
        .for_each(|(((y, cb), (cr, a)), p)| {
            let (r, g, b) = (p[0], p[1], p[2]);
            *y = 0.299 * r + 0.587 * g + 0.114 * b;
            if !grey {
                *cb = -0.168_736 * r - 0.331_264 * g + 0.5 * b;
                *cr = 0.5 * r - 0.418_688 * g - 0.081_312 * b;
            }
            *a = p[3];
        });
    (Planes { w, h, y, cb, cr, a }, grey)
}

fn to_rgba(p: &Planes, grey: bool) -> Rgba32FImage {
    let mut img = Rgba32FImage::new(p.w as u32, p.h as u32);
    img.as_mut().par_chunks_mut(4).enumerate().for_each(|(i, px)| {
        let y = p.y[i];
        if grey {
            px[0] = y.clamp(0.0, 1.0);
            px[1] = px[0];
            px[2] = px[0];
        } else {
            let (cb, cr) = (p.cb[i], p.cr[i]);
            px[0] = (y + 1.402 * cr).clamp(0.0, 1.0);
            px[1] = (y - 0.344_136 * cb - 0.714_136 * cr).clamp(0.0, 1.0);
            px[2] = (y + 1.772 * cb).clamp(0.0, 1.0);
        }
        px[3] = p.a[i].clamp(0.0, 1.0);
    });
    img
}

/// Retinex illumination of `y` (0..1), computed on a copy whose long side is `work` px.
fn retinex_illumination(y: &[f32], w: usize, h: usize, work: usize) -> Result<Vec<f32>, String> {
    let s = (work as f32 / w.max(h) as f32).min(1.0);
    let (sw, sh) = (((w as f32 * s).round() as usize).max(1), ((h as f32 * s).round() as usize).max(1));
    let mut packed = Rgba32FImage::new(w as u32, h as u32);
    packed.as_mut().par_chunks_mut(4).zip(y.par_iter()).for_each(|(px, v)| {
        px[0] = *v;
        px[3] = 1.0;
    });
    let small_img = resize_rgba32f(&packed, sw as u32, sh as u32)?;
    let small: Vec<f32> = small_img.as_raw().par_chunks(4).map(|px| px[0].clamp(0.0, 1.0)).collect();
    let log_l: Vec<f32> = small.par_iter().map(|v| v.ln_1p()).collect();
    let mut r = vec![0f32; sw * sh];
    let sigmas = [15.0f32, 80.0, 250.0];
    for sg in sigmas {
        let blur = gaussian(&small, sw, sh, sg * s);
        r.par_iter_mut().zip(log_l.par_iter().zip(blur.par_iter())).for_each(|(acc, (l, b))| *acc += l - b.ln_1p());
    }
    let illum_small: Vec<f32> = small
        .par_iter()
        .zip(r.par_iter())
        .map(|(v, rr)| (v / (rr / sigmas.len() as f32).exp().max(1e-3)).clamp(1e-3, 1.0))
        .collect();
    let mut packed_small = Rgba32FImage::new(sw as u32, sh as u32);
    packed_small.as_mut().par_chunks_mut(4).zip(illum_small.par_iter()).for_each(|(px, v)| {
        px[0] = *v;
        px[3] = 1.0;
    });
    let big = resize_rgba32f(&packed_small, w as u32, h as u32)?;
    let illum: Vec<f32> = big.as_raw().par_chunks(4).map(|px| px[0]).collect();
    // follow the image's own edges: no halo where light meets dark
    Ok(guided(y, &illum, w, h, 8, 1e-3).into_par_iter().map(|v| v.clamp(1e-3, 1.0)).collect())
}

/// Min / max of each pixel's 3x3 neighbourhood (anti-ringing bounds for the upscale).
fn local_range(y: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (cx, cy) = (i % w, i / w);
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for yy in cy.saturating_sub(1)..(cy + 2).min(h) {
                for xx in cx.saturating_sub(1)..(cx + 2).min(w) {
                    let v = y[yy * w + xx];
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
            (lo, hi)
        })
        .unzip()
}

/// Small deterministic Gaussian noise (xorshift + Box-Muller).
fn add_grain(y: &mut [f32], sigma: f32) {
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        ((s >> 11) as f64 / (1u64 << 53) as f64).max(1e-12)
    };
    for v in y.iter_mut() {
        let (u1, u2) = (next(), next());
        let n = (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos();
        *v = (*v + n as f32 * sigma).clamp(0.0, 1.0);
    }
}

/// The whole chain. `progress(0..1)`; `cancelled()` is checked between steps (Err "cancelled").
pub fn enhance(img: &Rgba32FImage, params: EnhanceParams, cancelled: &dyn Fn() -> bool, progress: &dyn Fn(f64)) -> Result<Rgba32FImage, String> {
    let p = params.validated()?;
    let stop = || if cancelled() { Err(crate::photo::ERR_CANCELLED.to_string()) } else { Ok(()) };
    let (mut pl, grey) = to_planes(img);
    let (w, h) = (pl.w, pl.h);
    progress(0.05);

    // 1. clean-up
    if p.denoise > 0.0 {
        let k = p.denoise;
        pl.y = guided(&pl.y, &pl.y, w, h, 2, 2e-4 * k * k);
        if !grey {
            pl.cb = guided(&pl.y, &pl.cb, w, h, 4, 1e-3 * k);
            pl.cr = guided(&pl.y, &pl.cr, w, h, 4, 1e-3 * k);
        }
    }
    stop()?;
    progress(0.25);

    // 2. shadow lift
    if p.shadow > 0.0 {
        let illum = retinex_illumination(&pl.y, w, h, 512)?;
        let s = p.shadow;
        pl.y.par_iter_mut().zip(illum.par_iter()).for_each(|(y, il)| {
            let gain = il.powf(-s).min(2.2);
            *y = ((1.0 - s) * *y + s * (*y * gain).clamp(0.0, 1.0)).clamp(0.0, 1.0);
        });
    }
    stop()?;
    progress(0.5);

    // 3. upscale (Lanczos), luma clamped to the source's local 3x3 range: no ringing halo
    if p.scale > 1 {
        let (lo, hi) = local_range(&pl.y, w, h);
        let up = resize_rgba32f(&pack(&pl), (w as u32) * p.scale, (h as u32) * p.scale)?;
        pl = unpack(&up);
        let (nw, s) = (pl.w, p.scale as usize);
        pl.y.par_chunks_mut(nw).enumerate().for_each(|(oy, row)| {
            let sy = (oy / s).min(h - 1);
            for (ox, v) in row.iter_mut().enumerate() {
                let i = sy * w + (ox / s).min(w - 1);
                *v = v.clamp(lo[i], hi[i]);
            }
        });
    }
    stop()?;
    progress(0.7);

    // 4. halo-free detail
    if (p.sharpness - 1.0).abs() > 1e-3 {
        let (w, h) = (pl.w, pl.h);
        let base = guided(&pl.y, &pl.y, w, h, 3 * p.scale as usize, 4e-3);
        // a sharpened pixel stays within its 3x3 neighbourhood's range: texture gets crisper,
        // a clean edge cannot overshoot into a halo
        let (lo, hi) = local_range(&pl.y, w, h);
        let k = p.sharpness;
        pl.y.par_iter_mut().enumerate().for_each(|(i, y)| {
            let b = base[i];
            let d = *y - b;
            *y = (b + (d * k * 8.0).tanh() / 8.0).clamp(lo[i], hi[i]).clamp(0.0, 1.0);
        });
    }
    stop()?;
    progress(0.9);

    // 5. grain
    if p.grain {
        add_grain(&mut pl.y, 0.005);
    }
    let out = to_rgba(&pl, grey);
    progress(1.0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> bool {
        false
    }
    fn quiet(_: f64) {}

    fn img_from(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 4]) -> Rgba32FImage {
        Rgba32FImage::from_fn(w, h, |x, y| image::Rgba(f(x, y)))
    }

    /// Smooth natural-ish pattern (gradients + soft texture).
    fn pattern(w: u32, h: u32) -> Rgba32FImage {
        img_from(w, h, |x, y| {
            let fx = x as f32 / w as f32;
            let fy = y as f32 / h as f32;
            let t = ((x as f32 * 0.21).sin() * (y as f32 * 0.17).cos()) * 0.05;
            [(0.2 + 0.5 * fx + t).clamp(0.0, 1.0), (0.3 + 0.4 * fy - t).clamp(0.0, 1.0), (0.6 - 0.3 * fx + t).clamp(0.0, 1.0), 1.0]
        })
    }

    #[test]
    fn enhance_guided_filter_keeps_constant_and_follows_guide() {
        let (w, h) = (40, 30);
        let c = vec![0.42f32; w * h];
        let g = guided(&c, &c, w, h, 3, 1e-3);
        assert!(g.iter().all(|v| (v - 0.42).abs() < 1e-5));
        // self-guided with a tiny eps keeps a step edge (edge preserving)
        let step: Vec<f32> = (0..w * h).map(|i| if i % w < w / 2 { 0.2 } else { 0.8 }).collect();
        let g = guided(&step, &step, w, h, 4, 1e-6);
        let max_err = g.iter().zip(&step).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max_err < 0.01, "edge kept, max err {max_err}");
        // box mean of a ramp is the ramp inside the image
        let ramp: Vec<f32> = (0..w * h).map(|i| (i % w) as f32).collect();
        let m = box_mean(&ramp, w, h, 2);
        assert!((m[10 * w + 20] - 20.0).abs() < 1e-4);
    }

    #[test]
    fn enhance_neutral_parameters_are_identity() {
        let src = pattern(64, 48);
        let p = EnhanceParams { scale: 1, shadow: 0.0, sharpness: 1.0, denoise: 0.0, grain: false };
        let out = enhance(&src, p, &none, &quiet).unwrap();
        let max = src.as_raw().iter().zip(out.as_raw()).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(max < 1e-4, "identity, max diff {max}");
    }

    #[test]
    fn enhance_step_edge_has_no_halo() {
        // dark/bright step (like hair against sky), defaults + strong sharpening
        let src = img_from(96, 64, |x, _| if x < 48 { [0.2, 0.2, 0.2, 1.0] } else { [0.8, 0.8, 0.8, 1.0] });
        for sharp in [1.6f32, 2.5] {
            let p = EnhanceParams { scale: 2, shadow: 0.0, sharpness: sharp, denoise: 1.0, grain: false };
            let out = enhance(&src, p, &none, &quiet).unwrap();
            let (mn, mx) = out.as_raw().chunks(4).fold((1f32, 0f32), |(a, b), px| (a.min(px[0]), b.max(px[0])));
            // upscale is anti-ringed and the detail step soft-limited: no visible halo (< 2 %)
            assert!(mx <= 0.8 + 0.02 && mn >= 0.2 - 0.02, "sharp {sharp}: range {mn}..{mx}");
        }
    }

    #[test]
    fn enhance_grey_stays_grey_and_size_scales() {
        let src = img_from(50, 40, |x, y| {
            let v = ((x + y) % 17) as f32 / 17.0;
            [v, v, v, 1.0]
        });
        for scale in [1u32, 2, 4] {
            let p = EnhanceParams { scale, shadow: 0.3, ..EnhanceParams::default() };
            let out = enhance(&src, p, &none, &quiet).unwrap();
            assert_eq!((out.width(), out.height()), (50 * scale, 40 * scale));
            assert!(out.as_raw().chunks(4).all(|px| px[0] == px[1] && px[1] == px[2]), "grey kept at scale {scale}");
        }
    }

    #[test]
    fn enhance_keeps_alpha_and_lifts_shadows() {
        let src = img_from(64, 64, |x, _| {
            let a = if x < 32 { 0.0 } else { 1.0 };
            [0.08, 0.06, 0.05, a]
        });
        let out = enhance(&src, EnhanceParams { scale: 1, ..EnhanceParams::default() }, &none, &quiet).unwrap();
        assert_eq!(out.get_pixel(5, 5).0[3], 0.0);
        assert_eq!(out.get_pixel(60, 5).0[3], 1.0);
        let lum = |p: [f32; 4]| 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
        assert!(lum(out.get_pixel(60, 30).0) > lum(src.get_pixel(60, 30).0), "dark area lifted");
    }

    #[test]
    fn enhance_rejects_bad_params_and_cancels() {
        assert!(EnhanceParams { scale: 3, ..EnhanceParams::default() }.validated().is_err());
        assert!(EnhanceParams { shadow: f32::NAN, ..EnhanceParams::default() }.validated().is_err());
        let r = enhance(&pattern(32, 32), EnhanceParams::default(), &|| true, &quiet);
        assert!(r.unwrap_err().starts_with(crate::photo::ERR_CANCELLED));
    }

    /// Manual comparison tool (never in CI): VHO_ENHANCE_IN=<photo> VHO_ENHANCE_OUT=<png>
    /// `cargo test --release --lib enhance_file_tool -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn enhance_file_tool() {
        let (Ok(inp), Ok(out)) = (std::env::var("VHO_ENHANCE_IN"), std::env::var("VHO_ENHANCE_OUT")) else { return };
        let d = crate::photo::decode::decode(std::path::Path::new(&inp), None).unwrap();
        let t = std::time::Instant::now();
        let r = enhance(&d.image.to_rgba32f(), EnhanceParams::default(), &none, &quiet).unwrap();
        eprintln!("{inp}: {}x{} in {:.2}s", r.width(), r.height(), t.elapsed().as_secs_f64());
        DynamicImage::ImageRgba32F(r).to_rgb8().save(&out).unwrap();
    }

    /// Timing on a 3 MP photo (release: `cargo test --release --lib enhance_perf -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn enhance_perf_3mp_2x() {
        let src = pattern(2048, 1536);
        let t = std::time::Instant::now();
        let out = enhance(&src, EnhanceParams::default(), &none, &quiet).unwrap();
        eprintln!("enhance 2048x1536 -> {}x{} in {:.2}s", out.width(), out.height(), t.elapsed().as_secs_f64());
    }
}
