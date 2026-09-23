// ============================================================
// PromptLens - Core Types
// ============================================================

/** A structured prompt field after normalization */
export interface PromptField {
  key: string;
  label: string;
  value: string;
  status: 'ok' | 'missing' | 'warning';
  editable: boolean;
}

/** The full normalized prompt result */
export interface NormalizedPrompt {
  fields: PromptField[];
  missingCount: number;
  warnings: string[];
  rawPrompt: string;
  skillId: string;
  taskType: string;
}

/** A saved normalization, newest first */
export interface HistoryEntry {
  id: string;
  at: number;
  raw: string;
  hadImage?: boolean;
  skillId: string;
  fields: PromptField[];
  rawPrompt: string;
}

/** Jev-style judgment result */
export interface JudgmentResult {
  taskType: string;
  missingFields: string[];
  complexity: number;          // 0-10
  needsClarification: boolean;
  confidence: number;
}

/** LLM provider config */
export interface LLMConfig {
  provider: 'openai' | 'deepseek' | 'openrouter' | 'custom';
  apiKey: string;
  baseUrl: string;
  judgeModel: string;
  genModel: string;
  /** Used only when a screenshot is attached. Empty means fall back to genModel if it can see images. */
  visionModel: string;
}

/** Project preset */
export interface ProjectPreset {
  id: string;
  name: string;
  techStack: string;
  codeStyle: string;
  outputPref: string;
  commonDirs: string[];
}

/** One turn in the chat page. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
}

/** Quality check item */
export interface CheckItem {
  id: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  passed: boolean;
}
