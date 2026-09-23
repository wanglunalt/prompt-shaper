import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ChatTurn, HistoryEntry, LLMConfig, NormalizedPrompt, ProjectPreset } from '../types';
import type { PromptSkill } from '../skills';
import { builtinSkills } from '../skills';
import { builtinThemes, type Theme } from '../themes';
import { PROVIDER_DEFAULTS, testConnection } from '../core/llm';
import { dragScreenshot } from '../core/tauri';
import petIdle from '../assets/pet/idle.png';
import petCling from '../assets/pet/cling.png';
import petSit from '../assets/pet/sit.png';
import petFloat from '../assets/pet/float.png';
import petRun1 from '../assets/pet/run-1.png';
import petRun2 from '../assets/pet/run-2.png';
import petRun3 from '../assets/pet/run-3.png';
import petRun4 from '../assets/pet/run-4.png';

export type PetPose = 'idle' | 'float' | 'cling' | 'sit' | 'run';

const PET_ART: Record<PetPose, string> = {
  idle: petIdle,
  float: petFloat,
  cling: petCling,
  sit: petSit,
  run: petRun1,
};

const RUN_FRAMES = [petRun1, petRun2, petRun3, petRun4];

const SKILL_SHORT: Record<string, string> = {
  'bug-fix': '修复',
  'new-feature': '新功能',
  'refactor': '重构',
  'ui': '页面',
};

type Page = 'compose' | 'settings' | 'history' | 'chat';

interface Anchor { x: number; y: number }
interface Frame { left: number; top: number; width: number; maxHeight: number }

function LensMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.25" fill="none" stroke="white" strokeWidth="2.2" />
      <path d="M15.2 15.2 L20 20" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Icon({ name }: { name: 'gear' | 'close' | 'clock' | 'scan' | 'clip' | 'trash' | 'back' | 'eye' | 'chat' }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      {name === 'close' && <path {...common} d="M6 6 L18 18 M18 6 L6 18" />}
      {name === 'back' && <path {...common} d="M14 6 L8 12 L14 18 M8 12 H20" />}
      {name === 'clock' && (
        <>
          <circle {...common} cx="12" cy="12" r="8" />
          <path {...common} d="M12 8 V12 L15 14" />
        </>
      )}
      {name === 'scan' && (
        <path {...common} d="M7 4 H4 V7 M17 4 H20 V7 M20 17 V20 H17 M7 20 H4 V17 M4 12 H20" />
      )}
      {name === 'clip' && (
        <>
          <rect {...common} x="8" y="7" width="10" height="13" rx="1.5" />
          <path {...common} d="M10 7 V5.5 A2 2 0 0 1 14 5.5 V7" />
        </>
      )}
      {name === 'trash' && (
        <>
          <path {...common} d="M5 7 H19" />
          <path {...common} d="M9 7 V5 H15 V7" />
          <path {...common} d="M7 7 L8 19 H16 L17 7" />
        </>
      )}
      {name === 'gear' && (
        <>
          <circle {...common} cx="12" cy="12" r="3" />
          <path {...common} d="M12 3.5 V6 M12 18 V20.5 M4.8 7.2 L6.8 8.6 M17.2 15.4 L19.2 16.8 M4.8 16.8 L6.8 15.4 M17.2 8.6 L19.2 7.2" />
        </>
      )}
      {name === 'eye' && (
        <>
          <path {...common} d="M2 12 C5 7 8.5 5 12 5 C15.5 5 19 7 22 12 C19 17 15.5 19 12 19 C8.5 19 5 17 2 12 Z" />
          <circle {...common} cx="12" cy="12" r="2.5" />
        </>
      )}
      {name === 'chat' && (
        <>
          <path {...common} d="M5 6 H19 A2 2 0 0 1 21 8 V15 A2 2 0 0 1 19 17 H9 L5 20 V8 A2 2 0 0 1 5 6 Z" />
        </>
      )}
    </svg>
  );
}

function imageFileFromDrop(data: DataTransfer | null): File | null {
  const file = data?.files?.[0];
  if (!file) return null;
  if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
  return null;
}

