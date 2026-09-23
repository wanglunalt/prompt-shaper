// ============================================================
// PromptLens - Skill System
// ============================================================

export interface PromptSkill {
  id: string;
  name: string;
  description: string;
  icon: string;
  triggers: {
    keywords: string[];
    taskType: string[];
  };
  template: {
    role: string;
    requiredFields: string[];
    optionalFields: string[];
    fieldGuides: Record<string, string>;
  };
  checklist: {
    id: string;
    label: string;
    severity: 'critical' | 'warning' | 'info';
  }[];
  outputSpec: {
    language: 'zh' | 'en';
    codeOnly: boolean;
    includeExplanation: boolean;
  };
  /** Short bias appended to the shared system prompt. */
  focus: string;
}

// ------------------------------------------------------------
// Built-in Skills
// ------------------------------------------------------------

export const builtinSkills: PromptSkill[] = [
  {
    id: 'bug-fix',
    name: 'Bug 修复',
    description: '修复报错、异常行为或不符合预期的功能',
    icon: '🐛',
    triggers: {
      keywords: ['报错', 'bug', '不工作', '为什么', '出错', '失败', '崩溃', 'fix', 'error', 'broken', 'not working'],
      taskType: ['debug', 'error'],
    },
    template: {
      role: '资深全栈工程师，擅长快速定位和修复问题',
      requiredFields: ['任务', '报错信息', '预期与实际'],
      optionalFields: ['上下文', '复现步骤', '约束'],
      fieldGuides: {
        任务: '用一句话描述要修复什么问题',
        报错信息: '完整的报错信息、堆栈、截图中的文字',
        预期与实际: '预期行为是什么？实际行为是什么？',
        上下文: '相关文件路径、技术栈、项目背景',
        复现步骤: '如何复现这个问题',
        约束: '修复时必须遵守的约束（不改其他模块、不引入新依赖等）',
      },
    },
    checklist: [
      { id: 'error_complete', label: '是否提供了完整报错信息？', severity: 'critical' },
      { id: 'repro_clear', label: '复现步骤是否清晰？', severity: 'warning' },
      { id: 'tech_stack', label: '技术栈是否已说明？', severity: 'warning' },
      { id: 'file_path', label: '相关文件路径是否提供？', severity: 'info' },
    ],
    outputSpec: { language: 'zh', codeOnly: false, includeExplanation: true },
    focus: `本次按 Bug 修复倾斜：
- 写清复现路径、预期行为和实际行为
- 根因只写成假设，不要写成已证实的事实
- 修复必须最小侵入，点名不能改动的模块
- 验收要包含原来的功能仍然可用`,
  },
  {
    id: 'new-feature',
    name: '新功能开发',
    description: '从零实现一个新功能或新组件',
    icon: '✨',
    triggers: {
      keywords: ['帮我加', '实现', '做一个', '写一个', '开发', '新建', 'add', 'implement', 'create', 'new feature'],
      taskType: ['feature', 'build'],
    },
    template: {
      role: '资深前端工程师，注重代码质量和可维护性',
      requiredFields: ['任务', '上下文', '输出格式'],
      optionalFields: ['约束', '边界情况', '测试'],
      fieldGuides: {
        任务: '要实现什么功能？详细描述需求',
        上下文: '技术栈、项目结构、相关文件路径',
        输出格式: '希望输出什么？完整文件？代码片段？diff？',
        约束: '必须遵守的约束（不引入新依赖、代码风格要求等）',
        边界情况: '需要考虑的边界情况',
        测试: '是否需要附带测试用例',
      },
    },
    checklist: [
      { id: 'requirements_clear', label: '需求描述是否足够详细？', severity: 'critical' },
      { id: 'tech_stack', label: '技术栈是否已说明？', severity: 'critical' },
      { id: 'output_format', label: '输出格式要求是否明确？', severity: 'warning' },
      { id: 'constraints', label: '是否有明确的约束条件？', severity: 'info' },
    ],
    outputSpec: { language: 'zh', codeOnly: false, includeExplanation: true },
    focus: `本次按新功能或脚本倾斜：
- 写清输入、输出和数据流
- 标出模块边界、状态放在哪里、依赖什么
- 覆盖空数据、加载中和失败
- 不要顺手重构无关代码`,
  },
  {
    id: 'refactor',
    name: '代码重构',
    description: '在不改变行为的前提下优化代码结构',
    icon: '🔄',
    triggers: {
      keywords: ['重构', '优化', '重写', '整理', 'clean', 'refactor', 'improve', 'restructure'],
      taskType: ['refactor', 'optimize'],
    },
    template: {
      role: '资深工程师，注重代码可维护性和最佳实践',
      requiredFields: ['任务', '当前代码', '重构目标'],
      optionalFields: ['约束', '测试', '性能目标'],
      fieldGuides: {
        任务: '要重构什么？哪个文件或模块？',
        当前代码: '当前代码内容或文件路径',
        重构目标: '重构目标？可读性？性能？类型安全？解耦？',
        约束: '重构时必须保持的行为不变性、兼容性要求',
        测试: '是否有现有测试可以验证重构正确性？',
        性能目标: '如果是性能优化，目标是什么？',
      },
    },
    checklist: [
      { id: 'code_provided', label: '是否提供了待重构的代码？', severity: 'critical' },
      { id: 'goal_clear', label: '重构目标是否明确？', severity: 'critical' },
      { id: 'behavior_preserved', label: '是否强调了不改变外部行为？', severity: 'warning' },
      { id: 'tests', label: '是否有测试保障？', severity: 'info' },
    ],
    outputSpec: { language: 'zh', codeOnly: false, includeExplanation: true },
    focus: `本次按重构倾斜：
- 外部行为必须保持不变
- 写明类型安全和模块边界
- 说明如何验证行为没有变化
- 禁止借重构改变产品行为`,
  },
  {
    id: 'ui',
    name: '页面优化',
    description: '调整界面、布局、样式或交互，不改无关业务',
    icon: '🎨',
    triggers: {
      keywords: ['优化页面', '页面', '样式', '布局', '界面', '响应式', 'tailwind', 'css', '动画', '组件', 'ui', 'ux'],
      taskType: ['ui', 'style'],
    },
    template: {
      role: '资深前端工程师，注重现有组件复用和交互完整性',
      requiredFields: ['任务', '上下文', '输出格式'],
      optionalFields: ['约束', '边界情况', '测试'],
      fieldGuides: {
        任务: '要改哪一块界面，希望变成什么样',
        上下文: '现有组件、样式体系和断点',
        输出格式: '改哪些文件，是否保持现有交互',
        约束: '不能改动的业务逻辑和接口',
        边界情况: '空状态、加载、窄屏',
        测试: '主要断点和原有操作是否还在',
      },
    },
    checklist: [
      { id: 'reuse', label: '是否要求复用现有组件？', severity: 'warning' },
      { id: 'responsive', label: '是否写了响应式或断点？', severity: 'warning' },
      { id: 'behavior', label: '是否强调不改业务接口？', severity: 'critical' },
    ],
    outputSpec: { language: 'zh', codeOnly: false, includeExplanation: true },
    focus: `本次按页面优化倾斜：
- 优先复用现有组件和样式体系
- 写清响应式、交互反馈和空状态
- 不要改业务接口和无关数据流
- 验收包含主要断点，以及现有操作仍然可用`,
  },
];

