//! Native child window that hosts mpv's video output (Plan 02 path A, Windows).
//!
//! Layout inside the Tauri top-level HWND:
//!   [WebView2 host HWND, transparent background]   <- top of sibling z-order, receives all input
//!   [VhoMpvVideo child HWND, WS_DISABLED]           <- bottom; passed to mpv as `wid`
//!       [mpv's own child window (created by mpv)]

#[cfg(windows)]
mod imp {
    use std::sync::Once;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPFILEHEADER, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap,
        CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, GetStockObject,
        BLACK_BRUSH, HBRUSH, ReleaseDC, SRCCOPY, SelectObject,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const CLASS: &[u16] = &[
        b'V' as u16, b'h' as u16, b'o' as u16, b'M' as u16, b'p' as u16, b'v' as u16, b'V' as u16,
        b'i' as u16, b'd' as u16, b'e' as u16, b'o' as u16, 0,
    ];

    unsafe extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                // Never steal clicks from the webview, even where it is transparent.
                WM_NCHITTEST => HTTRANSPARENT as LRESULT,
                WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
                _ => DefWindowProcW(h, msg, w, l),
            }
        }
    }

    pub fn create(parent: isize, w: i32, h: i32) -> isize {
        static REG: Once = Once::new();
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            REG.call_once(|| {
                let wc = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(wndproc),
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
            let hwnd = CreateWindowExW(
                WS_EX_NOPARENTNOTIFY,
                CLASS.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN | WS_DISABLED,
                0,
                0,
                w,
                h,
                parent as HWND,
                std::ptr::null_mut(),
                hinst,
                std::ptr::null(),
            );
            send_to_bottom(hwnd as isize, w, h);
            hwnd as isize
        }
    }

    pub fn send_to_bottom(hwnd: isize, w: i32, h: i32) {
        unsafe {
            SetWindowPos(hwnd as HWND, HWND_BOTTOM, 0, 0, w, h, SWP_NOACTIVATE);
        }
    }

    /// Debug helper: list direct children of the top-level window in z-order (top first).
    pub fn child_zorder(parent: isize) -> Vec<String> {
        let mut out = vec![];
        unsafe {
            let mut c = GetWindow(parent as HWND, GW_CHILD);
            while !c.is_null() {
                let mut buf = [0u16; 128];
                let n = GetClassNameW(c, buf.as_mut_ptr(), 128);
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(c, &mut r);
                out.push(format!(
                    "{:#x} {} {}x{} visible={}",
                    c as usize,
                    String::from_utf16_lossy(&buf[..n as usize]),
                    r.right,
                    r.bottom,
                    IsWindowVisible(c)
                ));
                c = GetWindow(c, GW_HWNDNEXT);
            }
        }
        out
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 128];
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), 128) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    /// Screen point -> (belongs to our top-level window?, class chain from hit HWND up to root).
    pub fn hit_test(top: isize, sx: i32, sy: i32) -> (bool, Vec<String>) {
        unsafe {
            let mut h = WindowFromPoint(windows_sys::Win32::Foundation::POINT { x: sx, y: sy });
            let ours = !h.is_null() && GetAncestor(h, GA_ROOT) == top as HWND;
            let mut chain = vec![];
            while !h.is_null() && chain.len() < 8 {
                chain.push(class_of(h));
                if h == top as HWND {
                    break;
                }
                h = GetParent(h);
            }
            if !ours {
                chain = vec!["<other application>".into()]; // do not record other apps' details
            }
            (ours, chain)
        }
    }

    pub fn hit_test_client(top: isize, x: i32, y: i32) -> (bool, Vec<String>) {
        let mut p = windows_sys::Win32::Foundation::POINT { x, y };
        unsafe { windows_sys::Win32::Graphics::Gdi::ClientToScreen(top as HWND, &mut p) };
        hit_test(top, p.x, p.y)
    }

    /// Grab what DWM actually shows on screen for the top-level window's client area (BMP).
    /// Screen-DC capture = composited result, so it proves whether video is visible under the UI.
    /// Refuses when any of 5 probe points is covered by another application's window.
    pub fn capture_client(top: isize, path: &std::path::Path) -> Result<(u32, u32, f64), String> {
        unsafe {
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(top as HWND, &mut r);
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            windows_sys::Win32::Graphics::Gdi::ClientToScreen(top as HWND, &mut pt);
            let (w, h) = (r.right, r.bottom);
            for (fx, fy) in [(0.5, 0.5), (0.05, 0.1), (0.95, 0.1), (0.05, 0.95), (0.95, 0.95)] {
                let (sx, sy) = (pt.x + (w as f64 * fx) as i32, pt.y + (h as f64 * fy) as i32);
                if !hit_test(top, sx, sy).0 {
                    return Err("window is occluded by another application; capture skipped".into());
                }
            }
            let sdc = GetDC(std::ptr::null_mut());
            let mdc = CreateCompatibleDC(sdc);
            let bmp = CreateCompatibleBitmap(sdc, w, h);
            let old = SelectObject(mdc, bmp);
            BitBlt(mdc, 0, 0, w, h, sdc, pt.x, pt.y, SRCCOPY);
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: h, // bottom-up, as BMP files expect
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut px = vec![0u8; (w * h * 4) as usize];
            GetDIBits(mdc, bmp, 0, h as u32, px.as_mut_ptr() as _, &mut bi, DIB_RGB_COLORS);
            SelectObject(mdc, old);
            DeleteObject(bmp);
            DeleteDC(mdc);
            ReleaseDC(std::ptr::null_mut(), sdc);

            // fraction of "non-black" pixels: quick black-screen detector
            let nonblack = px.chunks(4).filter(|p| p[0] as u32 + p[1] as u32 + p[2] as u32 > 48).count();
            let ratio = nonblack as f64 / (w * h).max(1) as f64;

            let fh = BITMAPFILEHEADER {
                bfType: 0x4d42,
                bfSize: (14 + 40 + px.len()) as u32,
                bfReserved1: 0,
                bfReserved2: 0,
                bfOffBits: 54,
            };
            let mut f = Vec::with_capacity(54 + px.len());
            f.extend_from_slice(&fh.bfType.to_le_bytes());
            f.extend_from_slice(&fh.bfSize.to_le_bytes());
            f.extend_from_slice(&0u32.to_le_bytes());
            f.extend_from_slice(&fh.bfOffBits.to_le_bytes());
            let ih = bi.bmiHeader;
            f.extend_from_slice(&ih.biSize.to_le_bytes());
            f.extend_from_slice(&ih.biWidth.to_le_bytes());
            f.extend_from_slice(&ih.biHeight.to_le_bytes());
            f.extend_from_slice(&ih.biPlanes.to_le_bytes());
            f.extend_from_slice(&ih.biBitCount.to_le_bytes());
            f.extend_from_slice(&ih.biCompression.to_le_bytes());
            f.extend_from_slice(&0u32.to_le_bytes());
            f.extend_from_slice(&0i32.to_le_bytes());
            f.extend_from_slice(&0i32.to_le_bytes());
            f.extend_from_slice(&0u32.to_le_bytes());
            f.extend_from_slice(&0u32.to_le_bytes());
            f.extend_from_slice(&px);
            std::fs::write(path, f).map_err(|e| e.to_string())?;
            Ok((w as u32, h as u32, ratio))
        }
    }
}

#[cfg(windows)]
pub use imp::*;
