# 配置面板重设计 · 第二部分：MCP / 语义索引 / Agent 设置 / Proxy

> 状态：**设计待评审**。第一部分（Provider 区块，`SETTINGS-PANEL.md`）已获批准。
> 本文档梳理配置面板其余区块与 CLI 的差距，逐项给出对齐方案。实施需用户批准。

## 1. MCP Servers 区块

### 现状问题

| # | 问题 | 详情 |
|---|------|------|
| M1 | **存储位置与 CLI 不一致** | VS Code 存 `thincoder.mcpServers`（VS Code settings，dict `{name: config}`）；CLI 存 config.json `mcp.servers[]`（数组，条目带 name）。两端互不可见——CLI 加的 server VS Code 看不到，反之亦然 |
| M2 | stdio 表单缺 `env` 字段 | CLI addFlow 可输 `KEY=value` 环境变量；VS Code 表单没有 |
| M3 | 无重连、无连接状态 | CLI `/mcp connect` + `●/○` 状态；VS Code 面板只列配置，看不到是否已连接，也不能重连 |
| M4 | 重名静默覆盖 | CLI 拒绝重名；VS Code `saveMcpServer` 直接覆盖同名条目 |
| M5 | 无 AI 辅助添加 | CLI 有 "Describe with AI"（自然语言生成配置）；VS Code 无。**建议不做**——锦上添花，且面板里跑一次 LLM 生成交互链很长 |
| M6 | args 分隔符不一致 | CLI stdio args 空格分隔；VS Code 逗号分隔。小事，对齐 CLI 即可 |

### 方案（对齐 CLI）

1. **MCP 迁移进共享 config.json**（M1）：`raw.mcp.servers[]`，条目形态与 CLI 完全一致（`{name, command, args?, env?}` / `{name, url, headers?}` / `{name, wsUrl, headers?}`）。一次性迁移逻辑并进 `migrate-settings.mjs`（模式与 providers 迁移相同：读旧 settings → 写 config.json → 清旧键，flag 防重跑）。
2. 读写入口：`settings.mjs` 的 getMcpServers/saveMcpServer/deleteMcpServer 改走 config-io；`chat-panel._chat` 传给 runAgent 的 mcpServers 改从 config.json 读（形态从 dict 变数组，agent.mjs 的 MCP 注入段同步改，按 CLI 的列表格式渲染）。
3. **表单补 env 字段**（M2），args 改空格分隔（M6），重名校验拒绝（M4）。
4. **连接状态与重连**（M3）：`mcp/index.mjs` 暴露 `mcpConnectedNames()`（读内部 `_servers` map）；面板行显示 ●/○ + 工具数；行上加 [Reconnect] 按钮 → 新消息 `reconnectMcp` → disconnect + 重新 connect（连接是 agent 调 mcp 工具时懒建立的，面板重连 = 预热/修复断连）。
5. **M5 不做**，记录在案。

### 消息协议变化

- `saveMcpServer` / `deleteMcpServer`：保留名字，落盘改 config.json；save 时校验重名（返回错误消息给 webview 提示）。
- 新增 `reconnectMcp`：`{ name }`。
- `mcpStatus` 推送：增加每 server 的 `connected`/`toolCount` 字段。

## 2. Semantic Index 区块

**模型与 baseURL 写死为 SiliconFlow bge-m3——这是定案，不是待修问题。**（2026-08-03 用户拍板：embedding 模型固定；CLI 侧原有的 5 模型选择属过度工程，已在 CLI `2d99b60` 撤除该 picker。向量索引的格式假定单一 embedding 空间，暴露模型选择只会制造索引失配。）

VS Code 现状（`_saveEmbeddingConfig`/`_resolveEmbedder` 写死 bge-m3 + SiliconFlow）**保持不动**。本区块唯一要做的：

| # | 事项 | 详情 |
|---|------|------|
| I1 | key 管理入口保留 | 现有 Add/Change/✕ 交互不变，落盘 config.json embedding.apiKey（已如此） |

不做：模型选择、baseURL 输入、任何 embedding 高级设置。

## 3. Agent 设置区块（新增，目前完全没有）

CLI `/config` 的可配置项，config.json `agent.*`，VS Code 面板**零入口**：

| 配置项 | CLI | VS Code 现状 |
|--------|-----|--------------|
| `agent.maxTurns` | /config 可改 | 已接线（agent.mjs 读 config），无 UI |
| `agent.subagentTurns` | /config 可改 | 已接线，无 UI |
| `agent.compactThreshold` | /config 可改（auto 标记） | **未接线**（compactHistory 用内部默认），无 UI |
| `agent.verifyGuard` | /config 开关，默认 off（opt-in） | **无此字段；verify guard 永远开启**——与 CLI 行为不一致 |
| `advisor.enabled` / `guard` / `provider` / `model` | config + /advisor 命令 | 工具已移植，开关只能手改 config.json |

