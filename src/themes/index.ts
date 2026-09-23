// ============================================================
// PromptLens - Theme System
// ============================================================

export interface Theme {
  id: string;
  name: string;
  variables: Record<string, string>;
  bubble: {
    size: number;
    gradient: [string, string];
    glow: boolean;
  };
  panel: {
    width: number;
    maxHeight: number;
    opacity: number;
  };
}

export const builtinThemes: Theme[] = [
  {
    id: 'azure',
    name: '蓝白',
    variables: {
      '--bg': 'rgba(255, 255, 255, 0.97)',
      '--header': 'rgba(244, 248, 255, 0.98)',
      '--surface': '#F3F7FF',
      '--surface-hover': '#E5EFFF',
      '--primary': '#2563EB',
      '--primary-hover': '#1D4ED8',
      '--primary-soft': 'rgba(37, 99, 235, 0.12)',
      '--text': '#0F2744',
      '--text-secondary': '#3D5A80',
      '--text-muted': '#7B8BA6',
      '--border': 'rgba(37, 99, 235, 0.16)',
      '--danger': '#DC2626',
      '--warning': '#D97706',
      '--success': '#059669',
      '--radius': '18px',
      '--shadow': '0 18px 40px rgba(37, 99, 235, 0.16), 0 2px 8px rgba(15, 39, 68, 0.06)',
      '--bubble-ring': '#ffffff',
      '--bubble-shadow': 'rgba(37, 99, 235, 0.38)',
    },
    bubble: {
      size: 56,
      gradient: ['#60A5FA', '#1D4ED8'],
      glow: true,
    },
    panel: { width: 400, maxHeight: 62, opacity: 0.98 },
  },
  {
    id: 'devon',
    name: '深夜编码',
    variables: {
      '--bg': 'rgba(22, 22, 28, 0.92)',
      '--surface': 'rgba(255, 255, 255, 0.06)',
      '--surface-hover': 'rgba(255, 255, 255, 0.1)',
      '--primary': '#8B5CF6',
      '--primary-hover': '#7C3AED',
      '--text': '#E2E8F0',
      '--text-secondary': '#94A3B8',
      '--text-muted': '#64748B',
      '--border': 'rgba(255, 255, 255, 0.08)',
      '--danger': '#EF4444',
      '--warning': '#F59E0B',
      '--success': '#10B981',
      '--radius': '16px',
      '--shadow': '0 8px 32px rgba(0,0,0,0.4)',
      '--header': 'rgba(22, 22, 28, 0.96)',
      '--primary-soft': 'rgba(139, 92, 246, 0.18)',
      '--bubble-ring': 'rgba(255,255,255,0.18)',
      '--bubble-shadow': 'rgba(0,0,0,0.35)',
    },
    bubble: {
      size: 48,
      gradient: ['#8B5CF6', '#3B82F6'],
      glow: true,
    },
    panel: { width: 400, maxHeight: 60, opacity: 0.95 },
  },
  {
    id: 'minimal',
    name: '极简白',
    variables: {
      '--bg': 'rgba(255, 255, 255, 0.96)',
      '--surface': 'rgba(0, 0, 0, 0.03)',
      '--surface-hover': 'rgba(0, 0, 0, 0.06)',
      '--primary': '#3B82F6',
      '--primary-hover': '#2563EB',
      '--text': '#111827',
      '--text-secondary': '#4B5563',
      '--text-muted': '#9CA3AF',
      '--border': 'rgba(0, 0, 0, 0.08)',
      '--danger': '#DC2626',
      '--warning': '#D97706',
      '--success': '#059669',
      '--radius': '14px',
      '--shadow': '0 4px 24px rgba(0,0,0,0.1)',
      '--header': 'rgba(255, 255, 255, 0.98)',
      '--primary-soft': 'rgba(59, 130, 246, 0.12)',
      '--bubble-ring': '#ffffff',
      '--bubble-shadow': 'rgba(37, 99, 235, 0.28)',
    },
    bubble: {
      size: 44,
      gradient: ['#3B82F6', '#8B5CF6'],
      glow: false,
    },
    panel: { width: 380, maxHeight: 55, opacity: 0.98 },
  },
  {
    id: 'glass',
    name: '毛玻璃',
    variables: {
      '--bg': 'rgba(30, 30, 40, 0.65)',
      '--surface': 'rgba(255, 255, 255, 0.08)',
      '--surface-hover': 'rgba(255, 255, 255, 0.12)',
      '--primary': '#06B6D4',
      '--primary-hover': '#0891B2',
      '--text': '#F1F5F9',
      '--text-secondary': '#CBD5E1',
      '--text-muted': '#94A3B8',
      '--border': 'rgba(255, 255, 255, 0.12)',
      '--danger': '#F87171',
      '--warning': '#FBBF24',
      '--success': '#34D399',
      '--radius': '20px',
      '--shadow': '0 8px 32px rgba(0,0,0,0.2)',
      '--header': 'rgba(30, 30, 40, 0.72)',
      '--primary-soft': 'rgba(6, 182, 212, 0.18)',
      '--bubble-ring': 'rgba(255,255,255,0.2)',
      '--bubble-shadow': 'rgba(6, 182, 212, 0.35)',
    },
    bubble: {
      size: 48,
      gradient: ['#06B6D4', '#8B5CF6'],
      glow: true,
    },
    panel: { width: 400, maxHeight: 60, opacity: 0.75 },
  },
];

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.variables)) {
    root.style.setProperty(key, value);
  }
  root.style.setProperty('--panel-width', `${theme.panel.width}px`);
  root.style.setProperty('--bubble-size', `${theme.bubble.size}px`);
  root.style.setProperty('--bubble-from', theme.bubble.gradient[0]);
  root.style.setProperty('--bubble-to', theme.bubble.gradient[1]);
  root.style.colorScheme = theme.id === 'devon' || theme.id === 'glass' ? 'dark' : 'light';
  document.body.dataset.theme = theme.id;
}