function startShotDrag(event: ReactPointerEvent, onToast: (message: string) => void) {
  if (event.button !== 0) return;
  event.stopPropagation();
  const startX = event.clientX;
  const startY = event.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    dragScreenshot().catch((error: unknown) => {
      onToast(error instanceof Error ? error.message : '拖出截图失败');
    });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

interface BubbleProps {
  bubbleRef: RefObject<HTMLDivElement | null>;
  position: Anchor;
  onMove: (x: number, y: number) => void;
  onCommit: (x: number, y: number) => void;
  onToggle: () => void;
  imageUrl: string | null;
  dropHot: boolean;
  onImageFile: (file: File) => void;
  onToast: (message: string) => void;
  pose: PetPose;
  scale: number;
  onScale: (deltaY: number) => void;
  onFloat: () => void;
  runStep: number;
  face: 1 | -1;
}

export function Bubble({ bubbleRef, position, onMove, onCommit, onToggle, imageUrl, dropHot, onImageFile, onToast, pose, scale, onScale, onFloat, runStep, face }: BubbleProps) {
  useEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      onScale(event.deltaY);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [bubbleRef, onScale]);
  const handleMouseDown = (e: ReactMouseEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = position.x;
    const origY = position.y;
    let moved = false;
    const handleMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        moved = true;
        onFloat();
      }
      onMove(origX + dx, origY + dy);
    };
    const handleUp = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved) onToggle();
      else onCommit(origX + dx, origY + dy);
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return (
    <div
      ref={bubbleRef}
      className={`pulse-bubble pet pose-${pose}${face < 0 ? ' face-left' : ''}${dropHot ? ' drop-hot' : ''}`}
      style={{ left: position.x, top: position.y, width: 156 * scale, height: 168 * scale }}
      onMouseDown={handleMouseDown}
      title="点一下打开。松开后绕着窗口跑，窗口挨在一起会跑过去。贴上下沿才坐下。滚轮改大小"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(e) => {
        e.preventDefault();
        const file = imageFileFromDrop(e.dataTransfer);
        if (file) onImageFile(file);
      }}
    >
      <img className="pet-art" src={pose === 'run' ? RUN_FRAMES[runStep % 4] : PET_ART[pose]} alt="太空小熊" draggable={false} />
      {imageUrl && (
        <img
          className="bubble-shot"
          src={imageUrl}
          alt="已放入的截图"
          title="按住拖出气泡"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => startShotDrag(e, onToast)}
        />
      )}
    </div>
  );
}

interface PanelProps {
  panelRef: RefObject<HTMLDivElement | null>;
  frame: Frame;
  anchor: Anchor;
  onMove: (x: number, y: number) => void;
  onCommit: (x: number, y: number) => void;
  page: Page;
  onPage: (page: Page) => void;
  rawInput: string;
  onRawInputChange: (v: string) => void;
  imageUrl: string | null;
  onClearImage: () => void;
  onImageFile: (file: File) => void;
  skill: PromptSkill;
  onSkillChange: (s: PromptSkill) => void;
  result: NormalizedPrompt | null;
  onFieldChange: (index: number, value: string) => void;
  loading: boolean;
  error: string | null;
  hints: string[];
  onNormalize: () => void;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onToast: (message: string) => void;
  onOcr: () => void;
  clipboardWatch: boolean;
  onClipboardToggle: () => void;
  history: HistoryEntry[];
  onRestore: (entry: HistoryEntry) => void;
  onClearHistory: () => void;
  llmConfig: LLMConfig;
  onLlmConfig: (config: LLMConfig) => void;
  onSaveConfig: () => void;
  presets: ProjectPreset[];
  activePresetId: string;
  onPresets: (items: ProjectPreset[]) => void;
  onActivePreset: (id: string) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  dropHot: boolean;
  chat: ChatTurn[];
  chatInput: string;
  onChatInput: (value: string) => void;
  onSendChat: () => void;
  chatLoading: boolean;
  chatError: string | null;
  chatImage: string | null;
  onChatImageFile: (file: File) => void;
  onClearChatImage: () => void;
}

