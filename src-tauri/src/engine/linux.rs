//! Linux video surface (ADR 0002, path B): mpv's render API draws into a `GtkGLArea` that sits
//! UNDER the transparent WebKitGTK webview inside a `GtkOverlay` of the Tauri window. One GTK
//! window, composited by GTK itself, so it works the same on Wayland and X11 (no foreign-window
//! embedding: the LGPL libmpv has no X11 backend and Wayland has no `wid` at all).
//!
//! Ownership and threads:
//! - The GL context belongs to the `GtkGLArea` (GDK: EGL on Wayland, GLX or EGL on X11). The mpv
//!   render context is created in `realize`, used in `render` and freed in `unrealize` /
//!   `shutdown`, always on the GTK main thread with that context current.
//! - mpv's update callback runs on an mpv thread: it only posts `queue_render` to the GTK main
//!   context (`MainContext::invoke`), it never calls mpv or GL.
//! - The core (`Arc<Mpv>`) is held by the render context, so `mpv_terminate_destroy` can never
//!   run before `mpv_render_context_free`.

use std::cell::RefCell;
use std::ffi::{CString, c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use gtk::prelude::*;
use serde_json::{Value, json};

use super::mpv::Mpv;
use super::mpv::render::RenderContext;

thread_local! {
    static AREA: RefCell<Option<gtk::GLArea>> = const { RefCell::new(None) };
    static RENDER: RefCell<Option<RenderContext>> = const { RefCell::new(None) };
}

/// Frames drawn by mpv into the GL area (diagnostics / smoke test).
pub static FRAMES: AtomicU64 = AtomicU64::new(0);
static WANT_VISIBLE: AtomicBool = AtomicBool::new(false);
/// An mpv frame was drawn since the last paint: report the swap after GTK presents it.
static DRAWN: AtomicBool = AtomicBool::new(false);
/// Smoke test: read back the centre pixel after the next render.
static PROBE: AtomicBool = AtomicBool::new(false);
static PIXEL: Mutex<Option<[u8; 4]>> = Mutex::new(None);
static INFO: Mutex<Option<Value>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// GL entry points (EGL or GLX, decided by the GDK backend)
// ---------------------------------------------------------------------------

type ProcFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;

struct Gl {
    proc_address: ProcFn,
    kind: &'static str,
    get_integerv: unsafe extern "C" fn(u32, *mut c_int),
    bind_framebuffer: unsafe extern "C" fn(u32, u32),
    read_pixels: unsafe extern "C" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void),
    _lib: libloading::Library,
}
unsafe impl Send for Gl {}
unsafe impl Sync for Gl {}

static GL: OnceLock<Result<Gl, String>> = OnceLock::new();

const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;

fn load_gl(wayland: bool) -> Result<Gl, String> {
    // Wayland: GDK always uses EGL. X11: GTK 3 uses GLX unless GDK_GL=gles / EGL is forced;
    // glXGetProcAddressARB resolves both core and extension functions for the GLX context.
    let order: &[(&str, &str, &str)] = if wayland {
        &[("libEGL.so.1", "eglGetProcAddress", "egl")]
    } else {
        &[("libGL.so.1", "glXGetProcAddressARB", "glx"), ("libEGL.so.1", "eglGetProcAddress", "egl")]
    };
    let mut errors = vec![];
    for (lib, sym, kind) in order {
        let r = unsafe {
            libloading::Library::new(lib).and_then(|l| {
                let f: ProcFn = *l.get::<ProcFn>(format!("{sym}\0").as_bytes())?;
                Ok((l, f))
            })
        };
        match r {
            Ok((l, f)) => {
                let get = |name: &str| -> Result<*mut c_void, String> {
                    let c = CString::new(name).unwrap();
                    let p = unsafe { f(c.as_ptr()) };
                    if p.is_null() { Err(format!("{name} not found via {sym}")) } else { Ok(p) }
                };
                let gi = get("glGetIntegerv")?;
                let bf = get("glBindFramebuffer")?;
                let rp = get("glReadPixels")?;
                return Ok(Gl {
                    proc_address: f,
                    kind,
                    get_integerv: unsafe { std::mem::transmute::<*mut c_void, unsafe extern "C" fn(u32, *mut c_int)>(gi) },
                    bind_framebuffer: unsafe { std::mem::transmute::<*mut c_void, unsafe extern "C" fn(u32, u32)>(bf) },
                    read_pixels: unsafe {
                        std::mem::transmute::<*mut c_void, unsafe extern "C" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void)>(rp)
                    },
                    _lib: l,
                });
            }
            Err(e) => errors.push(format!("{lib}: {e}")),
        }
    }
    Err(errors.join("; "))
}

unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    match GL.get() {
        Some(Ok(gl)) => unsafe { (gl.proc_address)(name) },
        _ => std::ptr::null_mut(),
    }
}

unsafe extern "C" fn on_update(_data: *mut c_void) {
    // mpv thread: only schedule a redraw on the GTK main thread
    gtk::glib::MainContext::default().invoke(|| {
        AREA.with(|a| {
            if let Some(a) = a.borrow().as_ref() {
                a.queue_render();
            }
        })
    });
}

fn gdk_backend() -> &'static str {
    let name = gtk::gdk::Display::default().map(|d| d.type_().name().to_string()).unwrap_or_default();
    if name.contains("Wayland") {
        "wayland"
    } else if name.contains("X11") {
        "x11"
    } else {
        "unknown"
    }
}

// ---------------------------------------------------------------------------
// Attaching the surface to the Tauri window (GTK main thread)
// ---------------------------------------------------------------------------

/// Inserts the GL area under the webview. Must run on the GTK main thread (Tauri `setup`).
pub fn attach<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, mpv: Arc<Mpv>) -> Result<(), String> {
    let vbox = win.default_vbox().map_err(|e| format!("default_vbox: {e}"))?;
    let children = vbox.children();
    if children.is_empty() {
        return Err("Tauri window has no webview widget".into());
    }
    let overlay = gtk::Overlay::new();
    let area = gtk::GLArea::new();
    area.set_auto_render(false);
    area.set_has_alpha(false);
    area.set_hexpand(true);
    area.set_vexpand(true);
    for child in &children {
        vbox.remove(child);
    }
    overlay.add(&area);
    for child in &children {
        overlay.add_overlay(child);
    }
    vbox.pack_start(&overlay, true, true, 0);
    let backend = gdk_backend();

    let core = Arc::clone(&mpv);
    area.connect_realize(move |a| {
        a.make_current();
        if let Some(e) = a.error() {
            set_info(json!({"error": format!("GL context: {e}"), "gdkBackend": backend}));
            return;
        }
        let gl = GL.get_or_init(|| load_gl(backend == "wayland"));
        let gl_kind = match gl {
            Ok(g) => g.kind,
            Err(e) => {
                set_info(json!({"error": format!("GL loader: {e}"), "gdkBackend": backend}));
                return;
            }
        };
        let uses_es = a.context().map(|c| c.uses_es()).unwrap_or(false);
        match core.create_render_context(get_proc_address) {
            Ok(rc) => {
                rc.set_update_callback(on_update, std::ptr::null_mut());
                RENDER.with(|r| *r.borrow_mut() = Some(rc));
                // GTK swaps the window buffers itself; tell mpv when a frame it drew was presented
                // (frame timing / display sync)
                if let Some(clock) = a.frame_clock() {
                    clock.connect_after_paint(|_| {
                        if DRAWN.swap(false, Ordering::Relaxed) {
                            RENDER.with(|r| {
                                if let Some(rc) = r.borrow().as_ref() {
                                    rc.report_swap();
                                }
                            });
                        }
                    });
                }
                set_info(json!({"gdkBackend": backend, "gl": gl_kind, "gles": uses_es, "error": null}));
            }
            Err(e) => set_info(json!({"error": format!("mpv_render_context_create: {e}"), "gdkBackend": backend, "gl": gl_kind})),
        }
    });
    area.connect_unrealize(|a| {
        a.make_current();
        RENDER.with(|r| r.borrow_mut().take());
    });
    area.connect_render(|a, _ctx| {
        RENDER.with(|r| {
            let r = r.borrow();
            let (Some(rc), Some(Ok(gl))) = (r.as_ref(), GL.get()) else { return };
            let scale = a.scale_factor().max(1);
            let (w, h) = (a.allocated_width() * scale, a.allocated_height() * scale);
            let mut fbo: c_int = 0;
            unsafe { (gl.get_integerv)(GL_DRAW_FRAMEBUFFER_BINDING, &mut fbo) };
            if rc.render(fbo, w, h, true).is_ok() {
                FRAMES.fetch_add(1, Ordering::Relaxed);
                DRAWN.store(true, Ordering::Relaxed);
                if PROBE.swap(false, Ordering::Relaxed) {
                    // mpv leaves its own read binding behind: read from GtkGLArea's FBO explicitly
                    let mut px = [0u8; 4];
                    unsafe {
                        (gl.bind_framebuffer)(GL_READ_FRAMEBUFFER, fbo as u32);
                        (gl.read_pixels)(w / 2, h / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px.as_mut_ptr() as *mut c_void);
                    }
                    *PIXEL.lock().unwrap() = Some(px);
                }
            }
        });
        gtk::glib::Propagation::Stop
    });
    area.connect_size_allocate(|a, _| a.queue_render());
    overlay.show_all();
    area.set_visible(WANT_VISIBLE.load(Ordering::Relaxed));
    AREA.with(|a| *a.borrow_mut() = Some(area));
    Ok(())
}

