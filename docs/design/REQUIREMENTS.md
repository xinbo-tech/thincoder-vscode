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
| 支持的 Provider | 16 个 preset（含 Claude/Gemini）+ 自定义端点（三协议） | 见下表 |
| 模型配置 | `~/.thincoder/config.json`（与 CLI 共享） | providers[] + activeProvider，见「与 CLI 的关系」 |
| 会话存储 | `~/.thincoder/sessions/`（与 CLI 共享） | 完整 sha1(cwd) + 槽位，两端互读 |
| 工具审批 | `autoApprove` 默认 `false` | 用户显式开启才自动执行 |
| 模型能力 | 自包含 `src/config.mjs` | MODEL_SPECS 表独立维护 |
| Session 标题 | LLM 自动生成（首条消息后触发） | 失败静默降级为截断消息 |

### Provider 预设（以 CLI 为唯一权威）

**权威来源**：preset 表以 CLI `src/config.mjs` 的 `PROVIDER_PRESETS` 为唯一权威，VS Code 不再各自硬编码（避免漂移）。当前全集 16 个，含 `claude`（format: anthropic）与 `gemini`（format: google）：

| 类别 | Provider |
|------|----------|
| OpenAI 兼容 | deepseek, kimi, glm, qwen, qwenplan, minimax, openai, grok, mistral, volcengine, hunyuan, siliconflow, openrouter, groq |
| Anthropic 协议 | claude（`format: "anthropic"`，Messages API） |
| Google 协议 | gemini（`format: "google"`，streamGenerateContent） |

每个 Provider 的能力参数（context window、maxOutput、thinking API 类型、温度范围）存在 `src/config.mjs` 的 MODEL_SPECS 表里，`specForModel(model)` 按模型名前缀匹配。

### Provider 与模型选择（对齐 CLI，✅ 已定）

四条契约，全部对齐 CLI 现有行为：

1. **配置共享**：读写 `~/.thincoder/config.json`（`providers[]` + `activeProvider`），与 CLI 同一份文件；`apiKey` 缺省回退环境变量。旧 VS Code settings 一次性迁移后停用（见「与 CLI 的关系」）。
2. **模型选择 = 二级菜单**：对齐 CLI `openModelPicker → openModelListForProvider` 两级结构 + add/remove/key 管理项。Webview 无键盘导航，用 **hover flyout 子菜单**实现两级语义：主下拉列 provider 行（provider 名 + 右侧当前模型 + `›`），hover 弹出该 provider 的模型子菜单，点击模型选中。
3. **模型添加 = 添加/删除 provider 模式**：对齐 CLI `addProviderFlow` / `removeProviderFlow` / `setKeyFlow`。添加流程：选 preset（过滤已添加的）→ 自动填 baseURL/model → 输入 API key；custom 走手动流程（下条）。删除：列出非 active 的 provider 供移除。key 管理：单独入口设/改 key。
4. **custom 支持三种协议**：对齐 CLI `addProviderFlow` 的 custom 分支——手动输入 name / baseURL / model，并选 **API format: `openai`（默认）/ `anthropic` / `google`**，写入 `provider.format`。三种协议都有 transport（见下）。

**协议 transport**：`openai`（默认，SSE chat completions）、`anthropic`（Messages API，CLI `provider/anthropic.mjs`）、`google`（streamGenerateContent，CLI `provider/google.mjs`）。VS Code 需补齐 anthropic / google 两个 transport 才能承接 custom 的协议选择——当前仅有 openai transport。

## v1 功能范围（已实现）

- Agent 主循环：多轮工具调用，上下文压缩，子 agent 派生
- 工具系统：20+ 工具（文件/搜索/Git/系统/网络/交互/补丁）
- Agent 自律工具链：`task` / `plan` / `goal` / `verify` / `recent_changes` / `subagent` / `skill`
- 多 Provider：16 个 preset（含 Claude/Gemini）+ 自定义 endpoint（openai/anthropic/google 三协议），与 CLI 共享 `~/.thincoder/config.json`
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

两个独立产品，共享设计理念、提示词体系，以及**会话数据与配置数据**——两端读写同一份磁盘文件，可无缝接续同一会话、同一组 provider：

```
thincoder CLI                       thincoder-vscode
├── 终端 TUI（裸 ANSI）              ├── VS Code 侧面板（Webview）
├── 3 层记忆 + MCP                   ├── （未来自建）
└── npm i -g thincoder               └── VS Code Marketplace

        两端共享（同一磁盘位置，互相读写）
        ├── ~/.thincoder/config.json      配置（providers + activeProvider）
        └── ~/.thincoder/sessions/        会话（完整 sha1(cwd) + 槽位）
```

同级独立产品。用户只装哪一个都行；同时装则共享配置与会话，切换无感。
