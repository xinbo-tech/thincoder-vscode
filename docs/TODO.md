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

## Issue 批量（2026-08-22，来源：Gitee/GitHub issue 巡检）

- [ ] GitHub thincoder#2 GLM 5.3 畸形 tool_calls 解析崩溃——需求层已入 `docs/design/ARCHITECTURE.md` 变更段
- [ ] IK9UZ8 标题生成同修（扩展端 generate-title.mjs）——权威源 CLI `docs/design/SESSION.md` §7
- [ ] 巡检登记：GitHub #1 embedding 三件套、IK9IXD 公式渲染、IK9UWM 中文粘贴——CLI 侧待办见 `thincoder/docs/TODO.md`
## 语义索引 needsRebuild 的 git 快路径盲区（2026-08-23 六轮 advisor 收敛后暂缓，来源：indexer.mjs 评审）

- [ ] git 快路径 gitignore 盲区：`discoverFiles` 不感知 `.gitignore`，gitignored 的非 memory 可索引文件（`generated/*.ts`、`*.gen.js` 等）增删改不触发重建 → 索引静默过期
- [ ] `listMemoryFiles` 只看 `.thincoder/memory/` 顶层，而 `discoverFiles` 递归子目录 → 嵌套 memory 文件被索引却反复判 `file-removed`（死循环）。二选一：递归，或限定只扫一层
- [ ] `indexer.mjs` 326 行超 300 建议线 → 拆 `chunk`/`rebuild` 到 `index-chunk.mjs` / `index-rebuild.mjs`
- [ ] reason 串失配：`file-changed`（git 路径）vs `file-changes`（fallback），另 `file-added/removed/missing` 未统一
- [ ] `loadIndex`/`searchIndex` 不校验 `manifest.vector_dim === decode.dim` 与 `embed_model`，切换 embedding 模型（维度不同）时静默产出全 0 得分
- [ ] 方向决策（A/B 待定）：A=放弃 porcelain 快路径，改为「commit 预筛 + indexed∪discoverFiles 完整 mtime 对比」，一次性消除上面两个盲区并统一 reason（正确性/简单性优先，推荐）；B=保留快路径只做最小外科补丁
- [ ] 版本 0.1.43 待办：为已提交但未进 changelog 的 indexer 系列修复（c45f1fe → 66ea83f 区间，约 7 个 commit）补一条 changelog 条目
