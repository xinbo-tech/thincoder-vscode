# ThinCoder VS Code 设计文档地图（docs/design/）

> 本文件是 `docs/design/` 的板块登记表与归属规则——写/改设计文档前**先查这里**。
> 核心纪律：**一个板块一个文档**；功能点并入所属板块文档（不新建）；新板块才新建并在此登记；同一机制只在一处详述（权威源），其余文档引用、不复制。与 CLI 端 `thincoder/docs/design/README.md` 同构。

## 板块 → 文档映射

| 板块 | 文档文件 | 备注 |
|---|---|---|
| 架构 | `ARCHITECTURE.md` | 权威源 |
| 需求与决策 | `REQUIREMENTS.md` | 需求与决策记录 |
| 三观（提示词根基） | `PHILOSOPHY.md` | |
| 配置面板（Settings） | `SETTINGS-PANEL.md`、`SETTINGS-PANEL-2.md`、`SETTINGS-PANEL-PROXY-ROW.md`、`SETTINGS-REORG.md`、`SETTINGS-SUBMODEL-SHELL.md`、`MODEL-PICKER-UNIFY.md` | 6 文档同板块——**待合并（TODO）** |
| Responses 传输 | `RESPONSES-TRANSPORT.md` | |
| 项目切换 | `PROJECT-SWITCHER.md` | |
| 发布流程 | `RELEASE.md` | |
| 会诊 | `CONSULTATION.md` | |
| 飞刀 | `ESCALATE.md` | |
| 轮末蒸馏异步化 | `SEND-STALL-DISTILL-REQUIREMENTS.md`、`SEND-STALL-DISTILL-TUNING.md` | send 按钮卡顿修复：结束信号先行、蒸馏异步（2026-08-25，与 CLI 同源） |
| 工具移除 | `SLEEP-REMOVAL-REQUIREMENTS.md`、`SLEEP-REMOVAL-TUNING.md` | sleep 工具删除（2026-08-25，与 CLI 同源） |
| 工具输出限制 | `TOOL-OUTPUT-LIMITS-REQUIREMENTS.md`、`TOOL-OUTPUT-LIMITS-TUNING.md` | 落盘阈值/显示层 16K→64K（2026-08-24，与 CLI 同源） |
| Agent 运行参数 | `AGENT-PARAMS-REQUIREMENTS.md`、`AGENT-PARAMS-TUNING.md` | 评审超时/轮次上限调整（2026-08-24，与 CLI 同源） |
| Agent 循环 | `TURN-CAP-CONTINUE.md` | 与 CLI 端 `TURN-CAP-CONTINUE.md` 同源（两处描述，待收敛单一权威源——**待合并（TODO）**） |
| Webview 性能 | `webview-input-lag.md` | 输入卡顿修复方案 |

## 规则

1. **一个板块一个文档**：新功能点不新建文档，并入所属板块的现有文档（追加变更段或更新章节）。
2. **先查地图定位归属**：写文档前先查本表——找到所属板块就改该板块文档，**不得为既有板块新建文件**。
3. **新板块才新建**：确无归属的新板块才新建文档，并立即在本表登记。
4. **单一权威源**：同一机制只在一处详述；其余文档引用（指路），不复制内容——多处复制必然漂移矛盾。
5. **存量待合并**：表中标注"待合并（TODO）"的是存量碎片（如 Settings 板块 6 文档），合并不在此表范围内直接进行——统一记录于 `docs/TODO.md`。

## 变更记录

- 2026-08-21：初版（文档归属纪律，规格见 CLI `docs/design/AGENT-LOOP.md` §12 及本仓库 `ARCHITECTURE.md` 同步段）
- 2026-08-24：新增板块「Agent 运行参数」（AGENT-PARAMS-*）与「工具输出限制」（TOOL-OUTPUT-LIMITS-*）
- 2026-08-25：新增板块「轮末蒸馏异步化」（SEND-STALL-DISTILL-*）与「工具移除」（SLEEP-REMOVAL-*）
