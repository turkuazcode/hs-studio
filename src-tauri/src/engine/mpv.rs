//! Thin, hand-written libmpv client-API binding (MIT, part of VHO; from experiments/mpv-spike).
//!
//! * libmpv is loaded at **runtime** with `libloading` (dynamic linking, LGPL-friendly, and the app
//!   can fall back to the HTML5 engine when the DLL is missing).
//! * Only the ~15 functions VHO needs are bound. Every value crossing the boundary is converted
//!   through `mpv_node` <-> `serde_json::Value`, so the frontend gets plain JSON.
//! * The event loop runs on its own thread (`spawn_event_loop`) and hands each event, already
//!   converted to JSON via `mpv_event_to_node`, to a callback (the Tauri app emits it).

use std::ffi::{CStr, CString, c_char, c_double, c_int, c_ulong, c_void};
use std::path::Path;
use std::sync::Arc;

use libloading::Library;
use serde_json::{Map, Value};

pub const FORMAT_NONE: c_int = 0;
pub const FORMAT_STRING: c_int = 1;
pub const FORMAT_FLAG: c_int = 3;
pub const FORMAT_INT64: c_int = 4;
pub const FORMAT_DOUBLE: c_int = 5;
pub const FORMAT_NODE: c_int = 6;
pub const FORMAT_NODE_ARRAY: c_int = 7;
pub const FORMAT_NODE_MAP: c_int = 8;
pub const FORMAT_BYTE_ARRAY: c_int = 9;

pub const EVENT_NONE: c_int = 0;
pub const EVENT_SHUTDOWN: c_int = 1;

#[repr(C)]
#[derive(Clone, Copy)]
union NodeU {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double: c_double,
    list: *mut NodeList,
    ba: *mut ByteArray,
}

#[repr(C)]
struct Node {
    u: NodeU,
    format: c_int,
}

#[repr(C)]
struct NodeList {
    num: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}

#[repr(C)]
struct ByteArray {
    data: *mut c_void,
    size: usize,
}

#[repr(C)]
pub struct Event {
    pub event_id: c_int,
    pub error: c_int,
    pub reply_userdata: u64,
    pub data: *mut c_void,
}

type Handle = c_void;

#[allow(non_snake_case)]
struct Api {
    client_api_version: unsafe extern "C" fn() -> c_ulong,
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    free: unsafe extern "C" fn(*mut c_void),
    create: unsafe extern "C" fn() -> *mut Handle,
    initialize: unsafe extern "C" fn(*mut Handle) -> c_int,
    terminate_destroy: unsafe extern "C" fn(*mut Handle),
    set_option_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
    command_node: unsafe extern "C" fn(*mut Handle, *mut Node, *mut Node) -> c_int,
    set_property: unsafe extern "C" fn(*mut Handle, *const c_char, c_int, *mut c_void) -> c_int,
    get_property: unsafe extern "C" fn(*mut Handle, *const c_char, c_int, *mut c_void) -> c_int,
    observe_property: unsafe extern "C" fn(*mut Handle, u64, *const c_char, c_int) -> c_int,
    free_node_contents: unsafe extern "C" fn(*mut Node),
    event_to_node: unsafe extern "C" fn(*mut Node, *mut Event) -> c_int,
    wait_event: unsafe extern "C" fn(*mut Handle, c_double) -> *mut Event,
    wakeup: unsafe extern "C" fn(*mut Handle),
    request_log_messages: unsafe extern "C" fn(*mut Handle, *const c_char) -> c_int,
    _lib: Library,
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        *$lib
            .get(concat!($name, "\0").as_bytes())
            .map_err(|e| format!("{}: {e}", $name))?
    };
}

