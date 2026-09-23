#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod draft;

// PromptLens - overlay backend
use std::num::NonZeroIsize;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use raw_window_handle::{HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};

use arboard::Clipboard;
use serde::Deserialize;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use windows::Win32::Foundation::{HWND, LPARAM, POINT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_LBUTTON,
    VIRTUAL_KEY, GetAsyncKeyState, ReleaseCapture,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
    WindowFromPoint, GA_ROOT, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SW_SHOW, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

struct ClipboardState {
    last_emitted: String,
    enabled: bool,
    own_text: String,
    pause_until: Instant,
    last_image_sig: u64,
    last_seq: u32,
}

struct ScreenRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

struct OverlayState {
    rects: Vec<ScreenRect>,
    force_capture: bool,
    drag_passthrough: bool,
    ignoring: bool,
    pointer_down_on_us: bool,
    last_foreign: isize,
}

#[derive(Clone)]
struct StagedDrag {
    file: std::path::PathBuf,
    preview: std::path::PathBuf,
}

struct AppState {
    clip: Mutex<ClipboardState>,
    overlay: Mutex<OverlayState>,
    staged_drag: Mutex<Option<StagedDrag>>,
}

#[derive(Deserialize)]
struct CssRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn fit_overlay(window: &tauri::WebviewWindow) {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w > 0 && h > 0 {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
        }
    }
}

pub(crate) fn hwnd_bits(window: &tauri::WebviewWindow) -> isize {
    window.hwnd().map(|hwnd| hwnd.0 as isize).unwrap_or(0)
}

fn mark_own_clipboard(state: &AppState, text: &str) {
    let mut clip = state.clip.lock().unwrap();
    clip.own_text = text.to_string();
    clip.last_emitted = text.to_string();
    clip.pause_until = Instant::now() + Duration::from_secs(2);
}

fn focus_hwnd(hwnd: isize) {
    unsafe {
        let target = HWND(hwnd as *mut _);
        let fg = GetForegroundWindow();
        let current = GetCurrentThreadId();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let target_thread = GetWindowThreadProcessId(target, None);
        if fg_thread != 0 && fg_thread != current {
            let _ = AttachThreadInput(current, fg_thread, true);
        }
        if target_thread != 0 && target_thread != current {
            let _ = AttachThreadInput(current, target_thread, true);
        }
        let _ = ShowWindow(target, SW_SHOW);
        let _ = SetForegroundWindow(target);
        if fg_thread != 0 && fg_thread != current {
            let _ = AttachThreadInput(current, fg_thread, false);
        }
        if target_thread != 0 && target_thread != current {
            let _ = AttachThreadInput(current, target_thread, false);
        }
    }
}

fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let payload = data_url.split_once(',').map(|(_, data)| data).unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| e.to_string())
}

fn clipboard_set_image_data_url(data_url: &str) -> Result<(), String> {
    let bytes = decode_data_url(data_url)?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (width, height) = img.dimensions();
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: img.into_raw().into(),
    })
    .map_err(|e| e.to_string())
}

fn send_paste() {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(4);
    macro_rules! key_event {
        ($vk:expr, $up:expr) => {{
            let mut input = INPUT {
                r#type: INPUT_KEYBOARD,
                ..Default::default()
            };
            input.Anonymous.ki = KEYBDINPUT {
                wVk: $vk,
                dwFlags: if $up { KEYEVENTF_KEYUP } else { Default::default() },
                ..Default::default()
            };
            input
        }};
    }

    inputs.push(key_event!(VK_CONTROL, false));
    inputs.push(key_event!(VIRTUAL_KEY(b'V' as u16), false));
    inputs.push(key_event!(VIRTUAL_KEY(b'V' as u16), true));
    inputs.push(key_event!(VK_CONTROL, true));

    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
    std::thread::sleep(Duration::from_millis(160));
}

fn type_text(text: &str) -> Result<(), String> {
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())?;
    drop(cb);
    std::thread::sleep(Duration::from_millis(80));
    send_paste();
    Ok(())
}

fn deliver_to_focused(text: &str, image_data_url: Option<&str>) -> Result<(), String> {
    if let Some(url) = image_data_url.filter(|value| !value.is_empty()) {
        clipboard_set_image_data_url(url)?;
        std::thread::sleep(Duration::from_millis(80));
        send_paste();
        std::thread::sleep(Duration::from_millis(280));
    }
    type_text(text)
}

struct DragWindow(isize);