export function Panel(props: PanelProps) {
  const {
    panelRef, frame, anchor, onMove, onCommit, page, onPage,
  } = props;

  const handleHeaderDown = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = anchor;
    const move = (ev: MouseEvent) => onMove(orig.x + ev.clientX - startX, orig.y + ev.clientY - startY);
    const up = (ev: MouseEvent) => {
      onCommit(orig.x + ev.clientX - startX, orig.y + ev.clientY - startY);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      ref={panelRef}
      className={`panel${props.dropHot ? ' drop-hot' : ''}${page === 'chat' ? ' chat-panel' : ''}`}
      style={{ left: frame.left, top: frame.top, width: frame.width, maxHeight: frame.maxHeight }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(e) => {
        e.preventDefault();
        const file = imageFileFromDrop(e.dataTransfer);
        if (!file) return;
        if (page === 'chat') props.onChatImageFile(file);
        else props.onImageFile(file);
      }}
    >
      <div className="panel-header" onMouseDown={handleHeaderDown}>
        <div className="panel-title">
          <span className="title-mark"><LensMark /></span>
          <span>{page === 'settings' ? '设置' : page === 'history' ? '最近生成' : page === 'chat' ? '对话' : '提示词整形'}</span>
          {props.clipboardWatch && <span className="watch-dot" title="剪贴板监听中" />}
        </div>
        <div className="panel-actions">
          {page !== 'compose' ? (
            <button className="icon-btn" title="返回" onClick={() => onPage('compose')}><Icon name="back" /></button>
          ) : (
            <>
              <button className="icon-btn" title="最近生成" onClick={() => onPage('history')}><Icon name="clock" /></button>
              <button className="icon-btn" title="设置" onClick={() => onPage('settings')}><Icon name="gear" /></button>
            </>
          )}
          <button className="icon-btn" title="收起" onClick={props.onClose}><Icon name="close" /></button>
        </div>
      </div>

      {page === 'compose' && <Compose {...props} />}
      {page === 'chat' && (
        <Chat
          chat={props.chat}
          input={props.chatInput}
          onInput={props.onChatInput}
          onSend={props.onSendChat}
          loading={props.chatLoading}
          error={props.chatError}
          image={props.chatImage}
          onClearImage={props.onClearChatImage}
        />
      )}
      {page === 'settings' && (
        <Settings
          llmConfig={props.llmConfig}
          onLlmConfig={props.onLlmConfig}
          onSaveConfig={props.onSaveConfig}
          presets={props.presets}
          activePresetId={props.activePresetId}
          onPresets={props.onPresets}
          onActivePreset={props.onActivePreset}
          theme={props.theme}
          onTheme={props.onTheme}
          clipboardWatch={props.clipboardWatch}
          onClipboardToggle={props.onClipboardToggle}
        />
      )}
      {page === 'history' && (
        <HistoryList history={props.history} onRestore={props.onRestore} onClear={props.onClearHistory} />
      )}
    </div>
  );
}

