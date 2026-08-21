# ThinCoder VS Code 架构设计

> 本文档定义 VS Code 扩展的模块划分、数据流和设计决策。
> 约束：纯 `.mjs`、零 npm 运行时依赖、VS Code API + Node 标准库。

## 设计原则

1. **薄封装**：扩展是 agent 核心的 VS Code 适配层。Agent 循环、工具系统、prompt 体系采用与 ThinCoder 一致的设计理念。负责任，不是办公设备。
2. **职责分离**：扩展主机（extension host）负责 agent 循环和工具执行；Webview 只负责 UI 渲染和用户交互。两者通过 `postMessage` 单向通信。
3. **零构建**：无 TypeScript、无打包器。`extension.mjs` 即入口，`package.json` 声明 `"type": "module"`。
4. **VS Code 原生能力优先**：工具执行通过 VS Code API 增强（如 `workspace.openTextDocument` 在写入后自动在编辑器中打开文件）。
5. **会话与 CLI 共享**：会话数据存储在 `~/.thincoder/sessions/`（与 CLI 同一磁盘位置），两端互读互写，跨产品接续无感。旧 `context.workspaceState` 方案已废弃（pre-release，无迁移）。

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
  _context      // vscode.ExtensionContext（workspaceState 存模型偏好等轻量状态，会话已迁磁盘文件）
  _panel        // vscode.WebviewPanel (聊天 UI)
  _abortController  // 当前的 AbortController（用于取消正在运行的 agent）
}
```

**会话持久化**（与 CLI 共享，同一磁盘位置）：
- 存储位置：`~/.thincoder/sessions/`
- 文件：槽位文件 `session.json.N` + `session.json.manifest`（槽位元数据 + active 指针 + sessionId）
- 目录键：完整 40 位 `sha1(normalizeCwd(cwd))`，其中 normalizeCwd **大写 Windows 盘符**（`d:\…` → `D:\…`）——`uri.fsPath` 会小写盘符，直接 hash 会与 CLI 的 `process.cwd()` 不一致；旧 12 位 hash 文件首访时改名
- 数据结构：槽位文件全量覆盖写，扩展以 `...existing` 展开式透传不认识的字段（activeModel / engineering / engDesignToken 等 CLI 字段往返不丢）
- 废弃方案（pre-release，无迁移）：`context.workspaceState` 的 `thincoder.sessions.<base64(workspacePath).slice(0,32)>`、legacy `messages/` 目录 + base64 文件名 + Memento 索引

**Provider 配置**：与 CLI 共享 `~/.thincoder/config.json`，结构为 `providers[]`（每项 `{ name, baseURL, model, apiKey, chatPath?, maxTokens?, format? }`）+ `activeProvider` 指针；`apiKey` 缺省时回退环境变量。preset 表**以 CLI `config.mjs` 的 `PROVIDER_PRESETS` 为唯一权威**（16 个，含 claude/gemini），VS Code 不再各自硬编码，避免两端漂移。读写逻辑在 `src/extension/config.mjs`（共享 config.json），设置管理 `src/extension/settings.mjs`，会话 I/O `src/extension/session-io.mjs`。首次启动若检测到旧版 VS Code settings 里的 `thincoder.providers`，一次性迁移进 `~/.thincoder/config.json` 后停用 settings 存储。

**模型选择 UI（对齐 CLI 二级菜单）**：主下拉列 provider 行（provider 名 + 右侧当前模型 + `›`），hover 弹出该 provider 的模型 flyout 子菜单，点击模型选中——两级语义对应 CLI `openModelPicker → openModelListForProvider`，因 Webview 无键盘导航改用 hover flyout 实现。主下拉底部含 add / remove / key 管理入口。

**Provider 增删（对齐 CLI）**：`addProviderFlow`（选 preset[过滤已添加] → 自动填 baseURL/model → 输 key；custom 手动输 name/baseURL/model + 选 format）、`removeProviderFlow`（列非 active provider 供删）、`setKeyFlow`（设/改 key）。

**协议 transport**：三种 `provider.format` —— `openai`（默认，SSE chat completions）、`anthropic`（Messages API）、`google`（streamGenerateContent）。三种 transport 均已实现并在 `src/provider.mjs` 的 `TRANSPORTS` 表按 format 分派（含 thinking、tool calls、多模态），可承接 custom 的协议选择及 claude/gemini preset。

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

**工具结果落盘与写时自清理（2026-08-21）**：工具结果超 16k 字符落盘 `<cwd>/.thincoder/tmp/tool-<id>.txt`，模型只见 2k 预览 + `[Large output saved…]` 路径指引（`offloadToolResult`，CLI parity）。落盘目录写时自清理：每次 offload 写新文件前删除目录内 mtime 超过 3 天（`TMP_RETENTION_MS`）的文件——子目录不动、异常静默；同目录的 paste-* 粘贴图片临时文件一并按此回收。需求与用例见 CLI `docs/design/ARCHITECTURE.md`「落盘目录写时自清理」——**清理逻辑**两端逐行等价、CLI 为准；落盘目录两端各自为政（CLI `~/.thincoder/tool-results/`、VS Code `<cwd>/.thincoder/tmp/`）。实现 `src/agent/run-helpers.mjs`（sync 版 readdirSync/statSync/unlinkSync），测试新建 `test/run-helpers.test.mjs`。

**上下文注入（顶层）**：
```
[System: working directory snapshot]
[System: project dependency outline]
[System: AUTO mode active]          ← 当 autoApprove 为 true 时；每次循环迭代动态检查（live getter，CLI parity）——
                                       approve-all / AUTO 按钮在轮次中途翻转后，下一条注入即生效
