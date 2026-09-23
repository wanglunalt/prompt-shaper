use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use uiautomation::patterns::{UITextPattern, UIValuePattern};
use uiautomation::types::TextUnit;
use uiautomation::{UIAutomation, UIElement};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS,
    DeleteDC, DeleteObject, GetDC, GetDIBits, GetDeviceCaps, HDC, HGDIOBJ, LOGPIXELSX, ReleaseDC,
    SelectObject,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::Console::{
    AttachConsole, FreeConsole, GetConsoleScreenBufferInfo, ReadConsoleOutputCharacterW,
    CONSOLE_SCREEN_BUFFER_INFO,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
};
use windows::core::w;

#[link(name = "user32")]
extern "system" {
    fn PrintWindow(hwnd: HWND, hdc: HDC, nflags: u32) -> i32;
}

use crate::hwnd_bits;
use crate::AppState;

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(automation) = UIAutomation::new() else {
            eprintln!("无法初始化界面读取，跟随输入不可用");
            return;
        };
        let mut worker = OcrWorker::start();
        let mut seen = String::new();
        let mut frame: Option<(u64, Option<String>)> = None;
        let mut last_alacritty: isize = 0;
        loop {
            std::thread::sleep(Duration::from_millis(450));
            let enabled = app.state::<AppState>().clip.lock().unwrap().enabled;
            if !enabled {
                seen.clear();
                frame = None;
                last_alacritty = 0;
                continue;
            }
            let Some(text) = read_draft(
                &automation,
                our_hwnd(&app),
                &mut worker,
                &mut frame,
                &mut last_alacritty,
            ) else {
                continue;
            };
            if text == seen {
                continue;
            }
            seen = text.clone();
            let _ = app.emit("draft-text", text);
        }
    });
}

fn our_hwnd(app: &AppHandle) -> isize {
    app.get_webview_window("main").map(|win| hwnd_bits(&win)).unwrap_or(0)
}

fn read_draft(
    automation: &UIAutomation,
    our: isize,
    worker: &mut Option<OcrWorker>,
    frame: &mut Option<(u64, Option<String>)>,
    last_alacritty: &mut isize,
) -> Option<String> {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() {
        return None;
    }
    let fg_bits = fg.0 as isize;
    let (hwnd, pid) = if fg_bits == our {
        if *last_alacritty == 0 {
            return None;
        }
        let hwnd = HWND(*last_alacritty as *mut std::ffi::c_void);
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        (hwnd, pid)
    } else {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
        if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
            return None;
        }
        (fg, pid)
    };
    let process = process_name(pid);
    let title = window_title(hwnd);
    if process_file(&process).contains("alacritty") {
        *last_alacritty = hwnd.0 as isize;
        return alacritty_draft(hwnd, worker, frame);
    }
    if fg_bits == our || !is_follow_target(&process, &title) {
        return None;
    }

    let focused = automation.get_focused_element().ok()?;
    if focused.get_process_id().ok()? == unsafe { GetCurrentProcessId() } {
        return None;
    }
    if focused.is_password().unwrap_or(false) {
        return None;
    }

    if let Some(text) = console_draft(pid) {
        return Some(text);
    }

    let walker = automation.get_control_view_walker().ok()?;
    let mut current = focused;
    for _ in 0..6 {
        if current.is_password().unwrap_or(false) {
            return None;
        }
        if let Some(text) = draft_from_element(&current) {
            return Some(text);
        }
        current = walker.get_parent(&current).ok()?;
    }
    None
}

fn draft_from_element(element: &UIElement) -> Option<String> {
    if let Ok(pattern) = element.get_pattern::<UIValuePattern>() {
        if let Ok(value) = pattern.get_value() {
            let text = tidy(&value);
            if usable(&text) && text.chars().count() < 1100 {
                return Some(text);
            }
        }
    }
    let pattern = element.get_pattern::<UITextPattern>().ok()?;
    if let Ok(document) = pattern.get_document_range() {
        let text = tidy(&document.get_text(1200).unwrap_or_default());
        if usable(&text) && text.chars().count() < 1100 {
            return Some(text);
        }
    }
    let (_active, line) = pattern.get_caret_range().ok()?;
    let _ = line.expand_to_enclosing_unit(TextUnit::Line);
    let text = tidy(&line.get_text(500).ok()?);
    if text.chars().count() >= 450 {
        return None;
    }
    usable(&text).then_some(text)
}

