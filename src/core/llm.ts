// ============================================================
// PromptLens - LLM Client
// ============================================================

import type { LLMConfig } from '../types';
import type { PromptSkill } from '../skills';
import { stripFences } from './prompt';

const STORAGE_KEY = 'promptlens_llm_config';

export const PROVIDER_DEFAULTS: Record<Exclude<LLMConfig['provider'], 'custom'>, { baseUrl: string; genModel: string; visionModel: string }> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', genModel: 'deepseek/deepseek-chat-v3.1', visionModel: 'openai/gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', genModel: 'deepseek-chat', visionModel: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', genModel: 'gpt-4o-mini', visionModel: 'gpt-4o-mini' },
};

function fallbackConfig(): LLMConfig {
  return {
    provider: 'openrouter',
    apiKey: '',
    baseUrl: PROVIDER_DEFAULTS.openrouter.baseUrl,
    judgeModel: 'typesafe/jev-1.13',
    genModel: PROVIDER_DEFAULTS.openrouter.genModel,
    visionModel: PROVIDER_DEFAULTS.openrouter.visionModel,
  };
}

export function loadLLMConfig(): LLMConfig {
  const fallback = fallbackConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LLMConfig>;
    const provider = parsed.provider ?? fallback.provider;
    const defaults = provider === 'custom' ? null : PROVIDER_DEFAULTS[provider];
    return {
      ...fallback,
      ...parsed,
      provider,
      visionModel: parsed.visionModel ?? defaults?.visionModel ?? '',
    };
  } catch {
    return fallback;
  }
}

