// ============================================================
// PromptLens - Tauri Bridge
// ============================================================

import { isTauri, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export { isTauri };

export interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function hideWindow(): Promise<void> {
  if (isTauri()) await getCurrentWindow().hide();
}

export async function showWindow(): Promise<void> {
  if (isTauri()) {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  }
}

export async function copyToClipboard(text: string): Promise<void> {
  if (isTauri()) {
    await invoke('set_clipboard_text', { text });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

export async function setClipboardEnabled(enabled: boolean): Promise<void> {
  if (isTauri()) await invoke('set_clipboard_enabled', { enabled });
}

export async function revealOverlay(): Promise<void> {
  if (isTauri()) await invoke('reveal_overlay');
}

export async function onDraftText(cb: (text: string) => void): Promise<UnlistenFn> {
  if (isTauri()) return await listen<string>('draft-text', (e) => cb(e.payload));
  return () => {};
}

export async function onClipboardText(cb: (text: string) => void): Promise<UnlistenFn> {
  if (isTauri()) return await listen<string>('clipboard-text', (e) => cb(e.payload));
  return () => {};
}

export async function onClipboardImage(cb: (dataUrl: string) => void): Promise<UnlistenFn> {
  if (isTauri()) return await listen<string>('clipboard-image', (e) => cb(e.payload));
  return () => {};
}

export async function onFileDrop(handlers: {
  onHover: (active: boolean) => void;
  onDrop: (paths: string[]) => void;
}): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    const kind = event.payload.type;
    if (kind === 'enter' || kind === 'over') handlers.onHover(true);
    else if (kind === 'leave') handlers.onHover(false);
    else if (kind === 'drop') {
      handlers.onHover(false);
      handlers.onDrop(event.payload.paths);
    }
  });
}

export async function readDroppedImage(path: string): Promise<string> {
  return await invoke('read_dropped_image', { path });
}

export async function onStartOcr(cb: () => void): Promise<UnlistenFn> {
  if (isTauri()) return await listen('start-ocr', () => cb());
  return () => {};
}

export async function updateHitRects(rects: HitRect[]): Promise<void> {
  if (isTauri()) await invoke('update_hit_rects', { rects });
}

export async function setForceCapture(capture: boolean): Promise<void> {
  if (isTauri()) await invoke('set_force_capture', { capture });
}

/** Client CSS pixels. Rust maps them onto the virtual screen and runs Windows OCR. */
export async function captureAndOcr(x: number, y: number, width: number, height: number): Promise<string> {
  if (!isTauri()) throw new Error('框选识别只能在桌面版里使用');
  return await invoke('capture_and_ocr', { x, y, width, height });
}

/** Hide this window, focus the previous app, paste, then show again. */
export async function pasteToFocusedWindow(text: string, imageDataUrl?: string | null): Promise<void> {
  if (isTauri()) {
    await invoke('paste_text_to_focused_window', { text, imageDataUrl: imageDataUrl || null });
    return;
  }
  await copyToClipboard(text);
}

let stagedDrag: Promise<void> = Promise.resolve();

/** Write the PNG before the user starts dragging, so the drag can begin immediately. */
export function stageDragImage(dataUrl: string): void {
  if (!isTauri()) return;
  stagedDrag = invoke('stage_drag_image', { dataUrl }).then(() => undefined);
}

export interface WindowBox {
  hwnd: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function windowUnderCursor(): Promise<WindowBox | null> {
  if (!isTauri()) return null;
  return await invoke<WindowBox | null>('window_under_cursor');
}

export async function trackedWindowRect(hwnd: number): Promise<WindowBox | null> {
  if (!isTauri()) return null;
  return await invoke<WindowBox | null>('tracked_window_rect', { hwnd });
}

export async function listWindows(): Promise<WindowBox[]> {
  if (!isTauri()) return [];
  return await invoke<WindowBox[]>('list_windows');
}

/** Drag the prepared screenshot out as a PNG file. */
export async function dragScreenshot(): Promise<void> {
  if (!isTauri()) throw new Error('拖出截图需要桌面版');
  await stagedDrag;
  await invoke('drag_screenshot');
}
