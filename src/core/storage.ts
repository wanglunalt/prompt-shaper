import type { HistoryEntry, ProjectPreset } from '../types';

const HISTORY_KEY = 'promptlens_history';
const PRESET_KEY = 'promptlens_presets';
const ACTIVE_PRESET_KEY = 'promptlens_active_preset';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadHistory(): HistoryEntry[] {
  const items = readJson<HistoryEntry[]>(HISTORY_KEY, []);
  return Array.isArray(items) ? items.slice(0, 8) : [];
}

export function saveHistory(items: HistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 8)));
}

export function loadPresets(): ProjectPreset[] {
  const items = readJson<ProjectPreset[]>(PRESET_KEY, []);
  return Array.isArray(items) ? items : [];
}

export function savePresets(items: ProjectPreset[]): void {
  localStorage.setItem(PRESET_KEY, JSON.stringify(items));
}

export function loadActivePresetId(): string {
  return localStorage.getItem(ACTIVE_PRESET_KEY) ?? '';
}

export function saveActivePresetId(id: string): void {
  localStorage.setItem(ACTIVE_PRESET_KEY, id);
}

export function formatProjectContext(preset: ProjectPreset | null): string {
  if (!preset) return '';
  const dirs = preset.commonDirs.map((d) => d.trim()).filter(Boolean).join('、');
  return [
    preset.techStack.trim() && `技术栈：${preset.techStack.trim()}`,
    preset.codeStyle.trim() && `代码风格：${preset.codeStyle.trim()}`,
    preset.outputPref.trim() && `输出偏好：${preset.outputPref.trim()}`,
    dirs && `常用目录：${dirs}`,
  ].filter(Boolean).join('\n');
}