user input
```

**子 agent 支持**：
- `depth=0`：顶层 agent，拥有完整工具集 + meta 工具
- `depth=1`：子 agent，role 模式相关（非工程 explore/plan/coder，工程 explore/plan/eng-coder，见下文「subagent role 枚举按模式覆盖」），工具集缩减，prompt 叠加角色 overlay
- explore/plan：只读工具；coder：完整工具
- 轮次上限对齐 CLI：统一取共享 config.json 的 `agent.subagentTurns`（默认 100），顶层轮次取 `agent.maxTurns`（默认 100）

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
| 文件 | `read`, `write`, `edit`, `insert_after`, `delete`, `lint`（CLI 级联）, `checklist` |
| 搜索 | `glob`, `grep`, `ls`, `code_search`, `doc_search` |
| Git | `git_diff`, `git_status`, `git_log`, `checkpoint` |
| 系统 | `bash` |
| 网络 | `websearch`, `fetch` |
| 交互 | `question` |
| 媒体 | `read_image` |
| 补丁 | `apply_patch` |
| 代码智能 | `lsp`（VS Code 原生语言服务）, `execute`（vm 沙箱 JS） |
| 元工具 | `task`, `recent_changes`, `subagent`, `plan`, `goal`, `skill`, `verify`, `timer`, `advisor`, `eng` |

**lsp（VS Code 原生实现）**：CLI 的 lsp 工具自起 LSP server 进程（JSON-RPC over stdio，需 config.json `lsp.servers` 配置）；VS Code 侧直接用编辑器自己的语言服务（`vscode.executeDefinitionProvider` / `executeReferenceProvider` / `executeHoverProvider` / `executeDocumentSymbolProvider` + `languages.getDiagnostics`），无需配置、无需进程管理，任何装有语言扩展的语言都可用。子命令与 CLI 一致：definition / references / hover / symbols / diagnostics。

**advisor / eng（与 CLI 同源移植）**：
- `advisor`：独立只读评审子代理，工具集 = read/glob/grep/ls/git_diff/git_status/git_log/code_search（CLI 另有 lsp，VS Code 侧待补，见 TODO.md）。收敛协议（round 1 全量 → round 2 验证+新明显问题 → round 3+ 严格验证，机械上限 5 轮）、会话内 `_advisorSession` 复用、`.thincoder/advisor.md` 自定义标准、advisor guard pushback（最多 3 次）——全部与 CLI 一致。
- `type='design'` 设计评审：生成 HMAC 签名 design token（1 小时过期），advisor 仅在无 🔴 时回显 `[DESIGN-TOKEN:…]`，回显即签发 token 给 eng-coder。
- `eng`：工程模式开关，engineering 标志落盘共享 config.json（`agent.engineering`）；工程模式下主代理 system prompt 换成 `engineering.md` + 项目 METHODOLOGY.md，dispatch 门禁机械拦截 design review 通过前的代码文件写入（docs/** 豁免），`eng-coder` 子代理须持 token 才获写权限（spawn 时校验 + 运行时门禁双保险）。
- 工程状态持久化：`engineering` 进 config.json，`engDesignToken` 进会话槽位文件（`_advisorRound` 为 per-run，不持久化，与 CLI 一致）。

**提示词借鉴增量（kimi-code 对照，2026-08-21）**：explore 彻底度分级（quick/medium/thorough，prompt 约定形态）+ system.md 确认理解补"列出最重要的验收标准"。需求/设计/测试/文件清单见 CLI `docs/design/AGENT-LOOP.md`「## 10. 提示词借鉴增量」——两端 `src/prompts/` 改动保持 byte-identical，subagent 工具 description 两端各自同步语义。VS Code 端受影响文件：`src/prompts/explore.md`、`src/prompts/main.md`、`src/prompts/system.md`、`src/agent-tools/subagent.mjs`、测试、`CHANGELOG.md`。

**开工前计划确认纪律（2026-08-21）**：任何写代码/写文档动作前纯文字复述"理解+计划"并等用户明确确认，无豁免（普通模式 + 工程模式；子 agent 不适用）。需求/设计/测试/文件清单见 CLI `docs/design/AGENT-LOOP.md`「## 11. 开工前计划确认纪律」——两端 `src/prompts/system.md`、`engineering.md` 保持 byte-identical。VS Code 端受影响文件：`src/prompts/system.md`、`src/prompts/engineering.md`、`test/agent.test.mjs`、`CHANGELOG.md`。

**subagent 活动流修复（2026-08-22）**：

- **需求**（用户报告，仅 VS Code 端）：① 同一 turn 多次调用 eng-coder 时，后续调用的活动流继续显示在第一个 eng-coder 块里（应每次调用独立一块）；② eng-coder 块只有工具调用输出，无 reasoning 也无主输出 token。
- **设计**：`src/agent-tools/subagent.mjs`——① 面板通道名 `sub:${role}` → `sub:${role}#${subId}`（webview `_subBlocks` 按 name 复用块的根因；resume 续跑 subId 不变，块不重复）；② `baseOpts` 加 `streamOutput: true`（agent.mjs 的 onToken depth gate 豁免，escalate 同款）；③ runAgent 调用的 `onToken` 改为累加 + `panel({ kind: "text", text: t })`，新增 `onReasoning: (r) => panel({ kind: "think", text: r })`（agent.mjs 的 onReasoning 无 gate，传了就流）。`webview/chat.js` 的 `subagentChunk` 无需改动（按 name 建块，标题自动显示 `eng-coder#N` 可区分多次调用）。CLI 端无此问题（relay 前缀已含 role#id），不涉及。
- **测试**（`test/subagent.test.mjs` + webview 测试）：① panel 通道名含 `#${subId}`（单测 execute 的 onToolPanel 捕获）；② onToken 转 panel kind=text、onReasoning 转 panel kind=think；③ webview `subagentChunk`：`sub:eng-coder#1` 与 `sub:eng-coder#2` 各自建独立块、`_subBlocks` 两个 key；④ 回归：全量测试通过。
- **受影响文件**：`src/agent-tools/subagent.mjs`、`test/subagent.test.mjs`、webview 测试文件（`test/webview-lib.test.mjs` 或 `test/ui.test.mjs`，选现有 subagentChunk 覆盖处）、`CHANGELOG.md`。