impl Api {
    fn load(path: &Path) -> Result<Self, String> {
        unsafe {
            // Resolve libmpv's own dependencies (avcodec-*.dll, libass...) from the DLL's folder.
            #[cfg(windows)]
            let lib: Library = libloading::os::windows::Library::load_with_flags(
                path,
                libloading::os::windows::LOAD_WITH_ALTERED_SEARCH_PATH,
            )
            .map_err(|e| format!("load {}: {e}", path.display()))?
            .into();
            #[cfg(not(windows))]
            let lib = Library::new(path).map_err(|e| format!("load {}: {e}", path.display()))?;
            Ok(Api {
                client_api_version: sym!(lib, "mpv_client_api_version"),
                error_string: sym!(lib, "mpv_error_string"),
                free: sym!(lib, "mpv_free"),
                create: sym!(lib, "mpv_create"),
                initialize: sym!(lib, "mpv_initialize"),
                terminate_destroy: sym!(lib, "mpv_terminate_destroy"),
                set_option_string: sym!(lib, "mpv_set_option_string"),
                command_node: sym!(lib, "mpv_command_node"),
                set_property: sym!(lib, "mpv_set_property"),
                get_property: sym!(lib, "mpv_get_property"),
                observe_property: sym!(lib, "mpv_observe_property"),
                free_node_contents: sym!(lib, "mpv_free_node_contents"),
                event_to_node: sym!(lib, "mpv_event_to_node"),
                wait_event: sym!(lib, "mpv_wait_event"),
                wakeup: sym!(lib, "mpv_wakeup"),
                request_log_messages: sym!(lib, "mpv_request_log_messages"),
                _lib: lib,
            })
        }
    }
}

/// An initialized mpv core. All libmpv client functions are thread-safe, so this is Send + Sync.
pub struct Mpv {
    api: Api,
    h: *mut Handle,
}
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.api.terminate_destroy)(self.h) }
    }
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| format!("NUL byte in {s:?}"))
}

/// Owned C-side mirror of a JSON value, kept alive while mpv reads it.
struct OwnedNode {
    node: Node,
    _strings: Vec<CString>,
    _lists: Vec<Box<NodeList>>,
    _values: Vec<Vec<Node>>,
    _keys: Vec<Vec<*mut c_char>>,
}

impl OwnedNode {
    fn from_json(v: &Value) -> Result<Self, String> {
        let mut o = OwnedNode {
            node: Node { u: NodeU { int64: 0 }, format: FORMAT_NONE },
            _strings: vec![],
            _lists: vec![],
            _values: vec![],
            _keys: vec![],
        };
        o.node = o.build(v)?;
        Ok(o)
    }

    fn build(&mut self, v: &Value) -> Result<Node, String> {
        Ok(match v {
            Value::Null => Node { u: NodeU { int64: 0 }, format: FORMAT_NONE },
            Value::Bool(b) => Node { u: NodeU { flag: *b as c_int }, format: FORMAT_FLAG },
            Value::Number(n) if n.is_i64() => {
                Node { u: NodeU { int64: n.as_i64().unwrap() }, format: FORMAT_INT64 }
            }
            Value::Number(n) => {
                Node { u: NodeU { double: n.as_f64().unwrap_or(0.0) }, format: FORMAT_DOUBLE }
            }
            Value::String(s) => {
                let c = cstr(s)?;
                let p = c.as_ptr() as *mut c_char;
                self._strings.push(c);
                Node { u: NodeU { string: p }, format: FORMAT_STRING }
            }
            Value::Array(a) => {
                let mut vals = Vec::with_capacity(a.len());
                for x in a {
                    vals.push(self.build(x)?);
                }
                self.list(vals, None, FORMAT_NODE_ARRAY)
            }
            Value::Object(m) => {
                let mut vals = Vec::with_capacity(m.len());
                let mut keys = Vec::with_capacity(m.len());
                for (k, x) in m {
                    vals.push(self.build(x)?);
                    let c = cstr(k)?;
                    keys.push(c.as_ptr() as *mut c_char);
                    self._strings.push(c);
                }
                self.list(vals, Some(keys), FORMAT_NODE_MAP)
            }
        })
    }

    fn list(&mut self, mut vals: Vec<Node>, keys: Option<Vec<*mut c_char>>, format: c_int) -> Node {
        let mut keys = keys;
        let mut l = Box::new(NodeList {
            num: vals.len() as c_int,
            values: vals.as_mut_ptr(),
            keys: keys.as_mut().map_or(std::ptr::null_mut(), |k| k.as_mut_ptr()),
        });
        let p: *mut NodeList = &mut *l;
        self._values.push(vals);
        if let Some(k) = keys {
            self._keys.push(k);
        }
        self._lists.push(l);
        Node { u: NodeU { list: p }, format }
    }
}