fn tidy(text: &str) -> String {
    text.replace('\u{fffc}', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn usable(text: &str) -> bool {
    text.chars().count() >= 4
}

fn process_file(process_path: &str) -> String {
    process_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_follow_target(process_path: &str, title: &str) -> bool {
    let file = process_file(process_path);
    if file.contains("promptlens") {
        return false;
    }
    if file.contains("cursor") || file.contains("alacritty") || file.contains("windowsterminal") {
        return true;
    }
    let title_l = title.to_lowercase();
    let ai_title = ["grok", "chatgpt", "claude", "gemini", "copilot", "cursor", "deepseek", "kimi"]
        .iter()
        .any(|key| title_l.contains(key));
    if !ai_title {
        return false;
    }
    ["chrome", "msedge", "alacritty", "windowsterminal", "code", "claude"]
        .iter()
        .any(|name| file.contains(name))
}

struct OcrWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl OcrWorker {
    fn start() -> Option<Self> {
        let script = include_str!("../ocr-loop.ps1");
        let script_path = std::env::temp_dir().join("promptlens_ocr_loop.ps1");
        std::fs::write(&script_path, script).ok()?;
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script_path.to_string_lossy(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let mut worker = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };
        let mut ready = String::new();
        worker.stdout.read_line(&mut ready).ok()?;
        if ready.trim() != "READY" {
            let _ = worker.child.kill();
            return None;
        }
        Some(worker)
    }

    fn recognize(&mut self, path: &str) -> Option<String> {
        writeln!(self.stdin, "{path}").ok()?;
        self.stdin.flush().ok()?;
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).ok()?;
            if n == 0 {
                return None;
            }
            let Some(payload) = line.trim().strip_prefix("OK ") else {
                continue;
            };
            if payload.is_empty() || payload == "-" {
                return Some(String::new());
            }
            let bytes = STANDARD.decode(payload).unwrap_or_default();
            return Some(String::from_utf8(bytes).unwrap_or_default());
        }
    }
}

fn alacritty_draft(
    hwnd: HWND,
    worker: &mut Option<OcrWorker>,
    frame: &mut Option<(u64, Option<String>)>,
) -> Option<String> {
    let captured = unsafe { print_window_bottom(hwnd) }?;
    let image = image::imageops::resize(
        &captured,
        captured.width().saturating_mul(3),
        captured.height().saturating_mul(3),
        image::imageops::FilterType::Lanczos3,
    );
    let hash = hash_pixels(captured.as_raw());
    if let Some((prev, text)) = &*frame {
        if *prev == hash {
            return text.clone();
        }
    }
    let path = std::env::temp_dir().join("promptlens_alac.png");
    image.save(&path).ok()?;
    let parsed = recognize_band(worker, &path.to_string_lossy()).and_then(|text| input_above_status(&text));
    *frame = Some((hash, parsed.clone()));
    parsed
}

fn recognize_band(worker: &mut Option<OcrWorker>, path: &str) -> Option<String> {
    if worker.is_none() {
        *worker = OcrWorker::start();
    }
    let Some(current) = worker.as_mut() else {
        return None;
    };
    match current.recognize(path) {
        Some(text) => Some(text),
        None => {
            let _ = worker.take().map(|mut dead| dead.child.kill());
            *worker = OcrWorker::start();
            worker.as_mut()?.recognize(path)
        }
    }
}

unsafe fn print_window_bottom(hwnd: HWND) -> Option<image::RgbaImage> {
    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect).ok()?;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width < 80 || height < 80 || width > 8000 || height > 8000 {
        return None;
    }
    let screen = GetDC(None);
    if screen.is_invalid() {
        return None;
    }
    let dpi = GetDeviceCaps(Some(screen), LOGPIXELSX).max(96);
    let band = (176 * dpi / 96).clamp(140, 320).min(height);
    let memory = CreateCompatibleDC(Some(screen));
    if memory.is_invalid() {
        let _ = ReleaseDC(None, screen);
        return None;
    }
    let bitmap = CreateCompatibleBitmap(screen, width, height);
    if bitmap.is_invalid() {
        let _ = DeleteDC(memory);
        let _ = ReleaseDC(None, screen);
        return None;
    }
    let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
    let printed = PrintWindow(hwnd, memory, 2);
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..BITMAPINFOHEADER::default()
        },
        ..BITMAPINFO::default()
    };
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    let lines = if printed != 0 {
        GetDIBits(
            memory,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    } else {
        0
    };
    if !previous.0.is_null() {
        SelectObject(memory, previous);
    }
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(memory);
    let _ = ReleaseDC(None, screen);
    if lines <= 0 {
        return None;
    }
    let y0 = (height - band) as usize;
    let row = width as usize;
    let mut rgba = Vec::with_capacity(row * band as usize * 4);
    for y in y0..(y0 + band as usize) {
        for x in 0..row {
            let i = (y * row + x) * 4;
            rgba.extend_from_slice(&[pixels[i + 2], pixels[i + 1], pixels[i], 255]);
        }
    }
    image::RgbaImage::from_raw(width as u32, band as u32, rgba)
}

fn hash_pixels(buf: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut index = 0;
    while index < buf.len() {
        hash ^= buf[index] as u64;
        hash = hash.wrapping_mul(0x100000001b3);
        index += 17;
    }
    hash
}