**文档归属纪律 + advisor 设计评审增强（2026-08-21）**：文档地图（`docs/design/README.md`，两端各建）+ system.md 归属纪律（找到就改、新建须登记、单一权威源引用不复制）+ advisor-design.md 加 Document ownership 维度（矛盾表述 🔴、碎片化 🟡）与引用纪律 + fallback 转硬加载。需求/设计/测试/文件清单见 CLI `docs/design/AGENT-LOOP.md`「## 12. 文档归属纪律 + advisor 设计评审增强」——两端 prompts 保持 byte-identical。




**advisor 开关语义重构（对齐 CLI AGENT-LOOP.md §8，2026-08-21）**：

- **需求**：`advisor.enabled` 是双义开关——既 gate 评审能力（非工程模式 enabled=false 时 advisor 工具返回 "not enabled"），又 gate guard 推回。用户拍板：**评审能力恒启用（不设禁用开关），开关语义收敛为 guard，guard 默认 OFF**（评审自愿调用，打开才强制）。工程模式行为不变。
- **设计**：`src/advisor/run.mjs` 删除 enabled gate；`src/agent.mjs` guard 条件 `advisorCfg?.enabled && advisorCfg?.guard !== false` → `advisorCfg?.guard === true`（工程模式豁免保留）；`src/config-io.mjs` guard 默认 `?? true` → `?? false`；`enabled` 字段废弃不再读写（存量不迁移，pre-release 约定，CHANGELOG 说明）。UI：工具栏 ADVISOR 按钮语义改为 guard（消息 `setAdvisorEnabled` → `setAdvisorGuard`，`webview/chat.js` `_advisorOn` ← `settings.advisor.guard`，按钮文案/aria 由 ADVISOR 改为 GUARD）；设置面板删除 `adv-enabled` 开关、保留 `adv-guard`（默认未勾选）；`locales/*.json` 相应文案（`toolbar.advisor` 改 guard 语义，`settings.advisorEnabled*` 移除或改义）。评审 provider 沿用 `resolveAdvisorProvider`（未配 advisor.provider → 继承主 provider，恒启用零障碍）。
- **测试**（更新 `test/advisor.test.mjs` / `test/settings.test.mjs` / `test/settings-panel.test.mjs` / `test/chat-panel.test.mjs`）：① 无任何 advisor 配置时调 advisor 正常执行（不再 "not enabled"）；② `{ advisor: {} }` 改代码收尾不推回（guard 默认 OFF）；③ `{ advisor: { guard: true } }` 改代码未评审收尾推回 "MUST get an advisor review"；④ 工程模式豁免不变；⑤ `{ advisor: { enabled: true } }` 不再触发推回（enabled 废弃）；⑥ 面板开关读写真值：`saveAgentSettingsFromPanel({ advisor: { guard: true } })` → config.json `advisor.guard === true`，enabled 不再写入；⑦ `agentSettings()` 返回 guard 供按钮/面板反射。
- **受影响文件**：`src/advisor/run.mjs`、`src/agent.mjs`、`src/config-io.mjs`、`src/extension/panel-messages.mjs`、`src/extension/settings.mjs`、`webview/chat.js`、`webview/settings.js`、`webview/index.html`、`locales/en.json`、`locales/zh.json`、`AGENTS.md`（消息协议表 setAdvisorEnabled 行）、`test/advisor.test.mjs`、`test/settings.test.mjs`、`test/settings-panel.test.mjs`、`test/chat-panel.test.mjs`、`test/agent.test.mjs`（补 loop 级 guard 推回用例 ②③④⑤ 的 VS Code 侧断言——agent.mjs 内联 guard 逻辑需本端测试兜底，不依赖 CLI 侧）、`CHANGELOG.md`。CLI 端文件清单见 CLI AGENT-LOOP.md §8（两端逐行等价，CLI 为准）。