impl HasWindowHandle for DragWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, raw_window_handle::HandleError> {
        let hwnd = NonZeroIsize::new(self.0).ok_or(raw_window_handle::HandleError::Unavailable)?;
        let handle = Win32WindowHandle::new(hwnd);
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
    }
}

fn client_rect_to_screen(
    window: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(i32, i32, i32, i32), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let sw = (w * scale).round() as i32;
    let sh = (h * scale).round() as i32;
    if sw < 8 || sh < 8 {
        return Err("选区太小".into());
    }
    let sx = pos.x + (x * scale).round() as i32;
    let sy = pos.y + (y * scale).round() as i32;
    Ok((sx, sy, sw, sh))
}

fn capture_region(sx: i32, sy: i32, sw: i32, sh: i32) -> Result<String, String> {
    use xcap::Monitor;

    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let mut matched: Option<xcap::Monitor> = None;
    for monitor in monitors {
        let mx = monitor.x();
        let my = monitor.y();
        let mw = monitor.width() as i32;
        let mh = monitor.height() as i32;
        let overlaps = sx < mx + mw && sx + sw > mx && sy < my + mh && sy + sh > my;
        if overlaps {
            matched = Some(monitor);
            break;
        }
    }
    let monitor = matched.ok_or("选区不在任何显示器上")?;
    let mx = monitor.x();
    let my = monitor.y();
    let screenshot = monitor.capture_image().map_err(|e| e.to_string())?;
    let img_w = screenshot.width();
    let img_h = screenshot.height();
    let rel_x = (sx - mx).max(0) as u32;
    let rel_y = (sy - my).max(0) as u32;
    if rel_x >= img_w || rel_y >= img_h {
        return Err("选区超出屏幕".into());
    }
    let cw = (sw.max(1) as u32).min(img_w - rel_x);
    let ch = (sh.max(1) as u32).min(img_h - rel_y);
    let cropped = image::imageops::crop_imm(&screenshot, rel_x, rel_y, cw, ch).to_image();
    let path = std::env::temp_dir().join("promptlens_ocr.png");
    cropped.save(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

fn recognize_image(image_path: &str) -> Result<String, String> {
    let script = include_str!("../ocr.ps1");
    let script_path = std::env::temp_dir().join("promptlens_ocr.ps1");
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;
    let out_path = std::env::temp_dir().join("promptlens_ocr.txt");
    let _ = std::fs::remove_file(&out_path);

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path.to_string_lossy(),
            "-ImagePath",
            image_path,
            "-OutPath",
            &out_path.to_string_lossy(),
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("无法启动文字识别：{e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        let detail = format!("{err}{out}").trim().to_string();
        return Err(if detail.is_empty() {
            "文字识别失败".into()
        } else {
            format!("文字识别失败：{detail}")
        });
    }

    let text = std::fs::read_to_string(&out_path).unwrap_or_default();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有识别到文字".into());
    }
    Ok(text)
}

fn image_sig(img: &arboard::ImageData) -> u64 {
    let mut hash = ((img.width as u64) << 32) | img.height as u64;
    let bytes = img.bytes.as_ref();
    let step = (bytes.len() / 48).max(1);
    for (i, byte) in bytes.iter().step_by(step).take(48).enumerate() {
        hash = hash.wrapping_mul(16777619) ^ (*byte as u64).wrapping_add(i as u64);
    }
    hash
}

fn clipboard_image_data_url(img: &arboard::ImageData) -> Result<String, String> {
    let width = img.width as u32;
    let height = img.height as u32;
    let rgba = image::RgbaImage::from_raw(width, height, img.bytes.to_vec()).ok_or("截图像素无效")?;
    let max_edge = 1600u32;
    let dynamic = if width.max(height) > max_edge {
        let scale = max_edge as f32 / width.max(height) as f32;
        let nw = ((width as f32) * scale).round().max(1.0) as u32;
        let nh = ((height as f32) * scale).round().max(1.0) as u32;
        image::DynamicImage::ImageRgba8(rgba).resize(nw, nh, image::imageops::FilterType::Triangle)
    } else {
        image::DynamicImage::ImageRgba8(rgba)
    };
    let mut png = Vec::new();
    dynamic
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", base64_encode(&png)))
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 { out.push(TABLE[((n >> 6) & 63) as usize] as char); } else { out.push('='); }
        if chunk.len() > 2 { out.push(TABLE[(n & 63) as usize] as char); } else { out.push('='); }
    }
    out
}