function Compose(props: PanelProps) {
  const promptText = props.result?.fields.map((field) => field.value.trim()).filter(Boolean).join('\n\n') ?? '';
  return (
    <>
      <div className="skill-row">
        {builtinSkills.map((s) => (
          <button
            key={s.id}
            className={`skill-chip ${props.skill.id === s.id ? 'active' : ''}`}
            title={s.description}
            onClick={() => props.onSkillChange(s)}
          >
            {SKILL_SHORT[s.id] ?? s.name}
          </button>
        ))}
      </div>

      <div className="input-wrap">
        {props.imageUrl && (
          <div className="shot-preview">
            <img
              src={props.imageUrl}
              alt="截图预览"
              title="按住拖出气泡"
              draggable={false}
              onPointerDown={(e) => startShotDrag(e, props.onToast)}
            />
            <span className="shot-hint">按住图片拖出气泡</span>
            <button type="button" className="shot-remove" onClick={props.onClearImage}>移除</button>
          </div>
        )}
        <textarea
          className="raw-input"
          placeholder="说一句需求，或把截图拖进来。例如：修复这个 bug"
          value={props.rawInput}
          onChange={(e) => props.onRawInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) props.onNormalize();
          }}
        />
        <div className="input-kbd"><span className="kbd">Ctrl</span><span className="kbd">Enter</span></div>
      </div>

      <div className="tool-row">
        <button className="text-btn" onClick={() => props.onPage('chat')}><Icon name="chat" />对话</button>
        <span className="tool-gap" />
        <button className="icon-btn" title="框选并识别文字" onClick={props.onOcr}><Icon name="scan" /></button>
        <button
          className={`icon-btn ${props.clipboardWatch ? 'on' : ''}`}
          title={props.clipboardWatch ? '关闭跟随输入' : '开启跟随输入'}
          onClick={props.onClipboardToggle}
        >
          <Icon name="clip" />
        </button>
        <button className="icon-btn" title="清空" onClick={() => { props.onRawInputChange(''); props.onClearImage(); }} disabled={!props.rawInput && !props.imageUrl}>
          <Icon name="trash" />
        </button>
      </div>

      <button className="primary-btn block" onClick={props.onNormalize} disabled={props.loading || (!props.rawInput.trim() && !props.imageUrl)}>
        {props.loading && <span className="spinner" />}
        {props.loading ? '正在输出' : '规范化'}
      </button>

      {!props.loading && !props.result && props.hints.length > 0 && (
        <p className="hint-line">可能缺少：{props.hints.join('、')}。可以直接生成。</p>
      )}
      {props.error && <div className="error-box">{props.error}</div>}

      {props.loading && !props.result?.fields.some((f) => f.value.trim()) && (
        <p className="hint-line">正在输出…</p>
      )}
      {promptText && (
        <div className="result-block">
          <textarea
            className="prompt-edit"
            value={promptText}
            onChange={(e) => props.onFieldChange(0, e.target.value)}
          />
          <div className="result-actions">
            <button className="primary-btn block" onClick={props.onPaste}>填入上一个窗口</button>
            <button className="ghost-btn" onClick={props.onCopy}>复制</button>
          </div>
        </div>
      )}
    </>
  );
}