// ------------------------------------------------------------
// Skill Matcher - match user input to best skill
// ------------------------------------------------------------

export function matchSkill(input: string): PromptSkill {
  const lower = input.toLowerCase();
  let best = builtinSkills[0];
  let bestScore = 0;

  for (const skill of builtinSkills) {
    let score = 0;
    for (const kw of skill.triggers.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += kw.length; // longer keyword match = higher score
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return best;
}

// ------------------------------------------------------------
// Build the normalization prompt from skill + user input
// ------------------------------------------------------------

export function buildSystemPrompt(skill: PromptSkill): string {
  return `# Role: Senior Staff Software Engineer & AI Prompt Optimizer

你是一位拥有 15 年全栈与架构经验的资深工程师。开发者正在使用 Cursor、Windsurf、Claude Code 或 Copilot 写代码。
你的唯一任务：把他们模糊、口语化的需求，转成这些工具可以零歧义执行的编程任务说明。
如果用户附了截图，先读图，再写提示词。

## 视觉与截图
截图可能是报错、控制台、页面或接口响应。只提取图里看得到的内容，不要编造图中没有的文字。
1. 报错和日志：摘出完整错误信息、堆栈、状态码、文件名和行号。
2. 页面截图：说明错位、溢出、样式异常、断点或没渲染出来的组件。
3. 写进同一段提示词：先写图中的具体现象，再写图里出现的文件、函数或接口；没有的写「待确认」。做法按图中的原因来，验收写成报错消失或页面恢复正常。

## 转换原则
1. 意图拆解：补上开发者漏掉的常规细节，例如状态、边界、错误处理、类型。
2. 限定修改范围：写明改什么，以及绝不能破坏什么，避免模型大面积重写。
3. 分步：复杂需求拆成可执行步骤。
4. 验收：每条都能被开发者拿去要求 AI 自测。
5. 可以按技术栈补全常规做法。文件路径、接口字段、报错原文没有依据时写「待确认」，不要编造。

## 场景侧重
模型应自行判断输入更接近哪一类，并加重对应内容：
- 页面优化：组件复用、响应式、现有样式体系、交互反馈
- Bug 修复：复现路径、根因假设、最小侵入、原功能仍可用
- 新功能或脚本：输入输出、数据流、模块边界、失败与空状态
- 重构：行为保持不变、类型安全、如何证明行为没变

若下面给出了本次侧重，以它为准：
${skill.focus}

## 输出
输入可能只写了一半。只润色已经出现的意思，把这一句补成能交给编程助手的说法，不要换成另一个任务。后文变长后，以最新全文为准重写。缺的文件和报错写「待确认」。
不要思考过程，不要前言，不要标题，不要 emoji，不要代码块。
只输出一段可以直接粘贴给编程助手的提示词，段落之间空一行，按这个顺序写：
1. 要改什么。有截图时写图里看得见的现象。
2. 动哪些模块，以及明确不能动什么。图里没有的路径写「待确认」。
3. 几条可执行的做法，带上边界和失败情况。
4. 两三条验收，写成做完后能检查的结果。
语气像资深工程师交代任务，尽快开始输出。`;
}