/// Convert an mpv-owned node into JSON (does not free it).
unsafe fn node_to_json(n: &Node) -> Value {
    unsafe {
        match n.format {
            FORMAT_STRING => Value::String(CStr::from_ptr(n.u.string).to_string_lossy().into_owned()),
            FORMAT_FLAG => Value::Bool(n.u.flag != 0),
            FORMAT_INT64 => Value::from(n.u.int64),
            FORMAT_DOUBLE => serde_json::Number::from_f64(n.u.double).map_or(Value::Null, Value::Number),
            FORMAT_NODE_ARRAY | FORMAT_NODE_MAP => {
                let l = &*n.u.list;
                let vals = if l.num > 0 { std::slice::from_raw_parts(l.values, l.num as usize) } else { &[] };
                if n.format == FORMAT_NODE_ARRAY {
                    Value::Array(vals.iter().map(|v| node_to_json(v)).collect())
                } else {
                    let keys = std::slice::from_raw_parts(l.keys, l.num.max(0) as usize);
                    let mut m = Map::new();
                    for (k, v) in keys.iter().zip(vals) {
                        m.insert(CStr::from_ptr(*k).to_string_lossy().into_owned(), node_to_json(v));
                    }
                    Value::Object(m)
                }
            }
            FORMAT_BYTE_ARRAY => Value::from((*n.u.ba).size),
            _ => Value::Null,
        }
    }
}

impl Mpv {
    /// Load the DLL, create a core, apply pre-init options, initialize.
    /// Only `wid` and `vo` are mandatory; an option this libmpv build does not know is logged and
    /// skipped (so a newer/older DLL never disables the engine because of a cosmetic option).
    pub fn new(dll: &Path, options: &[(&str, &str)]) -> Result<Arc<Self>, String> {
        let api = Api::load(dll)?;
        let h = unsafe { (api.create)() };
        if h.is_null() {
            return Err("mpv_create failed".into());
        }
        let mpv = Mpv { api, h };
        for (k, v) in options {
            let (kc, vc) = (cstr(k)?, cstr(v)?);
            if let Err(e) = mpv.check(unsafe { (mpv.api.set_option_string)(h, kc.as_ptr(), vc.as_ptr()) }) {
                if matches!(*k, "wid" | "vo") {
                    return Err(format!("option {k}={v}: {e}"));
                }
                eprintln!("[VHO] mpv option {k}={v} ignored: {e}");
            }
        }
        mpv.check(unsafe { (mpv.api.initialize)(h) })?;
        Ok(Arc::new(mpv))
    }

    pub fn client_api_version(&self) -> (u32, u32) {
        let v = unsafe { (self.api.client_api_version)() } as u32;
        (v >> 16, v & 0xffff)
    }

    fn check(&self, rc: c_int) -> Result<(), String> {
        if rc >= 0 {
            Ok(())
        } else {
            let s = unsafe { CStr::from_ptr((self.api.error_string)(rc)) };
            Err(s.to_string_lossy().into_owned())
        }
    }

    /// `command(["loadfile", "x.mkv"])` etc. Returns the command result as JSON.
    pub fn command(&self, args: &Value) -> Result<Value, String> {
        let mut input = OwnedNode::from_json(args)?;
        let mut out = Node { u: NodeU { int64: 0 }, format: FORMAT_NONE };
        self.check(unsafe { (self.api.command_node)(self.h, &mut input.node, &mut out) })?;
        let v = unsafe { node_to_json(&out) };
        unsafe { (self.api.free_node_contents)(&mut out) };
        Ok(v)
    }

    pub fn set_property(&self, name: &str, value: &Value) -> Result<(), String> {
        let name = cstr(name)?;
        let mut input = OwnedNode::from_json(value)?;
        self.check(unsafe {
            (self.api.set_property)(self.h, name.as_ptr(), FORMAT_NODE, &mut input.node as *mut Node as *mut c_void)
        })
    }

    pub fn get_property(&self, name: &str) -> Result<Value, String> {
        let name = cstr(name)?;
        let mut out = Node { u: NodeU { int64: 0 }, format: FORMAT_NONE };
        self.check(unsafe {
            (self.api.get_property)(self.h, name.as_ptr(), FORMAT_NODE, &mut out as *mut Node as *mut c_void)
        })?;
        let v = unsafe { node_to_json(&out) };
        unsafe { (self.api.free_node_contents)(&mut out) };
        Ok(v)
    }