function Settings(props: {
  llmConfig: LLMConfig;
  onLlmConfig: (config: LLMConfig) => void;
  onSaveConfig: () => void;
  presets: ProjectPreset[];
  activePresetId: string;
  onPresets: (items: ProjectPreset[]) => void;
  onActivePreset: (id: string) => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  clipboardWatch: boolean;
  onClipboardToggle: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [savedTip, setSavedTip] = useState('');
  const [testing, setTesting] = useState(false);
  const [testTip, setTestTip] = useState<{ ok: boolean; text: string } | null>(null);
  const active = props.presets.find((p) => p.id === props.activePresetId) ?? null;

  const patchPreset = (patch: Partial<ProjectPreset>) => {
    if (!active) return;
    props.onPresets(props.presets.map((p) => (p.id === active.id ? { ...p, ...patch } : p)));
  };

  return (
    <div className="settings-body">
      <div className="section-label">外观</div>
      <div className="theme-row">
        {builtinThemes.map((t) => (
          <button
            key={t.id}
            className={`theme-dot ${props.theme.id === t.id ? 'active' : ''}`}
            style={{ background: t.variables['--primary'] }}
            title={t.name}
            onClick={() => props.onTheme(t)}
          />
        ))}
      </div>

      <div className="setting-row">
        <label>接口</label>
        <div className="seg">
          {(['openrouter', 'deepseek', 'openai', 'custom'] as const).map((id) => (
            <button
              key={id}
              className={`skill-chip ${props.llmConfig.provider === id ? 'active' : ''}`}
              onClick={() => {
                const defaults = id === 'custom' ? null : PROVIDER_DEFAULTS[id];
                props.onLlmConfig({
                  ...props.llmConfig,
                  provider: id,
                  ...(defaults ?? {}),
                });
              }}
            >
              {id === 'openrouter' ? 'OpenRouter' : id === 'deepseek' ? 'DeepSeek' : id === 'openai' ? 'OpenAI' : '自定义'}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <label>Base URL</label>
        <input
          type="text"
          value={props.llmConfig.baseUrl}
          onChange={(e) => props.onLlmConfig({ ...props.llmConfig, baseUrl: e.target.value })}
        />
      </div>
      <div className="setting-row">
        <label>API Key</label>
        <div className="key-line">
          <input
            type={showKey ? 'text' : 'password'}
            value={props.llmConfig.apiKey}
            placeholder="sk-..."
            onChange={(e) => props.onLlmConfig({ ...props.llmConfig, apiKey: e.target.value })}
          />
          <button className="icon-btn" title={showKey ? '隐藏' : '显示'} onClick={() => setShowKey((v) => !v)}>
            <Icon name="eye" />
          </button>
        </div>
      </div>
      <div className="setting-row">
        <label>模型</label>
        <input
          type="text"
          value={props.llmConfig.genModel}
          onChange={(e) => props.onLlmConfig({ ...props.llmConfig, genModel: e.target.value })}
        />
        <p className="hint-text">没有截图时用这个模型整理文字。</p>
      </div>
      <div className="setting-row">
        <label>识图模型</label>
        <input
          type="text"
          value={props.llmConfig.visionModel}
          placeholder="openai/gpt-4o-mini"
          onChange={(e) => props.onLlmConfig({ ...props.llmConfig, visionModel: e.target.value })}
        />
        <p className="hint-text">有截图时自动改用这个模型。OpenRouter 可填 openai/gpt-4o-mini。DeepSeek 官方接口不能识图。</p>
      </div>
      <div className="setting-row">
        <button
          type="button"
          className="ghost-btn test-btn"
          disabled={testing}
          onClick={() => {
            setTesting(true);
            setTestTip(null);
            testConnection(props.llmConfig)
              .then((text) => setTestTip({ ok: true, text }))
              .catch((error: unknown) => setTestTip({
                ok: false,
                text: error instanceof Error ? error.message : '连接失败',
              }))
              .finally(() => setTesting(false));
          }}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {testTip && <p className={`test-status ${testTip.ok ? 'ok' : 'bad'}`}>{testTip.text}</p>}
        <p className="hint-text">用当前的 Base URL、API Key 和文字模型发一条短消息，不会改动已保存的配置。</p>
      </div>
      <div className="setting-row">
        <label>跟随输入</label>
        <p className="hint-text">开启后，读取 Alacritty 里 Grok 正在写的那一行，写多少就润色多少，继续输入会按最新内容重写。也会读取 Cursor，以及复制的文字和截图。</p>
        <button className={`toggle-btn ${props.clipboardWatch ? 'on' : ''}`} onClick={props.onClipboardToggle}>
          {props.clipboardWatch ? '已开启' : '已关闭'}
        </button>
      </div>

      <div className="section-label">项目背景</div>
      <div className="preset-list">
        <button
          className={`skill-chip ${props.activePresetId === '' ? 'active' : ''}`}
          onClick={() => props.onActivePreset('')}
        >
          不使用
        </button>
        {props.presets.map((p) => (
          <button
            key={p.id}
            className={`skill-chip ${props.activePresetId === p.id ? 'active' : ''}`}
            onClick={() => props.onActivePreset(p.id)}
          >
            {p.name || '未命名'}
          </button>
        ))}
      </div>
      <button
        className="text-btn"
        onClick={() => {
          const id = `${Date.now()}`;
          props.onPresets([...props.presets, {
            id, name: '当前项目', techStack: '', codeStyle: '', outputPref: '', commonDirs: [],
          }]);
          props.onActivePreset(id);
        }}
      >
        添加一份背景
      </button>
      {active && (
        <>
          <div className="setting-row">
            <label>名称</label>
            <input value={active.name} onChange={(e) => patchPreset({ name: e.target.value })} />
          </div>
          <div className="setting-row">
            <label>技术栈</label>
            <input value={active.techStack} onChange={(e) => patchPreset({ techStack: e.target.value })} />
          </div>
          <div className="setting-row">
            <label>代码风格</label>
            <input value={active.codeStyle} onChange={(e) => patchPreset({ codeStyle: e.target.value })} />
          </div>
          <div className="setting-row">
            <label>输出偏好</label>
            <input value={active.outputPref} onChange={(e) => patchPreset({ outputPref: e.target.value })} />
          </div>
          <div className="setting-row">
            <label>常用目录，用逗号分隔</label>
            <input
              key={active.id}
              defaultValue={active.commonDirs.join(', ')}
              onChange={(e) => patchPreset({
                commonDirs: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
              })}
            />
          </div>
          <button
            className="text-btn"
            onClick={() => {
              props.onPresets(props.presets.filter((p) => p.id !== active.id));
              props.onActivePreset('');
            }}
          >
            删除这份背景
          </button>
        </>
      )}

      {savedTip && <p className="saved-tip">{savedTip}</p>}
      <button
        className="primary-btn block"
        onClick={() => {
          props.onSaveConfig();
          setSavedTip('已保存');
        }}
      >
        保存
      </button>
      <p className="hint-text">Ctrl+Shift+P 显示或隐藏。Ctrl+Shift+O 框选识别。Esc 返回或收起。</p>
    </div>
  );
}

function HistoryList(props: { history: HistoryEntry[]; onRestore: (entry: HistoryEntry) => void; onClear: () => void }) {
  if (props.history.length === 0) {
    return <div className="history-body"><p className="empty-note">还没有生成记录</p></div>;
  }
  return (
    <div className="history-body">
      {props.history.map((entry) => {
        const skill = builtinSkills.find((s) => s.id === entry.skillId);
        const d = new Date(entry.at);
        const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return (
          <button key={entry.id} className="history-item" onClick={() => props.onRestore(entry)}>
            <span className="history-title">{entry.raw.replace(/\s+/g, ' ').slice(0, 48)}</span>
            <span className="history-meta">{skill?.name ?? '提示词'}{entry.hadImage ? ' · 含截图' : ''} · {stamp}</span>
          </button>
        );
      })}
      <button className="text-btn" onClick={props.onClear}>清空记录</button>
    </div>
  );
}

function Chat(props: {
  chat: ChatTurn[];
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  loading: boolean;
  error: string | null;
  image: string | null;
  onClearImage: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [props.chat, props.loading]);

  return (
    <div className="chat-body">
      <div className="chat-log">
        {props.chat.length === 0 && (
          <p className="hint-line">直接提问，也可以把图片拖进来。有图时用识图模型回答。</p>
        )}
        {props.chat.map((turn) => (
          <div key={turn.id} className={`chat-msg ${turn.role}`}>
            {turn.image && <img className="chat-shot" src={turn.image} alt="发送的图片" />}
            {turn.content || (turn.role === 'assistant' && props.loading ? '正在回答…' : '')}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {props.error && <div className="error-box">{props.error}</div>}
      {props.image && (
        <div className="shot-preview chat-pending">
          <img src={props.image} alt="待发送的图片" />
          <span className="shot-hint">松手已放入，和问题一起发送</span>
          <button type="button" className="shot-remove" onClick={props.onClearImage}>移除</button>
        </div>
      )}
      <div className="chat-compose">
        <textarea
          className="raw-input chat-input"
          placeholder="输入问题，或把图片拖进来。Enter 发送"
          value={props.input}
          onChange={(e) => props.onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              props.onSend();
            }
          }}
        />
        <button className="primary-btn chat-send" onClick={props.onSend} disabled={props.loading || (!props.input.trim() && !props.image)}>
          {props.loading ? '回答中' : '发送'}
        </button>
      </div>
    </div>
  );
}

interface Box { x: number; y: number; w: number; h: number }

export function OcrOverlay(props: {
  tip: string;
  box: Box | null;
  onStart: (x: number, y: number) => void;
  onMove: (x: number, y: number) => void;
  onEnd: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="ocr-overlay"
      onMouseDown={(e) => props.onStart(e.clientX, e.clientY)}
      onMouseMove={(e) => props.onMove(e.clientX, e.clientY)}
      onMouseUp={(e) => {
        if ((e.target as HTMLElement).closest('.ocr-exit')) return;
        props.onEnd();
      }}
    >
      {props.box && (
        <>
          <div className="ocr-select-box" style={{ left: props.box.x, top: props.box.y, width: props.box.w, height: props.box.h }} />
          <div className="ocr-size" style={{ left: props.box.x, top: props.box.y + props.box.h + 6 }}>
            {Math.round(props.box.w)} × {Math.round(props.box.h)}
          </div>
        </>
      )}
      <div className="ocr-hint">{props.tip}</div>
      <button className="ocr-exit" onMouseDown={(e) => e.stopPropagation()} onClick={props.onCancel}>取消</button>
    </div>
  );
}

export type { Page };