fn set_info(v: Value) {
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        eprintln!("[VHO] linux video surface: {e}");
    }
    *INFO.lock().unwrap() = Some(v);
}

/// Surface diagnostics for `engine_status` (GDK backend, GL API, render context errors).
pub fn info() -> Value {
    let mut v = INFO.lock().unwrap().clone().unwrap_or_else(|| json!({"error": "GL area not realized yet"}));
    v["surface"] = json!("gtk-glarea-render-api");
    v["frames"] = json!(FRAMES.load(Ordering::Relaxed));
    v
}

pub fn render_ready() -> bool {
    RENDER.with(|r| r.borrow().is_some())
}

/// Smoke test: centre pixel of the next rendered frame (main thread schedules a redraw).
pub fn request_pixel_probe() {
    *PIXEL.lock().unwrap() = None;
    PROBE.store(true, Ordering::Relaxed);
}
pub fn probed_pixel() -> Option<[u8; 4]> {
    *PIXEL.lock().unwrap()
}

/// Smoke test (main thread): centre pixel of the GL area as the user sees it, read back from the
/// window GTK composited (video + the transparent webview above it). Proves the webview does not
/// cover the video, which the FBO read-back alone cannot show.
pub fn composited_centre_pixel() -> Option<[u8; 3]> {
    use gtk::gdk::prelude::WindowExtManual;
    AREA.with(|a| {
        let a = a.borrow();
        let area = a.as_ref()?;
        let top = area.toplevel()?;
        let (x, y) = area.translate_coordinates(&top, area.allocated_width() / 2, area.allocated_height() / 2)?;
        let pb = top.window()?.pixbuf(x, y, 1, 1)?;
        let bytes = pb.read_pixel_bytes();
        (bytes.len() >= 3).then(|| [bytes[0], bytes[1], bytes[2]])
    })
}

/// Shows / hides the video under the webview (main thread).
pub fn set_visible(on: bool) {
    WANT_VISIBLE.store(on, Ordering::Relaxed);
    AREA.with(|a| {
        if let Some(a) = a.borrow().as_ref() {
            a.set_visible(on);
            if on {
                a.queue_render();
            }
        }
    });
}

pub fn is_visible() -> bool {
    AREA.with(|a| a.borrow().as_ref().map(|a| a.is_visible()).unwrap_or(false))
}

pub fn geometry() -> ([i32; 4], [i32; 4], bool) {
    AREA.with(|a| match a.borrow().as_ref() {
        Some(a) => {
            let r = [0, 0, a.allocated_width(), a.allocated_height()];
            (r, r, a.is_visible())
        }
        None => ([0; 4], [0; 4], false),
    })
}

/// Engine shutdown (main thread): free the render context with its GL context current, before
/// the core goes away.
pub fn shutdown() {
    AREA.with(|a| {
        if let Some(a) = a.borrow().as_ref() {
            a.make_current();
        }
    });
    RENDER.with(|r| r.borrow_mut().take());
}

/// Schedules a redraw (any thread).
pub fn queue_render() {
    unsafe { on_update(std::ptr::null_mut()) }
}