    pub fn get_property_string(&self, name: &str) -> Option<String> {
        let name = cstr(name).ok()?;
        let mut p: *mut c_char = std::ptr::null_mut();
        let rc = unsafe {
            (self.api.get_property)(self.h, name.as_ptr(), FORMAT_STRING, &mut p as *mut _ as *mut c_void)
        };
        if rc < 0 || p.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
        unsafe { (self.api.free)(p as *mut c_void) };
        Some(s)
    }

    pub fn observe(&self, id: u64, name: &str) -> Result<(), String> {
        let name = cstr(name)?;
        self.check(unsafe { (self.api.observe_property)(self.h, id, name.as_ptr(), FORMAT_NODE) })
    }

    pub fn request_log_messages(&self, level: &str) {
        if let Ok(l) = cstr(level) {
            unsafe { (self.api.request_log_messages)(self.h, l.as_ptr()) };
        }
    }

    /// Interrupt a blocking `mpv_wait_event` (used by the production facade on shutdown).
    #[allow(dead_code)]
    pub fn wakeup(&self) {
        unsafe { (self.api.wakeup)(self.h) }
    }

    /// Blocking event loop on a dedicated thread. `on_event` receives the event as JSON
    /// (`{"event":"property-change","name":"time-pos","data":12.3,...}`), exactly the shape of
    /// mpv's JSON IPC, which keeps the frontend protocol documented by mpv itself.
    pub fn spawn_event_loop<F>(self: &Arc<Self>, mut on_event: F) -> std::thread::JoinHandle<()>
    where
        F: FnMut(Value) + Send + 'static,
    {
        let mpv = Arc::clone(self);
        std::thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || loop {
                // 100 ms timeout: the callback gets `Value::Null` when idle, which lets the
                // facade flush rate-limited values (the last time-pos after a seek while paused)
                let ev = unsafe { (mpv.api.wait_event)(mpv.h, 0.1) };
                if ev.is_null() {
                    continue;
                }
                let id = unsafe { (*ev).event_id };
                if id == EVENT_NONE {
                    on_event(Value::Null);
                    continue;
                }
                let mut node = Node { u: NodeU { int64: 0 }, format: FORMAT_NONE };
                let json = unsafe {
                    if (mpv.api.event_to_node)(&mut node, ev) >= 0 {
                        let v = node_to_json(&node);
                        (mpv.api.free_node_contents)(&mut node);
                        v
                    } else {
                        Value::Null
                    }
                };
                on_event(json);
                if id == EVENT_SHUTDOWN {
                    break;
                }
            })
            .expect("spawn mpv event thread")
    }
}

// ---------------------------------------------------------------------------
// Render API (path B, ADR 0002): mpv draws into an OpenGL framebuffer the application owns.
// Used on Linux (GtkGLArea). All calls must happen on the thread that owns the GL context,
// except the update callback, which mpv invokes on its own thread.
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", test))]
#[cfg_attr(test, allow(dead_code))]
pub mod render {
    use super::*;

    pub const RENDER_PARAM_INVALID: c_int = 0;
    pub const RENDER_PARAM_API_TYPE: c_int = 1;
    pub const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
    pub const RENDER_PARAM_OPENGL_FBO: c_int = 3;
    pub const RENDER_PARAM_FLIP_Y: c_int = 4;
    pub const RENDER_PARAM_BLOCK_FOR_TARGET_TIME: c_int = 12;

    #[repr(C)]
    pub struct RenderParam {
        pub kind: c_int,
        pub data: *mut c_void,
    }

    pub type GetProcAddress = unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void;

    #[repr(C)]
    pub struct OpenGlInitParams {
        pub get_proc_address: Option<GetProcAddress>,
        pub get_proc_address_ctx: *mut c_void,
    }

    #[repr(C)]
    pub struct OpenGlFbo {
        pub fbo: c_int,
        pub w: c_int,
        pub h: c_int,
        /// 0 = unknown (mpv assumes GL_RGBA8-like)
        pub internal_format: c_int,
    }