#[derive(serde::Serialize)]
struct WindowBox {
    hwnd: i64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn css_window_box(window: &tauri::WebviewWindow, hwnd: HWND) -> Option<WindowBox> {
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width < 80 || height < 80 {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    Some(WindowBox {
        hwnd: hwnd.0 as isize as i64,
        x: (rect.left - origin_x) as f64 / scale,
        y: (rect.top - origin_y) as f64 / scale,
        w: width as f64 / scale,
        h: height as f64 / scale,
    })
}

fn foreign_root(hwnd: HWND, our: isize) -> Option<HWND> {
    if hwnd.is_invalid() {
        return None;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let root = if root.is_invalid() { hwnd } else { root };
    if root.0 as isize == our || !unsafe { IsWindowVisible(root) }.as_bool() {
        return None;
    }
    Some(root)
}

#[tauri::command]
fn window_under_cursor(window: tauri::WebviewWindow, state: tauri::State<AppState>) -> Option<WindowBox> {
    let our = hwnd_bits(&window);
    let _ = window.set_ignore_cursor_events(true);
    {
        let mut overlay = state.overlay.lock().unwrap();
        overlay.ignoring = true;
    }
    let mut pt = POINT::default();
    unsafe { GetCursorPos(&mut pt).ok()? };
    let hit = unsafe { WindowFromPoint(pt) };
    if let Some(root) = foreign_root(hit, our) {
        return css_window_box(&window, root);
    }
    let last = state.overlay.lock().unwrap().last_foreign;
    if last == 0 {
        return None;
    }
    let hwnd = HWND(last as *mut core::ffi::c_void);
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect).ok()? };
    if pt.x < rect.left || pt.x >= rect.right || pt.y < rect.top || pt.y >= rect.bottom {
        return None;
    }
    css_window_box(&window, hwnd)
}

struct EnumCtx {
    our: isize,
    out: Vec<HWND>,
}

unsafe extern "system" fn collect_top_windows(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumCtx);
    if hwnd.0 as isize != ctx.our {
        ctx.out.push(hwnd);
    }
    TRUE
}

fn window_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
    };
    ok.is_ok() && cloaked != 0
}

#[tauri::command]
fn list_windows(window: tauri::WebviewWindow) -> Vec<WindowBox> {
    let mut ctx = EnumCtx { our: hwnd_bits(&window), out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(collect_top_windows), LPARAM(&mut ctx as *mut EnumCtx as isize));
    }
    let virtual_w = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let virtual_h = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    let mut boxes = Vec::new();
    for hwnd in ctx.out {
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() || unsafe { IsIconic(hwnd) }.as_bool() {
            continue;
        }
        if window_cloaked(hwnd) {
            continue;
        }
        let ex = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let tool = WS_EX_TOOLWINDOW.0;
        let app = WS_EX_APPWINDOW.0;
        if ex & tool != 0 && ex & app == 0 {
            continue;
        }
        let mut rect = windows::Win32::Foundation::RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
            continue;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width >= virtual_w * 9 / 10 && height >= virtual_h * 9 / 10 {
            continue;
        }
        if let Some(box_) = css_window_box(&window, hwnd) {
            boxes.push(box_);
        }
    }
    boxes
}

#[tauri::command]
fn tracked_window_rect(window: tauri::WebviewWindow, hwnd: i64) -> Option<WindowBox> {
    let target = HWND(hwnd as *mut core::ffi::c_void);
    if target.is_invalid() || !unsafe { IsWindowVisible(target) }.as_bool() {
        return None;
    }
    css_window_box(&window, target)
}

fn point_in(rects: &[ScreenRect], x: i32, y: i32, pad: i32) -> bool {
    rects.iter().any(|r| {
        x >= r.x - pad && y >= r.y - pad && x < r.x + r.w + pad && y < r.y + r.h + pad
    })
}

#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) {
    fit_overlay(&window);
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn reveal_overlay(window: tauri::WebviewWindow) {
    fit_overlay(&window);
    let _ = window.show();
}

#[tauri::command]
fn set_clipboard_enabled(state: tauri::State<AppState>, enabled: bool) {
    let mut clip = state.clip.lock().unwrap();
    clip.enabled = enabled;
    if enabled {
        clip.last_seq = unsafe { GetClipboardSequenceNumber() };
    } else {
        clip.last_emitted.clear();
        clip.last_image_sig = 0;
        clip.last_seq = 0;
    }
}