**subagent role 枚举按模式覆盖（对齐 CLI setup.mjs）**：

- **需求**：非工程模式下 `subagent` 工具的 role enum 仍展示 `eng-coder`（VS Code 侧漏了 CLI 的按模式覆盖），模型看见"design-driven"角色后可用公开工具自主走完解锁链（`eng(enter)` → `advisor(type='design')` 拿 token → 派生 eng-coder 写码），造成"非工程模式盗用 eng-coder"。修复目标：非工程模式 schema 不展示 `eng-coder`；运行期硬门禁保持不动。
- **设计**：`src/agent-tools/subagent.mjs` 新增导出 `modeRoleField(engineering)`（纯函数，文案与 CLI `setup.mjs` 逐字一致）。**返回形状 `{ role: { type: "string", enum, description }, suffix: string }`**——`role` 整体替换 schema 的 `parameters.properties.role`（role 自身的 description 即模式相关文案），`suffix` 拼接到工具级 description 末尾（非工程 suffix 为 `""`）。两态取值——非工程：`role.enum = ["explore","plan","coder"]`、role 描述注明 "'eng-coder' is disabled in normal mode"、`suffix = ""`；工程：`role.enum = ["explore","plan","eng-coder"]`、role 描述注明 "'coder' is disabled in engineering mode"、`suffix = "In engineering mode, use role='eng-coder' for implementation (coder is disabled)."`。`src/agent.mjs` 将 `toolSchemas` 的构建从紧邻 tools 数组处**移到 `engineering` 计算之后**（以符号锚定：`const engineering = engState?.enabled ?? cfgEngineering` 之后），对 depth 0 的 subagent schema 应用 `modeRoleField(engineering)`；其余参数（designToken 等）不变。`subagent.mjs` 的 engineering/role 互斥 throw 与 `execute-tools.mjs` 的 eng-coder 写门禁**原样保留**（schema 覆盖只是第一道防线，不替代运行期校验）。
- **范围外**（记入 TODO.md，本变更不实现）：`eng(enter)` 的用户同意门、design token 的用户批准点、拒绝文案降噪（CLI 侧同样存在，两端待议）。
- **测试**（`test/subagent.test.mjs`）：① `modeRoleField(false)` → enum 含 coder、不含 eng-coder，role 描述含 "disabled in normal mode"，suffix 为空；② `modeRoleField(true)` → enum 含 eng-coder、不含 coder，role 描述含 "disabled in engineering mode"，suffix 指名 role='eng-coder'；③ 门禁回归：非工程 + `role='eng-coder'` 仍 throw "Engineering mode is not active"；④ 接线层测试：depth 0 构建出的 subagent schema 在非工程模式 role enum 不含 eng-coder、含 coder，工程模式不含 coder、含 eng-coder；⑤ 互斥回归：工程模式 + `role='coder'` throw "Engineering mode: use role='eng-coder' for implementation tasks."。
- **需求→用例映射**：需求「非工程模式 schema 不展示 eng-coder」→ ①④；「工程模式 schema 不展示 coder」→ ②④；「运行期硬门禁保持不动」→ ③⑤。

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

