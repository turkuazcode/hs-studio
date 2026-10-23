//! Native video surface for libmpv (ADR 0001).
//!
//! Windows — "A′ owned popup": the video lives in its own borderless, disabled top-level popup that
//! sits exactly under the client area of the (transparent) Tauri window. The Tauri window is made
//! an *owned* window of the popup, so Windows keeps it above the video in z-order and DWM
//! alpha-composites the two top-level windows (the only composition path that worked in the spike;
//! a child HWND under WebView2 shows black or the desktop).
//!
//! Following the main window: the Tauri HWND is subclassed and the popup is repositioned
//! synchronously on WM_WINDOWPOSCHANGED (move, resize, maximize, fullscreen, minimize/restore),
//! WM_SHOWWINDOW and WM_DPICHANGED, so it never lags a frame behind while dragging.
//!
//! Other platforms: no surface yet (render-API path B is a separate work package), so the engine
//! reports itself unavailable and the frontend uses the HTML5 engine.

#[cfg(windows)]
mod imp {
    use std::sync::Once;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{BLACK_BRUSH, ClientToScreen, GetStockObject, HBRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// "VhoMpvVideo\0" as UTF-16.
    const CLASS: &[u16] = &[
        b'V' as u16, b'h' as u16, b'o' as u16, b'M' as u16, b'p' as u16, b'v' as u16, b'V' as u16,
        b'i' as u16, b'd' as u16, b'e' as u16, b'o' as u16, 0,
    ];
    const SUBCLASS_ID: usize = 0x5648_4f31; // "VHO1"

    static TOP: AtomicIsize = AtomicIsize::new(0);
    static VIDEO: AtomicIsize = AtomicIsize::new(0);
    /// The frontend shows the popup only while the mpv engine plays a video (not for photos,
    /// the empty screen or the HTML5 engine).
    static WANT_VISIBLE: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn video_wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
                WM_NCHITTEST => HTTRANSPARENT as LRESULT,
                _ => DefWindowProcW(h, msg, w, l),
            }
        }
    }

    fn register() -> windows_sys::Win32::Foundation::HINSTANCE {
        static REG: Once = Once::new();
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            REG.call_once(|| {
                let wc = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(video_wndproc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: hinst,
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: GetStockObject(BLACK_BRUSH) as HBRUSH,
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: CLASS.as_ptr(),
                };
                RegisterClassW(&wc);
            });
            hinst
        }
    }

    /// Main-window subclass: keep the popup glued to the client area, synchronously.
    unsafe extern "system" fn top_subclass(
        h: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        unsafe {
            let r = DefSubclassProc(h, msg, w, l);
            match msg {
                WM_WINDOWPOSCHANGED | WM_SHOWWINDOW | WM_DPICHANGED | WM_SIZE => sync(),
                WM_NCDESTROY => {
                    RemoveWindowSubclass(h, Some(top_subclass), SUBCLASS_ID);
                    let v = VIDEO.swap(0, Ordering::SeqCst);
                    if v != 0 {
                        DestroyWindow(v as HWND);
                    }
                }
                _ => {}
            }
            r
        }
    }

    /// Creates the video popup, makes `top` its owned window, subclasses `top`.
    /// Returns the popup HWND (passed to mpv as `wid`).
    pub fn create(top: isize) -> Result<isize, String> {
        unsafe {
            let hinst = register();
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                CLASS.as_ptr(),
                std::ptr::null(),
                WS_POPUP | WS_CLIPCHILDREN | WS_DISABLED,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err(format!("CreateWindowExW: {}", std::io::Error::last_os_error()));
            }
            // owner relationship: the Tauri window (owned) always stays above the video (owner)
            SetWindowLongPtrW(top as HWND, GWLP_HWNDPARENT, hwnd as isize);
            // owned windows lose their taskbar button / Alt+Tab entry unless WS_EX_APPWINDOW is set
            let ex = GetWindowLongPtrW(top as HWND, GWL_EXSTYLE);
            SetWindowLongPtrW(top as HWND, GWL_EXSTYLE, ex | WS_EX_APPWINDOW as isize);
            TOP.store(top, Ordering::SeqCst);
            VIDEO.store(hwnd as isize, Ordering::SeqCst);
            if SetWindowSubclass(top as HWND, Some(top_subclass), SUBCLASS_ID, 0) == 0 {
                eprintln!("[VHO] SetWindowSubclass failed; the video follows the window only via events");
            }
            sync();
            Ok(hwnd as isize)
        }
    }

    /// Must run on the main (UI) thread, which owns both windows.
    pub fn set_visible(on: bool) {
        WANT_VISIBLE.store(on, Ordering::SeqCst);
        sync();
    }

    pub fn is_visible() -> bool {
        let v = VIDEO.load(Ordering::SeqCst);
        v != 0 && unsafe { IsWindowVisible(v as HWND) } != 0
    }

    /// Places the popup over the main window's client area (physical pixels) or hides it.
    pub fn sync() {
        let (top, video) = (TOP.load(Ordering::SeqCst), VIDEO.load(Ordering::SeqCst));
        if top == 0 || video == 0 {
            return;
        }
        unsafe {
            let (top, video) = (top as HWND, video as HWND);
            if !WANT_VISIBLE.load(Ordering::SeqCst) || IsIconic(top) != 0 || IsWindowVisible(top) == 0 {
                if IsWindowVisible(video) != 0 {
                    ShowWindow(video, SW_HIDE);
                }
                return;
            }
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(top, &mut r);
            let mut p = POINT { x: 0, y: 0 };
            ClientToScreen(top, &mut p);
            SetWindowPos(
                video,
                std::ptr::null_mut(),
                p.x,
                p.y,
                r.right.max(1),
                r.bottom.max(1),
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
            );
        }
    }

    /// (client rect of the main window in screen coords, popup rect, popup visible) — diagnostics.
    pub fn geometry() -> ([i32; 4], [i32; 4], bool) {
        let (top, video) = (TOP.load(Ordering::SeqCst), VIDEO.load(Ordering::SeqCst));
        if top == 0 || video == 0 {
            return ([0; 4], [0; 4], false);
        }
        unsafe {
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(top as HWND, &mut r);
            let mut p = POINT { x: 0, y: 0 };
            ClientToScreen(top as HWND, &mut p);
            let mut v: RECT = std::mem::zeroed();
            GetWindowRect(video as HWND, &mut v);
            (
                [p.x, p.y, r.right, r.bottom],
                [v.left, v.top, v.right - v.left, v.bottom - v.top],
                IsWindowVisible(video as HWND) != 0,
            )
        }
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    pub fn create(_top: isize) -> Result<isize, String> {
        Err("libmpv video embedding is not implemented on this platform yet (render API, path B)".into())
    }
    pub fn set_visible(_on: bool) {}
    pub fn is_visible() -> bool {
        false
    }
    pub fn sync() {}
    pub fn geometry() -> ([i32; 4], [i32; 4], bool) {
        ([0; 4], [0; 4], false)
    }
}

#[cfg(not(windows))]
pub use imp::*;
