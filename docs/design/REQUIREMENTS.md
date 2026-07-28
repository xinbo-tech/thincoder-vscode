# ThinCoder VS Code — 需求与决策记录

> 本文档记录 VS Code 扩展的需求决策、已确定事项和待讨论项。
> 独立产品，不依赖 thincoder CLI。零外部依赖（npm + 文件系统）。

## 已确定的决策

| 项 | 决策 | 备注 |
|---|---|---|
| 语言 | 纯 JavaScript (`.mjs`) | 无 TypeScript，无构建步骤，ESM 原生 |
| 依赖 | 零 npm 运行时依赖 | 仅 `node:` 标准库 + VS Code Extension API |
| 界面 | VS Code Webview (iframe) | HTML/CSS/JS，`postMessage` 通信 |
| 入口 | `extension.mjs` → `activate()` | 标准 VS Code 扩展激活模式 |
| LLM 调用 | 原生 `fetch` + SSE 流式 | OpenAI 兼容协议，支持 reasoning / thinking |
| 支持的 Provider | 6 个内置 preset + 自定义开放端点 | 见下表 |
| 模型配置 | `thincoder.providers` | `{ name: key \| {key, baseURL, model} }` |
| 会话存储 | `context.workspaceState`，per-workspace | 键名含 workspace hash，项目隔离 |
| 工具审批 | `autoApprove` 默认 `false` | 用户显式开启才自动执行 |
| 模型能力 | 自包含 `src/config.mjs` | MODEL_SPECS 表独立维护 |
| Session 标题 | LLM 自动生成（首条消息后触发） | 失败静默降级为截断消息 |

### 内置 Provider 预设（✅ 已定）

选型原则：**只跟顶流、只跟最新**。不兼容老旧模型、不做本地模型适配。预设表随模型换代增删，不留历史包袱。

| Provider | 默认模型 | Endpoint | 特殊适配 |
|----------|---------|----------|---------|
| DeepSeek | `deepseek-v4-pro` | `api.deepseek.com/v1` | thinking.type + reasoning_effort（high/max） |
| Kimi | `kimi-k3` | `api.moonshot.cn/v1` | thinking.effort（low/high/max），chatcompletion_v2 |
| GLM | `glm-5.2` | `open.bigmodel.cn/api/paas/v4` | thinking.type + reasoning_effort（7 级） |
| Qwen | `qwen3.7-max` | `dashscope.aliyuncs.com/compatible-mode/v1` | reasoning_effort |
| MiniMax | `MiniMax-M3` | `api.minimax.chat/v1` | chatPath: `/text/chatcompletion_v2` |
| OpenAI | `gpt-4o` | `api.openai.com/v1` | 标准协议，无额外适配 |
| Custom | 用户指定 | 用户指定 | OpenAI 兼容端点即可，适配仅做温度/输出钳位 |

每个 Provider 的能力参数（context window、maxOutput、thinking API 类型、温度范围）存在 `src/config.mjs` 的 MODEL_SPECS 表里，`specForModel(model)` 按模型名前缀匹配。

## v1 功能范围（已实现）

- Agent 主循环：多轮工具调用，上下文压缩，子 agent 派生
- 工具系统：20+ 工具（文件/搜索/Git/系统/网络/交互/补丁）
- Agent 自律工具链：`task` / `plan` / `goal` / `verify` / `recent_changes` / `subagent` / `skill`
- 多 Provider：DeepSeek / Kimi / GLM / Qwen / MiniMax / OpenAI + 自定义 endpoint
- 多会话 + 模型选择器 + 设置面板 + 快捷键
- `autoApprove` 配置项，默认 `false`
- repo_outline + context compaction

**暂未做（v1.x / v2）：**
- 三层记忆体系、MCP 客户端
- read_image UI、编辑器上下文感知、LSP 集成

## 待决策

以下每一项都需要人拍板——不是"做不做"而是"选哪个方案"。

### 安全边界（✅ 已定）

> 走**透明 + 默认保守 + 信任用户判断**路线。不搞命令级沙箱。
>
> - `autoApprove` 默认 `false`，Agent 先描述计划等确认
> - 开启 AUTO 时弹出一次性警告，告知风险
> - 审计靠 git + 聊天历史，不建独立的审计日志
> - prompt injection 防御 v2 再议

### 多 Provider 默认选择（✅ 已定）

> 自动选第一个有 key 的 provider。用户配 key 本身就是选择行为——只配了一个就用那个，配了多个按列表顺序取第一个。

### Multi-root Workspace 策略（✅ 已定）

> 目标是所有文件夹对 Agent 可见。v0.1.0 先用 `workspaceFolders[0]`，后续补全。
> 当前在状态栏上标明工作目录，用户知道有限制。

### API Key 存储（✅ 已定）

> 迁 `SecretStorage`（系统密钥链）。用户量为零，没有存量包袱，一步到位。

### Webview 技术选型（✅ 已定）

> 继续 vanilla JS。当前 ~600 行，不值得引入框架。撑不住了再迁。

### 与 CLI 记忆互通（✅ 已定）

> 暂不处理。等 VS Code 扩展先有自己的记忆体系再讨论互通方案。

### 国际化（✅ 已定）

> 全英文。架构上留扩展位——UI 文本集中到常量文件，不做散落在 DOM 操作里的裸字符串。

## 与 thincoder CLI 的关系

两个独立产品，共享设计理念和提示词体系，代码完全独立：

```
thincoder CLI                       thincoder-vscode
├── 终端 TUI（裸 ANSI）              ├── VS Code 侧面板（Webview）
├── 文件系统会话存储                  ├── workspaceState 会话存储
├── 3 层记忆 + MCP                   ├── （未来自建）
├── ~/.thincoder/config.json         ├── VS Code settings.json
└── npm i -g thincoder               └── VS Code Marketplace
```

同级独立产品。用户只装哪一个都行。
