import type { PromptField } from '../types';

export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function parseNormalizedOutput(markdown: string, streaming = false): PromptField[] {
  const value = stripFences(markdown).trim();
  const status = value ? 'ok' as const : 'missing' as const;
  return [{
    key: 'prompt',
    label: '提示词',
    value: value || (streaming ? '' : ''),
    status,
    editable: true,
  }];
}

export function composePrompt(fields: PromptField[]): string {
  const single = fields.find((field) => field.key === 'prompt');
  if (single) return single.value.trim();
  return fields.map((field) => field.value.trim()).filter(Boolean).join('\n\n');
}

export function missingLabels(fields: PromptField[]): string[] {
  return fields.filter((field) => field.status !== 'ok').map((field) => field.label);
}
