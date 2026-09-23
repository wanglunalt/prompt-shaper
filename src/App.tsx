import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { Bubble, Panel, OcrOverlay, type Page, type PetPose } from './components/FloatingUI';
import { builtinSkills, matchSkill, type PromptSkill } from './skills';
import { builtinThemes, applyTheme, type Theme } from './themes';
import { previewMissing, loadLLMConfig, saveLLMConfig, normalizePrompt, chatWithModel } from './core/llm';
import { composePrompt, missingLabels, parseNormalizedOutput } from './core/prompt';
import {
  loadHistory, saveHistory, loadPresets, savePresets,
  loadActivePresetId, saveActivePresetId, formatProjectContext,
} from './core/storage';
import {
  isTauri, setClipboardEnabled, onClipboardText, onClipboardImage, onDraftText, revealOverlay, captureAndOcr,
  pasteToFocusedWindow, onStartOcr, updateHitRects, setForceCapture, copyToClipboard, stageDragImage,
  onFileDrop, readDroppedImage, windowUnderCursor, trackedWindowRect, listWindows,
} from './core/tauri';
import { advanceRail, headingFromMove, nearestRail, placeOnRail, type Heading, type RailCursor } from './core/petRun';
import type { WindowBox } from './core/tauri';
import { compactImage, DEFAULT_SHOT_PROMPT, imageFileFromClipboard, readImageFile } from './core/image';
import type { ChatTurn, HistoryEntry, LLMConfig, NormalizedPrompt, ProjectPreset } from './types';
import './App.css';

const PET_W = 156;
const PET_H = 168;
const PET_SCALE_KEY = 'promptlens_pet_scale';

function loadPetScale() {
  const saved = Number(localStorage.getItem(PET_SCALE_KEY));
  if (Number.isFinite(saved)) return Math.min(1.15, Math.max(0.4, saved));
  return 0.62;
}

function clampAnchor(x: number, y: number, vw: number, vh: number, petW = PET_W) {
  return {
    x: Math.min(Math.max(-24, x), Math.max(8, vw - petW + 24)),
    y: Math.min(Math.max(-40, y), Math.max(8, vh - 80)),
  };
}

function panelFrame(anchor: { x: number; y: number }, vw: number, vh: number, width: number, petW: number) {
  const margin = 16;
  let left = anchor.x + petW + 12;
  if (left + width > vw - margin) left = anchor.x - width - 12;
  if (left < margin) left = margin;
  const maxHeight = Math.min(640, Math.max(240, vh - margin * 2));
  let top = anchor.y - 8;
  if (top + maxHeight > vh - margin) top = vh - margin - maxHeight;
  if (top < margin) top = margin;
  return { left, top, width, maxHeight };
}

function loadBubblePos() {
  try {
    const saved = localStorage.getItem('promptlens_pos');
    if (saved) {
      const p = JSON.parse(saved) as { x?: number; y?: number };
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return clampAnchor(p.x, p.y, window.innerWidth, window.innerHeight);
      }
    }
  } catch { /* ignore */ }
  return clampAnchor(window.innerWidth - PET_W - 24, Math.round(window.innerHeight * 0.28), window.innerWidth, window.innerHeight);
}

function loadTheme(): Theme {
  const azure = builtinThemes.find((item) => item.id === 'azure') ?? builtinThemes[0];
  if (!localStorage.getItem('promptlens_theme_v2')) {
    localStorage.setItem('promptlens_theme_v2', '1');
    localStorage.setItem('promptlens_theme', azure.id);
    return azure;
  }
  const saved = localStorage.getItem('promptlens_theme');
  return builtinThemes.find((item) => item.id === saved) ?? azure;
}

function toResult(fields: NormalizedPrompt['fields'], skillId: string, rawPrompt: string): NormalizedPrompt {
  const warnings = missingLabels(fields);
  return {
    fields,
    missingCount: warnings.length,
    warnings,
    rawPrompt,
    skillId,
    taskType: skillId,
  };
}