**上下文压缩**（与 CLI 统一规范，见 thincoder `docs/design/CONTEXT-COMPACTION.md`）：
- 触发：仅安全点（history 末尾为 user/tool）且完整 prompt 估算 ≥ 阈值；**实测优先**——上次响应的 `usage.prompt_tokens` 为基线，之后的消息按增量估算（无基线时 system+tools+history 纯估算）
- 阈值：显式 `agent.compactThreshold` 优先，否则 auto = 模型 context × **0.6**（为注入上下文与输出/reasoning 留余量）
- 策略：head（最早 2 条，tool_calls 配对保护）+ LLM 摘要（thinking 关闭，对前端静默）+ tail（窗口自适应 `max(10, ctx/100K×30)`，≤40% 历史，orphan tool 拉回 owner）
- 降级链：摘要 LLM 失败 → 连续 3 次后 `truncateFallback` 确定性截断（无 LLM 调用）；无 middle 可切 → `shrinkOversized` 单消息截断
- 压缩后回注：task 列表（先清旧注入去重）+ plan mode + AUTO/permission reminder
- 空响应（reasoning 耗尽/输出截断）：注入 reminder 重试，上限 2 次，仍空才抛错（IK60QP，CLI 同语义）

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
| Memory 三层体系 | ✅ 基础 | 文件式 markdown 条目 + frontmatter（CLI 条目格式兼容，put/search/list/remove）；配 embedding key 时走向量语义检索，否则关键词回退；不依赖 sqlite |
| MCP 支持 | ✅ | stdio + HTTP/WS transport，工具**动态展开为原生工具**（`{server}_{tool}` 前缀，CLI parity——统一规范见 thincoder `docs/design/MCP.md`；旧 `mcpTool` 网关已废弃）。配置存 `~/.thincoder/config.json` 的 `mcp.servers[]`（面板 Settings 可管理；旧 `thincoder.mcpServers` 设置已随迁移删除） |
| Checkpoint (git snapshot) | ✅ | git stash 快照 + list/create/rewind/cat，支持单文件恢复 |
| Image input | ✅ | 粘贴/拖拽 + 附加按钮（`attach-btn`），`read_image` 工具；多模态模型支持（Kimi K3、Qwen、GPT-4o、MiniMax M3），非多模态模型自动剥离图片部分 |
| Skill 系统 | ✅ | 读取 `.thincoder/skills/` 目录下的 .md 文件，列表注入上下文 |
| 权限审批 UI | ✅ | webview 逐工具弹窗（approve / deny / approve-all + diff 预览）；autoApprove 是**会话级槽位字段**（与 CLI 共享），AUTO 工具栏按钮或 approve-all 翻转它；agent 循环以 live getter 读取——轮次中途翻转立即停掉后续弹窗（2026-08-13 修复） |

