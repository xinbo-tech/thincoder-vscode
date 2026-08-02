# ThinCoder VS Code 架构设计

> 本文档定义 VS Code 扩展的模块划分、数据流和设计决策。
> 约束：纯 `.mjs`、零 npm 运行时依赖、VS Code API + Node 标准库。

## 设计原则

1. **薄封装**：扩展是 agent 核心的 VS Code 适配层。Agent 循环、工具系统、prompt 体系采用与 ThinCoder 一致的设计理念。负责任，不是办公设备。
2. **职责分离**：扩展主机（extension host）负责 agent 循环和工具执行；Webview 只负责 UI 渲染和用户交互。两者通过 `postMessage` 单向通信。
3. **零构建**：无 TypeScript、无打包器。`extension.mjs` 即入口，`package.json` 声明 `"type": "module"`。
4. **VS Code 原生能力优先**：工具执行通过 VS Code API 增强（如 `workspace.openTextDocument` 在写入后自动在编辑器中打开文件）。
5. **会话与 workspace 绑定**：会话数据存储在 `context.workspaceState`，按 workspace 路径隔离。打开不同项目不会看到彼此的会话。

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Extension Host                           │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  extension.mjs│    │ src/agent.mjs│    │src/provider  │  │
│  │  ChatPanel    │───▶│ runAgent()   │───▶│+src/mcp      │  │
│  │  +extension/  │    │ +context.mjs │    │ chat()       │  │
│  └──────┬────────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                    │                    │          │
│   postMessage          tool calls           HTTP → LLM API  │
│         │                    │                               │
│  ┌──────┴────────────────────┴──────────────────────────┐   │
│  │                   Webview (iframe)                    │   │
│  │  chat.js ─── ui.js ─── md.js ─── base|chat|controls|session|settings.css │   │
│  │  index.html                                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 模块详解

### 1. extension.mjs — ChatPanel 类

**职责**：扩展入口、会话生命周期管理、设置管理、Webview 创建与消息路由。

**核心状态**：
```js
class ChatPanel {
  _context      // vscode.ExtensionContext (workspaceState 用于持久化)
  _panel        // vscode.WebviewPanel (聊天 UI)
  _abortController  // 当前的 AbortController（用于取消正在运行的 agent）
}
```

**会话持久化**：
- 存储位置：`context.workspaceState`
- 键格式：`thincoder.sessions.<base64(workspacePath).slice(0,32)>`
- 数据结构：
  ```json
  {
    "active": "Session 1",
    "items": {
      "Session 1": { "title": "", "messages": [{ "type": "user|assistant", "content": "...", "timestamp": "..." }] }
    }
  }
  ```

**Provider 配置**：与 CLI 共享 `~/.thincoder/config.json`，结构为 `providers[]`（每项 `{ name, baseURL, model, apiKey, chatPath?, maxTokens? }`）+ `activeProvider` 指针；`apiKey` 缺省时回退环境变量。内置 6 个 preset（DeepSeek/Kimi/GLM/Qwen/MiniMax/OpenAI）加 `custom`，preset 表**以 CLI `config.mjs` 的 `PROVIDER_PRESETS` 为唯一权威**，VS Code 不再各自硬编码，避免两端漂移。读写逻辑在 `src/extension/config.mjs`（共享 config.json），设置管理 `src/extension/settings.mjs`，会话 I/O `src/extension/session-io.mjs`。首次启动若检测到旧版 VS Code settings 里的 `thincoder.providers`，一次性迁移进 `~/.thincoder/config.json` 后停用 settings 存储。

**LLM 标题生成**：
- 触发：会话第一条用户消息后，agent 完成回复
- 策略：用任意已配置的 provider 发送简短 prompt（"Generate a concise title"），限制输出 30 tokens
- 失败静默降级（使用首条消息截断作为标题）

### 2. src/agent.mjs — Agent 主循环

**职责**：多轮工具调用循环，采用与 ThinCoder 一致的架构设计。

**关键参数**：
```js
runAgent(provider, cwd, input, callbacks, signal, autoApprove, opts)
// opts: { depth, role, maxTurns } — 子 agent 上下文
```

**循环控制**：
- 默认最大轮次：100
- Stall 检测：连续 5 轮中工具重复 ≥ 3 次 → 警告注入
- Verify 守卫：顶层 agent 最多 push back 2 次（verify 失败后重试）

**上下文注入（顶层）**：
```
[System: working directory snapshot]
[System: project dependency outline]
[System: AUTO mode active]          ← 仅在 autoApprove=true 时
user input
```

**子 agent 支持**：
- `depth=0`：顶层 agent，拥有完整工具集 + meta 工具
- `depth=1`：子 agent，role 为 explore/plan/coder，工具集缩减，prompt 叠加角色 overlay
- explore：maxTurns=30，只读工具
- plan/coder：maxTurns=50，完整工具

### 3. 工具系统（`src/tools.mjs` → `src/tools/`）

**设计原则**：每个工具 `{ name, description, parameters, execute(ctx) }`，统一的工具接口规范。`tools.mjs` 是 re-export 入口，实现拆分到 `src/tools/` 子目录（`file.mjs`, `system.mjs`, `git.mjs`, `web.mjs`, `patch.mjs`, `index.mjs`）。

**VS Code 适配增强**：
- `write` / `edit`：写入后自动在编辑器中打开文件（`workspace.openTextDocument` → `window.showTextDocument`）
- `bash`：继承终端 shell 环境，`cwd` 默认为第一个 workspace 文件夹
- 路径解析：相对路径相对于 `ctx.cwd`（workspace 根目录）