### 方案

面板新增 **Agent** 区块（对齐 CLI /config）：

```
AGENT
  maxTurns        [100    ]        数字输入
  subagentTurns   [100    ]
  compactThreshold [auto  ]        留空=auto（按模型 context 算）
  verifyGuard     [toggle]         对齐 CLI：默认 off
ADVISOR
  enabled         [toggle]
  guard pushback  [toggle]         （guard !== false）
  provider/model  [文本框，可选]    独立评审模型（留空=主模型）
```

- 全部落盘 config.json（persistRaw），保存即生效（下一个 runAgent 调用读新值——maxTurns/subagentTurns/verifyGuard/advisor 都是每次 runAgent 开头读的，天然生效）。
- **verifyGuard 行为修正**：VS Code agent.mjs 的 verify guard 改为 `agent.verifyGuard === true` 才启用（对齐 CLI opt-in 语义）。这是行为变化，默认 off 后 verify guard 不再自动回推——与 CLI 一致。**注意**：此前 VS Code 一直是"永远开"，切换后需测试确认 advisor guard（opt-in）与 verify guard（opt-in）互斥逻辑与 CLI 一致。
- **compactThreshold 接线**：context.mjs compactHistory 接 config 值（explicit > auto-from-model，CLI resolveCompactThreshold 同款逻辑）。

## 4. Proxy（能力缺口，不只是 UI）

### 现状

CLI 有完整 proxy 支持：config.json `proxy: {uri, web, model}`、`/config` 里的 proxy 菜单（设置 URI、web/model 开关、连接测试、清除）、`proxy.mjs` 手写 CONNECT 隧道、web 工具和 provider 请求按开关走代理。**VS Code 完全没有**——web 工具直连，LLM 请求直连。对墙内用户这是实际痛点。

### 方案（建议，待批）

1. 移植 CLI `proxy.mjs` 的 CONNECT 隧道实现（Node 原生 net/tls，零依赖，VS Code extension host 可直接跑）。
2. 接线两处：`tools/web.mjs` 的 websearch/fetch（按 `proxy.web`）；`provider/transports/*` 的 LLM 请求（按 `proxy.model`，需 fetch 支持 dispatcher——Node 20+ 用 undici ProxyAgent，或走 CLI 同款隧道封装）。
3. 面板 Proxy 区块：URI 输入 + web/model 两个开关 + [Test] 按钮（对齐 CLI proxy 菜单的 test：fetch gstatic generate_204）。
4. 落盘 config.json `proxy` 段（config-io 已有 normalizeProxy，直接复用）。

工作量最大的一块，建议**单独一批**做，不与前面三块混。

## 5. 已确认不动的

- `thincoder.autoApprove`（VS Code 特有权限模型，合理留在 settings）
- engineering 模式：走 eng 工具（已移植），面板不加开关
- MCP AI 辅助添加（M5）：不做
- 面板整体布局：保持单列滚动分区

## 6. 实施批次建议

| 批次 | 内容 | 依赖 |
|------|------|------|
| A（已批） | Provider 区块重设计（SETTINGS-PANEL.md） | — |
| B | MCP：迁移 config.json + env/重名/重连 | A 完成后（settings.js 同一文件） |
| C | Agent/Advisor 设置区块 + verifyGuard/compactThreshold 接线（embedding 区块不动，模型写死 bge-m3） | 与 B 无冲突，可并行 |
| D | Proxy 全套（移植 + 接线 + UI） | 独立一批 |

## 7. 验收标准

**B（MCP）**：
1. CLI 与 VS Code 看到同一份 MCP server 列表（改一端另一端刷新可见）
2. stdio 表单含 env；重名拒绝；行显示 ●/○ 与工具数；[Reconnect] 可用
3. 旧 `thincoder.mcpServers` settings 一次性迁入 config.json 并清除

**C（Agent 设置）**：
4. maxTurns/subagentTurns/compactThreshold/verifyGuard/advisor 五项可看可改，改后下一轮生效
5. verifyGuard 默认 off 时 verify guard 不回推（与 CLI 一致）

**D（Proxy）**：
6. 设 proxy URI + web:on 后 websearch/fetch 走代理；Test 按钮返回 OK/错误
7. model:on 时 LLM 请求走代理