## 与 thincoder CLI 的差异

两个产品共享设计理念、提示词体系，以及**会话数据与配置数据**（同一磁盘位置、互相读写）。代码各自独立、安装独立、无运行时依赖。

| 方面 | CLI | VS Code |
|------|-----|---------|
| 用户界面 | 裸 ANSI TUI (~24 模块) | Webview (iframe) |
| 会话存储 | `~/.thincoder/sessions/`（共享，5 槽位轮转） | 同上（共享同一目录） |
| 工具目录约束 | 工作目录 (`process.cwd()`) | 第一个 workspace 文件夹 |
| 文件打开 | TUI 内显示 | VS Code 编辑器标签页 |
| 权限审批 | TUI 内交互式（y/n/a；a = approve + AUTO ON） | webview 逐工具弹窗（approve / deny / approve-all）；autoApprove 会话级槽位字段，两端语义一致 |
| 配置存储 | `~/.thincoder/config.json`（共享） | 同上（共享同一文件；apiKey 回退环境变量） |
| 记忆系统 | 3-layer FTS5 + vector | 文件式 markdown 条目（CLI 兼容格式；可选向量检索，无 FTS5） |
| MCP | ✅ | ✅ stdio + HTTP（`~/.thincoder/config.json` 的 `mcp.servers[]`） |

> **字段往返完整（已落地）**：共享槽位文件是全量覆盖写。`chat-panel._saveLines` 现以 `...existing` 展开式透传（不认识的字段原样保留），仅覆盖扩展自己拥有的字段——CLI 写入的 `activeModel`/`engineering`/`engDesignToken` 等字段在 VS Code 侧往返不丢。契约详见 CLI `docs/design/ARCHITECTURE.md`「会话存储统一 → 字段往返完整」。