#[tauri::command]
fn set_clipboard_text(state: tauri::State<AppState>, text: String) -> Result<(), String> {
    mark_own_clipboard(&state, &text);
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_clipboard_text() -> Result<String, String> {
    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn update_hit_rects(window: tauri::WebviewWindow, state: tauri::State<AppState>, rects: Vec<CssRect>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().unwrap_or(PhysicalPosition::new(0, 0));
    let mapped = rects
        .into_iter()
        .filter(|r| r.w > 1.0 && r.h > 1.0)
        .map(|r| ScreenRect {
            x: pos.x + (r.x * scale).round() as i32,
            y: pos.y + (r.y * scale).round() as i32,
            w: (r.w * scale).round() as i32,
            h: (r.h * scale).round() as i32,
        })
        .collect();
    state.overlay.lock().unwrap().rects = mapped;
}

#[tauri::command]
fn set_force_capture(state: tauri::State<AppState>, capture: bool) {
    state.overlay.lock().unwrap().force_capture = capture;
}

#[tauri::command]
async fn paste_text_to_focused_window(
    app: tauri::AppHandle,
    text: String,
    image_data_url: Option<String>,
) -> Result<(), String> {
    let foreign = app.state::<AppState>().overlay.lock().unwrap().last_foreign;
    let state = app.state::<AppState>();
    mark_own_clipboard(&*state, &text);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    let pasted = text.clone();
    let image = image_data_url.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(180));
        if foreign != 0 {
            focus_hwnd(foreign);
            std::thread::sleep(Duration::from_millis(120));
        }
        deliver_to_focused(&pasted, image.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(win) = app.get_webview_window("main") {
        fit_overlay(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }
    result
}

#[tauri::command]
async fn capture_and_ocr(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let rect = client_rect_to_screen(&window, x, y, width, height)?;
    let _ = window.hide();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(140));
        let path = capture_region(rect.0, rect.1, rect.2, rect.3)?;
        recognize_image(&path)
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(win) = app.get_webview_window("main") {
        fit_overlay(&win);
        let _ = win.show();
        let _ = win.set_focus();
    }
    outcome
}

#[tauri::command]
fn read_dropped_image(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("无法读取图片：{e}"))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("图片超过 20MB".into());
    }
    let mime = image_mime(&bytes).ok_or("请拖入图片文件")?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

#[tauri::command]
fn stage_drag_image(state: tauri::State<AppState>, data_url: String) -> Result<(), String> {
    let bytes = decode_data_url(&data_url)?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let file = std::env::temp_dir().join("promptlens-drag.png");
    let preview = std::env::temp_dir().join("promptlens-drag-preview.png");
    img.save(&file).map_err(|e| e.to_string())?;
    img.thumbnail(160, 100).save(&preview).map_err(|e| e.to_string())?;
    *state.staged_drag.lock().unwrap() = Some(StagedDrag { file, preview });
    Ok(())
}

#[tauri::command]
fn drag_screenshot(window: tauri::WebviewWindow, state: tauri::State<AppState>) -> Result<(), String> {
    let staged = state.staged_drag.lock().unwrap().clone();
    let Some(staged) = staged else {
        return Err("截图还没准备好，松开后重新按住图片再拖".into());
    };
    let file = std::fs::canonicalize(&staged.file).unwrap_or(staged.file);
    {
        let mut overlay = state.overlay.lock().unwrap();
        overlay.drag_passthrough = true;
        overlay.ignoring = true;
        overlay.pointer_down_on_us = false;
    }
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.hide();
    let _ = unsafe { ReleaseCapture() };
    let dragged = drag::start_drag(
        &DragWindow(hwnd_bits(&window)),
        drag::DragItem::Files(vec![file]),
        drag::Image::File(staged.preview),
        |_result, _cursor| {},
        drag::Options::default(),
    );
    {
        let mut overlay = state.overlay.lock().unwrap();
        overlay.drag_passthrough = false;
    }
    fit_overlay(&window);
    let _ = window.show();
    dragged.map_err(|e| e.to_string())
}

fn button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16) & 0x8000 != 0 }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            clip: Mutex::new(ClipboardState {
                last_emitted: String::new(),
                enabled: false,
                own_text: String::new(),
                pause_until: Instant::now(),
                last_image_sig: 0,
                last_seq: 0,
            }),
            overlay: Mutex::new(OverlayState {
                rects: Vec::new(),
                force_capture: false,
                drag_passthrough: false,
                ignoring: true,
                pointer_down_on_us: false,
                last_foreign: 0,
            }),
            staged_drag: Mutex::new(None),
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let accel = shortcut.to_string();
                    let Some(win) = app.get_webview_window("main") else { return };
                    if accel.contains('O') {
                        fit_overlay(&win);
                        let _ = app.emit("start-ocr", ());
                        let _ = win.show();
                        let _ = win.set_focus();
                    } else if accel.contains('P') {
                        if win.is_visible().unwrap_or(false) {
                            let _ = win.hide();
                        } else {
                            fit_overlay(&win);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            for shortcut in ["ctrl+shift+p", "ctrl+shift+o"] {
                if let Err(err) = app.global_shortcut().register(shortcut) {
                    eprintln!("快捷键 {shortcut} 已被占用，程序仍会启动：{err}");
                }
            }

            let show_i = MenuItem::with_id(app, "show", "显示 PromptLens", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            fit_overlay(&win);
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                fit_overlay(&win);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            if let Some(win) = app.get_webview_window("main") {
                fit_overlay(&win);
                let _ = win.set_ignore_cursor_events(true);
            }
            draft::spawn(app.handle().clone());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    let state = app_handle.state::<AppState>();
                    let seq = unsafe { GetClipboardSequenceNumber() };
                    let (enabled, own, last, paused, last_seq, last_image_sig) = {
                        let clip = state.clip.lock().unwrap();
                        (
                            clip.enabled,
                            clip.own_text.clone(),
                            clip.last_emitted.clone(),
                            Instant::now() < clip.pause_until,
                            clip.last_seq,
                            clip.last_image_sig,
                        )
                    };
                    if !enabled || paused || seq == last_seq {
                        continue;
                    }
                    let Ok(mut cb) = Clipboard::new() else { continue };
                    if let Ok(img) = cb.get_image() {
                        let sig = image_sig(&img);
                        if sig != last_image_sig {
                            if let Ok(url) = clipboard_image_data_url(&img) {
                                {
                                    let mut clip = state.clip.lock().unwrap();
                                    clip.last_image_sig = sig;
                                    clip.last_seq = seq;
                                }
                                drop(cb);
                                let _ = app_handle.emit("clipboard-image", url);
                                continue;
                            }
                        }
                    }
                    let text = match cb.get_text() {
                        Ok(text) => text,
                        Err(_) => {
                            state.clip.lock().unwrap().last_seq = seq;
                            continue;
                        }
                    };
                    drop(cb);
                    state.clip.lock().unwrap().last_seq = seq;
                    if text.is_empty() || text.len() <= 5 || text == last || text == own {
                        if text == own {
                            let mut clip = state.clip.lock().unwrap();
                            clip.last_emitted = text;
                            clip.own_text.clear();
                        }
                        continue;
                    }
                    {
                        let mut clip = state.clip.lock().unwrap();
                        clip.last_emitted = text.clone();
                    }
                    let _ = app_handle.emit("clipboard-text", text);
                }
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let Some(window) = app_handle.get_webview_window("main") else { return };
                let our = hwnd_bits(&window);
                loop {
                    tokio::time::sleep(Duration::from_millis(32)).await;
                    if !window.is_visible().unwrap_or(false) {
                        continue;
                    }
                    let mut pt = POINT::default();
                    let cursor_ok = unsafe { GetCursorPos(&mut pt) }.is_ok();
                    let state = app_handle.state::<AppState>();
                    let down = button_down();
                    let (should_ignore, changed) = {
                        let mut overlay = state.overlay.lock().unwrap();
                        let pad = if down && !overlay.pointer_down_on_us { 48 } else { 16 };
                        let inside = cursor_ok && point_in(&overlay.rects, pt.x, pt.y, pad);
                        if down && !overlay.ignoring && !overlay.drag_passthrough {
                            overlay.pointer_down_on_us = true;
                        }
                        if !down {
                            overlay.pointer_down_on_us = false;
                        }
                        let should_ignore = overlay.drag_passthrough
                            || (!overlay.force_capture && !overlay.pointer_down_on_us && !inside);
                        let changed = should_ignore != overlay.ignoring;
                        if changed {
                            overlay.ignoring = should_ignore;
                        }
                        (should_ignore, changed)
                    };
                    if changed {
                        let _ = window.set_ignore_cursor_events(should_ignore);
                    }
                    let fg = unsafe { GetForegroundWindow() };
                    let fg_id = fg.0 as isize;
                    if fg_id != 0 && fg_id != our {
                        state.overlay.lock().unwrap().last_foreign = fg_id;
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_window,
            show_window,
            reveal_overlay,
            set_clipboard_enabled,
            set_clipboard_text,
            get_clipboard_text,
            update_hit_rects,
            set_force_capture,
            capture_and_ocr,
            paste_text_to_focused_window,
            read_dropped_image,
            stage_drag_image,
            drag_screenshot,
            window_under_cursor,
            tracked_window_rect,
            list_windows,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