    type RenderHandle = c_void;
    pub type UpdateCallback = unsafe extern "C" fn(ctx: *mut c_void);

    struct RenderApi {
        create: unsafe extern "C" fn(*mut *mut RenderHandle, *mut Handle, *mut RenderParam) -> c_int,
        set_update_callback: unsafe extern "C" fn(*mut RenderHandle, Option<UpdateCallback>, *mut c_void),
        render: unsafe extern "C" fn(*mut RenderHandle, *mut RenderParam) -> c_int,
        report_swap: unsafe extern "C" fn(*mut RenderHandle),
        free: unsafe extern "C" fn(*mut RenderHandle),
    }

    /// An mpv render context bound to the GL context that was current when it was created. Keeps the
    /// core alive (`Arc<Mpv>`): the render context is always freed before `mpv_terminate_destroy`.
    pub struct RenderContext {
        api: RenderApi,
        h: *mut RenderHandle,
        _mpv: Arc<Mpv>,
    }

    impl Mpv {
        /// Creates the OpenGL render context. The GL context must be current on this thread and
        /// the core must have been created with `vo=libmpv`.
        pub fn create_render_context(self: &Arc<Self>, gpa: GetProcAddress) -> Result<RenderContext, String> {
            let api = unsafe {
                let lib = &self.api._lib;
                RenderApi {
                    create: sym!(lib, "mpv_render_context_create"),
                    set_update_callback: sym!(lib, "mpv_render_context_set_update_callback"),
                    render: sym!(lib, "mpv_render_context_render"),
                    report_swap: sym!(lib, "mpv_render_context_report_swap"),
                    free: sym!(lib, "mpv_render_context_free"),
                }
            };
            let api_type = c"opengl";
            let mut init = OpenGlInitParams { get_proc_address: Some(gpa), get_proc_address_ctx: std::ptr::null_mut() };
            let mut params = [
                RenderParam { kind: RENDER_PARAM_API_TYPE, data: api_type.as_ptr() as *mut c_void },
                RenderParam { kind: RENDER_PARAM_OPENGL_INIT_PARAMS, data: &mut init as *mut _ as *mut c_void },
                RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
            ];
            let mut h: *mut RenderHandle = std::ptr::null_mut();
            self.check(unsafe { (api.create)(&mut h, self.h, params.as_mut_ptr()) })?;
            Ok(RenderContext { api, h, _mpv: Arc::clone(self) })
        }
    }

    impl RenderContext {
        /// `cb(data)` is called from an mpv thread whenever a new frame should be drawn; it must only
        /// schedule a redraw (no mpv calls inside).
        pub fn set_update_callback(&self, cb: UpdateCallback, data: *mut c_void) {
            unsafe { (self.api.set_update_callback)(self.h, Some(cb), data) }
        }

        /// Renders the current frame into framebuffer `fbo` (w x h device pixels). Never blocks for
        /// the frame's target time (the caller is the UI thread).
        pub fn render(&self, fbo: c_int, w: c_int, h: c_int, flip_y: bool) -> Result<(), String> {
            let mut target = OpenGlFbo { fbo, w, h, internal_format: 0 };
            let mut flip: c_int = flip_y as c_int;
            let mut block: c_int = 0;
            let mut params = [
                RenderParam { kind: RENDER_PARAM_OPENGL_FBO, data: &mut target as *mut _ as *mut c_void },
                RenderParam { kind: RENDER_PARAM_FLIP_Y, data: &mut flip as *mut _ as *mut c_void },
                RenderParam { kind: RENDER_PARAM_BLOCK_FOR_TARGET_TIME, data: &mut block as *mut _ as *mut c_void },
                RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
            ];
            self._mpv.check(unsafe { (self.api.render)(self.h, params.as_mut_ptr()) })
        }

        /// Called after the frame drawn by `render` was presented (GTK frame clock `after-paint`).
        pub fn report_swap(&self) {
            unsafe { (self.api.report_swap)(self.h) }
        }
    }

    impl Drop for RenderContext {
        /// Must run with the same GL context current (GtkGLArea `unrealize`, or engine shutdown).
        fn drop(&mut self) {
            unsafe {
                (self.api.set_update_callback)(self.h, None, std::ptr::null_mut());
                (self.api.free)(self.h);
            }
        }
    }
}
