# CLI ↔ VS Code 能力差距

> 目标：把 CLI 已验证的能力全部移植到 VS Code 扩展。本文档即 checklist，完成一条划一条。

## 代码理解（3 项）

CLI 的 Agent 动手前先"读"项目，VS Code 版全靠 grep 硬撞。这三个工具是 Agent 的"眼睛"。

| # | 能力 | CLI 位置 | 说明 |
|---|------|---------|------|
| 1 | `repo_outline` | `src/tools/repomap.mjs` | 文件依赖关系图。Agent 看到哪些文件 import 了哪些文件，改一处知道影响面。 |
| 2 | `code_search` | `src/memory/code-sync.mjs` | FTS5 全文搜索源代码。Agent 用自然语言查函数/类/模式，比 grep 正则更智能。 |
| 3 | `doc_search` | `src/memory/docs.mjs` | 搜索 README、设计文档、AGENTS.md。Agent 动手前先读项目规范。 |

## 长期记忆（4 项）

CLI 有完整的 FTS5 + 向量混合检索记忆系统。VS Code 版每次对话从零开始。

| # | 能力 | CLI 位置 | 说明 |
|---|------|---------|------|
| 4 | `memory_put` 工具 | `src/memory/core.mjs` | Agent 学到的知识持久化存储。支持 rule/knowledge/decision/pattern 四种类型。 |
| 5 | `memory_search` 工具 | `src/memory/core.mjs` | 混合检索（FTS5 + 向量 + RRF），跨会话回忆。 |
| 6 | 代码索引同步 | `src/memory/code-sync.mjs` | git diff 驱动增量索引，文件变更后自动重建。`code_search` 的数据基础。 |
| 7 | 文档索引同步 | `src/memory/docs.mjs` | Markdown 按 ## 标题分块索引，增量更新。`doc_search` 的数据基础。 |

## Provider 健壮性（3 项）

| # | 能力 | CLI 位置 | 说明 |
|---|------|---------|------|
| 8 | TPM 闸门 | `src/provider/rate.mjs` | 窗口超预算时自动等待，实测 usage 记账。高并发防限流。 |
| 9 | Partial Mode 续写 | `src/provider/core.mjs` | 输出被截断时自动续写。对大文件/长回复很有用。 |
| 10 | DeepSeek Prefix Completion | `src/provider/core.mjs` | DeepSeek 特化的 /beta 端点续写。 |

## MCP 协议（1 项）

| # | 能力 | CLI 位置 | 说明 |
|---|------|---------|------|
| 11 | MCP 支持 | `src/mcp/` | HTTP/stdio/WS 三种 transport。Agent 可动态接入外部工具。 |

## Checkpoint（1 项）

当前 VS Code 的 checkpoint 只有 list/create，缺核心的 rewind。

| # | 能力 | CLI 位置 | 说明 |
|---|------|---------|------|
| 12 | Checkpoint rewind | `src/git/checkpoint.mjs` | 快照回滚。批量操作前保护未提交的代码。 |

---

## 已补齐

| # | 能力 | 备注 |
|---|------|------|
| — | （暂无） | |
