# PromptLens

Windows 桌面悬浮工具。把口语化的编程需求整理成一条可直接发给编程助手的提示词，并带一个可对话的太空小熊桌宠。

技术栈：Tauri 2、React 19、TypeScript、Vite。窗口全屏透明、置顶、无边框，只有小熊和面板接鼠标，其余区域点击穿透。

## 能做什么

- **整理提示词。** 输入一段粗糙需求，按当前技能收成一条专业提示词。未写清的信息标成「待确认」，不编造。
- **四种技能。** 修复、新功能、重构、页面。按输入自动匹配，也可以手动固定，清空输入后解除。
- **项目预设。** 技术栈、目录、约束写在用户消息里，和系统提示词分开。复制和「填入上一个窗口」用的是同一段成品。
- **跟随输入。** 读取前台 Alacritty 里已经打出的半句话（例如 `hi`、`不行啊`），边写边整理。读的是输入行，不是上一条助手回复。
- **截图。** 区域识别，或把图片拖进气泡、从气泡拖出。带图时走识图模型，纯文字走文本模型。
- **对话。** 面板里直接向已配置的模型提问，可以附图片。对话回答问题，不会把内容改写成开发提示词。
- **桌宠。** 3D 盲盒质感的太空小熊。滚轮缩放。自由拖动，只有放到窗口上沿或下沿才趴住或坐下。松开后绕窗口跑：单独的窗口绕一圈，两扇窗的边挨在一起时可以从一扇跑到另一扇。跑步时头保持朝向前进方向。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+P` | 显示或隐藏悬浮层 |
| `Ctrl+Shift+O` | 框选区域并识别文字 |

快捷键被其他程序占用时会在日志里说明，程序照常启动。退出请用托盘菜单。

## 环境

- Windows 10 或更高版本
- Node.js
- Rust（`rustup`，并带 MSVC 链接环境）
- 一个兼容 OpenAI Chat Completions 的接口。密钥只存在本机 `localStorage`，不会写进仓库

支持的提供商预设：OpenAI、DeepSeek、OpenRouter，也可以填自定义 Base URL。文本模型和识图模型分开配置。没有 API Key 时，整理功能退回一段模板，不会假装已经调用模型。

## 开发

在项目目录双击或运行：

```bat
启动.bat
```

脚本会把 Cargo 加入 `PATH`，关掉已经占用 1420 端口的旧进程，缺依赖时执行 `npm install`，然后运行 `npm run tauri:dev`。这个脚本只用于开发，不要拿它当安装包。

也可以手动：

```bat
npm install
npm run tauri:dev
```

前端开发地址是 `http://localhost:1420`。已经有一个开发进程时不要再开第二个。

类型检查：

```bat
npx tsc -p tsconfig.app.json --pretty false --noEmit
```

## 打包

```bat
npm run tauri:build
```

产物是 NSIS 安装包，在 `src-tauri/target/release/bundle/nsis/`。

## 目录

```text
src/App.tsx                 悬浮层状态：整理、对话、桌宠
src/components/FloatingUI.tsx  气泡、面板、对话和设置界面
src/core/llm.ts             模型请求与流式输出
src/core/prompt.ts          提示词拼装
src/core/petRun.ts          绕窗跑步的路线
src/skills/index.ts         四个技能
src/assets/pet/             小熊姿势图
src-tauri/src/main.rs       窗口穿透、截图拖放、窗口列表
src-tauri/src/draft.rs      Alacritty 跟随输入
src-tauri/ocr-loop.ps1      常驻 Windows OCR
启动.bat                    开发启动
```

## 模型怎么选

一次请求只调用一个 Chat Completions 接口。没有图片时用「模型」。有截图或对话图片时用「识图模型」；识图模型为空则退回文本模型（该模型需支持看图）。通义千问 / 阿里云地址会关闭思考模式。流式输出。`judgeModel` 会保存，当前版本不参与生成。
