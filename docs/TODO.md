# TODO — thincoder-vscode 项目级技术待办

> 设计遗留 / 评审发现 / 用户指示的后续项。完成即勾销。按板块/来源分组。

## 工程模式防盗用（2026-08-21 分析，来源：非工程模式盗用 eng-coder 事件）

- [ ] `eng(enter)` 加用户同意门（当前模型可自主翻转并把 `agent.engineering=true` 持久化进共享 config.json；exit 可保持自主）。CLI 侧同样存在。
- [ ] design token 签发后置为 pending，需用户批准才可派生 eng-coder（"wait for user approval" 目前只是 engineering.md 的 prompt 散文）。CLI 侧同样存在。
- [ ] 收紧拒绝文案：subagent/advisor 的错误信息不再逐条写出解锁步骤（"Engineering mode is not active"→"run advisor with type='design'"→"pass this exact token"）。CLI 侧同样存在。

## 文档债（2026-08-21 ARCHITECTURE.md 设计评审 advisory，未实现项）

- [ ] 存量碎片合并（2026-08-21 §12 文档归属纪律，范围外项）：Settings 板块 6 文档（SETTINGS-PANEL、SETTINGS-PANEL-2、SETTINGS-PANEL-PROXY-ROW、SETTINGS-REORG、SETTINGS-SUBMODEL-SHELL、MODEL-PICKER-UNIFY）合并；TURN-CAP-CONTINUE 两端同源描述收敛单一权威源（详见两端 docs/design/README.md 地图标注）
- [ ] design round2 专用提示词（§11 评审发现 #4）：design 重跑不再复用 code-review 收敛提示词

- [ ] ARCHITECTURE.md 补 NFR 小节（性能/安全/兼容性）与测试层总览（advisor #2）
- [ ] 原则 2 "postMessage 单向通信" 改述为"无共享状态、全部经消息协议通信"（advisor #3）
- [ ] 明确 PROVIDER_PRESETS 是静态镜像拷贝而非运行时 import CLI（advisor #4）
- [ ] 模块小节补 memory.mjs / repomap.mjs / specs.mjs / extension 子模块 / prompts（advisor #5）
- [ ] §6/§3/§4 补：懒加载历史分页、编辑器双通道+isDirty stop sign、Ctrl+I interrupt、isNonRetryableError/readSSE 立即失败（advisor #6）
- [ ] §2 runAgent 签名参数名对齐实际实现（input → text，advisor #8）
- [ ] §4 模型能力表补 thinkEnabledValue / noUsageStream（advisor #10）
- [ ] advisor 子代理工具集补 lsp（原文档 T19 遗留）
- [ ] 跨端文档漂移（2026-08-21 评审 advisory）：checkpoint 机制两端语义差异待明确（CLI v2 全量副本快照 vs VS Code git stash）、preset 计数 16/17、TUI 模块数 ~24/45、12 位旧 hash 改名侧未标注