function App() {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<Page>('compose');
  const expandedRef = useRef(false);
  const pageRef = useRef<Page>('compose');
  expandedRef.current = expanded;
  pageRef.current = page;
  const [bubblePos, setBubblePos] = useState(loadBubblePos);
  const [pose, setPose] = useState<PetPose>('run');
  const [runStep, setRunStep] = useState(0);
  const runStepRef = useRef(0);
  const [face, setFace] = useState<1 | -1>(1);
  const faceRef = useRef<1 | -1>(1);
  const bubblePosRef = useRef(bubblePos);
  bubblePosRef.current = bubblePos;
  const [petScale, setPetScale] = useState(loadPetScale);
  const hostRef = useRef<{ hwnd: number; mode: 'cling' | 'sit'; dx: number } | null>(null);
  const scaleRef = useRef(petScale);
  scaleRef.current = petScale;
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [rawInput, setRawInput] = useState('');
  const [pinnedSkill, setPinnedSkill] = useState<PromptSkill | null>(null);
  const [result, setResult] = useState<NormalizedPrompt | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(loadTheme);
  const [llmConfig, setLlmConfig] = useState<LLMConfig>(loadLLMConfig);
  const [clipboardWatch, setClipboardWatch] = useState(() => localStorage.getItem('promptlens_clipboard_watch') === 'true');
  const [dropHot, setDropHot] = useState(false);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatImage, setChatImage] = useState<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const dropLock = useRef(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [visionTick, setVisionTick] = useState(0);
  const [draftTick, setDraftTick] = useState(0);
  const rawMirror = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(0);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [presets, setPresets] = useState<ProjectPreset[]>(loadPresets);
  const [activePresetId, setActivePresetId] = useState(loadActivePresetId);
  const [ocrMode, setOcrMode] = useState(false);
  const [ocrTip, setOcrTip] = useState('拖动框选，松开后识别文字');
  const [selectBox, setSelectBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [toast, setToast] = useState('');
  const selectStart = useRef<{ x: number; y: number } | null>(null);
  const selectBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<string | null>(null);
  const visionPending = useRef(false);
  const ocrBusy = useRef(false);

  const frame = useMemo(
    () => panelFrame(bubblePos, viewport.w, viewport.h, theme.panel.width, PET_W * petScale),
    [bubblePos, viewport, theme.panel.width, petScale],
  );
  const hints = useMemo(() => previewMissing(rawInput, Boolean(imageUrl)), [rawInput, imageUrl]);
  const skill = pinnedSkill ?? matchSkill(rawInput);

  useEffect(() => { applyTheme(theme); }, [theme]);

  useEffect(() => {
    if (clipboardWatch && isTauri()) void setClipboardEnabled(true);
  }, [clipboardWatch]);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const showToastMsg = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2500);
  }, []);

  const moveAnchor = useCallback((x: number, y: number) => {
    setBubblePos(clampAnchor(x, y, window.innerWidth, window.innerHeight, PET_W * scaleRef.current));
  }, []);

  const commitAnchor = useCallback((x: number, y: number) => {
    const next = clampAnchor(x, y, window.innerWidth, window.innerHeight, PET_W * scaleRef.current);
    setBubblePos(next);
    localStorage.setItem('promptlens_pos', JSON.stringify(next));
  }, []);

  const changePetScale = useCallback((deltaY: number) => {
    setPetScale((current) => {
      const next = Math.min(1.15, Math.max(0.4, current + (deltaY > 0 ? -0.06 : 0.06)));
      localStorage.setItem(PET_SCALE_KEY, String(next));
      return next;
    });
  }, []);

  const petSize = () => ({ w: PET_W * scaleRef.current, h: PET_H * scaleRef.current });

  const settlePet = useCallback((x: number, y: number) => {
    void (async () => {
      const { w, h } = petSize();
      const info = await windowUnderCursor();
      const gripY = y + h * 0.45;
      const edge = Math.max(32, h * 0.28);
      const overWindow = Boolean(info)
        && x + w / 2 > info!.x
        && x + w / 2 < info!.x + info!.w;
      const distTop = info ? Math.abs(gripY - info.y) : Infinity;
      const distBottom = info ? Math.abs(gripY - (info.y + info.h)) : Infinity;
      const mode = overWindow && distTop <= edge && distTop <= distBottom
        ? 'cling'
        : overWindow && distBottom <= edge
          ? 'sit'
          : null;
      if (!info || !mode) {
        hostRef.current = null;
        setPose('run');
        commitAnchor(x, y);
        return;
      }
      const dx = Math.min(Math.max(w * 0.35, x + w / 2 - info.x), Math.max(w * 0.35, info.w - w * 0.35));
      hostRef.current = { hwnd: info.hwnd, mode, dx };
      setPose(mode);
      const next = clampAnchor(
        info.x + dx - w / 2,
        mode === 'cling' ? info.y - h * 0.46 : info.y + info.h - h * 0.64,
        window.innerWidth,
        window.innerHeight,
        w,
      );
      setBubblePos(next);
      localStorage.setItem('promptlens_pos', JSON.stringify(next));
    })();
  }, [commitAnchor]);

  useEffect(() => {
    if (pose !== 'cling' && pose !== 'sit') return;
    const timer = window.setInterval(() => {
      const host = hostRef.current;
      if (!host) return;
      void trackedWindowRect(host.hwnd).then((info) => {
        if (!info) {
          hostRef.current = null;
          setPose('run');
          return;
        }
        const { w, h } = petSize();
        const next = clampAnchor(
          info.x + host.dx - w / 2,
          host.mode === 'cling' ? info.y - h * 0.46 : info.y + info.h - h * 0.64,
          window.innerWidth,
          window.innerHeight,
          w,
        );
        setBubblePos(next);
      });
    }, 90);
    return () => window.clearInterval(timer);
  }, [pose]);

  const windowsRef = useRef<WindowBox[]>([]);

  useEffect(() => {
    if (pose !== 'run' || expanded || !isTauri()) return;
    let stop = false;
    const pull = () => {
      void listWindows().then((wins) => {
        if (!stop) windowsRef.current = wins;
      });
    };
    pull();
    const timer = window.setInterval(pull, 420);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [pose, expanded]);

  useEffect(() => {
    if (pose !== 'run' || expanded) return;
    let raf = 0;
    let last = performance.now();
    let speed = 0.05;
    let carry = 0;
    let spin = 0;
    let cursor: RailCursor | null = null;
    const holds = [18, 14, 18, 24];
    const boost = [0.74, 1.05, 0.78, 1.32];
    const applyHeading = (heading: Heading, dt: number) => {
      const target = heading === 'down' ? 90 : heading === 'up' ? -90 : 0;
      if (Math.abs(target - spin) > 1) spin += (target - spin) * Math.min(1, dt / 150);
      else spin = target;
      const flip = heading === 'left' && Math.abs(spin) < 14 ? -1 : 1;
      const face: 1 | -1 = heading === 'left' ? -1 : 1;
      if (faceRef.current !== face) {
        faceRef.current = face;
        setFace(face);
      }
      bubbleRef.current?.style.setProperty('--run-spin', `${spin.toFixed(2)}deg`);
      bubbleRef.current?.style.setProperty('--run-flip', String(flip));
    };
    const tick = (now: number) => {
      const dt = Math.min(34, now - last);
      last = now;
      const { w, h } = petSize();
      const pos = bubblePosRef.current;
      const cruise = 0.11;
      speed += (cruise - speed) * Math.min(1, dt / 180);
      const step = runStepRef.current;
      const moved = speed * boost[step] * dt;
      const windows = windowsRef.current;
      let x = pos.x;
      let y = pos.y;
      let heading: Heading = faceRef.current < 0 ? 'left' : 'right';
      if (!cursor || !windows.some((win) => win.hwnd === cursor!.hwnd)) {
        cursor = nearestRail(windows, pos.x, pos.y, w, h);
      }
      if (cursor) {
        const win = windows.find((item) => item.hwnd === cursor!.hwnd);
        if (win) {
          let goal = placeOnRail(win, cursor.side, cursor.t, w, h);
          if (Math.hypot(goal.x - pos.x, goal.y - pos.y) <= 16) {
            cursor = advanceRail(windows, cursor, moved);
            const landed = windows.find((item) => item.hwnd === cursor!.hwnd) ?? win;
            goal = placeOnRail(landed, cursor.side, cursor.t, w, h);
          }
          const dx = goal.x - pos.x;
          const dy = goal.y - pos.y;
          const dist = Math.hypot(dx, dy);
          const stepPx = Math.min(dist, moved);
          if (dist > 0.6) {
            x = pos.x + (dx / dist) * stepPx;
            y = pos.y + (dy / dist) * stepPx;
          } else {
            x = goal.x;
            y = goal.y;
          }
          heading = headingFromMove(dx, dy, goal.heading);
        }
      } else {
        const dir = faceRef.current;
        const max = Math.max(8, window.innerWidth - w - 8);
        const room = dir > 0 ? max - pos.x : pos.x - 8;
        let nextDir = dir;
        if (room < 36) speed = Math.max(0.02, speed * 0.9);
        x = pos.x + dir * moved;
        if (x <= 8) {
          x = 8;
          nextDir = 1;
        } else if (x >= max) {
          x = max;
          nextDir = -1;
        }
        if (nextDir !== faceRef.current) {
          faceRef.current = nextDir;
          setFace(nextDir);
          speed = 0.04;
        }
        y = pos.y;
        heading = nextDir < 0 ? 'left' : 'right';
      }
      applyHeading(heading, dt);
      const traveled = Math.hypot(x - pos.x, y - pos.y);
      carry += traveled;
      if (carry >= holds[step] * scaleRef.current && traveled > 0.2) {
        carry = 0;
        const nextStep = (step + 1) % 4;
        runStepRef.current = nextStep;
        setRunStep(nextStep);
      }
      const next = {
        x: Math.max(0, Math.min(window.innerWidth - w, x)),
        y: Math.max(0, Math.min(window.innerHeight - h, y)),
      };
      bubblePosRef.current = next;
      setBubblePos(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pose, expanded]);

  const beginOcr = useCallback(() => {
    setOcrMode(true);
    setOcrTip('拖动框选，松开后识别文字');
    setSelectBox(null);
    selectStart.current = null;
    selectBoxRef.current = null;
    setExpanded(false);
    if (isTauri()) {
      void setForceCapture(true);
      void updateHitRects([{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }]);
    }
  }, []);

  const endOcr = useCallback(() => {
    if (isTauri()) void setForceCapture(false);
    setOcrMode(false);
    setSelectBox(null);
    selectStart.current = null;
    selectBoxRef.current = null;
  }, []);

  const acceptImage = useCallback(async (dataUrl: string) => {
    const compact = await compactImage(dataUrl);
    if (!compact.startsWith('data:image') || imageRef.current === compact) return;
    imageRef.current = compact;
    setImageUrl(compact);
    stageDragImage(compact);
    setExpanded(true);
    setPage('compose');
    setResult(null);
    setError(null);
    setRawInput((prev) => (prev.trim() ? prev : DEFAULT_SHOT_PROMPT));
    visionPending.current = true;
    setVisionTick((n) => n + 1);
    showToastMsg('已接上截图');
  }, [showToastMsg]);

  const takeChatImage = useCallback(async (dataUrl: string) => {
    const compact = await compactImage(dataUrl);
    if (!compact.startsWith('data:image')) return;
    setChatImage(compact);
    setExpanded(true);
    setPage('chat');
    setChatError(null);
    showToastMsg('图片已放入对话');
  }, [showToastMsg]);

  const deliverImage = useCallback((dataUrl: string) => {
    if (expandedRef.current && pageRef.current === 'chat') {
      void takeChatImage(dataUrl);
      return;
    }
    void acceptImage(dataUrl);
  }, [acceptImage, takeChatImage]);

  const takeImageFile = useCallback((file: File) => {
    const now = Date.now();
    if (now - dropLock.current < 800) return;
    dropLock.current = now;
    void readImageFile(file).then((url) => deliverImage(url)).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : '读取截图失败');
    });
  }, [deliverImage]);

  const takeChatImageFile = useCallback((file: File) => {
    const now = Date.now();
    if (now - dropLock.current < 800) return;
    dropLock.current = now;
    void readImageFile(file).then((url) => takeChatImage(url)).catch((e: unknown) => {
      setChatError(e instanceof Error ? e.message : '读取截图失败');
    });
  }, [takeChatImage]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = onFileDrop({
      onHover: setDropHot,
      onDrop: (paths) => {
        const now = Date.now();
        if (now - dropLock.current < 800) return;
        dropLock.current = now;
        void (async () => {
          for (const path of paths) {
            try {
              deliverImage(await readDroppedImage(path));
              return;
            } catch {
              continue;
            }
          }
          showToastMsg('请拖入图片');
        })();
      },
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [deliverImage, showToastMsg]);

  useEffect(() => {
    if (!isTauri() || !clipboardWatch) return;
    const unlisten = onClipboardText((text) => {
      setRawInput(text);
      setResult(null);
      setError(null);
      setExpanded(true);
      setPage('compose');
      showToastMsg('已捕获剪贴板');
      if (imageRef.current) {
        visionPending.current = true;
        setVisionTick((n) => n + 1);
      }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [clipboardWatch, showToastMsg]);

  useEffect(() => {
    if (!isTauri() || !clipboardWatch) return;
    const unlisten = onClipboardImage((url) => { void acceptImage(url); });
    return () => { void unlisten.then((fn) => fn()); };
  }, [clipboardWatch, acceptImage]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = imageFileFromClipboard(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      void readImageFile(file).then((url) => deliverImage(url)).catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '读取截图失败');
      });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [deliverImage]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = onStartOcr(() => beginOcr());
    return () => { void unlisten.then((fn) => fn()); };
  }, [beginOcr]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (ocrMode) {
        endOcr();
        return;
      }
      if (page !== 'compose') setPage('compose');
      else setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ocrMode, page, endOcr]);

  useLayoutEffect(() => {
    if (!isTauri() || ocrMode) return;
    const rects = [bubbleRef.current, panelRef.current].flatMap((el) => {
      if (!el) return [];
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return [];
      return [{ x: r.x, y: r.y, w: r.width, h: r.height }];
    });
    void updateHitRects(rects);
  });

  const changeInput = (value: string) => {
    abortRef.current?.abort();
    runRef.current += 1;
    setLoading(false);
    setRawInput(value);
    setResult(null);
    setError(null);
    if (!value.trim()) setPinnedSkill(null);
  };

  const handleNormalize = useCallback(async (force = false) => {
    const text = rawInput.trim() || (imageUrl ? DEFAULT_SHOT_PROMPT : '');
    if (!text && !imageUrl) return;
    if (loading && !force) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const run = ++runRef.current;
    setLoading(true);
    setError(null);
    if (!force) setResult(null);
    let frame = 0;
    let pending = '';
    const paint = (streaming: boolean) => {
      if (run !== runRef.current) return;
      const fields = parseNormalizedOutput(pending, streaming);
      setResult(toResult(fields, skill.id, composePrompt(fields)));
    };
    try {
      const preset = presets.find((p) => p.id === activePresetId) ?? null;
      const normalized = await normalizePrompt(
        text,
        skill,
        llmConfig,
        formatProjectContext(preset),
        imageUrl,
        (chunk) => {
          pending = chunk;
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            paint(true);
          });
        },
        controller.signal,
      );
      if (run !== runRef.current) return;
      if (frame) cancelAnimationFrame(frame);
      pending = normalized;
      const fields = parseNormalizedOutput(normalized);
      const next = toResult(fields, skill.id, composePrompt(fields));
      setResult(next);
      if (!llmConfig.apiKey.trim()) showToastMsg('未配置 API Key，已按模板列出待补充项');
      const entry: HistoryEntry = {
        id: `${Date.now()}`,
        at: Date.now(),
        raw: text,
        hadImage: Boolean(imageUrl),
        skillId: skill.id,
        fields,
        rawPrompt: next.rawPrompt,
      };
      setHistory((prev) => {
        const items = [entry, ...prev].slice(0, 8);
        saveHistory(items);
        return items;
      });
    } catch (e) {
      if (run !== runRef.current || controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : '规范化失败，请检查 API 配置');
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, [rawInput, imageUrl, loading, llmConfig, skill, presets, activePresetId, showToastMsg]);

  useEffect(() => {
    if (!visionPending.current) return;
    const timer = window.setTimeout(() => {
      visionPending.current = false;
      void handleNormalize();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [visionTick, rawInput, imageUrl, handleNormalize]);

  rawMirror.current = rawInput;
  const normalizeRef = useRef(handleNormalize);
  normalizeRef.current = handleNormalize;

  useEffect(() => {
    if (!isTauri() || !clipboardWatch) return;
    const unlisten = onDraftText((text) => {
      const next = text.trim();
      if (!next || next === rawMirror.current.trim()) return;
      rawMirror.current = next;
      setRawInput(next);
      setError(null);
      setExpanded(true);
      setPage('compose');
      setDraftTick((n) => n + 1);
      void revealOverlay();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [clipboardWatch]);

  useEffect(() => {
    if (!draftTick) return;
    const timer = window.setTimeout(() => { void normalizeRef.current(true); }, 700);
    return () => window.clearTimeout(timer);
  }, [draftTick]);

  const handleFieldChange = (_index: number, value: string) => {
    setResult((prev) => {
      if (!prev) return prev;
      const fields = [{
        key: 'prompt',
        label: '提示词',
        value,
        status: value.trim() ? 'ok' as const : 'missing' as const,
        editable: true,
      }];
      return toResult(fields, prev.skillId, value.trim());
    });
  };

  const currentText = result ? composePrompt(result.fields) : '';

  const handleCopy = useCallback(async () => {
    if (!currentText) {
      showToastMsg('没有可复制的内容');
      return;
    }
    await copyToClipboard(currentText);
    showToastMsg('已复制');
  }, [currentText, showToastMsg]);

  const handleAutoFill = useCallback(async () => {
    if (!currentText) {
      showToastMsg('没有可填入的内容');
      return;
    }
    if (!isTauri()) {
      await copyToClipboard(currentText);
      showToastMsg('已复制，请粘贴到 AI 工具');
      return;
    }
    try {
      await pasteToFocusedWindow(currentText, imageUrl);
      showToastMsg(imageUrl ? '已填入提示词和截图' : '已填入上一个窗口');
    } catch (e) {
      setError(e instanceof Error ? e.message : '填入失败');
    }
  }, [currentText, imageUrl, showToastMsg]);

  const handleTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    localStorage.setItem('promptlens_theme', t.id);
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if ((!text && !chatImage) || chatLoading) return;
    const prior = chat.filter((turn) => turn.content.trim() || turn.image);
    const userTurn: ChatTurn = { id: `u-${Date.now()}`, role: 'user', content: text, image: chatImage ?? undefined };
    setChatImage(null);
    const assistantId = `a-${Date.now()}`;
    setChat([...prior, userTurn, { id: assistantId, role: 'assistant', content: '' }]);
    setChatInput('');
    setChatError(null);
    setChatLoading(true);
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;
    void chatWithModel(
      llmConfig,
      [...prior, userTurn],
      (full) => {
        setChat((items) => items.map((turn) => (turn.id === assistantId ? { ...turn, content: full } : turn)));
      },
      controller.signal,
    ).catch((e: unknown) => {
      if (controller.signal.aborted) return;
      setChatError(e instanceof Error ? e.message : '回答失败');
    }).finally(() => {
      if (chatAbortRef.current === controller) setChatLoading(false);
    });
  };

  const toggleClipboardWatch = () => {
    const next = !clipboardWatch;
    setClipboardWatch(next);
    localStorage.setItem('promptlens_clipboard_watch', String(next));
    if (isTauri()) void setClipboardEnabled(next);
    showToastMsg(next ? '剪贴板监听已开启' : '剪贴板监听已关闭');
  };

  const finishOcr = async () => {
    const box = selectBoxRef.current;
    const start = selectStart.current;
    if (!start || !box || box.w < 8 || box.h < 8 || ocrBusy.current) {
      endOcr();
      return;
    }
    ocrBusy.current = true;
    setSelectBox(null);
    setOcrTip('正在识别…');
    try {
      const text = await captureAndOcr(box.x, box.y, box.w, box.h);
      setRawInput((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
      setResult(null);
      setExpanded(true);
      setPage('compose');
      showToastMsg('已填入识别文字');
    } catch (e) {
      setExpanded(true);
      setError(e instanceof Error ? e.message : '识别失败');
    } finally {
      ocrBusy.current = false;
      endOcr();
    }
  };

  const restoreHistory = (entry: HistoryEntry) => {
    const found = builtinSkills.find((s) => s.id === entry.skillId) ?? builtinSkills[0];
    setPinnedSkill(found);
    setRawInput(entry.raw);
    imageRef.current = null;
    setImageUrl(null);
    visionPending.current = false;
    setResult(toResult(entry.fields, entry.skillId, entry.rawPrompt));
    setError(null);
    setPage('compose');
    if (entry.hadImage) showToastMsg('截图没有留在记录里，只恢复了文字');
  };

  const toastStyle = expanded && !ocrMode
    ? { left: frame.left, top: Math.max(12, frame.top - 44) }
    : { left: bubblePos.x, top: Math.max(12, bubblePos.y - 40) };

  return (
    <div className="app-root">
      {toast && <div className="toast" style={toastStyle}>{toast}</div>}
      {!expanded && !ocrMode && (
        <Bubble
          bubbleRef={bubbleRef}
          position={bubblePos}
          onMove={moveAnchor}
          onCommit={settlePet}
          onToggle={() => { setExpanded(true); setPage('compose'); }}
          imageUrl={imageUrl}
          dropHot={dropHot}
          onImageFile={takeImageFile}
          onToast={showToastMsg}
          pose={pose}
          scale={petScale}
          onScale={changePetScale}
          runStep={runStep}
          face={face}
          onFloat={() => { hostRef.current = null; setPose('float'); }}
        />
      )}
      {expanded && !ocrMode && (
        <Panel
          panelRef={panelRef}
          frame={frame}
          anchor={bubblePos}
          onMove={moveAnchor}
          onCommit={commitAnchor}
          page={page}
          onPage={setPage}
          rawInput={rawInput}
          onRawInputChange={changeInput}
          imageUrl={imageUrl}
          onClearImage={() => { imageRef.current = null; setImageUrl(null); visionPending.current = false; }}
          onImageFile={takeImageFile}
          skill={skill}
          onSkillChange={setPinnedSkill}
          result={result}
          onFieldChange={handleFieldChange}
          loading={loading}
          error={error}
          hints={hints}
          onNormalize={() => { void handleNormalize(); }}
          onClose={() => setExpanded(false)}
          onCopy={() => { void handleCopy(); }}
          onPaste={() => { void handleAutoFill(); }}
          onToast={showToastMsg}
          onOcr={beginOcr}
          clipboardWatch={clipboardWatch}
          onClipboardToggle={toggleClipboardWatch}
          history={history}
          onRestore={restoreHistory}
          onClearHistory={() => { setHistory([]); saveHistory([]); }}
          llmConfig={llmConfig}
          onLlmConfig={setLlmConfig}
          onSaveConfig={() => { saveLLMConfig(llmConfig); savePresets(presets); saveActivePresetId(activePresetId); }}
          presets={presets}
          activePresetId={activePresetId}
          onPresets={(items) => { setPresets(items); savePresets(items); }}
          onActivePreset={(id) => { setActivePresetId(id); saveActivePresetId(id); }}
          theme={theme}
          onTheme={handleTheme}
          dropHot={dropHot}
          chat={chat}
          chatInput={chatInput}
          onChatInput={setChatInput}
          onSendChat={sendChat}
          chatLoading={chatLoading}
          chatError={chatError}
          chatImage={chatImage}
          onChatImageFile={takeChatImageFile}
          onClearChatImage={() => setChatImage(null)}
        />
      )}
      {ocrMode && (
        <OcrOverlay
          tip={ocrTip}
          box={selectBox}
          onStart={(x, y) => { selectStart.current = { x, y }; }}
          onMove={(x, y) => {
            if (!selectStart.current) return;
            const sx = selectStart.current.x;
            const sy = selectStart.current.y;
            const box = {
              x: Math.min(sx, x),
              y: Math.min(sy, y),
              w: Math.abs(x - sx),
              h: Math.abs(y - sy),
            };
            selectBoxRef.current = box;
            setSelectBox(box);
          }}
          onEnd={() => { void finishOcr(); }}
          onCancel={endOcr}
        />
      )}
    </div>
  );
}

export default App;