export function saveLLMConfig(config: LLMConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function canSeeImages(model: string): boolean {
  return /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|pixtral|llava|qwen[\w.-]*vl|grok-4|grok-2-vision/i.test(model);
}

/** Text model stays as-is. Screenshots use the vision model when one is set. */
export function resolveModel(config: LLMConfig, hasImage: boolean): string {
  if (!hasImage) return config.genModel.trim();
  const vision = config.visionModel?.trim();
  if (vision) return vision;
  if (canSeeImages(config.genModel)) return config.genModel.trim();
  throw new Error('当前模型不能识别截图。请在设置里填写识图模型，例如 gpt-4o-mini。');
}

/** Local hint only. Does not block generation. */
export function previewMissing(input: string, hasImage = false): string[] {
  const text = input.trim();
  if (!text && !hasImage) return [];
  const missing: string[] = [];
  if (!/(react|vue|angular|python|java|golang|\bgo\b|rust|typescript|javascript|node|next|tauri|svelte)/i.test(text)) {
    missing.push('技术栈');
  }
  if (!/\.(tsx?|jsx?|py|java|go|rs|css|html|vue|json)\b/i.test(text) && !/(文件|路径|src\/)/.test(text)) {
    missing.push('文件路径');
  }
  if (!hasImage && /(报错|bug|崩溃|error|exception|失败|not working)/i.test(text) && !/(at\s+\S+|stack|堆栈|异常[:：])/i.test(text)) {
    missing.push('报错原文');
  }
  return missing;
}

export async function normalizePrompt(
  rawInput: string,
  skill: PromptSkill,
  config: LLMConfig,
  projectContext: string,
  imageDataUrl?: string | null,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { buildSystemPrompt } = await import('../skills');
  const systemPrompt = buildSystemPrompt(skill);
  const userText = [
    projectContext.trim() ? `项目背景：\n${projectContext.trim()}` : '',
    `开发者原始输入：\n${rawInput.trim() || '请分析截图中的问题，并整理成结构化开发任务'}`,
  ].filter(Boolean).join('\n\n');
  const userContent = imageDataUrl
    ? [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: userText },
      ]
    : userText;

  if (!config.apiKey.trim()) {
    const fallback = buildFallbackPrompt(rawInput, Boolean(imageDataUrl));
    onDelta?.(fallback);
    return fallback;
  }

  const model = resolveModel(config, Boolean(imageDataUrl));
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 900,
    stream: true,
  };
  if (/qwen/i.test(model) || /aliyuncs|dashscope|maas/i.test(config.baseUrl)) {
    body.enable_thinking = false;
  }

  let res: Response;
  try {
    res = await fetch(completionsUrl(config.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    throw new Error('无法连接接口，请检查 Base URL 和网络');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message = readApiError(data, res.status);
    if (imageDataUrl && /image|vision|multimodal|unsupported content/i.test(message)) {
      throw new Error(`${message}。请把识图模型换成 gpt-4o-mini 或 gemini-flash。`);
    }
    throw new Error(message);
  }

  const text = await readStreamedContent(res, onDelta);
  if (!text.trim()) throw new Error('模型没有返回内容');
  return stripFences(text);
}

export async function chatWithModel(
  config: LLMConfig,
  turns: { role: 'user' | 'assistant'; content: string; image?: string }[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!config.baseUrl.trim()) throw new Error('请先填写 Base URL');
  if (!config.apiKey.trim()) throw new Error('请先在设置里填写 API Key');
  const hasImage = turns.some((turn) => turn.image);
  if (!hasImage && !config.genModel.trim()) throw new Error('请先填写模型');
  const model = resolveModel(config, hasImage);
  const messages = [
    { role: 'system', content: '你是对话助手。直接回答用户的问题，使用用户的语言。不要改写成开发提示词，不要加固定标题。有图片时根据图片内容回答。' },
    ...turns
      .filter((turn) => turn.content.trim() || turn.image)
      .map((turn) => {
        if (turn.role === 'user' && turn.image) {
          return {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: turn.image } },
              { type: 'text', text: turn.content.trim() || '请看这张图片。' },
            ],
          };
        }
        return { role: turn.role, content: turn.content };
      }),
  ];
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: 1400,
    stream: true,
  };
  if (/qwen/i.test(model) || /aliyuncs|dashscope|maas/i.test(config.baseUrl)) {
    body.enable_thinking = false;
  }
  let res: Response;
  try {
    res = await fetch(completionsUrl(config.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new Error('无法连接接口，请检查 Base URL 和网络');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(readApiError(data, res.status));
  }
  const text = await readStreamedContent(res, onDelta);
  if (!text.trim()) throw new Error('模型没有返回内容');
  return text.trim();
}

export async function testConnection(config: LLMConfig): Promise<string> {
  if (!config.baseUrl.trim()) throw new Error('请先填写 Base URL');
  if (!config.apiKey.trim()) throw new Error('请先填写 API Key');
  if (!config.genModel.trim()) throw new Error('请先填写模型');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(completionsUrl(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.genModel.trim(),
        messages: [{ role: 'user', content: '回复：好' }],
        temperature: 0,
        max_tokens: 16,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(readApiError(data, res.status));
    const text = data?.choices?.[0]?.message?.content
      || data?.choices?.[0]?.message?.reasoning_content
      || data?.output?.text;
    if (!text || typeof text !== 'string') throw new Error('接口已连通，但模型没有返回内容');
    return `连接成功，${config.genModel.trim()} 已响应`;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('连接超时，请检查 Base URL 和网络');
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接接口，请检查 Base URL 和网络');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readStreamedContent(res: Response, onDelta?: (text: string) => void): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) onDelta?.(text);
    return typeof text === 'string' ? text : '';
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let sse = false;

  const push = (piece: string) => {
    if (!piece) return;
    full += piece;
    onDelta?.(full);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (!sse && /^\s*data:/m.test(buffer)) sse = true;
    if (!sse) continue;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) push(deltaFromSseLine(line));
  }

  if (!sse) {
    try {
      const data = JSON.parse(buffer);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string') {
        onDelta?.(text);
        return text;
      }
    } catch {
      return '';
    }
    return '';
  }

  push(deltaFromSseLine(buffer));
  return full;
}

function deltaFromSseLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload);
    const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? '';
    return typeof delta === 'string' ? delta : '';
  } catch {
    return '';
  }
}

function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function readApiError(data: { error?: { message?: string }; message?: string } | null, status: number): string {
  return data?.error?.message || data?.message || `接口返回 ${status}`;
}

function buildFallbackPrompt(rawInput: string, hasImage: boolean): string {
  const task = rawInput.trim() || '分析截图中的问题';
  const shot = hasImage ? '已附上截图。未配置 API Key，无法读取图中的报错原文。' : '';
  return [
    `请处理这个开发任务：${task}`,
    shot,
    '只改当前问题涉及的模块，不要改无关逻辑。文件路径、接口字段和报错原文若没有依据，写「待确认」，不要编造。',
    '完成后应能确认问题消失，原有功能仍然可用。',
  ].filter(Boolean).join('\n\n');
}