**路径安全**：
- `resolvePath(path, cwd)` → 拒绝 `../` 跳出 workspace 的路径
- 绝对路径仅在 cwd 子树内放行

**工具清单（20+）**：
| 分类 | 工具 |
|------|------|
| 文件 | `read`, `write`, `edit`, `insert_after`, `delete`, `syntax_check` |
| 搜索 | `glob`, `grep`, `ls`, `code_search`, `doc_search` |
| Git | `git_diff`, `git_status`, `git_log`, `checkpoint` |
| 系统 | `bash` |
| 网络 | `websearch`, `fetch` |
| 交互 | `question` |
| 媒体 | `read_image` |
| 补丁 | `apply_patch` |
| 元工具 | `task`, `recent_changes`, `subagent`, `plan`, `goal`, `skill`, `verify` |

### 4. LLM 调用层（`src/provider.mjs` + `src/provider/rate.mjs`）

**职责**：OpenAI 兼容的流式 chat completion，自动重试与退避。

**重试策略**：
- 网络错误：最多 3 次，退避 [1s, 4s, 12s]
- 429 限频：读取 `Retry-After` header，最多 3 次
- 5xx 服务端错误：退避重试最多 3 次

**流式处理**：
- 原生 `fetch` + `response.body.getReader()`
- 逐行解析 SSE (`data: {...}`)
- 支持 `reasoning_content` (DeepSeek/Kimi thinking)
- 支持 `usage` chunk (token 统计)

**模型能力适配**（`src/config.mjs`，自包含）：
- `thinking.type`：Kimi/GLM 的思考 API
- `reasoning_effort`：DeepSeek 的推理强度
- `maxOutput`：输出 token 上限
- `tempRange`：温度范围钳制
- `reasoningEcho`：thinking token 回传策略

### 5. src/context.mjs — 上下文管理

**上下文压缩**：
- 阈值：~80K tokens（估算）
- 策略：保留最后 ~30 条消息，旧消息归纳为摘要
- 摘要注入格式：`[Context compacted: ...] <conversation_summary>...</conversation_summary>`

**仓库大纲**：
- 扫描 `.js/.mjs/.ts/.jsx/.tsx` 文件
- 解析 `import` / `export` 语句
- 构建文件级依赖图
- 输出格式：目录依赖 + Hub 文件（被最多文件导入的）+ 入口点（不被其他文件导入的）

### 6. Webview 前端

**文件结构**：
- `index.html`：Webview shell，引用 5 个 CSS 文件（base, chat, controls, session, settings）和 `chat.js`
- `chat.js`：主逻辑 — 状态管理、事件处理、消息渲染控制、模型选择器、历史面板、设置面板
- `ui.js`：DOM 构造 — 欢迎页、消息气泡、工具调用卡片、loading 指示器
- `md.js`：Markdown → HTML 转换（代码块高亮、inline code、链接）

**消息流**：
```
用户输入 → chat.js:send()
  → vscode.postMessage({ type:"userMessage", text, model, reasoning, provider })
    → extension:_chat()
      → runAgent() [agent 循环]
        → onToken → webview.postMessage({ type:"token", text })
        → onToolCall → webview.postMessage({ type:"toolCall", name, args })
        → onToolResult → webview.postMessage({ type:"toolResult", name, text })
        → onComplete → webview.postMessage({ type:"complete" })
```

## 扩展点

| 功能 | 状态 | 备注 |
|------|------|------|
| Memory 三层体系 | ✅ 基础 | JSON 文件存储（put/search/list/remove），Type/tag/title/content 结构化。暂不依赖 better-sqlite3 |
| MCP 支持 | ✅ | stdio + HTTP transport，`mcpTool` 统一入口（connect/list/call/disconnect）。配置项 `thincoder.mcpServers` 注入上下文 |
| Checkpoint (git snapshot) | ✅ | git stash 快照 + list/create/rewind/cat，支持单文件恢复 |
| Image input | ❌ | `readImageTool` 已注册，但 webview 无粘贴/选择图片 UI |
| Skill 系统 | ✅ | 读取 `.thincoder/skills/` 目录下的 .md 文件，列表注入上下文 |
| 权限审批 UI | ❌ | `autoApprove=false` 时仅注入 system reminder，无工具级确认拦截 |

## 与 thincoder CLI 的差异

两个产品共享设计理念、提示词体系，以及**会话数据与配置数据**（同一磁盘位置、互相读写）。代码各自独立、安装独立、无运行时依赖。

| 方面 | CLI | VS Code |
|------|-----|---------|
| 用户界面 | 裸 ANSI TUI (~24 模块) | Webview (iframe) |
| 会话存储 | `~/.thincoder/sessions/`（共享，5 槽位轮转） | 同上（共享同一目录） |
| 工具目录约束 | 工作目录 (`process.cwd()`) | 第一个 workspace 文件夹 |
| 文件打开 | TUI 内显示 | VS Code 编辑器标签页 |
| 权限审批 | TUI 内交互式 | autoApprove 默认 false，提示 agent 确认但无工具级拦截 |
| 配置存储 | `~/.thincoder/config.json`（共享） | 同上（共享同一文件；apiKey 回退环境变量） |
| 记忆系统 | 3-layer FTS5 + vector | JSON 文件存储（单层） |
| MCP | ✅ | ✅ stdio + HTTP（`thincoder.mcpServers` 配置） |
