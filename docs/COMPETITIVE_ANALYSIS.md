# thincoder-vscode vs 行业竞品 — 能力对比

> 2026-07-28 评估

## 评测维度

### 1. 智能体循环（Agentic Loop）

| | ThinCoder | Copilot Chat | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 多轮工具调用 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Plan 模式（只读探索） | ✅ | ❌ | ✅ | ❌ | ❌ |
| Goal 追踪（目标+验证条件） | ✅ | ❌ | ❌ | ❌ | ❌ |
| Task 清单（进度跟踪） | ✅ | ✅ 弱 | ✅ | ❌ | ❌ |
| Subagent（并行子任务） | ✅ | ❌ | ❌ | ❌ | ❌ |
| Verify 守卫（写完必校验） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 失速检测（重复调用告警） | ✅ | ❌ | ❌ | ❌ | ❌ |
| 上下文压缩 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ |

**结论：Agent 能力业界领先。** Plan/Goal/Task/Subagent/Verify 五件套，目前没有一个竞品同时具备。

---

### 2. 模型供应商

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 内置供应商数 | **7** + custom | 1（GitHub） | 5+ | 5+ | 10+ |
| 自定义 provider | ✅ | ❌ | ✅ | ✅ | ✅ |
| 思考模式（reasoning） | ✅ | ❌ | ✅ | ✅ | ✅ |
| 多模态（图片） | ✅ | ✅ | ✅ | ✅ | ✅ |
| API key 系统密钥链存储 | ✅ | N/A | ✅ 明文 | ✅ | ✅ |

**结论：供应商覆盖中上。** 7 家不多不少，custom + 系统密钥链是亮点；Continue 有更多 provider 但配置更复杂。

---

### 3. 代码编辑体验

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 行内补全 | ❌ | ✅ | ❌ | ✅ | ✅ |
| diff 预览（accept/reject） | ❌ | ❌ | ✅ | ✅ | ✅ |
| 文件编辑（write/edit） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 编辑器焦点保持 | ✅ | ❌ | ❌ | ✅ | ✅ |
| 语法检查集成 | ✅ | ❌ | ❌ | ❌ | ❌ |

**结论：这是最大短板。** 没有行内补全和 diff 预览是功能性差距。Copilot 和 Cursor 在这块碾压所有竞品。

---

### 4. 会话管理

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 多会话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| LLM 自动生成标题 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Session bar（始终可见） | ✅ | ❌ | ❌ | ✅ | ❌ |
| 会话增删切 | ✅ | ❌ | ✅ | ✅ | ✅ |
| 会话持久化 | ✅ 文件 | ✅ 云端 | ✅ 文件 | ✅ 云端 | ✅ |

**结论：会话管理领先。** LLM 生成标题 + 始终可见的 session bar 是差异化优势。Copilot/Cursor 依赖云端同步有网络依赖，ThinCoder 纯本地。

---

### 5. 扩展性

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| MCP 协议 | ✅ | ❌ | ✅ | ❌ | ✅ |
| MCP 传输（stdio/http/ws） | ✅ 三种 | ❌ | ✅ stdio | ❌ | ✅ |
| 自定义 system prompt | ✅ .md 文件 | ❌ | ✅ | ✅ .cursorrules | ✅ |
| Skill 系统 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 插件/扩展机制 | ❌ | ❌ | ❌ | ❌ | ✅ |

**结论：MCP 能力强，但缺少 Skill/Plugin 体系。** Continue 的插件生态是最完善的。ThinCoder 的 .md 文件配置方式简单但灵活度有限。

---

### 6. 工程品质

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 代码量（源文件） | **~30 文件** | ~500+ | ~200+ | ~1000+ | ~500+ |
| 自动化测试 | ✅ 43 用例 | ✅ | ✅ | ✅ | ✅ |
| 架构文档 | ✅ | ❌ | ❌ | ❌ | ❌ |
| ESLint/格式化 | ❌ | ✅ | ✅ | ✅ | ✅ |
| CI/CD | ❌ | ✅ | ✅ | ✅ | ✅ |
| TypeScript | ❌ (JSDoc) | ✅ | ✅ | ✅ | ✅ |
| 错误处理 | 基础 try-catch | 完善 | 完善 | 完善 | 完善 |

**结论：小而精，但工业化不足。** 30 个源文件做到这些功能是工程能力的体现。缺 CI/CD、TS、linting 会在团队扩大时成为瓶颈。

---

### 7. 安全

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| autoApprove 默认 | **false** | N/A | true | false | false |
| 权限确认（per-tool） | ✅ | N/A | ✅ | ✅ | ✅ |
| API key 存储 | 系统密钥链 | N/A | 明文文件 | 系统密钥链 | 明文 |
| 环境变量过滤 | ✅ 黑名单 | N/A | ❌ | ❌ | ❌ |
| 沙箱隔离 | ❌ | ✅ 云端 | ❌ | ❌ | ❌ |

**结论：安全默认值业界最优。** `autoApprove=false` + 系统密钥链 + 环境变量过滤，这三个组合目前没有竞品同时做到。但缺少沙箱是一个硬差距。

---

### 8. 用户界面

| | ThinCoder | Copilot | Cline | Cursor | Continue |
|---|---|---|---|---|---|
| 聊天面板 | ✅ 侧栏 | ✅ 侧栏 | ✅ 侧栏 | ✅ 内嵌 | ✅ 侧栏 |
| 设置面板 | ✅ webview | ✅ VS Code UI | ✅ 侧栏 | ✅ 内嵌 | ✅ |
| 状态栏 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ |
| 暗色主题 | ✅ | ✅ | ✅ | ✅ | ✅ |
| i18n | ❌ | ✅ | ❌ | ✅ | ✅ |
| 无障碍 | ❌ | ✅ | ❌ | ✅ | ❌ |
| 响应式设计 | ❌ | ✅ | ❌ | ✅ | ✅ |

**结论：功能齐全，打磨不足。** session bar 是个好设计，但整体 UI 还处于"能用"阶段，离 Copilot 的 polished 体验有距离。

---

## 总评

```
                    ThinCoder   Copilot    Cline     Cursor    Continue
Agent 智能体         ★★★★★      ★★        ★★★★      ★★★       ★★★
模型供应商           ★★★★       ★         ★★★★      ★★★★      ★★★★★
代码编辑             ★★         ★★★★★     ★★★★      ★★★★★     ★★★★
会话管理             ★★★★★      ★★★       ★★★       ★★★★      ★★★
扩展性               ★★★        ★         ★★★       ★★        ★★★★★
工程品质             ★★★        ★★★★★     ★★★★      ★★★★★     ★★★★★
安全                 ★★★★★      ★★★★      ★★        ★★★★      ★★★
用户界面             ★★★        ★★★★★     ★★★       ★★★★★     ★★★★
```

**一句话：Agent 能力和安全性业界领先，代码编辑体验是最大短板，工程化程度中等。**

---

## 最值得投入的方向

1. **Diff 预览 + accept/reject** — 补齐最大体验缺口
2. **行内补全** — 但这是 heavy lift，仅次于 Cursor 的核心壁垒
3. **TypeScript 迁移** — 提升工程品质下限
4. **Continue 式的 @-context 系统** — 让用户更精确地控制上下文