fn input_above_status(ocr: &str) -> Option<String> {
    let lines: Vec<&str> = ocr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let anchor = lines.iter().rposition(|line| is_status_anchor(line))?;
    let mut index = anchor;
    while index > 0 {
        index -= 1;
        let line = lines[index];
        if is_status_anchor(line) || is_chrome_line(line) || is_noise(line) {
            continue;
        }
        let body = strip_marker(line);
        if body.is_empty() || is_placeholder(&body) || is_status_anchor(&body) || is_chrome_line(&body) {
            continue;
        }
        if body.chars().count() > 800 {
            return None;
        }
        return Some(body);
    }
    None
}

fn is_status_anchor(line: &str) -> bool {
    let low = line.trim().to_ascii_lowercase();
    if low.starts_with("grok") {
        return true;
    }
    let parts: Vec<&str> = low.split_whitespace().collect();
    parts.len() == 2
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && (parts[1] == "task" || parts[1] == "tasks")
}

fn is_placeholder(text: &str) -> bool {
    let low = text.trim().to_ascii_lowercase();
    low.starts_with("add a follow") || low == "ask anything"
}

fn is_chrome_line(text: &str) -> bool {
    let low = text.to_ascii_lowercase();
    low.contains("ctrl+")
        || low.contains("shift+tab")
        || low.contains("files edited")
        || low.contains("run everything")
}

fn is_noise(line: &str) -> bool {
    let text = line.trim();
    !text.is_empty()
        && text.chars().all(|ch| !ch.is_ascii_alphanumeric() && !is_cjk(ch))
}

fn is_cjk(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&ch)
}

fn strip_marker(text: &str) -> String {
    let trimmed = text
        .trim()
        .trim_start_matches(['→', '➜', '➤', '>', '❯', '›', '·', '•', '-', '—', '：', ':', '|', '丨'])
        .trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let rest = chars.as_str();
    if !first.is_ascii_alphanumeric() && rest.starts_with(char::is_whitespace) {
        return rest.trim().to_string();
    }
    trimmed.to_string()
}

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}

fn console_draft(foreground_pid: u32) -> Option<String> {
    let mut shells = Vec::new();
    for (pid, parent, name) in process_snapshot() {
        if parent == foreground_pid && is_shell(&name) {
            shells.push(pid);
        }
    }
    for pid in shells {
        if let Some(text) = read_cursor_line(pid) {
            let text = strip_prompt(&text);
            if usable(&text) && text.chars().count() < 1100 {
                return Some(text);
            }
        }
    }
    None
}

fn is_shell(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "wsl.exe"]
        .iter()
        .any(|shell| name == *shell)
}

fn process_snapshot() -> Vec<(u32, u32, String)> {
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return Vec::new();
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..PROCESSENTRY32W::default()
        };
        let mut rows = Vec::new();
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let name = String::from_utf16_lossy(
                    &entry.szExeFile[..entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len())],
                );
                rows.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        rows
    }
}

fn read_cursor_line(pid: u32) -> Option<String> {
    unsafe {
        let _ = FreeConsole();
        if AttachConsole(pid).is_err() {
            return None;
        }
        let handle = CreateFileW(
            w!("CONOUT$"),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        );
        let Ok(handle) = handle else {
            let _ = FreeConsole();
            return None;
        };
        let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
        if GetConsoleScreenBufferInfo(handle, &mut info).is_err() {
            let _ = CloseHandle(handle);
            let _ = FreeConsole();
            return None;
        }
        let width = info.dwSize.X.max(1) as usize;
        let mut buf = vec![0u16; width];
        let mut read = 0u32;
        let ok = ReadConsoleOutputCharacterW(
            handle,
            &mut buf,
            info.dwCursorPosition,
            &mut read,
        );
        let _ = CloseHandle(handle);
        let _ = FreeConsole();
        if ok.is_err() || read == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..read as usize]))
    }
}

fn strip_prompt(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("PS ") {
        if let Some(idx) = rest.find('>') {
            return rest[idx + 1..].trim().to_string();
        }
    }
    trimmed
        .trim_start_matches(['$', '#', '❯', '›', '>'])
        .trim()
        .to_string()
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        if ok.is_err() || len == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::input_above_status;

    #[test]
    fn skips_grok_placeholder() {
        let ocr = "Add a follow-up\n1 task\nGrok 4.7 255K High\n";
        assert_eq!(input_above_status(ocr), None);
    }

    #[test]
    fn reads_partial_chinese_input() {
        let ocr = "不行啊\nGrok 4.7 256K High\nD:\\1\\AI提示词\n";
        assert_eq!(input_above_status(ocr).as_deref(), Some("不行啊"));
    }

    #[test]
    fn strips_arrow_before_status() {
        let ocr = "→ 修复这个报错\n1 task\nGrok 4.7 High\n";
        assert_eq!(input_above_status(ocr).as_deref(), Some("修复这个报错"));
    }

    #[test]
    fn reads_hi_instead_of_the_previous_reply() {
        let ocr = "需要再加\n一层发送。\n砩 hi\nGrok 4.7 256K High\nD:\\1\\AI提示词\n";
        assert_eq!(input_above_status(ocr).as_deref(), Some("hi"));
    }
}
